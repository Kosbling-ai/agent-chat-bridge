import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
const refs = Object.fromEntries(['host','port','user','password','database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));
test('real MySQL guidance abandonment cancels only unknown guidance and preserves native facts', {
  skip: !process.env.BRIDGE_TEST_PASSWORD, timeout: 30000,
}, async () => {
  const pool = createPoolFromEnvironment(refs);
  await migrate(pool);
  const store = await createMysqlStore({ pool });
  let sequence = 0;
  const scope = { connectionId: 'guidance-recovery', conversationId: 'chat', agentId: 'codex' };
  async function job() {
    const added = await store.enqueueJob({ ...scope, kind: 'agent', idempotencyKey: String(++sequence), payload: {} });
    const [row] = await store.claimJobs({ kind: 'agent', owner: 'worker', leaseMs: 300000 });
    assert.equal(row.id, added.id);
    return row;
  }
  const request = (row, generation, key = row.id) => ({ runId: row.id, callerId: 'admin', idempotencyKey: key,
    expectedGeneration: generation, action: 'abandon_guidance_verified', evidence: 'Operator accepts uncertainty; no retry.' });
  try {
    const parent = await job();
    const attempt = await store.beginAgentAttempt({ ...parent, agentId: 'codex' });
    await store.bindAgentAttempt({ ...parent, expectedGeneration: attempt.generation, nativeThreadId: 'thread', nativeTurnId: 'turn' });
    const guidance = await job();
    await store.beginSteerAttempt({ ...guidance, agentId: 'codex' });
    await store.finishSteerAttempt({ ...guidance, outcome: 'unknown' });
    const before = await store.getSession(scope);
    await assert.rejects(store.enqueueRecovery(request(guidance, Number(attempt.generation) + 1)), { code: 'recovery_conflict' });
    assert.throws(() => store.enqueueRecovery({ ...request(guidance, attempt.generation), nativeThreadId: 'thread' }), { code: 'invalid_recovery' });
    const added = await store.enqueueRecovery(request(guidance, attempt.generation));
    assert.deepEqual(await store.enqueueRecovery(request(guidance, attempt.generation)), { id: added.id, duplicate: true });
    await assert.rejects(store.enqueueRecovery({ ...request(guidance, attempt.generation), evidence: 'Changed' }), { code: 'recovery_conflict' });
    const [lease] = await store.claimRecoveries({ owner: 'admin-worker', leaseMs: 300000 });
    await assert.rejects(store.finishRecovery({ ...lease, leaseToken: 'stale', outcome: 'applied' }), { code: 'stale_lease' });
    await store.finishRecovery({ ...lease, outcome: 'applied' });
    assert.deepEqual(await store.finishRecovery({ ...lease, outcome: 'applied' }), { status: 'applied' });
    assert.equal((await store.getJob({ id: guidance.id })).status, 'cancelled');
    assert.equal((await store.getSteerAttempt({ id: guidance.id })).status, 'unknown');
    assert.deepEqual(await store.getSession(scope), before);
    assert.equal((await store.getJob({ id: parent.id })).status, 'running');
    assert.deepEqual(await store.getConversationActivity(scope), { activeRunId: parent.id, unresolvedGuidance: false });
    assert.equal('evidence' in await store.getRecovery({ id: added.id }), false);
    assert.deepEqual(await store.claimJobs({ kind: 'agent', owner: 'worker', leaseMs: 300000 }), []);
    // The retained provider-unknown fact still prevents another steer to this same parent.
    const blocked = await job();
    assert.deepEqual(await store.beginSteerAttempt({ ...blocked, agentId: 'codex' }), { kind: 'inactive' });
    await store.finishJobWithOutbox(parent);
    const next = await store.beginAgentAttempt({ ...blocked, agentId: 'codex' });
    await store.bindAgentAttempt({ ...blocked, expectedGeneration: next.generation, nativeThreadId: 'thread', nativeTurnId: 'next-turn' });
    // Accepted guidance is never a cancellation target.
    const accepted = await job();
    await store.beginSteerAttempt({ ...accepted, agentId: 'codex' });
    await store.finishSteerAttempt({ ...accepted, outcome: 'accepted' });
    await assert.rejects(store.enqueueRecovery(request(accepted, attempt.generation)), { code: 'recovery_conflict' });
    const late = await job();
    await store.beginSteerAttempt({ ...late, agentId: 'codex' });
    await store.finishSteerAttempt({ ...late, outcome: 'unknown' });
    await store.finishJobWithOutbox(blocked);
    await store.enqueueRecovery(request(late, attempt.generation));
    const [lateLease] = await store.claimRecoveries({ owner: 'admin-worker', leaseMs: 300000 });
    await store.finishRecovery({ ...lateLease, outcome: 'applied' });
    assert.deepEqual(await store.getConversationActivity(scope), { activeRunId: null, unresolvedGuidance: false });
    assert.equal((await store.getJob({ id: parent.id })).status, 'succeeded');
  } finally { await store.close(); }
});
