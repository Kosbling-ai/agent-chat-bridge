import test from 'node:test';
import assert from 'node:assert/strict';
import { createSteeringHandler } from '../src/core/steering.mjs';
const job = { id: 'guidance', leaseToken: 'lease' };
test('steer sends only a new durable intent and records explicit rejection or unknown separately', async () => {
  for (const mode of ['accepted', 'rejected', 'unknown', 'recovery_required']) {
    const writes = [], calls = [];
    const handler = createSteeringHandler({ store: { beginSteerAttempt: async () => ({ kind: mode === 'recovery_required' ? mode : 'new', nativeThreadId: 'thread', nativeTurnId: 'turn', clientMessageId: 'guidance' }), finishSteerAttempt: async input => writes.push(input) },
      codex: { steerTurn: async input => { calls.push(input); if (mode !== 'accepted') throw Object.assign(new Error('SYNTHETIC'), { outcome: mode }); } } });
    assert.equal(await handler(job, 'guidance'), true);
    assert.equal(calls.length, mode === 'recovery_required' ? 0 : 1);
    assert.equal(writes[0].outcome, mode === 'recovery_required' ? 'unknown' : mode);
    if (calls.length) assert.deepEqual(calls[0], { threadId: 'thread', expectedTurnId: 'turn', input: [{ type: 'text', text: 'guidance' }], clientUserMessageId: 'guidance' });
  }
});
test('disabling steering does not replay an unresolved earlier steering intent as a new turn', async () => {
  let calls = 0, outcome;
  const handler = createSteeringHandler({ enabled: false, store: { getSteerAttempt: async () => ({ status: 'intent' }), beginSteerAttempt: async () => ({ kind: 'recovery_required' }), finishSteerAttempt: async input => { outcome = input.outcome; } }, codex: { steerTurn: async () => { calls++; } } });
  assert(await handler(job, 'guidance')); assert.equal(calls, 0); assert.equal(outcome, 'unknown');
});
test('accepted steering COMMIT loss is read back without contradicting the recorded outcome', async () => {
  let writes = 0;
  const handler = createSteeringHandler({ store: { beginSteerAttempt: async () => ({ kind: 'new' }), finishSteerAttempt: async () => { writes++; throw new Error('synthetic lost commit'); }, getSteerAttempt: async () => ({ status: 'accepted' }) }, codex: { steerTurn: async () => ({}) } });
  assert(await handler(job, 'guidance')); assert.equal(writes, 1);
});
