import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
import { createForwardJobStore } from '../src/storage/forward-jobs.mjs';
import { importBindingSnapshot } from '../src/storage/binding-import.mjs';

const enabled = Boolean(process.env.BRIDGE_TEST_PASSWORD);
const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));
const sourceQueue = { pending: 0, running: 0, replyPending: 0, unknown: 1, held: 2 };
const binding = (values = {}) => ({ feishu_open_id: 'ou-person', chat_id: 'chat-p2p', chat_type: 'p2p',
  codex_session_id: 'thread-p2p', thread_name: 'old-name', created_at: 11, updated_at: 22,
  last_message_id: 'old-message', last_message_at: 21, last_error: 'old-error', ...values });
const snapshot = (connectionId, bindings = [binding()]) => ({ version: 1, connectionId, exportedAt: 30,
  sourceQueue, systemMappings: [], bindings });

test('binding import is dry-run by default, preserves metadata, stays idempotent and rejects conflicts atomically',
  { skip: !enabled, timeout: 40_000 }, async () => {
    const pool = createPoolFromEnvironment(refs);
    try {
      await migrate(pool);
      const preview = await importBindingSnapshot({ pool, connectionId: 'import-a', rolloverOnRulesUpdate: false,
        snapshot: snapshot('import-a') });
      assert.deepEqual({ applied: preview.applied, inserted: preview.inserted, unchanged: preview.unchanged },
        { applied: false, inserted: 1, unchanged: 0 });
      assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM assistant_codex_sessions WHERE connection_id='import-a'"))[0][0].n), 0);

      const applied = await importBindingSnapshot({ pool, connectionId: 'import-a', rolloverOnRulesUpdate: false,
        snapshot: snapshot('import-a'), apply: true });
      assert.equal(applied.inserted, 1);
      const [[saved]] = await pool.query("SELECT * FROM assistant_codex_sessions WHERE connection_id='import-a'");
      assert.deepEqual({ thread: saved.codex_session_id, name: saved.thread_name, created: Number(saved.created_at),
        updated: Number(saved.updated_at), message: saved.last_message_id, messageAt: Number(saved.last_message_at), error: saved.last_error },
      { thread: 'thread-p2p', name: 'old-name', created: 11, updated: 22, message: 'old-message', messageAt: 21, error: 'old-error' });
      const replay = await importBindingSnapshot({ pool, connectionId: 'import-a', rolloverOnRulesUpdate: false,
        snapshot: snapshot('import-a', [binding({ updated_at: 999 })]), apply: true });
      assert.deepEqual({ inserted: replay.inserted, unchanged: replay.unchanged }, { inserted: 0, unchanged: 1 });
      assert.equal(Number((await pool.query("SELECT updated_at FROM assistant_codex_sessions WHERE connection_id='import-a'"))[0][0].updated_at), 22);
      await assert.rejects(importBindingSnapshot({ pool, connectionId: 'import-a', rolloverOnRulesUpdate: false,
        snapshot: snapshot('import-a', [binding({ codex_session_id: 'different-thread' })]), apply: true }),
      { code: 'binding_import_conflict' });

      await pool.execute(`INSERT INTO assistant_codex_sessions
        (connection_id,feishu_open_id,chat_id,chat_type,codex_session_id,thread_name,created_at,updated_at,last_message_id,last_message_at,last_error)
        VALUES ('other-bot','ou-owner','other-chat','p2p','thread-owned','',1,1,'',NULL,'')`);
      const atomic = snapshot('import-a', [binding({ feishu_open_id: 'ou-new', chat_id: 'new-chat', codex_session_id: 'thread-new' }),
        binding({ feishu_open_id: 'ou-conflict', chat_id: 'conflict-chat', codex_session_id: 'thread-owned' })]);
      await assert.rejects(importBindingSnapshot({ pool, connectionId: 'import-a', rolloverOnRulesUpdate: false,
        snapshot: atomic, apply: true }), { code: 'binding_import_thread_conflict' });
      assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM assistant_codex_sessions WHERE connection_id='import-a' AND chat_id='new-chat'"))[0][0].n), 0);

      await assert.rejects(importBindingSnapshot({ pool, connectionId: 'import-a', rolloverOnRulesUpdate: true,
        snapshot: snapshot('import-a'), apply: true }), { code: 'binding_import_rules_rollover_enabled' });
    } finally { await pool.end(); }
  });

