import test from 'node:test';
import assert from 'node:assert/strict';
import { withConnection } from '../src/storage/connection.mjs';
import { databaseError } from '../src/storage/errors.mjs';

function fixture(commit) {
  let destroyed = 0, released = 0;
  const connection = { query: async () => {}, beginTransaction: async () => {}, commit,
    rollback: async () => {}, destroy: () => { destroyed++; }, release: () => { released++; } };
  return { pool: { getConnection: async () => connection }, counts: () => ({ destroyed, released }) };
}
test('commit deadline preserves uncertainty and destroys the connection', async () => {
  const f = fixture(() => new Promise(() => {}));
  await assert.rejects(withConnection(f.pool, async () => {}, { transaction: true, timeoutMs: 15 }),
    { code: 'commit_unknown', reason: 'commit_timeout' });
  assert.deepEqual(f.counts(), { destroyed: 1, released: 0 });
});
test('lost commit acknowledgement retains only safe driver diagnostics', async () => {
  const f = fixture(async () => { throw Object.assign(new Error('secret SQL/password'), {
    code: 'ECONNRESET', errno: 104, sqlState: 'HY000', sql: 'private statement' }); });
  let error;
  try { await withConnection(f.pool, async () => {}, { transaction: true }); } catch (e) { error = e; }
  assert.equal(error.code, 'commit_unknown'); assert.equal(error.reason, 'commit_error');
  assert.equal(error.errorCode, 'ECONNRESET'); assert.equal(error.errno, 104); assert.equal(error.sqlState, 'HY000');
  assert.equal(error.message, 'commit_unknown'); assert.equal(error.cause, undefined);
  assert.equal(JSON.stringify(error).includes('secret'), false);
  assert.deepEqual(f.counts(), { destroyed: 1, released: 0 });
});
test('ordinary storage errors sanitize untrusted driver fields', () => {
  const e = databaseError({ code: 'private\nSQL', errno: -1, sqlState: 'bad state', message: 'credential' });
  assert.equal(e.code, 'store_unavailable');
  assert.equal(e.errorCode, undefined); assert.equal(e.errno, undefined); assert.equal(e.sqlState, undefined);
});
