import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
import { createRuntime } from '../src/core/runtime.mjs';
const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));
async function until(read, predicate) { for (let i = 0; i < 250; i++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('steering_timeout'); }
test('active guidance shares one final reply, rejected guidance defers, unknown guidance never replays', { skip: !process.env.BRIDGE_TEST_PASSWORD, timeout: 20000 }, async () => {
  const pool = createPoolFromEnvironment(refs); let store, runtime, mode = 'accepted', starts = 0, turnCalls = 0, steerCalls = 0;
  const sent = [], turns = new Map();
  const config = { feishu: { connectionId: 'steer-fixture', botOpenId: 'bot' }, routing: { version: '1', privateUserIds: [], groups: [] }, hooks: [] };
  async function complete(threadId) { const turn = turns.get(threadId); turn.status = 'completed'; turn.items = [{ type: 'agentMessage', text: 'parent final' }]; await runtime.notification({ method: 'turn/completed', params: { threadId, turn } }); }
  const codex = { status: () => ({ state: 'ready' }), startThread: async () => ({ thread: { id: `thread-${++starts}` } }), resumeThread: async ({ threadId }) => ({ thread: { id: threadId } }), readThread: async ({ threadId }) => ({ thread: { turns: [turns.get(threadId)] } }), async startTurn({ threadId, input }) {
    turnCalls++; const turn = { id: `turn-${turnCalls}`, status: 'inProgress', items: [] }; turns.set(threadId, turn);
    if (input[0].text === 'deferred-guidance') await complete(threadId);
    return { turn: { id: turn.id, status: 'inProgress' } };
  }, async steerTurn({ threadId, expectedTurnId }) {
    steerCalls++; assert.equal(expectedTurnId, turns.get(threadId).id);
    if (mode !== 'accepted') throw Object.assign(new Error('synthetic'), { outcome: mode });
    await complete(threadId); // Parent can complete before the steer RPC response.
    return { turnId: expectedTurnId };
  } };
  const chat = { sendMessage: async input => { sent.push(input); return { message_id: `message-${sent.length}` }; } };
  const enqueue = (conversationId, text) => store.enqueueJob({ connectionId: config.feishu.connectionId, conversationId, kind: 'agent', idempotencyKey: text, payload: { source: 'api', text } });
  try {
    await migrate(pool); store = await createMysqlStore({ pool });
    runtime = createRuntime({ config, store, codex, chat }); runtime.start();
    const first = await enqueue('accepted-chat', 'first-parent');
    await until(() => store.getAgentAttempt({ id: first.id }), row => row?.nativeTurnId);
    const guidance = await enqueue('accepted-chat', 'first-guidance');
    const accepted = await until(() => store.getJob({ id: guidance.id }), row => row.status === 'succeeded');
    assert.equal(accepted.result.targetRunId, first.id);
    await until(() => store.getJob({ id: first.id }), row => row.status === 'succeeded');
    assert.equal(turnCalls, 1); assert.equal(steerCalls, 1); assert.equal(sent.length, 1);
    const [[effects]] = await pool.execute('SELECT COUNT(*) AS count FROM bridge_outbox WHERE job_id=?', [guidance.id]); assert.equal(Number(effects.count), 0);
    mode = 'rejected';
    const second = await enqueue('deferred-chat', 'second-parent');
    const parentAttempt = await until(() => store.getAgentAttempt({ id: second.id }), row => row?.nativeTurnId);
    const deferred = await enqueue('deferred-chat', 'deferred-guidance');
    await until(() => store.getSteerAttempt({ id: deferred.id }), row => row?.status === 'rejected');
    await complete(parentAttempt.nativeThreadId);
    await until(() => store.getJob({ id: deferred.id }), row => row.status === 'succeeded');
    assert.equal(turnCalls, 3); assert.equal(steerCalls, 2, 'rejected target cannot be steered repeatedly');
    mode = 'unknown';
    const third = await enqueue('unknown-chat', 'third-parent');
    const thirdAttempt = await until(() => store.getAgentAttempt({ id: third.id }), row => row?.nativeTurnId);
    const unknown = await enqueue('unknown-chat', 'unknown-guidance');
    await until(() => store.getJob({ id: unknown.id }), row => row.status === 'unknown');
    await complete(thirdAttempt.nativeThreadId);
    await until(() => store.getJob({ id: third.id }), row => row.status === 'succeeded');
    await runtime.stop();
    runtime = createRuntime({ config: { ...config, codex: { steering: false } }, store, codex, chat }); runtime.start();
    assert.equal((await store.getJob({ id: unknown.id })).status, 'unknown');
    assert.equal(turnCalls, 4); assert.equal(steerCalls, 3);
    assert(runtime.status().running);
  } finally { await runtime?.stop(); if (store) await store.close(); else await pool.end(); }
});
