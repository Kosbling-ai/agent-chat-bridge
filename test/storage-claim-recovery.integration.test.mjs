import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';

const enabled = Boolean(process.env.BRIDGE_TEST_PASSWORD);
const refs = Object.fromEntries(['host','port','user','password','database']
  .map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));

function loseNextCommitAcknowledgement(pool, { failReadback = false } = {}) {
  const originalGetConnection = pool.getConnection.bind(pool);
  let acquisition = 0;
  pool.getConnection = async () => {
    const connection = await originalGetConnection();
    acquisition += 1;
    if (acquisition === 1) {
      const commit = connection.commit.bind(connection);
      connection.commit = async () => {
        connection.commit = commit;
        await commit();
        throw Object.assign(new Error('synthetic lost commit acknowledgement'), {
          code: 'PROTOCOL_CONNECTION_LOST', errno: 2013, sqlState: 'HY000',
        });
      };
    } else if (acquisition === 2 && failReadback) {
      const execute = connection.execute.bind(connection);
      connection.execute = async (sql, params) => {
        if (/SELECT \* FROM bridge_outbox/.test(sql)) {
          connection.execute = execute;
          throw Object.assign(new Error('synthetic readback failure'), { code: 'PROTOCOL_CONNECTION_LOST' });
        }
        return execute(sql, params);
      };
    }
    return connection;
  };
  return () => { pool.getConnection = originalGetConnection; };
}

function failNextCommitBeforeExecution(pool) {
  const originalGetConnection = pool.getConnection.bind(pool);
  let intercepted = false;
  pool.getConnection = async () => {
    const connection = await originalGetConnection();
    if (!intercepted) {
      intercepted = true;
      const commit = connection.commit.bind(connection);
      connection.commit = async () => {
        connection.commit = commit;
        throw Object.assign(new Error('synthetic pre-commit disconnect'), {
          code: 'ECONNRESET', errno: 54, sqlState: 'HY000',
        });
      };
    }
    return connection;
  };
  return () => { pool.getConnection = originalGetConnection; };
}

function delayNextSuccessfulCommitAcknowledgement(pool, delayMs) {
  const originalGetConnection = pool.getConnection.bind(pool);
  let intercepted = false;
  pool.getConnection = async () => {
    const connection = await originalGetConnection();
    if (!intercepted) {
      intercepted = true;
      const commit = connection.commit.bind(connection);
      connection.commit = async () => {
        connection.commit = commit;
        await commit();
        await new Promise(resolve => setTimeout(resolve, delayMs));
      };
    }
    return connection;
  };
  return () => { pool.getConnection = originalGetConnection; };
}

