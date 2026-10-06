import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import { withConnection } from '../src/storage/connection.mjs';
import { configureStorageDiagnosticRecorder } from '../src/storage/diagnostics.mjs';

const never = () => new Promise(() => {});

function fixture({ acquire, query, beginTransaction, commit, rollback, threadId = 41 } = {}) {
  let destroyed = 0;
  let released = 0;
  const connection = {
    threadId,
    query: query ?? (async () => {}),
    beginTransaction: beginTransaction ?? (async () => {}),
    commit: commit ?? (async () => {}),
    rollback: rollback ?? (async () => {}),
    destroy: () => { destroyed++; },
    release: () => { released++; },
  };
  const pool = { getConnection: acquire ?? (async () => connection) };
  return { pool, connection, counts: () => ({ destroyed, released }) };
}

function capture(pool) {
  const events = [];
  const detach = configureStorageDiagnosticRecorder(pool, event => events.push(event));
  return { events, detach };
}

function assertTimingShape(event, timeoutMs) {
  for (const field of ['poolWaitMs', 'setupMs', 'beginMs', 'operationMs', 'commitMs',
    'rollbackMs', 'durationMs', 'timeoutOvershootMs']) {
    assert.equal(typeof event[field], 'number', `${field} must be numeric`);
    assert.equal(Number.isSafeInteger(event[field]), true, `${field} must be a safe integer`);
    assert.ok(event[field] >= 0, `${field} must be non-negative`);
  }
  assert.equal(event.timeoutMs, timeoutMs);
  assert.match(event.operationId, /^[0-9a-f-]{36}$/);
}

test('quick successful operations do not emit diagnostics', async () => {
  const f = fixture();
  const recorded = capture(f.pool);
  assert.equal(await withConnection(f.pool, async () => 'ok'), 'ok');
  assert.deepEqual(recorded.events, []);
  assert.deepEqual(f.counts(), { destroyed: 0, released: 1 });
  recorded.detach();
});

test('successful operations taking at least 500ms emit one slow event', async () => {
  const f = fixture();
  const recorded = capture(f.pool);
  assert.equal(await withConnection(f.pool, async () => { await delay(510); return 'ok'; }, { timeoutMs: 1000 }), 'ok');
  assert.equal(recorded.events.length, 1);
  const event = recorded.events[0];
  assert.equal(event.code, 'storage_operation_slow');
  assert.equal(event.status, 'slow');
  assert.equal(event.stage, 'operation');
  assert.equal(event.transaction, false);
  assert.equal(event.dbConnectionId, 41);
  assert.equal(event.errorClass, undefined);
  assert.ok(event.operationMs >= 500);
  assert.ok(event.durationMs >= 500);
  assertTimingShape(event, 1000);
  recorded.detach();
});

for (const scenario of [
  { stage: 'acquire', options: {}, fixture: () => fixture({ acquire: never }), operation: async () => {} },
  { stage: 'setup', options: {}, fixture: () => fixture({ query: never }), operation: async () => {} },
  { stage: 'begin', options: { transaction: true }, fixture: () => fixture({ beginTransaction: never }), operation: async () => {} },
  { stage: 'operation', options: {}, fixture: () => fixture(), operation: never },
  { stage: 'commit', options: { transaction: true }, fixture: () => fixture({ commit: never }), operation: async () => {} },
  { stage: 'rollback', options: { transaction: true }, fixture: () => fixture({ rollback: never }),
    operation: async () => { throw Object.assign(new Error('hidden'), { code: 'ECONNRESET' }); } },
]) {
  test(`${scenario.stage} timeout emits one immediate failed diagnostic`, async () => {
    const f = scenario.fixture();
    const recorded = capture(f.pool);
    const timeoutMs = 20;
    const expectedCode = scenario.stage === 'commit' ? 'commit_unknown' : 'store_timeout';
    await assert.rejects(withConnection(f.pool, scenario.operation, { ...scenario.options, timeoutMs }), { code: expectedCode });
    assert.equal(recorded.events.length, 1);
    const event = recorded.events[0];
    assert.equal(event.code, 'storage_operation_failed');
    assert.equal(event.status, 'failed');
    assert.equal(event.stage, scenario.stage);
    assert.equal(event.transaction, scenario.options.transaction === true);
    assert.equal(event.errorClass, expectedCode);
    assert.equal(event.reason, scenario.stage === 'commit' ? 'commit_timeout' : 'operation_timeout');
    assert.ok(event.durationMs >= timeoutMs - 2);
    assertTimingShape(event, timeoutMs);
    recorded.detach();
  });
}

test('lost commit acknowledgement records only normalized safe error fields', async () => {
  const f = fixture({ commit: async () => { throw Object.assign(new Error('secret SQL and password'), {
    code: 'ECONNRESET', errno: 104, sqlState: 'HY000', sql: 'private statement', stack: 'private stack',
  }); } });
  const recorded = capture(f.pool);
  await assert.rejects(withConnection(f.pool, async () => {}, { transaction: true }), {
    code: 'commit_unknown', reason: 'commit_error',
  });
  assert.equal(recorded.events.length, 1);
  const event = recorded.events[0];
  assert.equal(event.stage, 'commit');
  assert.equal(event.errorClass, 'commit_unknown');
  assert.equal(event.reason, 'commit_error');
  assert.equal(event.errorCode, 'ECONNRESET');
  assert.equal(event.errno, 104);
  assert.equal(event.sqlState, 'HY000');
  assert.equal(JSON.stringify(event).includes('secret'), false);
  assert.equal(event.sql, undefined);
  assert.equal(event.stack, undefined);
  assert.equal(event.timeoutOvershootMs, 0);
  assert.deepEqual(f.counts(), { destroyed: 1, released: 0 });
  assertTimingShape(event, 1800);
  recorded.detach();
});

test('completed rollback timing retains the stage of the original failure', async () => {
  const f = fixture({ rollback: async () => { await delay(5); } });
  const recorded = capture(f.pool);
  await assert.rejects(withConnection(f.pool, async () => {
    throw Object.assign(new Error('private query'), { code: 'ER_LOCK_DEADLOCK', errno: 1213, sqlState: '40001' });
  }, { transaction: true }), { code: 'store_contention' });
  assert.equal(recorded.events.length, 1);
  const event = recorded.events[0];
  assert.equal(event.stage, 'operation');
  assert.equal(event.errorClass, 'store_contention');
  assert.ok(event.rollbackMs >= 4);
  assert.equal(event.timeoutOvershootMs, 0);
  assertTimingShape(event, 1800);
  recorded.detach();
});

test('late acquisition is destroyed and cannot emit a second diagnostic', async () => {
  let completeAcquire;
  const acquisition = new Promise(resolve => { completeAcquire = resolve; });
  const f = fixture({ acquire: () => acquisition });
  const recorded = capture(f.pool);
  await assert.rejects(withConnection(f.pool, async () => {}, { timeoutMs: 20 }), { code: 'store_timeout' });
  assert.equal(recorded.events.length, 1);
  completeAcquire(f.connection);
  await nextTurn();
  assert.equal(recorded.events.length, 1);
  assert.deepEqual(f.counts(), { destroyed: 1, released: 0 });
  recorded.detach();
});
