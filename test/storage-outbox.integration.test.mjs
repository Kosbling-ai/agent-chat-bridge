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
    // Expired send leases are reclassified at most every 5 s.
    assert.deepEqual(await claim(), []);
    clock += 3900;
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

test('real MySQL outbox claim merges its pending and recent-unknown branches by created_at under one LIMIT', {
  skip: !process.env.BRIDGE_TEST_PASSWORD, timeout: 30000,
}, async () => {
  const pool = createPoolFromEnvironment(refs);
  await migrate(pool);
  const clock = 1_800_000_000_000;
  const { randomUUID } = await import('node:crypto');
  // Both branches have eligible rows at once: one pending, one uncertain send of
  // an eligible kind first attempted within the last 55 minutes.
  async function seed(connectionId, pendingCreatedAt, unknownCreatedAt) {
    const rows = [
      [randomUUID(), connectionId, 'chat', `${connectionId}:pending`, 'reply', '0'.repeat(64), '{}', randomUUID(), 'pending', null, clock - 1000, pendingCreatedAt, clock],
      [randomUUID(), connectionId, 'chat', `${connectionId}:unknown`, 'reply', '0'.repeat(64), '{}', randomUUID(), 'unknown', clock - 60_000, clock - 1000, unknownCreatedAt, clock],
    ];
    await pool.query(`INSERT INTO bridge_outbox (id,connection_id,conversation_id,idempotency_key,kind,payload_hash,payload,platform_uuid,status,first_attempt_at,next_attempt_at,created_at,updated_at) VALUES ?`, [rows]);
    return { pending: rows[0][0], unknown: rows[1][0] };
  }
  const stores = [];
  try {
    for (const [connectionId, pendingCreatedAt, unknownCreatedAt] of [['union-unknown-first', clock - 5000, clock - 9000], ['union-pending-first', clock - 9000, clock - 5000]]) {
      const ids = await seed(connectionId, pendingCreatedAt, unknownCreatedAt);
      const store = await createMysqlStore({ connectionId, pool, now: () => clock });
      stores.push(store);
      const order = pendingCreatedAt < unknownCreatedAt ? [ids.pending, ids.unknown] : [ids.unknown, ids.pending];
      const first = await store.claimOutbox({ owner: 'worker', limit: 1, leaseMs: 60_000 });
      assert.equal(first.length, 1, connectionId);
      assert.equal(first[0].id, order[0], connectionId);
      const second = await store.claimOutbox({ owner: 'worker', limit: 1, leaseMs: 60_000 });
      assert.deepEqual(second.map(row => row.id), [order[1]], connectionId);
      assert.deepEqual(await store.claimOutbox({ owner: 'worker', limit: 1, leaseMs: 60_000 }), []);
    }
    // With limit 2, both come back from one claim in created_at order.
    const ids = await seed('union-limit-two', clock - 9000, clock - 5000);
    const store = await createMysqlStore({ connectionId: 'union-limit-two', pool, now: () => clock });
    stores.push(store);
    assert.deepEqual((await store.claimOutbox({ owner: 'worker', limit: 2, leaseMs: 60_000 })).map(row => row.id), [ids.pending, ids.unknown]);
  } finally {
    // close() also ends the shared pool; close it once.
    if (stores.length) await stores[0].close(); else await pool.end();
  }
});
