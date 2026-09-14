import { createHash, randomUUID } from 'node:crypto';
import { withConnection } from './connection.mjs';
import { StoreError } from './errors.mjs';

// Trial rows that may already have caused a native or delivery side effect stay
// isolated. A fresh binding or prepared input alone is safe to claim.
const SAFE_EXECUTION_SQL = `
  COALESCE(JSON_UNQUOTE(JSON_EXTRACT(result_json,'$.execution.unconfirmed')),'false')!='true'
  AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(result_json,'$.execution.status')),'') NOT IN ('start_intent','bound','unknown')
  AND JSON_EXTRACT(result_json,'$.execution.intent') IS NULL
  AND JSON_EXTRACT(result_json,'$.execution.threadId') IS NULL
  AND JSON_EXTRACT(result_json,'$.execution.turnId') IS NULL`;
const SAFE_DELIVERY_SQL = `
  JSON_SEARCH(result_json,'one','unknown') IS NULL
  AND JSON_SEARCH(result_json,'one','send_intent') IS NULL
  AND JSON_SEARCH(result_json,'one','upload_intent') IS NULL`;

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const parse = value => { try { return value ? JSON.parse(value) : {}; } catch { return {}; } };
const required = (value, max = 255) => {
  if (typeof value !== 'string' || !value || value.length > max) throw new StoreError('invalid_store_input');
  return value;
};
const safeJson = value => JSON.stringify(value ?? null);
const leaseArgs = input => [required(input.id, 36), required(input.leaseOwner, 191)];

function row(value) {
  if (!value) return null;
  const result = parse(value.result_json);
  return {
    ...value,
    id: value.public_run_id,
    internalId: String(value.internal_id ?? value.id),
    publicRunId: value.public_run_id,
    callerId: value.caller_id,
    conversationId: value.chat_id,
    executionNamespace: value.execution_namespace || null,
    deliveryMode: value.delivery_mode,
    messageId: value.message_id,
    sourceMessageId: value.source_message_id,
    chatId: value.chat_id,
    chatType: value.chat_type,
    messageType: value.message_type,
    senderOpenId: value.sender_open_id,
    senderName: value.sender_name,
    groupChatContext: parse(value.group_chat_context_json),
    contextEntries: parse(value.context_entries_json),
    leaseOwner: value.lease_owner,
    leaseExpiresAt: value.lease_expires_at == null ? null : Number(value.lease_expires_at),
    nextAttemptAt: value.next_attempt_at == null ? null : Number(value.next_attempt_at),
    startedAt: value.started_at == null ? null : Number(value.started_at),
    finishedAt: value.finished_at == null ? null : Number(value.finished_at),
    replySentAt: value.reply_sent_at == null ? null : Number(value.reply_sent_at),
    attempts: Number(value.attempts || 0),
    replyAttempts: Number(value.reply_attempts || 0),
    result,
    createdAt: Number(value.created_at),
    updatedAt: Number(value.updated_at),
  };
}

export function requestFingerprint(input) {
  return hash({ conversationId: input.conversationId, text: input.prompt, executionNamespace: input.executionNamespace || '', deliveryMode: input.deliveryMode || 'bridge' });
}

