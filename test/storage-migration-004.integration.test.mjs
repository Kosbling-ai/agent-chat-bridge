import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { assertSchemaCurrent, migrate } from '../src/storage/migrations.mjs';

const enabled = Boolean(process.env.BRIDGE_TEST_PASSWORD);
const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map((key) => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));
const assistantTables = ['assistant_codex_sessions', 'assistant_codex_events', 'assistant_codex_forward_jobs', 'assistant_inbound_messages', 'assistant_message_events'];
const storageCli = fileURLToPath(new URL('../src/storage/migrate-cli.mjs', import.meta.url));
const publicCli = fileURLToPath(new URL('../bin/agent-chat-bridge.mjs', import.meta.url));

function cliCode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { env: process.env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1);
  const lines = (result.stdout + result.stderr).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  return lines[0].code;
}

async function install003(pool) {
  for (let version = 1; version <= 3; version++) {
    const file = new URL(`../src/storage/migrations/00${version}-${['initial', 'codex-sessions', 'forward-runtime'][version - 1]}.sql`, import.meta.url);
    const sql = await readFile(file, 'utf8');
    for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) await pool.query(statement);
    if (version === 1) await pool.query('CREATE TABLE bridge_schema_migrations (version INT UNSIGNED PRIMARY KEY, checksum CHAR(64) CHARACTER SET ascii NOT NULL, applied_at BIGINT UNSIGNED NOT NULL) ENGINE=InnoDB');
    await pool.execute('INSERT INTO bridge_schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)', [version, createHash('sha256').update(sql).digest('hex'), 1000 + version]);
  }
}

async function hasColumn(pool, table) {
  const [[row]] = await pool.execute("SELECT COUNT(*) AS count FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'connection_id'", [table]);
  return Number(row.count) === 1;
}

