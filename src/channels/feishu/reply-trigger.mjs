const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 500;

// A reply may point to an immediate parent and a different thread root. Check
// both, but keep the immediate parent for the existing reply-context section.
export function createReplyTrigger({ inbound, chat, botOpenId, now = Date.now, log = () => {} } = {}) {
  const cache = new Map();
  async function check(messageId, chatId, deadlineAt) {
    const key = JSON.stringify([chatId, messageId]);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached;
    cache.delete(key);

    let botMessage = false;
    try {
      botMessage = Boolean(await inbound?.hasBotMessage?.({ messageId, chatId, botOpenId }));
    } catch (error) {
      log('warning', 'reply_trigger', 'lookup_failed', { code: error?.code || 'reply_trigger_store_failed' });
    }
    let item;
    if (!botMessage && typeof chat?.getMessage === 'function') {
      try {
        const remaining = deadlineAt === undefined ? FETCH_TIMEOUT_MS : Math.min(FETCH_TIMEOUT_MS, deadlineAt - now() - 250);
        if (remaining < 1) return { botMessage: false };
        item = (await chat.getMessage({ messageId, timeoutMs: Math.floor(remaining) }))?.items?.[0];
        const sender = item?.sender;
        botMessage = Boolean(item && !item.deleted && item.chat_id === chatId
          && sender?.id_type === 'open_id' && sender.id === botOpenId);
      } catch (error) {
        log('warning', 'reply_trigger', 'lookup_failed', { code: error?.code || 'reply_trigger_fetch_failed' });
        return { botMessage: false };
      }
    }
    const result = { botMessage, item, expiresAt: now() + CACHE_TTL_MS };
    cache.set(key, result);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return result;
  }
  return async function botReply(event, { deadlineAt } = {}) {
    const parentId = event.message?.parentId || event.message?.parent_id || '';
    const rootId = event.message?.rootId || event.message?.root_id || '';
    let parentMessage;
    for (const messageId of [...new Set([parentId, rootId].filter(Boolean))]) {
      if (deadlineAt !== undefined && now() >= deadlineAt - 250) break;
      const result = await check(messageId, event.conversationId, deadlineAt);
      if (messageId === parentId) parentMessage = result.item;
      if (result.botMessage) return { triggered: true, parentMessage: parentMessage || (parentId ? undefined : result.item) };
    }
    return { triggered: false };
  };
}
