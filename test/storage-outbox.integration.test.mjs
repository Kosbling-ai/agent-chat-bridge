import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';

const refs = Object.fromEntries(['host','port','user','password','database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));
test('real MySQL multipart order survives concurrent claims, restart, unknown and terminal failure', {
  skip: !process.env.BRIDGE_TEST_PASSWORD, timeout: 30000,
}, async () => {
  let pool = createPoolFromEnvironment(refs);
  await migrate(pool);
  let clock = Date.now();
  let store = await createMysqlStore({connectionId:'multipart', pool, now: () => clock });
  const claim = () => store.claimOutbox({ owner: 'worker', limit: 100, leaseMs: 1000 });
  async function completedJob(key) {
    const registered = await store.enqueueJob({
      kind: 'agent', connectionId: 'multipart', conversationId: key, idempotencyKey: key, payload: {},
    });
    const [job] = await store.claimJobs({ kind: 'agent', owner: 'model', leaseMs: 1000 });
    assert.equal(job.id, registered.id);
    const result = await store.finishJobWithOutbox({ id: job.id, leaseToken: job.leaseToken, result: { modelCompleted: true }, outbox: [
      { idempotencyKey: `${key}:1`, kind: 'reply', payload: { text: 'first' } },
      { idempotencyKey: `${key}:2`, kind: 'reply', payload: { text: 'second' } },
      { idempotencyKey: `${key}:3`, kind: 'reply', payload: { text: 'third' } },
    ] });
    assert.equal(result.outbox[0].predecessorId, null);
    assert.equal(result.outbox[1].predecessorId, result.outbox[0].id);
    assert.equal(result.outbox[2].predecessorId, result.outbox[1].id);
    return { id: job.id, effects: result.outbox };
  }
  try {
    const one = await completedJob('one');
    const two = await completedJob('two');
    // Both jobs can progress, but no later part may bypass its own first send.
    const claimed = (await Promise.all([claim(), claim()])).flat();
    assert.deepEqual(claimed.map(row => row.id).sort(), [one.effects[0].id, two.effects[0].id].sort());
    assert.deepEqual(await claim(), []);
    const first = claimed.find(row => row.id === one.effects[0].id);
    const failed = claimed.find(row => row.id === two.effects[0].id);
    await store.settleOutbox({ id: failed.id, leaseToken: failed.leaseToken, status: 'failed', errorCode: 'delivery_rejected' });
    assert.equal((await store.getJob({ id: two.id })).status, 'delivery_failed');
    assert.deepEqual(await store.claimJobs({ kind: 'agent', owner: 'model', leaseMs: 1000 }), []);
    const blocked = await store.getOutbox({ id: two.effects[1].id });
    assert.equal(blocked.status, 'pending');
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.predecessorStatus, 'failed');

    // Process restart while the first send is unresolved: only the same UUID
    // can be reclaimed after expiry, never the second or third part.
    await store.close();
    pool = createPoolFromEnvironment(refs);
    store = await createMysqlStore({connectionId:'multipart', pool, now: () => clock });
    assert.deepEqual(await claim(), []);
    clock += 1100;
    const [retried] = await claim();
    assert.equal(retried.id, first.id);
    assert.equal(retried.platformUuid, first.platformUuid);
    assert.deepEqual(await claim(), []);
    await store.settleOutbox({ id: retried.id, leaseToken: retried.leaseToken, status: 'unknown' });
    const [retryAgain] = await claim();
    assert.equal(retryAgain.id, first.id);
    await store.settleOutbox({ id: retryAgain.id, leaseToken: retryAgain.leaseToken, status: 'sent' });
    for (const effect of one.effects.slice(1)) {
      const [part] = await claim();
      assert.equal(part.id, effect.id);
      assert.deepEqual(await claim(), []);
      await store.settleOutbox({ id: part.id, leaseToken: part.leaseToken, status: 'sent' });
    }
    assert.equal((await store.getJob({ id: one.id })).status, 'succeeded');
    assert.equal((await store.getJob({ id: two.id })).status, 'delivery_failed');
    assert.deepEqual(await claim(), []);
  } finally { await store.close(); }
});
