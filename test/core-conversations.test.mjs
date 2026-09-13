import test from 'node:test';
import assert from 'node:assert/strict';
import { listCatchupConversations } from '../src/core/conversations.mjs';
import { validateConfig } from '../src/config.mjs';

test('catchup scope combines groups/hooks with keyset-paged known private conversations', async () => {
  const calls = [];
  const config = { feishu: { connectionId: 'fixture' }, routing: { groups: [{ conversationId: 'group' }] }, hooks: [{ conversationIds: ['group', 'business', 'private-a', 'unknown-private'], catchupGroupIds: ['business'] }] };
  const store = { listKnownConversations: async input => {
    calls.push(input);
    return input.afterConversationId ? { items: [{ conversationId: 'private-b', conversationType: 'p2p' }], nextCursor: null }
      : { items: [{ conversationId: 'private-a', conversationType: 'p2p' }], nextCursor: 'private-a' };
  } };
  assert.deepEqual(await listCatchupConversations({ config, store }), [
    { conversationId: 'group', conversationType: 'group' }, { conversationId: 'private-a', conversationType: 'p2p' },
    { conversationId: 'private-b', conversationType: 'p2p' }, { conversationId: 'business', conversationType: 'group' },
  ]);
  assert.equal(calls[1].afterConversationId, 'private-a');
  assert(calls.every(call => call.connectionId === 'fixture' && call.limit === 100 && call.conversationType === 'p2p'));
});
test('hook catchup groups require explicit scoped configuration', () => {
  const config = { schemaVersion: 1, storage: Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, 'SYNTHETIC'])), codex: { bin: '/fixture', cwd: '/fixture' }, feishu: { connectionId: 'fixture', appIdEnv: 'SYNTHETIC', appSecretEnv: 'SYNTHETIC', botOpenId: 'bot' }, routing: { version: '1', privateUserIds: [], groups: [] }, auth: { clients: [{ id: 'client', tokenEnv: 'SYNTHETIC', conversationIds: [], admin: false }] }, hooks: [{ id: 'hook', url: 'http://example.invalid', tokenEnv: 'SYNTHETIC', conversationIds: ['group'] }] };
  assert.deepEqual(validateConfig(config).hooks[0].catchupGroupIds, []);
  config.hooks[0].catchupGroupIds = ['foreign'];
  assert.throws(() => validateConfig(config), { code: 'invalid_hook_catchup_scope' });
  config.hooks[0].catchupGroupIds = ['group'];
  assert.deepEqual(validateConfig(config).hooks[0].catchupGroupIds, ['group']);
});
test('catchup refuses an oversized scope instead of silently dropping chats', async () => {
  const config = { feishu: { connectionId: 'fixture' }, routing: { groups: Array.from({ length: 1000 }, (_, i) => ({ conversationId: `group-${i}` })) }, hooks: [] };
  await assert.rejects(listCatchupConversations({ config, store: { listKnownConversations: async () => ({ items: [{ conversationId: 'private', conversationType: 'p2p' }] }) } }), /catchup_scope_limit/);
});
