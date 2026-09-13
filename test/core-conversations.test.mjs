import test from 'node:test';
import assert from 'node:assert/strict';
import { listCatchupConversations } from '../src/core/conversations.mjs';

test('catchup scope combines groups/hooks with keyset-paged known private conversations', async () => {
  const calls = [];
  const config = { feishu: { connectionId: 'fixture' }, routing: { groups: [{ conversationId: 'group' }] }, hooks: [{ conversationIds: ['group', 'business', 'private-a'] }] };
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
test('catchup refuses an oversized scope instead of silently dropping chats', async () => {
  const config = { feishu: { connectionId: 'fixture' }, routing: { groups: Array.from({ length: 1000 }, (_, i) => ({ conversationId: `group-${i}` })) }, hooks: [] };
  await assert.rejects(listCatchupConversations({ config, store: { listKnownConversations: async () => ({ items: [{ conversationId: 'private', conversationType: 'p2p' }] }) } }), /catchup_scope_limit/);
});
