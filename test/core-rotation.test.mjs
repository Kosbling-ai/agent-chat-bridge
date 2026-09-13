import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSessionRotation } from '../src/core/session-rotation.mjs';

test('idle rotation preserves activity CAS and refuses active native work', async () => {
  const calls = [];
  const session = { generation: 3, nativeThreadId: 'thread', lastMessageAt: 1700000000000, activeRunId: null };
  const thread = { id: 'thread', cwd: '/workspace', createdAt: 1700000000, turns: [] };
  const inspect = createSessionRotation({ connectionId: 'fixture', workspace: '/workspace', config: { rolloverIdleMs: 1000, rolloverOnRulesUpdate: false }, now: () => 1700000002000,
    store: { getAgentAttempt: async () => null, getSession: async () => session, rotateIdleSession: async value => calls.push(value) }, codex: { readThread: async () => ({ thread }) } });
  await inspect({ id: 'job', conversationId: 'chat' });
  assert.equal(calls[0].reason, 'session_idle'); assert.equal(calls[0].expectedLastMessageAt, session.lastMessageAt);
  assert.equal(calls[0].idempotencyKey, 'run:job:session_idle:3');
  thread.turns = [{ id: 'active', status: 'inProgress' }];
  await assert.rejects(inspect({ id: 'other', conversationId: 'chat' }), /rotation_native_active/); assert.equal(calls.length, 1);
  thread.turns = []; session.activeRunId = 'other-run';
  await inspect({ id: 'other', conversationId: 'chat' }); assert.equal(calls.length, 1);
});
test('rules rotation retains production timestamp margin and ignores absent rules', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'bridge-rules-'));
  try {
    const file = join(workspace, 'AGENTS.md'); await writeFile(file, 'synthetic rules');
    const time = 1700000000000; await utimes(file, new Date(time), new Date(time));
    const calls = [], thread = { id: 'thread', cwd: workspace, createdAt: (time - 1000) / 1000, turns: [] };
    const inspect = createSessionRotation({ connectionId: 'fixture', workspace, config: { rolloverIdleMs: 0, rulesFiles: ['missing.md', 'AGENTS.md'] },
      store: { getAgentAttempt: async () => null, getSession: async () => ({ generation: 1, nativeThreadId: 'thread' }), rotateIdleSession: async value => calls.push(value) }, codex: { readThread: async () => ({ thread }) } });
    await inspect({ id: 'job', conversationId: 'chat' }); assert.equal(calls.length, 0);
    thread.createdAt -= 1;
    await inspect({ id: 'job', conversationId: 'chat' }); assert.equal(calls[0].reason, 'rules_updated');
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
test('only a scoped explicit archived read refusal permits archived rotation', async () => {
  const calls = [];
  let error = Object.assign(new Error('synthetic'), { outcome: 'unknown' });
  const inspect = createSessionRotation({ connectionId: 'fixture', workspace: '/workspace', config: { rolloverIdleMs: 1, rolloverOnRulesUpdate: false },
    store: { getAgentAttempt: async () => null, getSession: async () => ({ generation: 1, nativeThreadId: 'thread', lastMessageAt: 1 }), rotateIdleSession: async value => calls.push(value) }, codex: { readThread: async () => { throw error; } } });
  await assert.rejects(inspect({ id: 'job', conversationId: 'chat' })); assert.equal(calls.length, 0);
  error = Object.assign(new Error('synthetic'), { outcome: 'rejected', reason: { kind: 'thread_archived', threadId: 'thread' } });
  await inspect({ id: 'job', conversationId: 'chat' }); assert.equal(calls[0].reason, 'thread_archived');
});
