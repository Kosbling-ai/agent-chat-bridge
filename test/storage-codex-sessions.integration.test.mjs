import assert from 'node:assert/strict';
import test from 'node:test';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { assertSchemaCurrent, migrate } from '../src/storage/migrations.mjs';
import { createCodexSessionStore } from '../src/storage/codex-sessions.mjs';

const enabled = Boolean(process.env.BRIDGE_TEST_PASSWORD);
const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map((key) => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));

test('isolated MySQL upgrades v1 and preserves exact Codex session/event queries', { skip: !enabled, timeout: 40_000 }, async () => {
  const pool = createPoolFromEnvironment(refs);
  try {
    assert.deepEqual(await migrate(pool), { version: 2, applied: true });
    assert.deepEqual(await assertSchemaCurrent(pool), { version: 2 });
    const store = createCodexSessionStore({ pool, schema: process.env.BRIDGE_TEST_DATABASE, now: () => 1000 });
    const binding = { feishuOpenId: 'system:fixture', chatId: 'chat-a', chatType: 'group', codexSessionId: 'thread-a', threadName: 'fixture' };
    await store.saveCodexBinding(binding, { messageId: 'message-a' });
    assert.equal((await store.loadBinding({ bindingOpenId: binding.feishuOpenId, chatId: binding.chatId, chatType: 'group' })).codexSessionId, 'thread-a');
    await store.saveCodexRealtimeEvent(binding, { messageId: 'message-a', eventKey: 'public:1', eventType: 'public_progress', role: 'activity', title: 'progress', text: '', detail: { kind: 'tool' }, createdAt: 1001 });
    assert.equal((await store.readPublicProgress({ binding, threadId: 'thread-a', messageId: 'message-a' })).length, 1);
    assert.equal((await store.readPublicProgress({ binding: { ...binding, feishuOpenId: 'system:other' }, threadId: 'thread-a', messageId: 'message-a' })).length, 0);

    // Recreate a released v1-only ledger inside this task-owned temporary schema.
    await pool.query('DROP TABLE assistant_codex_events');
    await pool.query('DROP TABLE assistant_codex_sessions');
    await pool.query('DELETE FROM bridge_schema_migrations WHERE version = 2');
    assert.deepEqual(await migrate(pool), { version: 2, applied: true });
    assert.deepEqual(await assertSchemaCurrent(pool), { version: 2 });
  } finally { await pool.end(); }
});
