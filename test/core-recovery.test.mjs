import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryHandler } from '../src/core/recovery.mjs';
const action = { id: 'action', runId: 'run', conversationId: 'chat', expectedGeneration: 1, leaseToken: 'lease', action: 'adopt_turn', nativeThreadId: 'thread', nativeTurnId: 'turn' };
const attempt = { connectionId: 'fixture', conversationId: 'chat', status: 'unknown', generation: 1 };
test('recovery read rejection retains the leased action and never falsely terminalizes original work', async () => {
  const writes = [], logs = [];
  const handler = createRecoveryHandler({ workspace: '/workspace', connectionId: 'fixture', store: { getAgentAttempt: async () => attempt, finishRecovery: async value => writes.push(value) }, codex: { readThread: async () => { throw Object.assign(new Error('SYNTHETIC_PROVIDER_SECRET'), { outcome: 'rejected' }); } }, log: (...row) => logs.push(row) });
  await handler(action);
  assert.equal(writes.length, 0);
  assert(logs.some(row => row[3]?.code === 'recovery_read_unavailable'));
  assert(!JSON.stringify(logs).includes('SYNTHETIC_PROVIDER_SECRET'));
});
test('lost management COMMIT response observes applied state instead of contradictory rejection', async () => {
  const writes = [], logs = [];
  const handler = createRecoveryHandler({ workspace: '/workspace', connectionId: 'fixture', store: { getAgentAttempt: async () => attempt, finishRecovery: async value => { writes.push(value); throw Object.assign(new Error('synthetic'), { code: 'commit_unknown' }); }, getRecovery: async () => ({ status: 'applied' }) }, codex: { readThread: async () => ({ thread: { id: 'thread', cwd: '/workspace', turns: [{ id: 'turn', status: 'completed' }] } }) }, log: (...entry) => logs.push(entry) });
  await handler(action);
  assert.equal(writes.length, 1); assert.equal(writes[0].outcome, 'applied');
  assert(logs.some(entry => entry[2] === 'succeeded' && entry[3]?.code === 'recovery_commit_confirmed'));
});
test('verified guidance abandonment validates durable identity without native RPC or native attempt reads', async () => {
  for (const valid of [true, false]) {
    const writes = [];
    const handler = createRecoveryHandler({ workspace: '/workspace', connectionId: 'fixture', store: { getSteerAttempt: async () => ({ ...attempt, conversationId: valid ? 'chat' : 'other' }), finishRecovery: async input => writes.push(input) }, codex: {} });
    await handler({ ...action, action: 'abandon_guidance_verified', nativeThreadId: undefined, nativeTurnId: undefined });
    assert.equal(writes.length, 1); assert.equal(writes[0].outcome, valid ? 'applied' : 'rejected');
  }
});
