import { createHash } from 'node:crypto';

function quoteIdentifier(value) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('invalid schema identifier');
  return `\`${name}\``;
}
const limit = (value, max) => String(value || '').slice(0, max);
const stableKey = (value) => createHash('sha1').update(String(value || '')).digest('hex').slice(0, 24);

export function createCodexSessionStore({ pool, schema, now = Date.now } = {}) {
  if (!pool?.query) throw new Error('codex session store requires an injected pool');
  const prefix = `${quoteIdentifier(schema)}.`;
  const table = (name) => `${prefix}${quoteIdentifier(name)}`;
  const rows = async (sql, params = []) => (await pool.query(sql, params))[0];
  const one = async (sql, params = []) => (await rows(sql, params))[0] || null;

  async function loadBinding(identity) {
    const bindingOpenId = identity.feishuOpenId || identity.bindingOpenId;
    const row = await one(`SELECT codex_session_id, thread_name, chat_type, created_at, updated_at, last_message_id, last_message_at, last_error
      FROM ${table('assistant_codex_sessions')} WHERE feishu_open_id = ? AND chat_id = ? LIMIT 1`, [bindingOpenId, identity.chatId]);
    if (!row) return null;
    return {
      feishuOpenId: bindingOpenId, chatId: identity.chatId,
      chatType: row.chat_type || identity.chatType || '', codexSessionId: row.codex_session_id,
      threadName: row.thread_name || '', lastMessageAt: Number(row.last_message_at || row.updated_at || 0),
      created: false,
    };
  }

  async function saveCodexBinding(binding, options = {}) {
    const timestamp = now();
    await rows(`INSERT INTO ${table('assistant_codex_sessions')} (
      feishu_open_id, chat_id, chat_type, codex_session_id, thread_name, created_at,
      updated_at, last_message_id, last_message_at, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE chat_type=VALUES(chat_type), codex_session_id=VALUES(codex_session_id),
      thread_name=VALUES(thread_name), updated_at=VALUES(updated_at), last_message_id=VALUES(last_message_id),
      last_message_at=VALUES(last_message_at), last_error=VALUES(last_error)`, [
      binding.feishuOpenId, binding.chatId, binding.chatType || '', binding.codexSessionId,
      binding.threadName || '', timestamp, timestamp, options.messageId || '', timestamp, limit(options.lastError, 1000),
    ]);
  }

  async function saveCodexRealtimeEvent(binding, event) {
    const threadId = String(event.codexSessionId || binding.codexSessionId || '').trim();
    if (!threadId) throw new Error('codex event requires a thread id');
    const eventKey = limit(event.eventKey || stableKey(JSON.stringify(event)), 180);
    await rows(`INSERT INTO ${table('assistant_codex_events')} (
      codex_session_id, feishu_open_id, chat_id, message_id, event_key,
      event_type, role, title, text, detail_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE event_type=VALUES(event_type), role=VALUES(role), title=VALUES(title),
      text=VALUES(text), detail_json=VALUES(detail_json), created_at=VALUES(created_at)`, [
      threadId, binding.feishuOpenId || '', binding.chatId || '', event.messageId || '', eventKey,
      limit(event.eventType, 60), limit(event.role || 'activity', 30), limit(event.title, 180),
      limit(event.text, 12000), JSON.stringify(event.detail || {}), Number(event.createdAt) || now(),
    ]);
  }

  async function findAcceptedMessageEvent(binding, messageId, { includeInFlight = false } = {}) {
    if (!messageId || !binding?.codexSessionId) return null;
    const result = await rows(`SELECT event_key, event_type, role, title, text, detail_json, created_at, id
      FROM ${table('assistant_codex_events')} WHERE codex_session_id = ? AND message_id = ? ORDER BY id DESC LIMIT 20`, [binding.codexSessionId, messageId]);
    for (const prefix of ['assistant-final:', 'error:', ...(includeInFlight ? ['user-steer-confirmed:'] : [])]) {
      const match = result.find((row) => String(row.event_key || '').startsWith(prefix));
      if (match) return match;
    }
    return null;
  }

  async function loadSteerEvents(binding, messageId) {
    return rows(`SELECT event_key, detail_json FROM ${table('assistant_codex_events')}
      WHERE codex_session_id = ? AND event_key IN (?, ?, ?)`, [binding.codexSessionId,
      `user-steer-attempt:${messageId}`, `user-steer-confirmed:${messageId}`, `user-steer-rejected:${messageId}`]);
  }

  async function readPublicProgress({ binding, threadId, messageId, cursor = 0, limit: pageLimit = 100 }) {
    const bounded = Math.max(1, Math.min(250, Number(pageLimit) || 100));
    return rows(`SELECT id, event_key, event_type, role, title, text, detail_json, created_at
      FROM ${table('assistant_codex_events')}
      WHERE feishu_open_id = ? AND chat_id = ? AND codex_session_id = ? AND message_id = ?
        AND event_type = 'public_progress' AND id > ? ORDER BY id ASC LIMIT ?`, [
      binding.feishuOpenId, binding.chatId, threadId, messageId, Number(cursor) || 0, bounded,
    ]);
  }

  return Object.freeze({
    loadBinding, saveCodexBinding,
    touchCodexBinding: saveCodexBinding,
    saveCodexRealtimeEvent, findAcceptedMessageEvent, loadSteerEvents, readPublicProgress,
  });
}
