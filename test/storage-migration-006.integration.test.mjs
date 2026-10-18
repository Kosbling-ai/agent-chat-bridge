import assert from 'node:assert/strict';
import test from 'node:test';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { assertSchemaCurrent, migrate } from '../src/storage/migrations.mjs';

const enabled = Boolean(process.env.BRIDGE_TEST_PASSWORD);
const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map((key) => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));
const INDEXES = [
  ['assistant_codex_events', 'idx_assistant_codex_events_message', ['connection_id', 'codex_session_id', 'message_id', 'id']],
  ['assistant_codex_forward_jobs', 'idx_forward_status_finished', ['connection_id', 'status', 'finished_at', 'id']],
  ['bridge_jobs', 'jobs_conversation_open', ['connection_id', 'conversation_id', 'hook_id', 'kind', 'status', 'sequence']],
  ['bridge_outbox', 'outbox_unknown_recent', ['connection_id', 'status', 'first_attempt_at', 'next_attempt_at']],
];

async function indexColumns(pool, table, name) {
  const [rows] = await pool.query(`SHOW INDEX FROM ${table} WHERE Key_name = ?`, [name]);
  return rows.sort((left, right) => Number(left.Seq_in_index) - Number(right.Seq_in_index)).map((row) => row.Column_name);
}
async function ledger(pool) {
  const [rows] = await pool.query('SELECT version FROM bridge_schema_migrations ORDER BY version');
  return rows.map((row) => Number(row.version));
}
// 006 adds only secondary indexes, so removing them and its ledger row is the
// exact 005 schema.
async function rewindTo005(pool, keep = []) {
  for (const [table, name] of INDEXES) {
    if (!keep.includes(name) && (await indexColumns(pool, table, name)).length) await pool.query(`ALTER TABLE ${table} DROP INDEX ${name}`);
  }
  await pool.query('DELETE FROM bridge_schema_migrations WHERE version = 6');
}

test('006 adds the query indexes online, skips matching pre-applied ones and is idempotent', { skip: !enabled, timeout: 120_000 }, async () => {
  const pool = createPoolFromEnvironment(refs);
  try {
    assert.deepEqual(await migrate(pool), { version: 6, applied: true });
    for (const [table, name, columns] of INDEXES) assert.deepEqual(await indexColumns(pool, table, name), columns, name);

    // 005 database with rows, upgraded by the explicit migration command.
    await rewindTo005(pool);
    assert.deepEqual(await ledger(pool), [1, 2, 3, 4, 5]);
    await assert.rejects(assertSchemaCurrent(pool), { code: 'schema_version_mismatch' });
    await pool.execute("INSERT INTO assistant_codex_events (connection_id,codex_session_id,feishu_open_id,chat_id,message_id,event_key,event_type,role,title,text,detail_json,created_at) VALUES ('bot','thread','actor','chat','om_1','assistant-final:om_1','assistant','assistant','','kept','{}',1)");
    assert.deepEqual(await migrate(pool), { version: 6, applied: true });
    assert.deepEqual(await assertSchemaCurrent(pool), { version: 6 });
    for (const [table, name, columns] of INDEXES) assert.deepEqual(await indexColumns(pool, table, name), columns, name);
    const [[kept]] = await pool.query("SELECT text FROM assistant_codex_events WHERE connection_id='bot' AND message_id='om_1'");
    assert.equal(kept.text, 'kept');
    assert.deepEqual(await migrate(pool), { version: 6, applied: false });

    // An operator may have created some of the indexes ahead of the release.
    await rewindTo005(pool, ['idx_assistant_codex_events_message', 'outbox_unknown_recent']);
    assert.deepEqual(await migrate(pool), { version: 6, applied: true });
    for (const [table, name, columns] of INDEXES) assert.deepEqual(await indexColumns(pool, table, name), columns, name);
    assert.deepEqual(await ledger(pool), [1, 2, 3, 4, 5, 6]);

    // A same-named index with another definition is never silently replaced.
    await rewindTo005(pool);
    await pool.query('ALTER TABLE bridge_outbox ADD INDEX outbox_unknown_recent (connection_id,status)');
    await assert.rejects(migrate(pool), { code: 'schema_version_mismatch' });
    assert.deepEqual(await ledger(pool), [1, 2, 3, 4, 5]);
    assert.deepEqual(await indexColumns(pool, 'bridge_outbox', 'outbox_unknown_recent'), ['connection_id', 'status']);
    await pool.query('ALTER TABLE bridge_outbox DROP INDEX outbox_unknown_recent');
    assert.deepEqual(await migrate(pool), { version: 6, applied: true });
    assert.deepEqual(await assertSchemaCurrent(pool), { version: 6 });

    // The migration session's metadata-lock wait is restored for pooled reuse.
    await rewindTo005(pool);
    const connection = await pool.getConnection();
    try {
      const pinned = { query: (...args) => connection.query(...args), execute: (...args) => connection.execute(...args), release() {}, destroy() {} };
      assert.deepEqual(await migrate({ getConnection: async () => pinned }), { version: 6, applied: true });
      const [[session]] = await connection.query('SELECT @@SESSION.lock_wait_timeout AS value, @@GLOBAL.lock_wait_timeout AS global');
      assert.equal(Number(session.value), Number(session.global));
    } finally { connection.release(); }
  } finally { await pool.end(); }
});
