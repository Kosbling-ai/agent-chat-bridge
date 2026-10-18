import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createMysqlStore } from '../src/storage/store.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';

// 0.2.29 idle tick (claimJobs + claimOutbox), measured from its code:
// SET, BEGIN, SELECT j.*, COMMIT + SET, BEGIN, UPDATE (lease expiry), SELECT j.*, COMMIT,
// i.e. 9 round trips and 2 transactions, repeated every 100 ms (~600 ticks/min).
const BEFORE = { statementsPerTick: 9, transactionsPerTick: 2, ticksPerIdleMinute: 600 };

async function migrationRows() {
  return Promise.all(['001-initial', '002-codex-sessions', '003-forward-runtime', '004-bot-connection', '005-sender-union-id', '006-query-indexes']
    .map(async (name, index) => ({ version: index + 1, checksum: createHash('sha256')
      .update(await readFile(new URL(`../src/storage/migrations/${name}.sql`, import.meta.url), 'utf8')).digest('hex') })));
}

test('an idle claim tick sends fewer statements and no wide row metadata', async () => {
  const migrations = await migrationRows();
  const log = [];
  let transactions = 0;
  const connection = {
    async query(sql) { log.push(sql); return sql.startsWith('SELECT version') ? [migrations] : [[]]; },
    async execute(sql) { log.push(sql); return sql.startsWith('UPDATE') ? [{ affectedRows: 0 }] : [[]]; },
    async beginTransaction() { transactions += 1; log.push('BEGIN'); },
    async commit() { log.push('COMMIT'); },
    async rollback() {}, release() {}, destroy() {},
  };
  let clock = 1_000_000;
  const store = await createMysqlStore({ pool: { async getConnection() { return connection; } }, connectionId: 'bot', now: () => clock });
  const tick = async () => {
    log.length = 0; transactions = 0;
    assert.deepEqual(await store.claimJobs({ kind: 'hook', owner: 'worker', leaseMs: 60_000, limit: 1 }), []);
    assert.deepEqual(await store.claimOutbox({ owner: 'worker', leaseMs: 60_000, limit: 1 }), []);
    return { statements: log.length, transactions, sql: [...log] };
  };
  const first = await tick();
  // The first tick also reclassifies expired send leases.
  assert.deepEqual(first.sql.map(sql => sql.split(/[\s(]/).filter(Boolean)[0]), ['BEGIN', 'SELECT', 'COMMIT', 'BEGIN', 'UPDATE', 'SELECT', 'COMMIT']);
  clock += 1000;
  const idle = await tick();
  assert.deepEqual(idle.sql.map(sql => sql.split(/[\s(]/).filter(Boolean)[0]), ['BEGIN', 'SELECT', 'COMMIT', 'BEGIN', 'SELECT', 'COMMIT']);
  assert.equal(idle.statements, 6);
  assert.equal(idle.transactions, 2);
  assert.ok(idle.statements < BEFORE.statementsPerTick);
  assert.equal(idle.sql.some(sql => /SET SESSION/.test(sql)), false);
  // Only IDs (and the UNION sort key) are selected, never `SELECT j.*`.
  assert.equal(idle.sql.some(sql => /SELECT j\.\*/.test(sql)), false);
  assert.match(idle.sql[1], /^SELECT j\.id FROM bridge_jobs/);
  assert.match(idle.sql[4], /^\(SELECT j\.id,j\.created_at FROM bridge_outbox j[\s\S]*UNION ALL[\s\S]*FORCE INDEX \(outbox_unknown_recent\)/);
  // Lease expiry runs again once 5 s have passed.
  clock += 4000;
  assert.equal((await tick()).sql.filter(sql => sql.startsWith('UPDATE')).length, 1);
  clock += 4999;
  assert.equal((await tick()).sql.filter(sql => sql.startsWith('UPDATE')).length, 0);
});

test('an idle communication worker backs off to one claim tick per second', async () => {
  let clock = 0;
  let ticks = 0;
  let stopAt;
  const waits = [];
  let blocked = false;
  const runtime = createCommunicationRuntime({
    config: { feishu: { connectionId: 'fixture', botOpenId: 'bot' }, codex: {}, routing: { privateUserIds: [], groups: [] }, hooks: [] },
    chat: {}, now: () => clock,
    store: { async claimJobs() { ticks += 1; return []; }, async claimOutbox() { return []; } },
    wait: async milliseconds => {
      waits.push(milliseconds); clock += milliseconds;
      if (clock >= 60_000 && !blocked) { blocked = true; stopAt = ticks; await new Promise(() => {}); }
    },
  });
  runtime.start();
  while (!blocked) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(waits.slice(0, 6), [100, 200, 400, 800, 1000, 1000]);
  assert.ok(stopAt <= 64, `idle ticks per minute: ${stopAt}`);
  assert.ok(stopAt * 6 < BEFORE.ticksPerIdleMinute * BEFORE.statementsPerTick / 10);
  await runtime.stop();
});
