import { createHash } from 'node:crypto';
import { withConnection } from './connection.mjs';
import { StoreError } from './errors.mjs';

function quoteIdentifier(value) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('invalid schema identifier');
  return `\`${name}\``;
}
const limit = (value, max) => String(value || '').slice(0, max);
const stableKey = (value) => createHash('sha1').update(String(value || '')).digest('hex').slice(0, 24);
// Reads share the runtime pool with claims, so they get the same bounded
// deadline instead of waiting indefinitely for a connection or a slow server.
const READ_TIMEOUT_MS = 1800;
// Realtime event writes are fire-and-forget from the executor. Bound how many
// hold pool connections at once; further writes wait in order and are not dropped.
export const EVENT_WRITE_CONCURRENCY = 2;

export function createCodexSessionStore({ pool, schema, connectionId, now = Date.now } = {}) {
  if (!pool?.query) throw new Error('codex session store requires an injected pool');
  if (typeof connectionId !== 'string' || !connectionId || connectionId.length > 128) throw new StoreError('invalid_store_input');
  const prefix = `${quoteIdentifier(schema)}.`;
  const table = (name) => `${prefix}${quoteIdentifier(name)}`;
  const rows = async (sql, params = []) => (await pool.query(sql, params))[0];
  const readRows = (sql, params = []) => withConnection(pool, async (connection) => (await connection.query(sql, params))[0], { timeoutMs: READ_TIMEOUT_MS });
  const readOne = async (sql, params = []) => (await readRows(sql, params))[0] || null;
  let eventWritesActive = 0;
  const eventWriteQueue = [];
  const acquireEventWrite = () => {
    if (eventWritesActive < EVENT_WRITE_CONCURRENCY) { eventWritesActive += 1; return Promise.resolve(); }
    return new Promise((resolve) => { eventWriteQueue.push(resolve); });
  };
  // Hand the slot straight to the oldest waiter so the bound is never exceeded.
  const releaseEventWrite = () => {
    const next = eventWriteQueue.shift();
    if (next) next(); else eventWritesActive -= 1;
  };

  async function loadBinding(identity) {
    const bindingOpenId = identity.feishuOpenId || identity.bindingOpenId;
    const row = await readOne(`SELECT codex_session_id, thread_name, chat_type, created_at, updated_at, last_message_id, last_message_at, last_error
      FROM ${table('assistant_codex_sessions')} WHERE connection_id = ? AND feishu_open_id = ? AND chat_id = ? LIMIT 1`, [connectionId,bindingOpenId, identity.chatId]);
    if (!row) return null;
    return {
      feishuOpenId: bindingOpenId, chatId: identity.chatId,
      chatType: identity.chatType || '', codexSessionId: row.codex_session_id,
      threadName: row.thread_name || '', lastMessageAt: Number(row.last_message_at || row.updated_at || 0),
      created: false,
    };
  }

  async function saveCodexBinding(binding, options = {}) {
    const timestamp = now();
    await rows(`INSERT INTO ${table('assistant_codex_sessions')} (
      connection_id, feishu_open_id, chat_id, chat_type, codex_session_id, thread_name, created_at,
      updated_at, last_message_id, last_message_at, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE chat_type=VALUES(chat_type), codex_session_id=VALUES(codex_session_id),
      thread_name=VALUES(thread_name), updated_at=VALUES(updated_at), last_message_id=VALUES(last_message_id),
      last_message_at=VALUES(last_message_at), last_error=VALUES(last_error)`, [
      connectionId,binding.feishuOpenId, binding.chatId, binding.chatType || '', binding.codexSessionId,
      binding.threadName || '', timestamp, timestamp, options.messageId || '', timestamp, limit(options.lastError, 1000),
    ]);
  }

  async function saveCodexRealtimeEvent(binding, event) {
    const threadId = String(event.codexSessionId || binding.codexSessionId || '').trim();
    if (!threadId) return;
    const eventKey = limit(event.eventKey || stableKey(JSON.stringify(event)), 180);
    await acquireEventWrite();
    try {
    await rows(`INSERT INTO ${table('assistant_codex_events')} (
      connection_id, codex_session_id, feishu_open_id, chat_id, message_id, event_key,
      event_type, role, title, text, detail_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE event_type=VALUES(event_type), role=VALUES(role), title=VALUES(title),
      text=VALUES(text), detail_json=VALUES(detail_json), created_at=VALUES(created_at)`, [
      connectionId,threadId, binding.feishuOpenId || '', binding.chatId || '', event.messageId || '', eventKey,
      limit(event.eventType, 60), limit(event.role || 'activity', 30), limit(event.title, 180),
      limit(event.text, 12000), JSON.stringify(event.detail || {}), Number(event.createdAt) || now(),
    ]);
    } finally { releaseEventWrite(); }
  }

  async function findAcceptedMessageEvent(binding, messageId, { includeInFlight = false } = {}) {
    if (!messageId || !binding?.codexSessionId) return null;
    const result = await readRows(`SELECT event_key, event_type, role, title, text, detail_json, created_at, id
      FROM ${table('assistant_codex_events')} WHERE connection_id = ? AND codex_session_id = ? AND message_id = ? ORDER BY id DESC LIMIT 20`, [connectionId,binding.codexSessionId, messageId]);
    for (const prefix of ['assistant-final:', 'error:', ...(includeInFlight ? ['user-steer-confirmed:'] : [])]) {
      const match = result.find((row) => String(row.event_key || '').startsWith(prefix));
      if (match) return match;
    }
    return null;
  }

  async function loadSteerEvents(binding, messageId) {
    return readRows(`SELECT event_key, detail_json FROM ${table('assistant_codex_events')}
      WHERE connection_id = ? AND codex_session_id = ? AND event_key IN (?, ?, ?)`, [connectionId,binding.codexSessionId,
      `user-steer-attempt:${messageId}`, `user-steer-confirmed:${messageId}`, `user-steer-rejected:${messageId}`]);
  }

  // Point lookup on the (connection_id, codex_session_id, event_key) unique key.
  async function loadCodexEvent(binding, eventKey) {
    if (!binding?.codexSessionId || !eventKey) return null;
    return readOne(`SELECT event_key, event_type, detail_json, created_at FROM ${table('assistant_codex_events')}
      WHERE connection_id = ? AND codex_session_id = ? AND event_key = ? LIMIT 1`, [connectionId, binding.codexSessionId, limit(eventKey, 180)]);
  }

  async function readPublicProgress({ binding, threadId, messageId, cursor = 0, limit: pageLimit = 100 }) {
    const bounded = Math.max(1, Math.min(250, Number(pageLimit) || 100));
    const objectCursor = cursor && typeof cursor === 'object' ? cursor : null;
    const afterId = String(objectCursor?.id ?? cursor ?? '0');
    const afterAt = Number(objectCursor?.at ?? 0);
    if (!/^\d+$/.test(afterId) || !Number.isSafeInteger(afterAt) || afterAt < 0) throw new Error('invalid progress cursor');
    return readRows(`SELECT id, event_key, event_type, role, title, text, detail_json, created_at
      FROM ${table('assistant_codex_events')}
      WHERE connection_id = ? AND feishu_open_id = ? AND chat_id = ? AND codex_session_id = ? AND message_id = ?
        AND event_type = 'public_progress' AND created_at >= ? AND (created_at > ? OR id > ?)
      ORDER BY created_at ASC,id ASC LIMIT ?`, [
      connectionId,binding.feishuOpenId, binding.chatId, threadId, messageId, afterAt, afterAt, afterId, bounded,
    ]);
  }

  const operations = {
    loadBinding, saveCodexBinding,
    touchCodexBinding: saveCodexBinding,
    saveCodexRealtimeEvent, findAcceptedMessageEvent, loadSteerEvents, loadCodexEvent, readPublicProgress,
  };
  return Object.freeze(Object.fromEntries(Object.entries(operations).map(([name, operation]) => [name, (input, ...rest) => {
    if (input?.connectionId !== undefined && input.connectionId !== connectionId) throw new StoreError('invalid_store_input');
    return operation(input, ...rest);
  }])));
}
