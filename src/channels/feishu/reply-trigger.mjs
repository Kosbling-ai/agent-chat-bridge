const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const WARNING_TTL_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 500;

// Ownership is cached, never the message body. Only a message fetched for this
// particular ingest may be passed to reply-context; later ingests read it again.
export function createReplyTrigger({ inbound, chat, botOpenId, botAppId = '', now = Date.now, log = () => {} } = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const warned = new Map();
  const keyFor = (chatId, messageId) => JSON.stringify([chatId, messageId]);
  function put(key, botMessage, ttlMs) {
    cache.delete(key);
    cache.set(key, { botMessage, expiresAt: now() + ttlMs });
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  function cached(key) {
    const entry = cache.get(key);
    if (entry && entry.expiresAt > now()) return entry.botMessage;
    cache.delete(key);
    return undefined;
  }
  function warn(key, error, fallback) {
    if ((warned.get(key) || 0) > now()) return;
    warned.delete(key);
    warned.set(key, now() + WARNING_TTL_MS);
    while (warned.size > CACHE_LIMIT) warned.delete(warned.keys().next().value);
    const code = typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(error.code) ? error.code : fallback;
    const platformCode = Number.isSafeInteger(error?.platformCode) && error.platformCode >= 0 ? error.platformCode : undefined;
    log('warning', 'reply_trigger', 'lookup_failed', { code, ...(platformCode === undefined ? {} : { platformCode }) });
  }
  async function localOwnership(messageId, chatId) {
    const key = keyFor(chatId, messageId);
    if (cached(key) === true) return true;
    try {
      if (await inbound?.hasBotMessage?.({ messageId, chatId, botOpenId })) {
        put(key, true, CACHE_TTL_MS);
        return true;
      }
    } catch (error) {
      warn(key, error, 'reply_trigger_store_failed');
    }
    return false;
  }
  async function remoteOwnership(messageId, chatId, deadlineAt) {
    const key = keyFor(chatId, messageId);
    const known = cached(key);
    if (known !== undefined) return { botMessage: known };
    const pending = inFlight.get(key);
    if (pending) return { botMessage: (await pending).botMessage };
    const remaining = deadlineAt === undefined ? FETCH_TIMEOUT_MS : Math.min(FETCH_TIMEOUT_MS, deadlineAt - now() - 250);
    if (remaining < 1) return { botMessage: false };
    const operation = (async () => {
      if (typeof chat?.getMessage !== 'function') {
        warn(key, null, 'reply_trigger_fetch_unavailable');
        put(key, false, FAILURE_TTL_MS);
        return { botMessage: false };
      }
      try {
        const item = (await chat.getMessage({ messageId, timeoutMs: Math.max(1, Math.floor(remaining)) }))?.items?.[0];
        if (!item || item.deleted) {
          put(key, false, FAILURE_TTL_MS);
          return { botMessage: false };
        }
        const sender = item.sender || {};
        const botMessage = item.chat_id === chatId && ((sender.id_type === 'open_id' && sender.id === botOpenId)
          || (Boolean(botAppId) && sender.id_type === 'app_id' && sender.id === botAppId));
        put(key, botMessage, CACHE_TTL_MS);
        return { botMessage, item };
      } catch (error) {
        warn(key, error, 'reply_trigger_fetch_failed');
        put(key, false, FAILURE_TTL_MS);
        return { botMessage: false };
      }
    })();
    inFlight.set(key, operation);
    try { return await operation; } finally { if (inFlight.get(key) === operation) inFlight.delete(key); }
  }
  return async function botReply(event, { deadlineAt } = {}) {
    const parentId = event.message?.parentId || event.message?.parent_id || '';
    const rootId = event.message?.rootId || event.message?.root_id || '';
    const ids = [...new Set([parentId, rootId].filter(Boolean))];
    if (!ids.length) return { triggered: false };

    // Do both indexed lookups before any potentially slow Feishu read. A bot
    // root must still trigger when its immediate human parent cannot be read.
    const local = await Promise.all(ids.map(id => localOwnership(id, event.conversationId)));
    if (local.some(Boolean)) return { triggered: true };

    let parentMessage;
    for (const messageId of ids) {
      const result = await remoteOwnership(messageId, event.conversationId, deadlineAt);
      if (messageId === parentId) parentMessage = result.item;
      if (result.botMessage) return { triggered: true, parentMessage: parentMessage || (parentId ? undefined : result.item) };
    }
    return { triggered: false };
  };
}
