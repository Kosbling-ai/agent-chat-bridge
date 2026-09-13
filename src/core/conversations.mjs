// Only configured group scopes and previously received private chats belong to
// bridge catchup. This is not a directory of all chats visible to the bot.
export async function listCatchupConversations({ config, store }) {
  const conversations = new Map();
  function add(conversation) {
    const existing = conversations.get(conversation.conversationId);
    if (existing && existing.conversationType !== conversation.conversationType) throw new Error('catchup_scope_type_conflict');
    conversations.set(conversation.conversationId, conversation);
    if (conversations.size > 1000) throw new Error('catchup_scope_limit');
  }
  for (const group of config.routing.groups) add({ conversationId: group.conversationId, conversationType: 'group' });
  let cursor;
  do {
    const page = await store.listKnownConversations({ connectionId: config.feishu.connectionId, conversationType: 'p2p', afterConversationId: cursor, limit: 100 });
    for (const item of page.items) add(item);
    if (page.nextCursor && cursor && page.nextCursor <= cursor) throw new Error('catchup_scope_cursor_invalid');
    cursor = page.nextCursor;
  } while (cursor);
  // Hook scopes may include private chats already known through ingress. Do not
  // overwrite their observed type with the default for configured business groups.
  for (const hook of config.hooks) for (const conversationId of hook.conversationIds) if (!conversations.has(conversationId)) add({ conversationId, conversationType: 'group' });
  return [...conversations.values()];
}
