import { createHash } from 'node:crypto';
import { withConnection } from './connection.mjs';
import { StoreError } from './errors.mjs';
import { safeObserver } from '../logger.mjs';

function quoteIdentifier(value) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('invalid schema identifier');
  return `\`${name}\``;
}
const limit = (value, max) => String(value || '').slice(0, max);
const stableKey = (value) => createHash('sha1').update(String(value || '')).digest('hex').slice(0, 24);
// All session-store SQL runs through withConnection, so every call has a
// deadline (including the wait for a pool connection) and its errors are
// normalized store_* codes. Reads that gate turn admission (binding, receipt,
// steer and injection lookups) use the background claim deadline
// (storage.claimTimeoutMs, default 15000 ms); before 0.2.30 they had none.
// Execution-card progress polling keeps a short deadline: a miss is retried on
// the next poll.
export const PROGRESS_READ_TIMEOUT_MS = 1800;
// Writes (bindings and realtime events) get a 10 s deadline.
export const WRITE_TIMEOUT_MS = 10_000;
// Realtime event writes are mostly fire-and-forget from the executor. At most
// this many hold pool connections at once; the rest wait in order.
export const EVENT_WRITE_CONCURRENCY = 2;
// Best-effort events (progress and streamed text) may be dropped, oldest first,
// when more than this many are queued. Receipts and every other key
// (assistant-final:, error:, user:, user-steer-*, item:, ...) are never dropped.
export const BEST_EFFORT_EVENT_QUEUE_LIMIT = 200;
const BEST_EFFORT_EVENT_PREFIXES = ['public:', 'agent-delta:'];
const DROP_LOG_INTERVAL_MS = 60_000;

const deadline = value => Number.isInteger(value) && value >= 10 && value <= 30_000;

