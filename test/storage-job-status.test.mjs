import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { BLOCKING_HOOK_JOB_STATUSES, BRIDGE_JOB_STATUSES, TERMINAL_BRIDGE_JOB_STATUSES, createMysqlStore } from '../src/storage/store.mjs';

const storageDir = new URL('../src/storage/', import.meta.url);
const srcDir = new URL('../src/', import.meta.url);
async function sourceFiles() {
  const files = (await readdir(srcDir, { recursive: true })).filter(name => name.endsWith('.mjs'));
  return Object.fromEntries(await Promise.all(files.map(async name => [name, await readFile(new URL(name, srcDir), 'utf8')])));
}
// Every assignment to `status` in an SQL write that can target bridge_jobs, in
// any file under src/: UPDATE bridge_jobs (with or without alias, single or
// multi-line, status anywhere in SET), UPDATE ${table} (the shared claim
// update), INSERT/REPLACE INTO bridge_jobs with an explicit status column, and
// ON DUPLICATE KEY UPDATE assignments.
function statusWrites(file, source) {
  const writes = [];
  const assignments = (clause, kind) => {
    for (const match of clause.matchAll(/(?:^|[\s,(])(?:\w+\.)?status\s*=\s*('([^']*)'|\?|[^\s,)]+)/g)) {
      writes.push({ file, kind, value: match[2] ?? match[1] });
    }
  };
  for (const match of source.matchAll(/UPDATE\s+(?:bridge_jobs\b(?:\s+\w+)?|\$\{\s*\w+\s*\})\s+SET\b([\s\S]*?)\bWHERE\b/g)) {
    assert.ok(match[1].length < 2000, `${file}: unbounded UPDATE match`);
    assignments(match[1], 'update');
  }
  for (const match of source.matchAll(/(?:INSERT|REPLACE)\s+(?:IGNORE\s+)?INTO\s+bridge_jobs\s*\(([^)]*)\)([\s\S]*?)`/g)) {
    if (match[1].split(',').map(column => column.trim()).includes('status')) writes.push({ file, kind: 'insert', value: 'explicit-column' });
    const upsert = /ON\s+DUPLICATE\s+KEY\s+UPDATE([\s\S]*)$/i.exec(match[2]);
    if (upsert) assignments(upsert[1], 'upsert');
  }
  return writes;
}

// The hook-ordering claim probes each non-terminal status by equality. That is
// equivalent to the former `status NOT IN ('succeeded','failed','cancelled')`
// only while BRIDGE_JOB_STATUSES lists every value the code can write. Adding a
// status, or a new status write, must update that list (and this audit).
test('bridge_jobs status writes anywhere in src stay within the statuses the hook claim probes', async () => {
  const sources = await sourceFiles();
  const writes = Object.entries(sources).flatMap(([file, source]) => statusWrites(file, source));
  const literal = new Set(writes.filter(write => write.kind !== 'insert' && write.value !== '?').map(write => write.value));
  const parameterized = writes.filter(write => write.value === '?').map(write => `${write.file}:${write.kind}`).sort();
  // No INSERT sets status explicitly: new rows take the column default.
  assert.deepEqual(writes.filter(write => write.kind === 'insert'), []);
  // Audited parameterized writers and the values they can bind:
  // storage/store.mjs finishJobWithOutbox -> reply_pending | succeeded
  // storage/store.mjs retryJob            -> failed | pending
  // storage/steering.mjs settle steer     -> succeeded | pending | unknown
  assert.deepEqual(parameterized, ['storage/steering.mjs:update', 'storage/store.mjs:update', 'storage/store.mjs:update']);
  assert.match(sources['storage/store.mjs'], /const status = outbox\.length \? 'reply_pending' : 'succeeded';/);
  assert.match(sources['storage/store.mjs'], /input\.terminal \? 'failed' : 'pending'/);
  assert.match(sources['storage/steering.mjs'], /\{accepted:'succeeded',rejected:'pending',unknown:'unknown'\}\[input\.outcome\]/);
  // The shared claim update marks rows running; the column default is pending.
  assert.ok(literal.has('running'));
  const ddl = await readFile(new URL('migrations/001-initial.sql', storageDir), 'utf8');
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS bridge_jobs \([\s\S]*?status VARCHAR\(24\) NOT NULL DEFAULT 'pending'/);
  const written = new Set([...literal, 'reply_pending', 'succeeded', 'failed', 'pending', 'unknown', 'pending']);
  assert.deepEqual([...written].sort(), [...BRIDGE_JOB_STATUSES].sort());
  assert.deepEqual([...BLOCKING_HOOK_JOB_STATUSES].sort(),
    BRIDGE_JOB_STATUSES.filter(status => !TERMINAL_BRIDGE_JOB_STATUSES.includes(status)).sort());
  assert.deepEqual([...TERMINAL_BRIDGE_JOB_STATUSES].sort(), ['cancelled', 'failed', 'succeeded']);
});

test('the status-write audit sees the forms that bypassed the first version', () => {
  const forms = [
    ["UPDATE bridge_jobs SET error_code=?,status='late' WHERE id=?", 'late'],
    ['UPDATE bridge_jobs\n      SET status=?\n      WHERE id=?', '?'],
    ["UPDATE bridge_jobs j SET j.updated_at=?, j.status = 'aliased' WHERE j.id=?", 'aliased'],
    ["INSERT INTO bridge_jobs (id,status) VALUES (?,?) ON DUPLICATE KEY UPDATE status='upserted'`", 'upserted'],
  ];
  for (const [sql, value] of forms) {
    const found = statusWrites('core/example.mjs', sql.endsWith('`') ? sql : sql);
    assert.ok(found.some(write => write.value === value), sql);
  }
  assert.deepEqual(statusWrites('core/example.mjs', "INSERT INTO bridge_jobs (id,status) VALUES (?,'x')`").map(write => write.kind), ['insert']);
  assert.deepEqual(statusWrites('core/example.mjs', "UPDATE bridge_outbox SET status='sent' WHERE id=?"), []);
  assert.deepEqual(statusWrites('core/example.mjs', "SELECT 1 FROM bridge_jobs prior WHERE prior.status='pending'"), []);
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