test('binding import refuses active target jobs and a live connection writer', { skip: !enabled, timeout: 40_000 }, async () => {
  const pool = createPoolFromEnvironment(refs);
  try {
    await migrate(pool);
    const jobs = createForwardJobStore({ pool, connectionId: 'import-jobs' });
    await jobs.upsert({ callerId: 'caller', idempotencyKey: randomUUID(), conversationId: 'chat', messageId: randomUUID(),
      bindingOpenId: 'system:test', chatType: 'group', senderOpenId: 'system:test', prompt: 'queued' });
    await assert.rejects(importBindingSnapshot({ pool, connectionId: 'import-jobs', rolloverOnRulesUpdate: false,
      snapshot: snapshot('import-jobs'), apply: true }), { code: 'binding_import_target_jobs' });

    const writer = await createMysqlStore({ pool, connectionId: 'import-busy' });
    try {
      await assert.rejects(importBindingSnapshot({ pool, connectionId: 'import-busy', rolloverOnRulesUpdate: false,
        snapshot: snapshot('import-busy'), apply: true }), { code: 'writer_busy' });
    } finally { await writer.close(); }
  } finally { await pool.end(); }
});

test('operator CLI previews unless --apply is explicit', { skip: !enabled, timeout: 40_000 }, async () => {
  const pool = createPoolFromEnvironment(refs);
  const directory = await mkdtemp(join(tmpdir(), 'bridge-binding-import-'));
  try {
    await migrate(pool);
    const config = JSON.parse(await readFile(new URL('../examples/bridge.json', import.meta.url), 'utf8'));
    config.feishu.connectionId = 'cli-import';
    config.codex.rolloverOnRulesUpdate = false;
    const configPath = join(directory, 'bridge.json');
    const snapshotPath = join(directory, 'snapshot.json');
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(snapshotPath, JSON.stringify(snapshot('cli-import', [binding({ codex_session_id: 'thread-cli' })])));
    const cli = fileURLToPath(new URL('../bin/agent-chat-bridge.mjs', import.meta.url));
    const cliEnv = { ...process.env, BRIDGE_DB_HOST: process.env.BRIDGE_TEST_HOST,
      BRIDGE_DB_PORT: process.env.BRIDGE_TEST_PORT, BRIDGE_DB_USER: process.env.BRIDGE_TEST_USER,
      BRIDGE_DB_PASSWORD: process.env.BRIDGE_TEST_PASSWORD, BRIDGE_DB_DATABASE: process.env.BRIDGE_TEST_DATABASE };
    const run = extra => spawnSync(process.execPath, [cli, 'import-bindings', '--config', configPath, '--input', snapshotPath, ...extra], {
      encoding: 'utf8', timeout: 10_000, env: cliEnv,
    });
    const preview = run([]);
    assert.equal(preview.status, 0, preview.stderr || preview.stdout);
    assert.match(preview.stdout, /"status":"previewed"/);
    assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM assistant_codex_sessions WHERE connection_id='cli-import'"))[0][0].n), 0);
    const apply = run(['--apply']);
    assert.equal(apply.status, 0, apply.stderr || apply.stdout);
    assert.match(apply.stdout, /"status":"succeeded"/);
    assert.equal(Number((await pool.query("SELECT COUNT(*) n FROM assistant_codex_sessions WHERE connection_id='cli-import'"))[0][0].n), 1);
  } finally {
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