export function createForwardJobStore({ pool, now = Date.now, operationTimeoutMs = 1800 } = {}) {
  if (!pool) throw new StoreError('invalid_store_input');
  const read = operation => withConnection(pool, operation, { timeoutMs: operationTimeoutMs });
  const write = operation => withConnection(pool, operation, { timeoutMs: operationTimeoutMs, transaction: true });
  const getBy = (column, value) => read(async connection => {
    const [[found]] = await connection.execute(`SELECT id AS internal_id, assistant_codex_forward_jobs.* FROM assistant_codex_forward_jobs WHERE ${column}=? LIMIT 1`, [value]);
    return row(found);
  });
  async function assertLease(connection, result) {
    if (!result.affectedRows) throw new StoreError('forward_lease_lost');
  }
  return Object.freeze({
    async upsert(input) {
      const callerId = required(input.callerId, 128);
      const idempotencyKey = required(input.idempotencyKey, 255);
      const keyHash = hash(`${callerId}\0${idempotencyKey}`);
      const requestHash = input.requestHash || requestFingerprint(input);
      return write(async connection => {
        const publicRunId = randomUUID();
        const createdAt = now();
        const initialResult = input.bindingOpenId ? { execution: { bindingOpenId: input.bindingOpenId } } : {};
        await connection.execute(`INSERT IGNORE INTO assistant_codex_forward_jobs
          (public_run_id,request_key_hash,request_hash,caller_id,execution_namespace,delivery_mode,message_id,source_message_id,chat_id,chat_type,message_type,sender_open_id,sender_name,conversation_scope,prompt,group_chat_context_json,context_entries_json,status,next_attempt_at,result_json,last_error,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [publicRunId,keyHash,requestHash,callerId,input.executionNamespace || '',input.deliveryMode || 'bridge',required(input.messageId,191),input.sourceMessageId || null,required(input.conversationId,191),input.chatType || 'group',input.messageType || 'text',input.senderOpenId || '',input.senderName || '',input.chatType === 'p2p' ? 'p2p' : 'group',input.prompt || '',safeJson(input.groupChatContext),safeJson(input.contextEntries || []),'pending',input.nextAttemptAt ?? createdAt,safeJson(initialResult),'',createdAt,createdAt]);
        const [[found]] = await connection.execute('SELECT id AS internal_id, assistant_codex_forward_jobs.* FROM assistant_codex_forward_jobs WHERE request_key_hash=? LIMIT 1', [keyHash]);
        if (!found || found.request_hash !== requestHash) throw new StoreError('job_conflict');
        return { ...row(found), duplicate: found.public_run_id !== publicRunId };
      });
    },
    getRun: ({ id }) => getBy('public_run_id', required(id,36)),
    getByMessageId: ({ messageId }) => getBy('message_id', required(messageId,191)),
    claim(input) {
      const owner = required(input.owner,191); const leaseMs = Number(input.leaseMs || 60000); const take = Math.max(1,Math.min(5,Number(input.limit || 1)));
      return write(async connection => {
        const at = now();
        const [candidates] = await connection.execute(`SELECT id FROM assistant_codex_forward_jobs
          WHERE ((status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (status='running' AND lease_expires_at<=?))
            AND ${SAFE_EXECUTION_SQL}
          ORDER BY created_at,id LIMIT ${take} FOR UPDATE SKIP LOCKED`, [at,at]);
        if (!candidates.length) return [];
        const ids = candidates.map(item => String(item.id));
        await connection.execute(`UPDATE assistant_codex_forward_jobs SET status='running',attempts=attempts+1,lease_owner=?,lease_expires_at=?,started_at=COALESCE(started_at,?),updated_at=? WHERE id IN (${ids.map(()=>'?').join(',')})`, [owner,at+leaseMs,at,at,...ids]);
        const [rows] = await connection.execute(`SELECT id AS internal_id, assistant_codex_forward_jobs.* FROM assistant_codex_forward_jobs WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY created_at,id`,ids);
        return rows.map(row);
      });
    },
    claimById(input) {
      const owner = required(input.owner,191); const leaseMs = Number(input.leaseMs || 60000);
      const id = required(input.id,36);
      return write(async connection => {
        const at = now();
        const [[candidate]] = await connection.execute(`SELECT id FROM assistant_codex_forward_jobs
          WHERE public_run_id=?
            AND ((status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (status='running' AND lease_expires_at<=?))
            AND ${SAFE_EXECUTION_SQL}
          FOR UPDATE`, [id,at,at]);
        if (!candidate) return null;
        await connection.execute(`UPDATE assistant_codex_forward_jobs SET status='running',attempts=attempts+1,
          lease_owner=?,lease_expires_at=?,started_at=COALESCE(started_at,?),updated_at=? WHERE id=?`,
        [owner,at+leaseMs,at,at,candidate.id]);
        const [[claimed]] = await connection.execute(`SELECT id AS internal_id,assistant_codex_forward_jobs.*
          FROM assistant_codex_forward_jobs WHERE id=?`, [candidate.id]);
        return row(claimed);
      });
    },
    claimReplyPending(input) {
      const owner = required(input.owner, 191);
      const leaseMs = Number(input.leaseMs || 60000);
      const take = Math.max(1, Math.min(5, Number(input.limit || 1)));
      return write(async connection => {
        const at = now();
        const [candidates] = await connection.execute(`SELECT id FROM assistant_codex_forward_jobs
          WHERE status='reply_pending' AND (lease_expires_at IS NULL OR lease_expires_at<=?)
            AND (next_attempt_at IS NULL OR next_attempt_at<=?)
            AND ${SAFE_DELIVERY_SQL}
          ORDER BY updated_at,id LIMIT ${take} FOR UPDATE SKIP LOCKED`, [at, at]);
        if (!candidates.length) return [];
        const ids = candidates.map(item => String(item.id));
        const slots = ids.map(() => '?').join(',');
        await connection.execute(`UPDATE assistant_codex_forward_jobs
          SET reply_attempts=reply_attempts+1,lease_owner=?,lease_expires_at=?,updated_at=?
          WHERE id IN (${slots})`, [owner, at + leaseMs, at, ...ids]);
        const [rows] = await connection.execute(`SELECT id AS internal_id, assistant_codex_forward_jobs.*
          FROM assistant_codex_forward_jobs WHERE id IN (${slots}) ORDER BY updated_at,id`, ids);
        return rows.map(row);
      });
    },
    renew(input) {
      const [id, owner] = leaseArgs(input);
      return write(async connection => {
        const at = now();
        const [result] = await connection.execute(`UPDATE assistant_codex_forward_jobs
          SET lease_expires_at=?,updated_at=? WHERE public_run_id=? AND lease_owner=?
            AND lease_expires_at>? AND status IN ('running','reply_pending','held','completed','failed','deferred')`, [at + Number(input.leaseMs || 60000), at, id, owner, at]);
        await assertLease(connection, result);
        return { renewed: true };
      });
    },
    patchExecution(input) {
      const [id, owner] = leaseArgs(input);
      return write(async connection => {
        const at = now();
        const [result] = await connection.execute(`UPDATE assistant_codex_forward_jobs
          SET result_json=JSON_SET(CASE WHEN JSON_VALID(result_json) THEN result_json ELSE JSON_OBJECT() END,
            '$.execution',CAST(? AS JSON)),updated_at=?
          WHERE public_run_id=? AND lease_owner=? AND lease_expires_at>? AND status='running'`, [safeJson(input.execution), at, id, owner, at]);
        await assertLease(connection, result);
        return { updated: true };
      });
    },
    patchFeedback(input) {
      const [id, owner] = leaseArgs(input);
      const key = required(input.key, 32);
      if (!['executionCard', 'typing', 'stop', 'delivery'].includes(key)) throw new StoreError('invalid_store_input');
      return write(async connection => {
        const at = now();
        const updatesCleanup = key === 'typing';
        const cleanupPending = updatesCleanup && input.value?.desired === false
          && !['confirmed', 'not_applicable'].includes(input.value?.outcome);
        const cleanupSql = updatesCleanup ? ',feedback_cleanup_pending=?,feedback_cleanup_at=?' : '';
        const cleanupArgs = updatesCleanup ? [cleanupPending ? 1 : 0, cleanupPending ? Number(input.value?.nextRetryAt || at) : null] : [];
        const [result] = await connection.execute(`UPDATE assistant_codex_forward_jobs
          SET result_json=JSON_SET(CASE WHEN JSON_VALID(result_json) THEN result_json ELSE JSON_OBJECT() END,
            '$.${key}',CAST(? AS JSON))${cleanupSql},updated_at=?
          WHERE public_run_id=? AND lease_owner=? AND lease_expires_at>? AND status IN ('running','reply_pending','held','completed','failed','deferred')`,
        [safeJson(input.value), ...cleanupArgs, at, id, owner, at]);
        await assertLease(connection, result);
        return { updated: true };
      });
    },
    patchReplyResult(input) {
      const [id, owner] = leaseArgs(input);
      return write(async connection => {
        const at = now();
        const [result] = await connection.execute(`UPDATE assistant_codex_forward_jobs
          SET result_json=JSON_MERGE_PATCH(CASE WHEN JSON_VALID(result_json) THEN result_json ELSE JSON_OBJECT() END,
            JSON_REMOVE(CAST(? AS JSON),'$.executionCard','$.typing','$.stop')),updated_at=?
          WHERE public_run_id=? AND lease_owner=? AND lease_expires_at>? AND status='reply_pending'`, [safeJson(input.result || {}), at, id, owner, at]);
        await assertLease(connection, result);
        return { updated: true };
      });
    },
    markReplyPending(input) {
      const [id, owner] = leaseArgs(input);
      const value = { ...input.result, execution: input.execution ?? input.result?.execution };
      return write(async connection => {
        const at = now();
        const [result] = await connection.execute(`UPDATE assistant_codex_forward_jobs
          SET status='reply_pending',
            result_json=JSON_MERGE_PATCH(CASE WHEN JSON_VALID(result_json) THEN result_json ELSE JSON_OBJECT() END,
              JSON_REMOVE(CAST(? AS JSON),'$.executionCard','$.typing','$.stop')),
            last_error=?,lease_expires_at=?,updated_at=?
          WHERE public_run_id=? AND lease_owner=? AND lease_expires_at>? AND status='running'`, [safeJson(value), input.errorCode || '', at, at, id, owner, at]);
        await assertLease(connection, result);
        return { status: 'reply_pending' };
      });
    },
    markFinished(input) {
      const [id, owner] = leaseArgs(input);
      if (!['completed', 'failed', 'deferred'].includes(input.status)) throw new StoreError('invalid_store_input');
      return write(async connection => {
        const at = now();
        const [result] = await connection.execute(`UPDATE assistant_codex_forward_jobs
          SET status=?,
            result_json=JSON_MERGE_PATCH(CASE WHEN JSON_VALID(result_json) THEN result_json ELSE JSON_OBJECT() END,
              JSON_REMOVE(CAST(? AS JSON),'$.executionCard','$.typing','$.stop','$.delivery')),
            last_error=CASE WHEN ?='' THEN last_error ELSE ? END,finished_at=?,reply_sent_at=?,lease_owner='',lease_expires_at=NULL,updated_at=?
          WHERE public_run_id=? AND lease_owner=? AND lease_expires_at>? AND status='reply_pending'`, [input.status, safeJson(input.result || {}), input.errorCode || '', input.errorCode || '', at, input.replySent === false ? null : at, at, id, owner, at]);
        await assertLease(connection, result);
        return { status: input.status };
      });
    },
    markFinishedWithoutReply(input) {
      const [id, owner] = leaseArgs(input);
      if (!['completed', 'deferred'].includes(input.status)) throw new StoreError('invalid_store_input');
      return write(async connection => {
        const at = now();
        const [result] = await connection.execute(`UPDATE assistant_codex_forward_jobs
          SET status=?,
            result_json=JSON_MERGE_PATCH(CASE WHEN JSON_VALID(result_json) THEN result_json ELSE JSON_OBJECT() END,
              JSON_REMOVE(CAST(? AS JSON),'$.executionCard','$.typing','$.stop')),
            last_error=CASE WHEN ?='' THEN last_error ELSE ? END,finished_at=?,reply_sent_at=NULL,lease_owner='',lease_expires_at=NULL,updated_at=?
          WHERE public_run_id=? AND lease_owner=? AND lease_expires_at>? AND status='running'`, [input.status, safeJson(input.result || {}), input.errorCode || '', input.errorCode || '', at, at, id, owner, at]);
        await assertLease(connection, result);
        return { status: input.status };
      });
    },
    markRetry(input) {
      const [id, owner] = leaseArgs(input);
      return write(async connection => {
        const isTerminal = Boolean(input.terminal);
        const status = isTerminal ? 'failed' : input.held ? 'held' : input.replyPending ? 'reply_pending' : 'pending';
        const at = now();
        const [result] = await connection.execute(`UPDATE assistant_codex_forward_jobs
          SET status=?,last_error=?,next_attempt_at=?,finished_at=?,
            attempts=GREATEST(attempts-?,0),lease_owner='',lease_expires_at=NULL,updated_at=?
          WHERE public_run_id=? AND lease_owner=? AND lease_expires_at>? AND status IN ('running','reply_pending')`, [status, input.errorCode || '', isTerminal ? null : (input.nextAttemptAt ?? at + 1000), isTerminal ? at : null, input.preserveAttempt ? 1 : 0, at, id, owner, at]);
        await assertLease(connection, result);
        return { status };
      });
    },
    beginStop(input) {
      const id = required(input.id, 36);
      const threadId = required(input.threadId, 255);
      const turnId = required(input.turnId, 255);
      const messageId = required(input.messageId, 191);
      return write(async connection => {
        const [[found]] = await connection.execute(`SELECT status,message_id,result_json FROM assistant_codex_forward_jobs
          WHERE public_run_id=? FOR UPDATE`, [id]);
        if (!found) return { outcome: 'not_found' };
        const result = parse(found.result_json);
        const execution = result.execution || {};
        if (execution.threadId !== threadId || execution.turnId !== turnId || found.message_id !== messageId) return { outcome: 'stale' };
        if (found.status !== 'running') return { outcome: 'already_finished' };
        const previous = result.stop;
        if (previous?.threadId === threadId && previous?.turnId === turnId && previous?.messageId === messageId) {
          return { outcome: 'replay', stop: previous };
        }
        const stop = { threadId, turnId, messageId, actor: required(input.actor, 191), intentAt: now(), outcome: 'pending' };
        await connection.execute(`UPDATE assistant_codex_forward_jobs
          SET result_json=JSON_SET(CASE WHEN JSON_VALID(result_json) THEN result_json ELSE JSON_OBJECT() END,
            '$.stop',CAST(? AS JSON)),updated_at=? WHERE public_run_id=? AND status='running'`, [safeJson(stop), now(), id]);
        return { outcome: 'new', stop };
      });
    },
    finishStop(input) {
      const id = required(input.id, 36);
      const stop = input.stop;
      if (!stop || !['requested', 'already_finished', 'unconfirmed'].includes(stop.outcome)) throw new StoreError('invalid_store_input');
      return write(async connection => {
        const at = now();
        const definitive = stop.outcome !== 'unconfirmed';
        const [result] = await connection.execute(`UPDATE assistant_codex_forward_jobs
          SET result_json=JSON_SET(CASE WHEN JSON_VALID(result_json) THEN result_json ELSE JSON_OBJECT() END,
            '$.stop',CAST(? AS JSON)),updated_at=?
          WHERE public_run_id=? AND status='running'
            AND JSON_UNQUOTE(JSON_EXTRACT(result_json,'$.stop.threadId'))=?
            AND JSON_UNQUOTE(JSON_EXTRACT(result_json,'$.stop.turnId'))=?
            AND JSON_UNQUOTE(JSON_EXTRACT(result_json,'$.stop.messageId'))=?
            AND JSON_UNQUOTE(JSON_EXTRACT(result_json,'$.stop.outcome')) ${definitive ? "IN ('pending','unconfirmed')" : "='pending'"}`,
        [safeJson(stop), at, id, stop.threadId, stop.turnId, stop.messageId]);
        if (result.affectedRows) return { stop };
        const [[found]] = await connection.execute(`SELECT result_json FROM assistant_codex_forward_jobs
          WHERE public_run_id=? LIMIT 1`, [id]);
        const saved = parse(found?.result_json).stop;
        if (saved?.threadId === stop.threadId && saved?.turnId === stop.turnId && saved?.messageId === stop.messageId) {
          return { stop: saved, replay: true };
        }
        throw new StoreError('stop_conflict');
      });
    },
    claimFeedbackPending(input) {
      const owner = required(input.owner, 191);
      const leaseMs = Number(input.leaseMs || 60000);
      const take = Math.max(1, Math.min(5, Number(input.limit || 1)));
      return write(async connection => {
        const at = now();
        const [candidates] = await connection.execute(`SELECT id FROM assistant_codex_forward_jobs
          FORCE INDEX (idx_forward_feedback_cleanup)
          WHERE feedback_cleanup_pending=1 AND feedback_cleanup_at<=?
            AND status IN ('held','completed','failed','deferred')
            AND (lease_expires_at IS NULL OR lease_expires_at<=?)
          ORDER BY feedback_cleanup_at,id LIMIT ${take} FOR UPDATE SKIP LOCKED`, [at, at]);
        if (!candidates.length) return [];
        const ids = candidates.map(item => String(item.id));
        const slots = ids.map(() => '?').join(',');
        await connection.execute(`UPDATE assistant_codex_forward_jobs SET lease_owner=?,lease_expires_at=?,updated_at=?
          WHERE id IN (${slots})`, [owner, at + leaseMs, at, ...ids]);
        const [rows] = await connection.execute(`SELECT id AS internal_id,assistant_codex_forward_jobs.*
          FROM assistant_codex_forward_jobs WHERE id IN (${slots}) ORDER BY updated_at,id`, ids);
        return rows.map(row);
      });
    },
    releaseFeedback(input) {
      const [id, owner] = leaseArgs(input);
      return write(async connection => {
        const at = now();
        const [result] = await connection.execute(`UPDATE assistant_codex_forward_jobs
          SET lease_owner='',lease_expires_at=NULL,feedback_cleanup_at=?,updated_at=?
          WHERE public_run_id=? AND lease_owner=? AND lease_expires_at>? AND status IN ('held','completed','failed','deferred')`,
        [input.nextAttemptAt ?? null, at, id, owner, at]);
        await assertLease(connection, result);
        return { released: true };
      });
    },
    readEvents(input) {
      return read(async connection => {
        const [[found]] = await connection.execute(`SELECT sender_open_id,chat_id,message_id,result_json
          FROM assistant_codex_forward_jobs WHERE public_run_id=? LIMIT 1`, [required(input.id, 36)]);
        if (!found) return [];
        const execution = parse(found.result_json).execution || {};
        if (!execution.bindingOpenId || !execution.threadId) return [];
        const after = String(input.after ?? '0');
        if (!/^\d+$/.test(after)) throw new StoreError('invalid_store_input');
        const take = Math.max(1, Math.min(100, Number(input.limit || 50)));
        const [rows] = await connection.execute(`SELECT id,event_key,event_type,role,title,text,detail_json,created_at
          FROM assistant_codex_events
          WHERE feishu_open_id=? AND chat_id=? AND codex_session_id=? AND message_id=? AND id>?
            AND event_type IN ('public_progress','agent_message','error','session_rollover')
          ORDER BY id LIMIT ${take}`, [execution.bindingOpenId, found.chat_id, execution.threadId, found.message_id, after]);
        return rows.map(item => {
          const progress = item.event_type === 'public_progress' ? parse(item.detail_json) : undefined;
          const payload = { role: item.role, title: item.title, text: item.text, ...(progress ? { progress } : {}) };
          return {
            id: String(item.id), sequence: String(item.id), runId: input.id, eventKey: item.event_key,
            type: item.event_type, role: item.role, title: item.title, text: item.text,
            ...(progress ? { progress } : {}), payload, createdAt: Number(item.created_at),
          };
        });
      });
    },
  });
}
