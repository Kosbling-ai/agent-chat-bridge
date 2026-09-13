import { createHash } from 'node:crypto';
import { normalizeFeishuEvent, RECEIVE, RECALL } from '../channels/feishu/normalize.mjs';
import { safeObserver } from '../logger.mjs';

const failure = code => Object.assign(new Error(code), { code });
const time = value => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw failure('invalid_history_time');
  return Math.round(number < 1e12 ? number * 1000 : number);
};
const bounded = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

// History is an observation of the message, not a fabricated WS edit event.
// Store must atomically deduplicate live/history by canonical message identity.
export function historyMessageEvent(item, conversation, { connectionId, botOpenId = '', receivedAt = Date.now() }) {
  if (!item || typeof item.message_id !== 'string' || !item.message_id
      || (item.chat_id && item.chat_id !== conversation.conversationId)) throw failure('invalid_history_message');
  const created = time(item.create_time);
  const updated = time(item.update_time || item.create_time);
  const sender = item.sender ?? {};
  const idType = ['open_id', 'user_id', 'union_id'].includes(sender.id_type) ? sender.id_type : '';
  const event = normalizeFeishuEvent(item.deleted === true ? RECALL : RECEIVE, {
    sender: { sender_type: sender.sender_type, sender_id: idType ? { [idType]: sender.id } : {} },
    message: {
      message_id: item.message_id, chat_id: conversation.conversationId, chat_type: conversation.conversationType,
      message_type: item.msg_type, content: typeof item.body?.content === 'string' ? item.body.content : '',
      create_time: String(created), update_time: String(updated),
      parent_id: item.parent_id, root_id: item.root_id, thread_id: item.thread_id,
      mentions: (item.mentions ?? []).map(mention => ({ ...mention,
        id: typeof mention.id === 'string' ? { [mention.id_type || 'open_id']: mention.id } : mention.id })),
    },
  }, { connectionId, botOpenId, receivedAt });
  event.source = 'history_catchup';
  event.message.updated = item.updated === true;
  return event;
}

