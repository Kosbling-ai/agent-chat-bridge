import { createHash } from 'node:crypto';
import { assertSchemaCurrent } from './migrations.mjs';
import { acquireWriter } from './writer.mjs';
import { withConnection } from './connection.mjs';
import { StoreError } from './errors.mjs';
import { codexBindingOpenId, deriveExecutionScope } from '../agents/codex/thread-scope.mjs';

const TOP_LEVEL = ['version', 'connectionId', 'exportedAt', 'sourceQueue', 'systemMappings', 'bindings'];
const QUEUE_FIELDS = ['pending', 'running', 'replyPending', 'unknown', 'held'];
const MAPPING_FIELDS = ['legacyBindingOpenId', 'callerId', 'executionNamespace'];
const BINDING_FIELDS = ['feishu_open_id', 'chat_id', 'chat_type', 'codex_session_id', 'thread_name',
  'created_at', 'updated_at', 'last_message_id', 'last_message_at', 'last_error'];
const BLOCKING_JOB_STATUSES = ['pending', 'running', 'reply_pending', 'held'];

function invalid(code = 'invalid_binding_snapshot') { throw new StoreError(code); }
function exactObject(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) invalid();
}
function text(value, max, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value) || value.length > max) invalid();
  return value;
}
function integer(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function textBytes(value, max) {
  const result = text(value, max, { empty: true });
  if (Buffer.byteLength(result, 'utf8') > max) invalid();
  return result;
}
const keyOf = row => JSON.stringify([row.connectionId, row.bindingOpenId, row.chatId]);
const threadScopeOf = row => JSON.stringify([row.connectionId, row.bindingOpenId, row.chatId]);

export function normalizeBindingSnapshot(input, expectedConnectionId) {
  exactObject(input, TOP_LEVEL);
  if (input.version !== 1) invalid('unsupported_binding_snapshot_version');
  const connectionId = text(input.connectionId, 128);
  if (connectionId !== expectedConnectionId) invalid('binding_import_connection_mismatch');
  integer(input.exportedAt);
  exactObject(input.sourceQueue, QUEUE_FIELDS);
  const sourceQueue = Object.fromEntries(QUEUE_FIELDS.map(field => [field, integer(input.sourceQueue[field])]));
  if (sourceQueue.pending || sourceQueue.running || sourceQueue.replyPending) invalid('binding_import_source_not_drained');
  if (!Array.isArray(input.systemMappings) || input.systemMappings.length > 1000) invalid();
  if (!Array.isArray(input.bindings) || input.bindings.length < 1 || input.bindings.length > 1000) invalid();

  const mappings = new Map();
  for (const value of input.systemMappings) {
    exactObject(value, MAPPING_FIELDS);
    const legacyBindingOpenId = text(value.legacyBindingOpenId, 191);
    const callerId = text(value.callerId, 128);
    const executionNamespace = text(value.executionNamespace, 128);
    if (!legacyBindingOpenId.startsWith('system:') || mappings.has(legacyBindingOpenId)) invalid();
    let bindingOpenId;
    try { bindingOpenId = deriveExecutionScope(callerId, executionNamespace); } catch { invalid(); }
    mappings.set(legacyBindingOpenId, { legacyBindingOpenId, callerId, executionNamespace, bindingOpenId });
  }

  const usedMappings = new Set();
  const keys = new Set();
  const threads = new Map();
  const bindings = input.bindings.map(value => {
    exactObject(value, BINDING_FIELDS);
    const sourceBindingOpenId = text(value.feishu_open_id, 191);
    const chatId = text(value.chat_id, 191);
    const chatType = text(value.chat_type, 64);
    if (!['p2p', 'group'].includes(chatType)) invalid();
    let bindingOpenId;
    let mapping = null;
    if (sourceBindingOpenId.startsWith('system:')) {
      if (chatType !== 'group') invalid();
      mapping = mappings.get(sourceBindingOpenId);
      if (!mapping) invalid('binding_import_mapping_missing');
      usedMappings.add(sourceBindingOpenId);
      bindingOpenId = mapping.bindingOpenId;
    } else if (chatType === 'group') {
      bindingOpenId = codexBindingOpenId({ feishuOpenId: sourceBindingOpenId, chatId, chatType });
      if (sourceBindingOpenId !== bindingOpenId) invalid('binding_import_identity_mismatch');
    } else {
      if (sourceBindingOpenId.startsWith('group:')) invalid('binding_import_identity_mismatch');
      bindingOpenId = sourceBindingOpenId;
    }
    const row = {
      connectionId, sourceBindingOpenId, bindingOpenId, chatId, chatType,
      codexSessionId: text(value.codex_session_id, 191),
      threadName: text(value.thread_name, 191, { empty: true }),
      createdAt: integer(value.created_at), updatedAt: integer(value.updated_at),
      lastMessageId: text(value.last_message_id, 191, { empty: true }),
      lastMessageAt: integer(value.last_message_at, { nullable: true }),
      lastError: textBytes(value.last_error, 65_535),
      ...(mapping ? { mapping } : {}),
    };
    const key = keyOf(row);
    if (keys.has(key)) invalid('binding_import_duplicate_identity');
    keys.add(key);
    const prior = threads.get(row.codexSessionId);
    if (prior && prior !== threadScopeOf(row)) invalid('binding_import_duplicate_thread');
    threads.set(row.codexSessionId, threadScopeOf(row));
    return row;
  });
  if ([...mappings.keys()].some(key => !usedMappings.has(key))) invalid('binding_import_mapping_unused');
  return Object.freeze({ version: 1, connectionId, exportedAt: input.exportedAt, sourceQueue, bindings });
}

async function inspect(connection, snapshot, { lock = false } = {}) {
  const suffix = lock ? ' FOR UPDATE' : '';
  const placeholders = snapshot.bindings.map(() => '?').join(',');
  const [existing] = await connection.execute(`SELECT connection_id,feishu_open_id,chat_id,chat_type,codex_session_id
    FROM assistant_codex_sessions
    WHERE connection_id=? OR codex_session_id IN (${placeholders})${suffix}`,
  [snapshot.connectionId, ...snapshot.bindings.map(row => row.codexSessionId)]);
  const byKey = new Map(existing.map(row => [JSON.stringify([row.connection_id, row.feishu_open_id, row.chat_id]), row]));
  const byThread = new Map();
  for (const row of existing) {
    const values = byThread.get(row.codex_session_id) || [];
    values.push(row);
    byThread.set(row.codex_session_id, values);
  }
  const [blocking] = await connection.execute(`SELECT status,COUNT(*) AS count
    FROM assistant_codex_forward_jobs WHERE connection_id=? AND status IN (?,?,?,?) GROUP BY status`,
  [snapshot.connectionId, ...BLOCKING_JOB_STATUSES]);
  if (blocking.length) throw new StoreError('binding_import_target_jobs');
  let inserted = 0;
  let unchanged = 0;
  const insertKeys = new Set();
  for (const item of snapshot.bindings) {
    const current = byKey.get(keyOf(item));
    if (current) {
      if (current.codex_session_id !== item.codexSessionId || current.chat_type !== item.chatType) {
        throw new StoreError('binding_import_conflict');
      }
      unchanged += 1;
    } else {
      inserted += 1;
      insertKeys.add(keyOf(item));
    }
    for (const owner of byThread.get(item.codexSessionId) || []) {
      if (owner.connection_id !== item.connectionId || owner.feishu_open_id !== item.bindingOpenId || owner.chat_id !== item.chatId) {
        throw new StoreError('binding_import_thread_conflict');
      }
    }
  }
  return { summary: { inserted, unchanged }, insertKeys };
}

export async function importBindingSnapshot({ pool, connectionId, rolloverOnRulesUpdate, snapshot, apply = false,
  operationTimeoutMs = 5000, dependencies = {} } = {}) {
  const assertCurrent = dependencies.assertSchemaCurrent || assertSchemaCurrent;
  const lockWriter = dependencies.acquireWriter || acquireWriter;
  const runWithConnection = dependencies.withConnection || withConnection;
  if (!pool || typeof connectionId !== 'string' || !connectionId) invalid('invalid_store_input');
  if (rolloverOnRulesUpdate !== false) invalid('binding_import_rules_rollover_enabled');
  const normalized = normalizeBindingSnapshot(snapshot, connectionId);
  await assertCurrent(pool);
  if (!apply) {
    const result = await runWithConnection(pool, connection => inspect(connection, normalized), { timeoutMs: operationTimeoutMs });
    return { applied: false, ...result.summary, total: normalized.bindings.length, sourceQueue: normalized.sourceQueue,
      mappings: normalized.bindings.filter(row => row.mapping).map(row => row.mapping) };
  }
  let transactionConnection;
  const writer = await lockWriter(pool, () => transactionConnection?.destroy(), { timeoutMs: operationTimeoutMs, connectionId });
  try {
    const result = await runWithConnection(pool, async connection => {
      transactionConnection = connection;
      await writer.verify();
      const plan = await inspect(connection, normalized, { lock: true });
      for (const row of normalized.bindings) {
        if (!plan.insertKeys.has(keyOf(row))) continue;
        try {
          await connection.execute(`INSERT INTO assistant_codex_sessions
            (connection_id,feishu_open_id,chat_id,chat_type,codex_session_id,thread_name,created_at,updated_at,last_message_id,last_message_at,last_error)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [row.connectionId,row.bindingOpenId,row.chatId,row.chatType,row.codexSessionId,
            row.threadName,row.createdAt,row.updatedAt,row.lastMessageId,row.lastMessageAt,row.lastError]);
        } catch (error) {
          if (error?.code === 'ER_DUP_ENTRY') throw new StoreError('binding_import_conflict');
          throw error;
        }
      }
      await writer.verify();
      return plan.summary;
    }, { timeoutMs: operationTimeoutMs, transaction: true });
    return { applied: true, ...result, total: normalized.bindings.length, sourceQueue: normalized.sourceQueue,
      mappings: normalized.bindings.filter(row => row.mapping).map(row => row.mapping) };
  } finally {
    transactionConnection = undefined;
    await writer.close();
  }
}

export function bindingSnapshotHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