test('real MySQL recovers committed claims by stable lease token and retains failed outbox readback',
  { skip: !enabled, timeout: 30_000 }, async () => {
    const pool = createPoolFromEnvironment(refs);
    await migrate(pool);
    const logs = [];
    const store = await createMysqlStore({ pool, connectionId: 'claim-recovery', claimTimeoutMs: 1000,
      log: (...entry) => logs.push(entry) });
    try {
      const hook = await store.enqueueJob({ kind: 'hook', connectionId: 'claim-recovery', conversationId: 'chat',
        hookId: 'hook', idempotencyKey: 'hook-job', payload: { event: 'fixture' } });
      let restore = loseNextCommitAcknowledgement(pool);
      const [claimedHook] = await store.claimJobs({ kind: 'hook', owner: 'hook-worker', limit: 1, leaseMs: 10_000 });
      restore();
      assert.equal(claimedHook.id, hook.id);
      assert.equal(claimedHook.attempts, 1);
      const [[hookRow]] = await pool.query('SELECT attempts,lease_owner,lease_token FROM bridge_jobs WHERE id=?', [hook.id]);
      assert.equal(hookRow.attempts, 1);
      assert.equal(hookRow.lease_owner, 'hook-worker');
      assert.equal(hookRow.lease_token, claimedHook.leaseToken);
      assert.deepEqual(await store.claimJobs({ kind: 'hook', owner: 'other-hook-worker', limit: 1, leaseMs: 10_000 }), []);
      await store.finishJobWithOutbox({ id: claimedHook.id, leaseToken: claimedHook.leaseToken });

      const timedHook = await store.enqueueJob({ kind: 'hook', connectionId: 'claim-recovery', conversationId: 'timed-chat',
        hookId: 'hook', idempotencyKey: 'timed-hook-job', payload: { event: 'timer-fixture' } });
      restore = delayNextSuccessfulCommitAcknowledgement(pool, 1200);
      const [timedClaim] = await store.claimJobs({ kind: 'hook', owner: 'timed-hook-worker', limit: 1, leaseMs: 10_000 });
      restore();
      assert.equal(timedClaim.id, timedHook.id);
      assert.equal(timedClaim.attempts, 1);
      const [[timedRow]] = await pool.query('SELECT attempts,lease_owner,lease_token FROM bridge_jobs WHERE id=?', [timedHook.id]);
      assert.equal(timedRow.attempts, 1);
      assert.equal(timedRow.lease_owner, 'timed-hook-worker');
      assert.equal(timedRow.lease_token, timedClaim.leaseToken);
      await store.finishJobWithOutbox({ id: timedClaim.id, leaseToken: timedClaim.leaseToken });

      const reaction = await store.recordOutbox({ connectionId: 'claim-recovery', conversationId: 'chat',
        idempotencyKey: 'non-idempotent-reaction', kind: 'reaction', payload: { emoji: 'OK' } });
      restore = loseNextCommitAcknowledgement(pool, { failReadback: true });
      await assert.rejects(store.claimOutbox({ owner: 'outbox-worker', limit: 1, leaseMs: 10_000 }),
        { code: 'store_unavailable' });
      restore();
      const [[pendingReadback]] = await pool.query('SELECT status,attempts,lease_owner,lease_token FROM bridge_outbox WHERE id=?', [reaction.id]);
      assert.equal(pendingReadback.status, 'running');
      assert.equal(pendingReadback.attempts, 1);
      assert.equal(pendingReadback.lease_owner, 'outbox-worker');
      assert.ok(pendingReadback.lease_token);
      assert.deepEqual(await store.claimOutbox({ owner: 'other-outbox-worker', limit: 1, leaseMs: 10_000 }), []);

      // The next poll resolves the retained claim before running a fresh claim
      // transaction, so a non-idempotent effect is neither lost nor re-claimed.
      const [claimedReaction] = await store.claimOutbox({ owner: 'outbox-worker', limit: 1, leaseMs: 10_000 });
      assert.equal(claimedReaction.id, reaction.id);
      assert.equal(claimedReaction.leaseToken, pendingReadback.lease_token);
      assert.equal(claimedReaction.attempts, 1);
      await store.settleOutbox({ id: claimedReaction.id, leaseToken: claimedReaction.leaseToken, status: 'sent' });

      const expiring = await store.recordOutbox({ connectionId: 'claim-recovery', conversationId: 'chat',
        idempotencyKey: 'expired-reaction', kind: 'reaction', payload: { emoji: 'DONE' } });
      restore = loseNextCommitAcknowledgement(pool, { failReadback: true });
      await assert.rejects(store.claimOutbox({ owner: 'expiring-worker', limit: 1, leaseMs: 100 }),
        { code: 'store_unavailable' });
      restore();
      await new Promise(resolve => setTimeout(resolve, 180));
      assert.deepEqual(await store.claimOutbox({ owner: 'expiring-worker', limit: 1, leaseMs: 100 }), []);
      const [[expiredRow]] = await pool.query('SELECT status,attempts,lease_token FROM bridge_outbox WHERE id=?', [expiring.id]);
      assert.equal(expiredRow.status, 'unknown');
      assert.equal(expiredRow.attempts, 1);
      assert.equal(expiredRow.lease_token, null);

      const recovered = logs.filter(([, operation, status]) => operation === 'storage_claim_recovery' && status === 'recovered');
      assert.equal(recovered.length, 3);
      const driverLosses = recovered.filter(([, , , fields]) => fields.reason === 'commit_error');
      assert.equal(driverLosses.length, 2);
      assert.ok(driverLosses.every(([, , , fields]) => fields.code === 'commit_unknown'
        && fields.reason === 'commit_error' && fields.errorCode === 'PROTOCOL_CONNECTION_LOST'
        && fields.errno === 2013 && fields.sqlState === 'HY000'));
      assert.ok(recovered.some(([, , , fields]) => fields.code === 'commit_unknown'
        && fields.reason === 'commit_timeout' && fields.errorCode === undefined));
    } finally {
      await store.close();
    }
  });

