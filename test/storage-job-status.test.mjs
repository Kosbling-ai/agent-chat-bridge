import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { BLOCKING_HOOK_JOB_STATUSES, BRIDGE_JOB_STATUSES, TERMINAL_BRIDGE_JOB_STATUSES, createMysqlStore } from '../src/storage/store.mjs';

const storageDir = new URL('../src/storage/', import.meta.url);
async function storageSources() {
  const files = (await readdir(storageDir)).filter(name => name.endsWith('.mjs'));
  return Object.fromEntries(await Promise.all(files.map(async name => [name, await readFile(new URL(name, storageDir), 'utf8')])));
}

// The hook-ordering claim probes each non-terminal status by equality. That is
// equivalent to the former `status NOT IN ('succeeded','failed','cancelled')`
// only while BRIDGE_JOB_STATUSES lists every value the code can write. Adding a
// status, or a new status write, must update that list (and this audit).
test('bridge_jobs status writes stay within the statuses the hook claim probes', async () => {
  const sources = await storageSources();
  const all = Object.values(sources).join('\n');
  const literal = new Set([...all.matchAll(/UPDATE bridge_jobs SET status='([a-z_]+)'/g)].map(match => match[1]));
  const parameterized = Object.entries(sources).flatMap(([name, source]) =>
    [...source.matchAll(/UPDATE bridge_jobs SET status=\?/g)].map(() => name)).sort();
  // Audited parameterized writers and the values they can bind:
  // store.mjs finishJobWithOutbox -> reply_pending | succeeded
  // store.mjs retryJob            -> failed | pending
  // steering.mjs settle steer     -> succeeded | pending | unknown
  assert.deepEqual(parameterized, ['steering.mjs', 'store.mjs', 'store.mjs']);
  assert.match(sources['store.mjs'], /const status = outbox\.length \? 'reply_pending' : 'succeeded';/);
  assert.match(sources['store.mjs'], /input\.terminal \? 'failed' : 'pending'/);
  assert.match(sources['steering.mjs'], /\{accepted:'succeeded',rejected:'pending',unknown:'unknown'\}\[input\.outcome\]/);
  // The claim marks rows running; the column default is pending.
  assert.match(sources['store.mjs'], /UPDATE \$\{table\} SET status='running'/);
  const ddl = await readFile(new URL('migrations/001-initial.sql', storageDir), 'utf8');
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS bridge_jobs \([\s\S]*?status VARCHAR\(24\) NOT NULL DEFAULT 'pending'/);
  const written = new Set([...literal, 'reply_pending', 'succeeded', 'failed', 'pending', 'unknown', 'running']);
  assert.deepEqual([...written].sort(), [...BRIDGE_JOB_STATUSES].sort());
  assert.deepEqual([...BLOCKING_HOOK_JOB_STATUSES].sort(),
    BRIDGE_JOB_STATUSES.filter(status => !TERMINAL_BRIDGE_JOB_STATUSES.includes(status)).sort());
  assert.deepEqual([...TERMINAL_BRIDGE_JOB_STATUSES].sort(), ['cancelled', 'failed', 'succeeded']);
});

test('claims select IDs first, probe each blocking hook status, and fetch rows only when work was claimed', async () => {
  const migrations = await Promise.all(['001-initial', '002-codex-sessions', '003-forward-runtime', '004-bot-connection', '005-sender-union-id', '006-query-indexes']
    .map(async (name, index) => ({ version: index + 1, checksum: (await import('node:crypto')).createHash('sha256')
      .update(await readFile(new URL(`migrations/${name}.sql`, storageDir), 'utf8')).digest('hex') })));
  const statements = [];
  let transactions = 0;
  let claimable = [];
  const connection = {
    async query(sql) { statements.push(sql); return sql.startsWith('SELECT version') ? [migrations] : [[]]; },
    async execute(sql, params) {
      statements.push(sql);
      if (/^SELECT j\.id FROM bridge_jobs/.test(sql)) return [claimable.map(id => ({ id }))];
      if (/^SELECT \* FROM bridge_jobs/.test(sql)) return [params.slice(1).map(id => ({ id, status: 'running', attempts: 1, lease_expires_at: '999' }))];
      return [{ affectedRows: claimable.length }];
    },
    async beginTransaction() { transactions += 1; statements.push('BEGIN'); },
    async commit() { statements.push('COMMIT'); },
    async rollback() {}, release() {}, destroy() {},
  };
  let clock = 100_000;
  const store = await createMysqlStore({ pool: { async getConnection() { return connection; } }, connectionId: 'bot', now: () => clock });
  statements.length = 0; transactions = 0;
  assert.deepEqual(await store.claimJobs({ kind: 'hook', owner: 'worker', leaseMs: 60_000, limit: 1 }), []);
  assert.deepEqual(statements.map(sql => sql.split(/\s/)[0]), ['BEGIN', 'SELECT', 'COMMIT']);
  assert.equal(transactions, 1);
  const claimSql = statements[1];
  assert.match(claimSql, /^SELECT j\.id FROM bridge_jobs j WHERE/);
  assert.doesNotMatch(claimSql, /NOT IN/);
  for (const status of BLOCKING_HOOK_JOB_STATUSES) assert.match(claimSql, new RegExp(`prior\\.status='${status}' AND prior\\.sequence<j\\.sequence`));
  for (const status of TERMINAL_BRIDGE_JOB_STATUSES) assert.doesNotMatch(claimSql, new RegExp(`prior\\.status='${status}'`));
  statements.length = 0;
  claimable = ['job-1'];
  const [job] = await store.claimJobs({ kind: 'hook', owner: 'worker', leaseMs: 60_000, limit: 1 });
  assert.equal(job.id, 'job-1');
  assert.equal(job.leaseExpiresAt, clock + 60_000);
  assert.deepEqual(statements.map(sql => sql.split(/\s/)[0]), ['BEGIN', 'SELECT', 'UPDATE', 'SELECT', 'COMMIT']);
  assert.match(statements[2], /WHERE connection_id=\? AND id IN \(\?\)$/);
  assert.match(statements[3], /^SELECT \* FROM bridge_jobs WHERE connection_id=\? AND id IN \(\?\)$/);
});