function abortable(operation, signal) {
  if (signal.aborted) return Promise.reject(failure('catchup_interrupted'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure('catchup_interrupted'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(failure('catchup_interrupted')); return; }
    const abort = () => { clearTimeout(timer); reject(failure('catchup_interrupted')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function createCatchup({ connectionId, botOpenId = '', chat, store, onEvent, listConversations,
  intervalMs = 60000, initialLookbackMs = 3600000, overlapMs = 120000, maxPagesPerConversation = 20,
  operationTimeoutMs = 15000, log = () => {}, now = Date.now, wait = delay, random = Math.random }) {
  if (typeof connectionId !== 'string' || !connectionId || !chat?.listMessages || !store?.getCursor || !store?.setCursor
      || typeof onEvent !== 'function' || typeof listConversations !== 'function'
      || !bounded(intervalMs, 1000, 3600000) || !bounded(initialLookbackMs, 1000, 604800000)
      || !bounded(overlapMs, 0, 3600000) || !bounded(maxPagesPerConversation, 1, 100)
      || !bounded(operationTimeoutMs, 1, 120000)) throw failure('invalid_catchup_dependencies');
  log = safeObserver(log);
  const controller = new AbortController();
  let active, timer, started = false, stopped = false;
  const step = fn => abortable(fn, AbortSignal.any([controller.signal, AbortSignal.timeout(operationTimeoutMs)]));
  async function conversationRun(conversation, summary) {
    const key = `catchup:${createHash('sha256').update(conversation.conversationId).digest('hex')}`;
    const cursorScope = { connectionId, key };
    const row = await step(() => store.getCursor(cursorScope));
    let version = Number(row?.version ?? 0);
    let cursor = typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value;
    if (cursor && (cursor.schemaVersion !== 1 || !bounded(cursor.throughMs, 0, Number.MAX_SAFE_INTEGER)
      || (cursor.window && (!bounded(cursor.window.startMs, 0, Number.MAX_SAFE_INTEGER)
        || !bounded(cursor.window.endMs, cursor.window.startMs, Number.MAX_SAFE_INTEGER)
        || typeof cursor.window.pageToken !== 'string' || cursor.window.pageToken.length > 512)))) {
      throw failure('invalid_catchup_cursor');
    }
    async function save(value) {
      const result = await step(() => store.setCursor({ ...cursorScope, expectedVersion: version, value }));
      version = result.version;
      cursor = value;
    }
    if (!cursor?.window) {
      // Keep seconds exact across restarts; API boundaries are seconds, not ms.
      const endMs = Math.floor(now() / 1000) * 1000;
      const startMs = Math.floor(Math.max(0, cursor ? cursor.throughMs - overlapMs : endMs - initialLookbackMs) / 1000) * 1000;
      if (startMs > endMs) throw failure('catchup_clock_regressed');
      await save({ schemaVersion: 1, throughMs: cursor?.throughMs ?? startMs, window: { startMs, endMs, pageToken: '' } });
    }
    const tokens = new Set([cursor.window.pageToken]);
    for (let page = 0; page < maxPagesPerConversation; page++) {
      await step(() => wait(500 + Math.floor(Math.max(0, Math.min(1, random())) * 500), controller.signal));
      const window = cursor.window;
      const result = await step(() => chat.listMessages({ conversationId: conversation.conversationId, pageSize: 50,
        startTime: String(window.startMs / 1000), endTime: String(window.endMs / 1000),
        ...(window.pageToken ? { pageToken: window.pageToken } : {}) }));
      if (!Array.isArray(result?.items) || result.items.length > 50 || typeof result.has_more !== 'boolean'
          || (result.has_more && (typeof result.page_token !== 'string' || !result.page_token
            || result.page_token.length > 512 || tokens.has(result.page_token)))) throw failure('invalid_history_page');
      // Validate the entire page before emitting any record; no cross-chat input.
      const events = result.items.map(item => historyMessageEvent(item, conversation, { connectionId, botOpenId, receivedAt: now() }));
      for (const event of events) {
        if (event.isApp || event.isSelf) continue;
        await step(() => onEvent(event, { signal: controller.signal }));
        summary.received++;
      }
      summary.pages++;
      if (!result.has_more) {
        await save({ schemaVersion: 1, throughMs: window.endMs, window: null });
        return;
      }
      tokens.add(result.page_token);
      await save({ ...cursor, window: { ...window, pageToken: result.page_token } });
    }
    summary.incomplete++;
  }
  async function run() {
    const began = now();
    const summary = { conversations: 0, pages: 0, received: 0, failed: 0, incomplete: 0 };
    try {
      const conversations = await step(() => listConversations());
      if (!Array.isArray(conversations) || conversations.length > 1000) throw failure('invalid_catchup_conversations');
      const seen = new Set();
      for (const conversation of conversations) {
        if (typeof conversation?.conversationId !== 'string' || !conversation.conversationId || conversation.conversationId.length > 255
          || !['p2p', 'group'].includes(conversation.conversationType)) throw failure('invalid_catchup_conversation');
        if (seen.has(conversation.conversationId)) continue;
        seen.add(conversation.conversationId);
        if (stopped) break;
        summary.conversations++;
        try { await conversationRun(conversation, summary); }
        catch (error) {
          summary.failed++;
          const terminal = ['invalid_catchup_cursor', 'catchup_clock_regressed'].includes(error?.code);
          if (!stopped) log(terminal ? 'error' : 'warning', 'catchup', terminal ? 'repair_required' : 'retry_pending',
            { code: terminal ? error.code : 'catchup_conversation_failed' });
        }
      }
      if (summary.received || summary.failed || summary.incomplete) log('info', 'catchup', 'finished', { durationMs: now() - began });
    } catch (error) {
      summary.failed++;
      const terminal = ['invalid_catchup_conversations', 'invalid_catchup_conversation'].includes(error?.code);
      if (!stopped) log(terminal ? 'error' : 'warning', 'catchup', terminal ? 'repair_required' : 'retry_pending',
        { code: terminal ? error.code : 'catchup_run_failed' });
    }
    return summary;
  }
  function runOnce() {
    if (stopped) return Promise.reject(failure('catchup_stopped'));
    if (!active) active = run().finally(() => { active = null; });
    return active;
  }
  async function tick() {
    await runOnce();
    if (!stopped) timer = setTimeout(tick, intervalMs);
    timer?.unref?.();
  }
  return {
    runOnce,
    start() { if (started || stopped) throw failure('catchup_already_started'); started = true; void tick(); },
    async stop() { stopped = true; clearTimeout(timer); controller.abort(); await active; },
    status: () => ({ running: started && !stopped, polling: Boolean(active) }),
  };
}
