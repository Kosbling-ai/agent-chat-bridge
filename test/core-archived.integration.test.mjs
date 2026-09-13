import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
import { createRuntime } from '../src/core/runtime.mjs';
const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));
async function until(read, predicate) { for (let i = 0; i < 200; i++) { const row = await read(); if (predicate(row)) return row; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('archived_timeout'); }
test('proven archived resume replaces once; replacement and reset uncertainty never replay admission', { skip: !process.env.BRIDGE_TEST_PASSWORD, timeout: 15000 }, async () => {
  const pool = createPoolFromEnvironment(refs); let store, runtime, mode = 'success', starts = 0, turns = 0, resets = 0;
  const config = { feishu: { connectionId: 'archived-fixture' }, routing: { groups: [], privateUserIds: [] }, hooks: [] };
  const scope = conversationId => ({ connectionId: config.feishu.connectionId, conversationId, agentId: 'codex' });
  const codex = { status: () => ({ state: 'ready' }), resumeThread: async ({ threadId }) => { throw Object.assign(new Error('synthetic'), { outcome: 'rejected', reason: { kind: 'thread_archived', threadId } }); }, startThread: async () => { starts++; if (mode === 'unknown') throw Object.assign(new Error('synthetic'), { outcome: 'unknown' }); return { thread: { id: `replacement-${starts}` } }; }, startTurn: async ({ threadId }) => { turns++; const turn = { id: `turn-${turns}`, status: 'completed', items: [{ type: 'agentMessage', text: 'answer' }] }; await runtime.notification({ method: 'turn/completed', params: { threadId, turn } }); return { turn }; } };
  const chat = { sendMessage: async () => ({ message_id: 'sent' }) };
  async function enqueue(conversationId) { await store.setSession({ ...scope(conversationId), expectedGeneration: 0, nativeThreadId: `old-${conversationId}` }); return store.enqueueJob({ ...scope(conversationId), kind: 'agent', idempotencyKey: conversationId, payload: { text: conversationId } }); }
  try {
    await migrate(pool); store = await createMysqlStore({ pool });
    const reset = store.resetRejectedThreadAdmission;
    store.resetRejectedThreadAdmission = async input => { resets++; const result = await reset(input); if (mode === 'lost-reset') throw Object.assign(new Error('synthetic'), { code: 'commit_unknown' }); return result; };
    runtime = createRuntime({ config, store, codex, chat }); runtime.start();
    const first = await enqueue('success');
    await until(() => store.getJob({ id: first.id }), row => row.status === 'succeeded');
    const session = await store.getSession(scope('success'));
    assert.equal(Number(session.generation), 2); assert.equal(session.nativeThreadId, 'replacement-1');
    assert.equal(starts, 1); assert.equal(turns, 1); assert.equal(resets, 1);
    await assert.rejects(store.setSession({ ...scope('foreign'), expectedGeneration: 0, nativeThreadId: 'old-success' }), { code: 'thread_scope_conflict' });
    mode = 'unknown';
    const second = await enqueue('unknown');
    await until(() => store.getJob({ id: second.id }), row => row.status === 'unknown');
    assert.equal(Number((await store.getAgentAttempt({ id: second.id })).generation), 2);
    assert.equal(starts, 2); assert.equal(turns, 1);
    mode = 'lost-reset';
    const third = await enqueue('lost-reset');
    await until(() => store.getJob({ id: third.id }), row => row.status === 'unknown');
    assert.equal(Number((await store.getAgentAttempt({ id: third.id })).generation), 2);
    assert.equal(starts, 2, 'lost reset acknowledgement never authorizes thread/start');
    await runtime.stop();
    mode = 'success';
    runtime = createRuntime({ config, store, codex, chat }); runtime.start();
    const fresh = await store.enqueueJob({ ...scope('fresh'), kind: 'agent', idempotencyKey: 'fresh', payload: { text: 'fresh' } });
    await until(() => store.getJob({ id: fresh.id }), row => row.status === 'succeeded');
    assert.equal(starts, 3); assert.equal(turns, 2); assert.equal(resets, 3);
    assert.equal((await store.getJob({ id: second.id })).status, 'unknown');
    assert.equal((await store.getJob({ id: third.id })).status, 'unknown');
    assert(runtime.status().running);
  } finally { await runtime?.stop(); if (store) await store.close(); else await pool.end(); }
});
