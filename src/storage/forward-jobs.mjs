import { createHash, randomUUID } from 'node:crypto';
import { withConnection } from './connection.mjs';
import { StoreError } from './errors.mjs';

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
        await connection.execute(`INSERT IGNORE INTO assistant_codex_forward_jobs
          (public_run_id,request_key_hash,request_hash,caller_id,execution_namespace,delivery_mode,message_id,chat_id,chat_type,message_type,sender_open_id,sender_name,conversation_scope,prompt,group_chat_context_json,context_entries_json,status,next_attempt_at,result_json,last_error,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [publicRunId,keyHash,requestHash,callerId,input.executionNamespace || '',input.deliveryMode || 'bridge',required(input.messageId,191),required(input.conversationId,191),input.chatType || 'group',input.messageType || 'text',input.senderOpenId || '',input.senderName || '',input.chatType === 'p2p' ? 'p2p' : 'group',input.prompt || '',safeJson(input.groupChatContext),safeJson(input.contextEntries || []),'pending',input.nextAttemptAt ?? createdAt,'{}','',createdAt,createdAt]);
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
          ORDER BY created_at,id LIMIT ${take} FOR UPDATE SKIP LOCKED`, [at,at]);
        if (!candidates.length) return [];
        const ids = candidates.map(item => String(item.id));
        await connection.execute(`UPDATE assistant_codex_forward_jobs SET status='running',attempts=attempts+1,lease_owner=?,lease_expires_at=?,started_at=COALESCE(started_at,?),updated_at=? WHERE id IN (${ids.map(()=>'?').join(',')})`, [owner,at+leaseMs,at,at,...ids]);
        const [rows] = await connection.execute(`SELECT id AS internal_id, assistant_codex_forward_jobs.* FROM assistant_codex_forward_jobs WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY created_at,id`,ids);
        return rows.map(row);
      });
    },
    claimReplyPending(input) {
      const owner=required(input.owner,191); const leaseMs=Number(input.leaseMs||60000); const take=Math.max(1,Math.min(5,Number(input.limit||1)));
      return write(async connection=>{ const at=now(); const [candidates]=await connection.execute(`SELECT id FROM assistant_codex_forward_jobs WHERE status='reply_pending' AND (lease_expires_at IS NULL OR lease_expires_at<=?) AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY updated_at,id LIMIT ${take} FOR UPDATE SKIP LOCKED`,[at,at]); if(!candidates.length)return[]; const ids=candidates.map(x=>String(x.id)); await connection.execute(`UPDATE assistant_codex_forward_jobs SET reply_attempts=reply_attempts+1,lease_owner=?,lease_expires_at=?,updated_at=? WHERE id IN (${ids.map(()=>'?').join(',')})`,[owner,at+leaseMs,at,...ids]); const [rows]=await connection.execute(`SELECT id AS internal_id, assistant_codex_forward_jobs.* FROM assistant_codex_forward_jobs WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY updated_at,id`,ids); return rows.map(row); });
    },
    renew(input) { const [id,owner]=leaseArgs(input); return write(async connection=>{ const [result]=await connection.execute("UPDATE assistant_codex_forward_jobs SET lease_expires_at=?,updated_at=? WHERE public_run_id=? AND lease_owner=? AND status IN ('running','reply_pending')",[now()+Number(input.leaseMs||60000),now(),id,owner]); await assertLease(connection,result); return {renewed:true}; }); },
    patchExecution(input) { const [id,owner]=leaseArgs(input); return write(async connection=>{ const encoded=safeJson(input.execution); const [result]=await connection.execute("UPDATE assistant_codex_forward_jobs SET result_json=JSON_SET(CASE WHEN JSON_VALID(result_json) THEN result_json ELSE JSON_OBJECT() END,'$.execution',CAST(? AS JSON)),updated_at=? WHERE public_run_id=? AND lease_owner=? AND status='running'",[encoded,now(),id,owner]); await assertLease(connection,result); return {updated:true}; }); },
    patchFeedback(input) { const [id,owner]=leaseArgs(input); const key=required(input.key,32); if(!['executionCard','typing','stop'].includes(key))throw new StoreError('invalid_store_input'); return write(async connection=>{ const [result]=await connection.execute(`UPDATE assistant_codex_forward_jobs SET result_json=JSON_SET(CASE WHEN JSON_VALID(result_json) THEN result_json ELSE JSON_OBJECT() END,'$.${key}',CAST(? AS JSON)),updated_at=? WHERE public_run_id=? AND lease_owner=? AND status IN ('running','reply_pending')`,[safeJson(input.value),now(),id,owner]); await assertLease(connection,result); return {updated:true}; }); },
    markReplyPending(input) { const [id,owner]=leaseArgs(input); return write(async connection=>{ const value={...input.result,execution:input.execution??input.result?.execution}; const [result]=await connection.execute("UPDATE assistant_codex_forward_jobs SET status='reply_pending',result_json=?,last_error=?,lease_expires_at=?,updated_at=? WHERE public_run_id=? AND lease_owner=? AND status='running'",[safeJson(value),input.errorCode||'',now(),now(),id,owner]); await assertLease(connection,result); return {status:'reply_pending'}; }); },
    markFinished(input) { const [id,owner]=leaseArgs(input); if(!['completed','failed','deferred'].includes(input.status))throw new StoreError('invalid_store_input'); return write(async connection=>{ const at=now(); const [result]=await connection.execute("UPDATE assistant_codex_forward_jobs SET status=?,result_json=?,last_error=?,finished_at=?,reply_sent_at=?,lease_owner='',lease_expires_at=NULL,updated_at=? WHERE public_run_id=? AND lease_owner=? AND status='reply_pending'",[input.status,safeJson(input.result||{}),input.errorCode||'',at,input.replySent===false?null:at,at,id,owner]); await assertLease(connection,result); return {status:input.status}; }); },
    markRetry(input) { const [id,owner]=leaseArgs(input); return write(async connection=>{ const terminal=Boolean(input.terminal); const status=terminal?'failed':input.held?'held':(input.replyPending?'reply_pending':'pending'); const at=now(); const [result]=await connection.execute("UPDATE assistant_codex_forward_jobs SET status=?,last_error=?,next_attempt_at=?,finished_at=?,lease_owner='',lease_expires_at=NULL,updated_at=? WHERE public_run_id=? AND lease_owner=? AND status IN ('running','reply_pending')",[status,input.errorCode||'',terminal?null:(input.nextAttemptAt??at+1000),terminal?at:null,at,id,owner]); await assertLease(connection,result); return {status}; }); },
    readEvents(input) { return read(async connection=>{ const [[found]]=await connection.execute('SELECT message_id FROM assistant_codex_forward_jobs WHERE public_run_id=? LIMIT 1',[required(input.id,36)]); if(!found)return[]; const after=String(input.after??'0'); if(!/^\d+$/.test(after))throw new StoreError('invalid_store_input'); const take=Math.max(1,Math.min(100,Number(input.limit||50))); const [rows]=await connection.execute(`SELECT id,codex_session_id,feishu_open_id,chat_id,message_id,event_type,role,title,text,detail_json,created_at FROM assistant_codex_events WHERE message_id=? AND id>? ORDER BY id LIMIT ${take}`,[found.message_id,after]); return rows.map(item=>({...item,id:String(item.id),detail:parse(item.detail_json)})); }); },
  });
}