test('real MySQL confirmed pre-commit failure consumes the runtime retry rather than recursing',
  { skip: !enabled, timeout: 30_000 }, async () => {
    const pool = createPoolFromEnvironment(refs);
    await migrate(pool);
    const logs = [];
    const store = await createMysqlStore({ pool, connectionId: 'claim-rollback', claimTimeoutMs: 1000,
      log: (...entry) => logs.push(entry) });
    try {
      const job = await store.enqueueJob({ kind: 'hook', connectionId: 'claim-rollback', conversationId: 'chat',
        hookId: 'hook', idempotencyKey: 'rolled-back-claim', payload: {} });
      const restore = failNextCommitBeforeExecution(pool);
      await assert.rejects(store.claimJobs({ kind: 'hook', owner: 'rollback-worker', limit: 1, leaseMs: 10_000 }),
        { code: 'commit_unknown', reason: 'commit_error', errorCode: 'ECONNRESET' });
      restore();
      const [[rolledBack]] = await pool.query('SELECT status,attempts,lease_token FROM bridge_jobs WHERE id=?', [job.id]);
      assert.equal(rolledBack.status, 'pending');
      assert.equal(rolledBack.attempts, 0);
      assert.equal(rolledBack.lease_token, null);
      assert.ok(logs.some(([, operation, status, fields]) => operation === 'storage_claim_recovery'
        && status === 'not_committed' && fields.errorCode === 'ECONNRESET'));

      const [claimed] = await store.claimJobs({ kind: 'hook', owner: 'rollback-worker', limit: 1, leaseMs: 10_000 });
      assert.equal(claimed.id, job.id);
      assert.equal(claimed.attempts, 1);
      await store.finishJobWithOutbox({ id: claimed.id, leaseToken: claimed.leaseToken });
    } finally {
      await store.close();
    }
  });

test('real MySQL claim deadline is independent from the shorter general storage deadline',
  { skip: !enabled, timeout: 30_000 }, async () => {
    const pool = createPoolFromEnvironment(refs);
    await migrate(pool);
    const store = await createMysqlStore({ pool, connectionId: 'claim-deadline', operationTimeoutMs: 100,
      claimTimeoutMs: 1000 });
    try {
      const job = await store.enqueueJob({ kind: 'hook', connectionId: 'claim-deadline', conversationId: 'chat',
        hookId: 'hook', idempotencyKey: 'delayed-claim', payload: {} });
      const originalGetConnection = pool.getConnection.bind(pool);
      let intercepted = false;
      pool.getConnection = async () => {
        const connection = await originalGetConnection();
        if (!intercepted) {
          intercepted = true;
          const commit = connection.commit.bind(connection);
          connection.commit = async () => {
            connection.commit = commit;
            await new Promise(resolve => setTimeout(resolve, 200));
            return commit();
          };
        }
        return connection;
      };
      const [claimed] = await store.claimJobs({ kind: 'hook', owner: 'slow-commit-worker', limit: 1, leaseMs: 10_000 });
      pool.getConnection = originalGetConnection;
      assert.equal(claimed.id, job.id);
      assert.equal(claimed.attempts, 1);
      await store.finishJobWithOutbox({ id: claimed.id, leaseToken: claimed.leaseToken });
    } finally {
      await store.close();
    }
  });
