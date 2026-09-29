import assert from 'node:assert/strict';
import test from 'node:test';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { assertSchemaCurrent, migrate } from '../src/storage/migrations.mjs';
import { createCodexSessionStore } from '../src/storage/codex-sessions.mjs';

const enabled = Boolean(process.env.BRIDGE_TEST_PASSWORD);
const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map((key) => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));

test('isolated MySQL migrates and preserves exact scoped Codex session/event queries', { skip: !enabled, timeout: 40_000 }, async () => {
  const pool = createPoolFromEnvironment(refs);
  try {
    assert.deepEqual(await migrate(pool), { version: 5, applied: true });
    assert.deepEqual(await assertSchemaCurrent(pool), { version: 5 });
    const store = createCodexSessionStore({connectionId:'fixture', pool, schema: process.env.BRIDGE_TEST_DATABASE, now: () => 1000 });
    const binding = { feishuOpenId: 'system:fixture', chatId: 'chat-a', chatType: 'group', codexSessionId: 'thread-a', threadName: 'fixture' };
    await store.saveCodexBinding(binding, { messageId: 'message-a' });
    assert.equal((await store.loadBinding({ bindingOpenId: binding.feishuOpenId, chatId: binding.chatId, chatType: 'group' })).codexSessionId, 'thread-a');
    await store.saveCodexRealtimeEvent(binding, { messageId: 'message-a', eventKey: 'public:1', eventType: 'public_progress', role: 'activity', title: 'progress', text: '', detail: { kind: 'tool' }, createdAt: 1001 });
    assert.equal((await store.readPublicProgress({ binding, threadId: 'thread-a', messageId: 'message-a' })).length, 1);
    assert.equal((await store.readPublicProgress({ binding: { ...binding, feishuOpenId: 'system:other' }, threadId: 'thread-a', messageId: 'message-a' })).length, 0);
    assert.equal(await store.loadCodexEvent(binding, 'injection:system-preamble'), null);
    await store.saveCodexRealtimeEvent(binding, { eventKey: 'injection:system-preamble', eventType: 'context_injection', role: 'activity', title: 'injection', text: '', detail: { state: 'injected', hash: 'h1' }, createdAt: 1002 });
    await store.saveCodexRealtimeEvent(binding, { eventKey: 'injection:system-preamble', eventType: 'context_injection', role: 'activity', title: 'injection', text: '', detail: { state: 'stale', reason: 'context_compaction' }, createdAt: 1003 });
    assert.deepEqual(JSON.parse((await store.loadCodexEvent(binding, 'injection:system-preamble')).detail_json), { state: 'stale', reason: 'context_compaction' });
    assert.equal(await store.loadCodexEvent({ ...binding, codexSessionId: 'thread-b' }, 'injection:system-preamble'), null);
    const otherConnection = createCodexSessionStore({connectionId:'other', pool, schema: process.env.BRIDGE_TEST_DATABASE, now: () => 1000 });
    assert.equal(await otherConnection.loadCodexEvent(binding, 'injection:system-preamble'), null);

    assert.deepEqual(await migrate(pool), { version: 5, applied: false });
    assert.deepEqual(await assertSchemaCurrent(pool), { version: 5 });
  } finally { await pool.end(); }
});
