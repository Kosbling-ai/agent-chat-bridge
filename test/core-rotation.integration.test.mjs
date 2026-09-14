import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
import { createRuntime } from '../src/core/runtime.mjs';
const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));
async function done(store, id) { for (let i = 0; i < 150; i++) { const row = await store.getJob({ id }); if (row.status === 'succeeded') return row; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('rotation_timeout'); }
test('idle native session rotates once before admission and subsequent messages reuse the replacement', { skip: !process.env.BRIDGE_TEST_PASSWORD, timeout: 15000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'bridge-rotation-'));
  const pool = createPoolFromEnvironment(refs); let store, runtime;
  let threadStarts = 0, resumes = 0, turns = 0;
  const config = { codex: { rolloverIdleMs: 2 * 86400000, rolloverOnRulesUpdate: false }, feishu: { connectionId: 'rotation-fixture', botOpenId: 'bot' }, routing: { version: '1', privateUserIds: [], groups: [] }, hooks: [] };
  const threads = new Map([['old-thread', { id: 'old-thread', cwd: workspace, createdAt: Math.floor((Date.now() - 3 * 86400000) / 1000), turns: [] }]]);
  const codex = { status: () => ({ state: 'ready' }), readThread: async ({ threadId }) => ({ thread: threads.get(threadId) }), startThread: async () => { threadStarts++; const thread = { id: 'new-thread', cwd: workspace, createdAt: Math.floor(Date.now() / 1000), turns: [] }; threads.set(thread.id, thread); return { thread }; }, resumeThread: async ({ threadId }) => { resumes++; return { thread: threads.get(threadId) }; }, async startTurn({ threadId }) {
    turns++; const turn = { id: `turn-${turns}`, status: 'completed', items: [{ type: 'agentMessage', text: 'answer' }] }; threads.get(threadId).turns.push(turn);
    await runtime.notification({ method: 'turn/completed', params: { threadId, turn } }); return { turn };
  } };
  const scope = { connectionId: config.feishu.connectionId, conversationId: 'chat', agentId: 'codex' };
  try {
    await migrate(pool); store = await createMysqlStore({connectionId:'rotation-fixture', pool });
    await store.setSession({ ...scope, expectedGeneration: 0, nativeThreadId: 'old-thread' });
    runtime = createRuntime({ config, store, codex, workspace, chat: { sendMessage: async () => ({ message_id: 'sent' }) } }); runtime.start();
    const first = await store.enqueueJob({ ...scope, kind: 'agent', idempotencyKey: 'first', payload: { source: 'api', text: 'first' } });
    await done(store, first.id);
    assert.equal(threadStarts, 1); assert.equal(resumes, 0);
    const session = await store.getSession(scope); assert.equal(Number(session.generation), 2); assert.equal(session.nativeThreadId, 'new-thread'); assert(Number(session.lastMessageAt) > 0);
    const second = await store.enqueueJob({ ...scope, kind: 'agent', idempotencyKey: 'second', payload: { source: 'api', text: 'second' } });
    await done(store, second.id);
    assert.equal(threadStarts, 1); assert.equal(resumes, 1); assert.equal(turns, 2);
    const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM bridge_session_rotations'); assert.equal(Number(count.count), 1);
    await assert.rejects(store.setSession({ ...scope, conversationId: 'foreign', expectedGeneration: 0, nativeThreadId: 'old-thread' }), { code: 'thread_scope_conflict' });
  } finally { await runtime?.stop(); if (store) await store.close(); else await pool.end(); await rm(workspace, { recursive: true, force: true }); }
});