test('004 preserves 003 rows, rejects missing or changed legacy ownership, and resumes partial DDL', { skip: !enabled, timeout: 90_000 }, async () => {
  const pool = createPoolFromEnvironment(refs);
  const dir = await mkdtemp(join(tmpdir(), 'bridge-migration-004-cli-'));
  try {
    const storageConfig = join(dir, 'storage.json');
    const publicConfig = join(dir, 'config.json');
    await writeFile(storageConfig, JSON.stringify(refs));
    await writeFile(publicConfig, JSON.stringify({
      schemaVersion: 1, storage: refs, codex: { bin: './codex', cwd: './workspace', envNames: [] },
      feishu: { connectionId: 'original-bot', appIdEnv: 'TEST_APP', appSecretEnv: 'TEST_SECRET', botOpenId: 'bot' },
      routing: { version: '1', privateUserIds: [], groups: [] },
      hooks: [],
    }));
    await install003(pool);
    await pool.execute("INSERT INTO assistant_codex_sessions (id,feishu_open_id,chat_id,chat_type,codex_session_id,thread_name,created_at,updated_at,last_message_id,last_message_at,last_error) VALUES (91,'actor','chat','group','thread-91','original',101,202,'message-91',203,'') ");
    await pool.execute("INSERT INTO assistant_codex_events (id,codex_session_id,feishu_open_id,chat_id,message_id,event_key,event_type,role,title,text,detail_json,created_at) VALUES (92,'thread-91','actor','chat','message-91','progress','progress','activity','title','original history','{}',204)");
    await pool.execute("INSERT INTO assistant_codex_forward_jobs (id,public_run_id,request_key_hash,request_hash,caller_id,execution_namespace,message_id,chat_id,prompt,group_chat_context_json,context_entries_json,status,result_json,last_error,created_at,updated_at) VALUES (93,'00000000-0000-0000-0000-000000000093','hash-93','request-93','caller','namespace','message-91','chat','original prompt','[]','[]','failed','{}','original error',205,206)");
    await pool.execute("INSERT INTO assistant_inbound_messages (id,message_id,chat_id,content_text,content_json,mentions_json,raw_event_json,received_at,updated_at) VALUES (94,'message-91','chat','original input','{}','[]','{}',207,208)");
    await pool.execute("INSERT INTO assistant_message_events (id,message_id,chat_id,event,ok,reason,detail,chat_type,message_type,created_at) VALUES (95,'message-91','chat','receive',1,'','original audit','group','text',209)");
    const before = {};
    for (const table of assistantTables) {
      const [[row]] = await pool.query(`SELECT * FROM ${table} LIMIT 1`);
      before[table] = row;
    }
    before.assistant_codex_forward_jobs.sender_union_id = null;
    before.assistant_inbound_messages.sender_union_id = null;
    await assert.rejects(migrate(pool), { code: 'legacy_connection_id_required' });
    assert.equal(cliCode(storageCli, ['--config', storageConfig]), 'legacy_connection_id_required');
    assert.equal(cliCode(publicCli, ['migrate', '--config', publicConfig]), 'legacy_connection_id_required');
    for (const table of assistantTables) assert.equal(await hasColumn(pool, table), false);
    const [[scopeAbsent]] = await pool.query("SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bridge_migration_004_scope'");
    assert.equal(Number(scopeAbsent.count), 0);
    const [[ledger3]] = await pool.query('SELECT MAX(version) AS version FROM bridge_schema_migrations');
    assert.equal(Number(ledger3.version), 3);
    const oldWriter = await pool.getConnection();
    const oldWriterLock = `bridge:writer:${createHash('sha256').update(process.env.BRIDGE_TEST_DATABASE).digest('hex').slice(0, 40)}`;
    try {
      await oldWriter.query('SELECT GET_LOCK(?, 0)', [oldWriterLock]);
      await assert.rejects(migrate(pool, { legacyConnectionId: 'original-bot' }), { code: 'writer_busy' });
      assert.equal(cliCode(storageCli, ['--config', storageConfig, '--legacy-connection-id', 'original-bot']), 'writer_busy');
      assert.equal(cliCode(publicCli, ['migrate', '--config', publicConfig, '--legacy-connection-id', 'original-bot']), 'writer_busy');
      assert.equal(await hasColumn(pool, assistantTables[0]), false);
    } finally {
      await oldWriter.query('SELECT RELEASE_LOCK(?)', [oldWriterLock]);
      oldWriter.release();
    }

    let failed = false;
    const interrupted = {
      async getConnection() {
        const real = await pool.getConnection();
        return {
          query(sql, ...args) {
            if (!failed && typeof sql === 'string' && sql.startsWith('ALTER TABLE assistant_codex_events ADD COLUMN')) {
              failed = true;
              throw new Error('synthetic_ddl_failure');
            }
            return real.query(sql, ...args);
          },
          execute: (...args) => real.execute(...args),
          release: () => real.release(),
          destroy: () => real.destroy(),
        };
      },
    };
    await assert.rejects(migrate(interrupted, { legacyConnectionId: 'original-bot' }));
    assert.equal(failed, true);
    assert.equal(await hasColumn(pool, assistantTables[0]), true);
    assert.equal(await hasColumn(pool, assistantTables[1]), false);
    await pool.execute("UPDATE assistant_codex_sessions SET connection_id = 'original-bot' WHERE connection_id IS NULL");
    await pool.query('ALTER TABLE assistant_codex_sessions MODIFY COLUMN connection_id VARCHAR(128) NOT NULL');
    await assert.rejects(migrate(pool, { legacyConnectionId: 'other-bot' }), { code: 'legacy_connection_id_mismatch' });
    assert.equal(cliCode(storageCli, ['--config', storageConfig, '--legacy-connection-id', 'other-bot']), 'legacy_connection_id_mismatch');
    assert.equal(cliCode(publicCli, ['migrate', '--config', publicConfig, '--legacy-connection-id', 'other-bot']), 'legacy_connection_id_mismatch');
    assert.deepEqual(await migrate(pool, { legacyConnectionId: 'original-bot' }), { version: 5, applied: true });
    assert.deepEqual(await assertSchemaCurrent(pool), { version: 5 });
    for (const table of assistantTables) {
      const [[row]] = await pool.query(`SELECT * FROM ${table} LIMIT 1`);
      assert.equal(row.connection_id, 'original-bot');
      const [[definition]] = await pool.execute("SELECT COLLATION_NAME AS collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'connection_id'", [table]);
      assert.equal(definition.collation, 'utf8mb4_bin');
      delete row.connection_id;
      assert.deepEqual(row, before[table], table);
    }
    assert.deepEqual(await migrate(pool), { version: 5, applied: false });
    await pool.execute("INSERT INTO assistant_codex_sessions (connection_id,feishu_open_id,chat_id,chat_type,codex_session_id,thread_name,created_at,updated_at,last_message_id,last_error) VALUES ('ORIGINAL-BOT','actor','chat','group','other-thread','other',301,302,'','')");
    const [lowerRows] = await pool.execute("SELECT id FROM assistant_codex_sessions WHERE connection_id = 'original-bot' AND feishu_open_id = 'actor' AND chat_id = 'chat'");
    const [upperRows] = await pool.execute("SELECT id FROM assistant_codex_sessions WHERE connection_id = 'ORIGINAL-BOT' AND feishu_open_id = 'actor' AND chat_id = 'chat'");
    assert.deepEqual(lowerRows.map((row) => Number(row.id)), [91]);
    assert.equal(upperRows.length, 1);
    assert.notEqual(Number(upperRows[0].id), 91);
    const [bridges] = await pool.query("SELECT INDEX_NAME AS name, COLUMN_NAME AS columnName FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('bridge_jobs','bridge_outbox','bridge_recoveries') AND INDEX_NAME IN ('jobs_claim','jobs_lease','outbox_claim','outbox_lease','outbox_cleanup','recovery_claim','recovery_idempotency') AND SEQ_IN_INDEX = 1");
    assert.equal(bridges.length, 7);
    assert.ok(bridges.every((row) => row.columnName === 'connection_id'));
  } finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
});

test('004 initializes an empty disposable schema without a legacy owner', { skip: !enabled, timeout: 90_000 }, async () => {
  const admin = createPoolFromEnvironment(refs);
  const schema = 'bridge_empty_004_test';
  await admin.query(`CREATE DATABASE ${schema}`);
  const pool = createPoolFromEnvironment(refs, { ...process.env, BRIDGE_TEST_DATABASE: schema });
  try {
    assert.deepEqual(await migrate(pool), { version: 5, applied: true });
    assert.deepEqual(await migrate(pool), { version: 5, applied: false });
    for (const table of assistantTables) {
      assert.equal(await hasColumn(pool, table), true);
      const [[definition]] = await pool.execute("SELECT IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'connection_id'", [table]);
      assert.equal(definition.nullable, 'NO');
    }
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE ${schema}`);
    await admin.end();
  }
});
