import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { createForwardJobStore } from '../src/storage/forward-jobs.mjs';
import { migrate } from '../src/storage/migrations.mjs';

const enabled = Boolean(process.env.BRIDGE_TEST_PASSWORD);
const refs = Object.fromEntries(
  ['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]),
);

async function withStore(connectionId, run) {
  const pool = createPoolFromEnvironment(refs);
  try {
    await migrate(pool);
    const insert = async records => {
      const fields = ['connection_id', 'public_run_id', 'message_id', 'caller_id', 'chat_id', 'prompt',
        'group_chat_context_json', 'context_entries_json', 'status', 'delivery_mode', 'finished_at',
        'last_error', 'result_json', 'created_at', 'updated_at'];
      const values = records.map((record, index) => [
        record.connectionId || connectionId, randomUUID(), `${connectionId}:${randomUUID()}:${index}`,
        'test', 'test', '', '[]', '[]', record.status || 'failed', record.mode || 'bridge',
        record.finishedAt, record.code || '', '{}', 1, 1,
      ]);
      await pool.execute(`INSERT INTO assistant_codex_forward_jobs (${fields.join(',')}) VALUES ${
        values.map(() => `(${fields.map(() => '?').join(',')})`).join(',')}`, values.flat());
    };
    await run({ insert, store: createForwardJobStore({ pool, connectionId }) });
  } finally { await pool.end(); }
}

test('task health summary counts both delivery modes and sanitizes codes', {
  skip: !enabled, timeout: 40_000,
}, async () => withStore('health-summary', async ({ insert, store }) => {
  const at = 1_000_000_000;
  await insert([
    { mode: 'bridge', code: 'CODEX_USAGE_LIMIT_EXCEEDED', finishedAt: at - 1000 },
    { mode: 'caller', code: 'private error text', finishedAt: at - 2000 },
    { mode: 'bridge', code: 'CODEX_TURN_INTERRUPTED', finishedAt: at - 3000 },
    { status: 'deferred', code: 'DEFERRED', finishedAt: at - 4000 },
    { code: 'OLD', finishedAt: at - 121 * 60_000 },
    { connectionId: 'health-other', code: 'OTHER_CONNECTION', finishedAt: at - 5000 },
  ]);
  const result = await store.taskHealthSummary({ windowMinutes: 120, checkedAt: at });
  assert.deepEqual(result, {
    window_minutes: 120, checked_at: at,
    failed: { total: 2, truncated: false, latest_finished_at: at - 1000,
      by_code: [{ code: 'CODEX_USAGE_LIMIT_EXCEEDED', count: 1 }, { code: 'OTHER', count: 1 }],
      by_mode: { bridge: 1, caller: 1 } },
    interrupted: { total: 1 },
  });
}));

test('interrupted excluded from failed task health summary', {
  skip: !enabled, timeout: 40_000,
}, async () => withStore('health-interrupted', async ({ insert, store }) => {
  await insert([{ code: 'CODEX_TURN_INTERRUPTED', finishedAt: 1000 }]);
  const result = await store.taskHealthSummary({ windowMinutes: 5, checkedAt: 1000 });
  assert.equal(result.failed.total, 0);
  assert.equal(result.failed.latest_finished_at, null);
  assert.deepEqual(result.failed.by_code, []);
  assert.equal(result.interrupted.total, 1);
}));

test('error code with trailing newline becomes OTHER in task health summary', {
  skip: !enabled, timeout: 40_000,
}, async () => withStore('health-invalid-codes', async ({ insert, store }) => {
  const at = 1_000_000;
  await insert([
    { code: 'FAIL\n', finishedAt: at },
    { code: 'FAIL\r\n', finishedAt: at - 1 },
    { code: `${'A'.repeat(64)}\n`, finishedAt: at - 2 },
    { code: 'B'.repeat(65), finishedAt: at - 3 },
    { code: 'CODEX_USAGE_LIMIT_EXCEEDED\n', finishedAt: at - 4 },
    { code: 'CODEX_USAGE_LIMIT_EXCEEDED', finishedAt: at - 5 },
  ]);
  const result = await store.taskHealthSummary({ windowMinutes: 5, checkedAt: at });
  assert.equal(result.failed.total, 6);
  assert.deepEqual(result.failed.by_code, [
    { code: 'OTHER', count: 5 },
    { code: 'CODEX_USAGE_LIMIT_EXCEEDED', count: 1 },
  ]);
}));

test('other connection excluded from task health summary', {
  skip: !enabled, timeout: 40_000,
}, async () => withStore('health-empty', async ({ insert, store }) => {
  await insert([{ connectionId: 'health-neighbor', code: 'FAIL', finishedAt: 1000 }]);
  const result = await store.taskHealthSummary({ windowMinutes: 5, checkedAt: 1000 });
  assert.equal(result.failed.total, 0);
  assert.equal(result.interrupted.total, 0);
}));

test('task health summary truncated at 500 rows and folds excess codes into OTHER', {
  skip: !enabled, timeout: 40_000,
}, async () => withStore('health-truncated', async ({ insert, store }) => {
  const at = 1_000_000;
  await insert(Array.from({ length: 501 }, (_, index) => ({
    code: `CODE_${String(index % 11).padStart(2, '0')}`,
    finishedAt: at - index,
  })));
  const result = await store.taskHealthSummary({ windowMinutes: 5, checkedAt: at });
  assert.equal(result.failed.total, 500);
  assert.equal(result.failed.truncated, true);
  assert.equal(result.failed.by_code.length, 10);
  assert.equal(result.failed.by_code.reduce((sum, item) => sum + item.count, 0), 500);
  assert(result.failed.by_code.some(item => item.code === 'OTHER'));
}));