export function createCodexSessionStore({ pool, schema, connectionId, now = Date.now, claimTimeoutMs = 15_000,
  writeTimeoutMs = WRITE_TIMEOUT_MS, log } = {}) {
  if (!pool?.query) throw new Error('codex session store requires an injected pool');
  if (typeof connectionId !== 'string' || !connectionId || connectionId.length > 128) throw new StoreError('invalid_store_input');
  if (!deadline(claimTimeoutMs) || !deadline(writeTimeoutMs)) throw new StoreError('invalid_storage_deadline');
  log = safeObserver(log);
  const prefix = `${quoteIdentifier(schema)}.`;
  const table = (name) => `${prefix}${quoteIdentifier(name)}`;
  const query = (sql, params, timeoutMs) => withConnection(pool, async (connection) => (await connection.query(sql, params))[0], { timeoutMs });
  const admissionRows = (sql, params = []) => query(sql, params, claimTimeoutMs);
  const admissionOne = async (sql, params = []) => (await admissionRows(sql, params))[0] || null;
  const writeRows = (sql, params = []) => query(sql, params, writeTimeoutMs);
  let eventWritesActive = 0;
  let queuedBestEffort = 0;
  let droppedSinceLog = 0;
  let droppedTotal = 0;
  let lastDropLogAt = -Infinity;
  let dropLogTimer;
  const eventWriteQueue = [];
  const flushDropLog = () => {
    dropLogTimer = undefined;
    if (!droppedSinceLog) return;
    lastDropLogAt = now();
    log('warning', 'codex_event_write', 'dropped', { code: 'codex_event_queue_full', droppedEvents: droppedSinceLog,
      droppedEventsTotal: droppedTotal, queuedEvents: eventWriteQueue.length });
    droppedSinceLog = 0;
  };
  const recordDrop = () => {
    droppedSinceLog += 1; droppedTotal += 1;
    const wait = DROP_LOG_INTERVAL_MS - (now() - lastDropLogAt);
    if (wait <= 0) { clearTimeout(dropLogTimer); flushDropLog(); return; }
    if (!dropLogTimer) { dropLogTimer = setTimeout(flushDropLog, Math.min(wait, DROP_LOG_INTERVAL_MS)); dropLogTimer.unref?.(); }
  };
  // Resolves true with a slot, or false when a best-effort write was dropped.
  const acquireEventWrite = (bestEffort) => {
    if (eventWritesActive < EVENT_WRITE_CONCURRENCY) { eventWritesActive += 1; return Promise.resolve(true); }
    return new Promise((resolve) => {
      eventWriteQueue.push({ resolve, bestEffort });
      if (bestEffort) queuedBestEffort += 1;
      if (queuedBestEffort > BEST_EFFORT_EVENT_QUEUE_LIMIT) {
        const [dropped] = eventWriteQueue.splice(eventWriteQueue.findIndex(entry => entry.bestEffort), 1);
        queuedBestEffort -= 1;
        dropped.resolve(false);
        recordDrop();
      }
    });
  };
  // Hand the slot straight to a waiter so the bound is never exceeded: the
  // oldest non-best-effort write (receipts, user:, user-steer-*, item:, ...)
  // first, otherwise the oldest best-effort one, so receipts never wait behind
  // queued progress. The write deadline guarantees every slot is released.
  const releaseEventWrite = () => {
    if (!eventWriteQueue.length) { eventWritesActive -= 1; return; }
    const priority = eventWriteQueue.findIndex(entry => !entry.bestEffort);
    const [next] = eventWriteQueue.splice(priority >= 0 ? priority : 0, 1);
    if (next.bestEffort) queuedBestEffort -= 1;
    next.resolve(true);
  };

  async function loadBinding(identity) {
    const bindingOpenId = identity.feishuOpenId || identity.bindingOpenId;
    const row = await admissionOne(`SELECT codex_session_id, thread_name, chat_type, created_at, updated_at, last_message_id, last_message_at, last_error
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
    await writeRows(`INSERT INTO ${table('assistant_codex_sessions')} (
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
    if (!await acquireEventWrite(BEST_EFFORT_EVENT_PREFIXES.some(value => eventKey.startsWith(value)))) return;
    try {
    await writeRows(`INSERT INTO ${table('assistant_codex_events')} (
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
    const result = await admissionRows(`SELECT event_key, event_type, role, title, text, detail_json, created_at, id
      FROM ${table('assistant_codex_events')} WHERE connection_id = ? AND codex_session_id = ? AND message_id = ? ORDER BY id DESC LIMIT 20`, [connectionId,binding.codexSessionId, messageId]);
    for (const prefix of ['assistant-final:', 'error:', ...(includeInFlight ? ['user-steer-confirmed:'] : [])]) {
      const match = result.find((row) => String(row.event_key || '').startsWith(prefix));
      if (match) return match;
    }
    return null;
  }

  async function loadSteerEvents(binding, messageId) {
    return admissionRows(`SELECT event_key, detail_json FROM ${table('assistant_codex_events')}
      WHERE connection_id = ? AND codex_session_id = ? AND event_key IN (?, ?, ?)`, [connectionId,binding.codexSessionId,
      `user-steer-attempt:${messageId}`, `user-steer-confirmed:${messageId}`, `user-steer-rejected:${messageId}`]);
  }

  // Point lookup on the (connection_id, codex_session_id, event_key) unique key.
  async function loadCodexEvent(binding, eventKey) {
    if (!binding?.codexSessionId || !eventKey) return null;
    return admissionOne(`SELECT event_key, event_type, detail_json, created_at FROM ${table('assistant_codex_events')}
      WHERE connection_id = ? AND codex_session_id = ? AND event_key = ? LIMIT 1`, [connectionId, binding.codexSessionId, limit(eventKey, 180)]);
  }

  async function readPublicProgress({ binding, threadId, messageId, cursor = 0, limit: pageLimit = 100 }) {
    const bounded = Math.max(1, Math.min(250, Number(pageLimit) || 100));
    const objectCursor = cursor && typeof cursor === 'object' ? cursor : null;
    const afterId = String(objectCursor?.id ?? cursor ?? '0');
    const afterAt = Number(objectCursor?.at ?? 0);
    if (!/^\d+$/.test(afterId) || !Number.isSafeInteger(afterAt) || afterAt < 0) throw new Error('invalid progress cursor');
    return query(`SELECT id, event_key, event_type, role, title, text, detail_json, created_at
      FROM ${table('assistant_codex_events')}
      WHERE connection_id = ? AND feishu_open_id = ? AND chat_id = ? AND codex_session_id = ? AND message_id = ?
        AND event_type = 'public_progress' AND created_at >= ? AND (created_at > ? OR id > ?)
      ORDER BY created_at ASC,id ASC LIMIT ?`, [
      connectionId,binding.feishuOpenId, binding.chatId, threadId, messageId, afterAt, afterAt, afterId, bounded,
    ], PROGRESS_READ_TIMEOUT_MS);
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
