import { createHash, randomUUID } from 'node:crypto';
import { withConnection } from './connection.mjs';
import { assertSchemaCurrent } from './migrations.mjs';
import { acquireWriter } from './writer.mjs';
import { StoreError } from './errors.mjs';
import { recoveryOperations } from './recovery.mjs';
import { rotationOperations } from './rotation.mjs';
import { steeringOperations } from './steering.mjs';

const json = (value) => JSON.stringify(value);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
const hash = (value) => createHash('sha256').update(json(canonical(value))).digest('hex');
const decode = (row) => row && Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), value]));
function text(value, max = 255) { if (typeof value !== 'string' || !value.length || value.length > max) throw new StoreError('invalid_store_input'); return value; }
function limit(value = 50) { if (!Number.isInteger(value) || value < 1 || value > 100) throw new StoreError('invalid_store_limit'); return value; }
function scope(input) { return [text(input.connectionId, 128), text(input.conversationId)]; }
function lease(input) { text(input.id, 36); text(input.leaseToken, 36); }

export async function createMysqlStore({ pool, operationTimeoutMs = 1800, onWriterLost, now = Date.now }) {
  await assertSchemaCurrent(pool);
  const activeConnections = new Set();
  const writer = await acquireWriter(pool, (error) => {
    for(const connection of activeConnections)connection.destroy();
    try { Promise.resolve(onWriterLost?.(error)).catch(() => {}); } catch { /* Host callback cannot revive the writer. */ }
  }, { timeoutMs: operationTimeoutMs });
  const read = (fn) => withConnection(pool, fn, { timeoutMs: operationTimeoutMs });
  const write = async (fn) => {
    writer.assert();
    let active;
    try {
      return await withConnection(pool, async (connection) => {
        active = connection;
        activeConnections.add(connection);
        await writer.verify();
        const result = await fn(connection);
        await writer.verify();
        return result;
      }, { timeoutMs: operationTimeoutMs, transaction: true });
    } finally {
      if (active) activeConnections.delete(active);
    }
  };
  async function claimThread(c, connectionId, conversationId, agentId, nativeThreadId) {
    if (nativeThreadId == null) return;
    text(nativeThreadId);
    await c.execute(`INSERT INTO bridge_thread_owners (connection_id,native_thread_id,conversation_id,agent_id)
      VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE native_thread_id=native_thread_id`, [connectionId,nativeThreadId,conversationId,agentId]);
    const [[owner]] = await c.execute(`SELECT conversation_id,agent_id FROM bridge_thread_owners
      WHERE connection_id=? AND native_thread_id=?`, [connectionId,nativeThreadId]);
    if (owner.conversation_id !== conversationId || owner.agent_id !== agentId) throw new StoreError('thread_scope_conflict');
  }
  async function lockRegistration(c, connectionId, conversationId) {
    // Lock before allocating inbox/job sequences. Otherwise a later transaction
    // may commit first and become runnable while an earlier sequence is hidden.
    await c.execute(`INSERT INTO bridge_registration_scopes (connection_id,conversation_id)
      VALUES (?,?) ON DUPLICATE KEY UPDATE conversation_id=conversation_id`, [connectionId,conversationId]);
  }
  async function insertJob(c, input) {
    const [connectionId, conversationId] = scope(input);
    await lockRegistration(c,connectionId,conversationId);
    if (!['agent', 'hook'].includes(input.kind)) throw new StoreError('invalid_job_kind');
    const hookId = input.kind === 'hook' ? text(input.hookId, 128) : '';
    const key = text(input.idempotencyKey);
    const payloadHash = hash({ conversationId, payload: input.payload });
    const id = randomUUID();
    await c.execute(`INSERT INTO bridge_jobs (id,kind,connection_id,conversation_id,hook_id,idempotency_key,event_id,source_sequence,payload_hash,payload,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id`, [id,input.kind,connectionId,conversationId,hookId,key,input.eventId ?? null,input.sourceSequence ?? null,payloadHash,json(input.payload),now(),now(),now()]);
    const [[row]] = await c.execute('SELECT id,payload_hash FROM bridge_jobs WHERE connection_id=? AND kind=? AND hook_id=? AND idempotency_key=?', [connectionId,input.kind,hookId,key]);
    if (row.payload_hash !== payloadHash) throw new StoreError('job_conflict');
    return { id: row.id, duplicate: row.id !== id };
  }
  async function insertOutbox(c, input) {
    const [connectionId, conversationId] = scope(input);
    const key = text(input.idempotencyKey);
    if (!['create','reply','reaction','upload','update','artifact_upload','artifact_send'].includes(input.kind)) throw new StoreError('invalid_outbox_kind');
    if (input.kind.startsWith('artifact_')) {
      const artifactScope = input.payload?.scope;
      const ref = input.payload?.ref;
      if (!input.jobId || !artifactScope || !ref || artifactScope.connectionId !== connectionId
          || artifactScope.conversationId !== conversationId || artifactScope.runId !== input.jobId
          || ref.connectionId !== connectionId || ref.conversationId !== conversationId
          || ref.runId !== input.jobId) throw new StoreError('invalid_artifact_effect');
      text(ref.artifactId);
      if (input.kind === 'artifact_send') {
        const [[predecessor]] = await c.execute(`SELECT kind,job_id,payload FROM bridge_outbox
          WHERE id=? AND connection_id=? AND conversation_id=?`, [text(input.predecessorId,36),connectionId,conversationId]);
        if (!predecessor || predecessor.kind !== 'artifact_upload' || predecessor.job_id !== input.jobId
            || hash(predecessor.payload.ref) !== hash(ref)) throw new StoreError('invalid_artifact_effect');
      }
    }
    const payloadHash = hash({ conversationId, kind: input.kind, payload: input.payload });
    const id = randomUUID();
    await c.execute(`INSERT INTO bridge_outbox (id,connection_id,conversation_id,idempotency_key,kind,payload_hash,payload,job_id,predecessor_id,platform_uuid,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id`, [id,connectionId,conversationId,key,input.kind,payloadHash,json(input.payload),input.jobId ?? null,input.predecessorId ?? null,input.platformUuid ?? randomUUID(),now(),now(),now()]);
    const [[row]] = await c.execute('SELECT id,payload_hash,platform_uuid,job_id,predecessor_id FROM bridge_outbox WHERE connection_id=? AND idempotency_key=?', [connectionId,key]);
    if (row.payload_hash !== payloadHash || row.job_id !== (input.jobId ?? null) || row.predecessor_id !== (input.predecessorId ?? null)) throw new StoreError('outbox_conflict');
    return { id: row.id, platformUuid: row.platform_uuid, predecessorId: row.predecessor_id, duplicate: row.id !== id };
  }
  async function owned(c, table, input) {
    lease(input);
    const columns = table === 'bridge_jobs' ? 'id,kind,connection_id,conversation_id' : 'id,job_id';
    const [[row]] = await c.execute(`SELECT ${columns},status,lease_token,lease_expires_at FROM ${table} WHERE id=? FOR UPDATE`, [input.id]);
    if (!row || row.lease_token !== input.leaseToken || row.status !== 'running' || Number(row.lease_expires_at) <= now()) throw new StoreError('stale_lease');
    return row;
  }
  async function releaseAttempt(c, jobId) {
    const [[attempt]] = await c.execute(`SELECT connection_id,conversation_id,agent_id,generation
      FROM bridge_attempts WHERE job_id=?`, [jobId]);
    if (!attempt) return;
    const [result] = await c.execute(`UPDATE bridge_sessions SET active_run_id=NULL,updated_at=?
      WHERE connection_id=? AND conversation_id=? AND agent_id=? AND generation=? AND active_run_id=?`, [
      now(), attempt.connection_id, attempt.conversation_id, attempt.agent_id, attempt.generation, jobId,
    ]);
    if (!result.affectedRows) throw new StoreError('session_conflict');
  }
  async function claim(table, input) {
    const take = limit(input.limit);
    text(input.owner, 128);
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 100 || input.leaseMs > 300000) throw new StoreError('invalid_lease');
    return write(async (c) => {
      let condition;
      let params;
      if (table === 'bridge_jobs') {
        if (!['agent','hook'].includes(input.kind)) throw new StoreError('invalid_job_kind');
        condition = `j.kind=? AND (
          (j.status='pending' AND j.next_attempt_at<=?) OR
          (j.status='running' AND j.lease_expires_at<=?)
        ) AND (j.kind<>'hook' OR NOT EXISTS (
          SELECT 1 FROM bridge_jobs prior
          WHERE prior.connection_id=j.connection_id AND prior.conversation_id=j.conversation_id
            AND prior.hook_id=j.hook_id AND prior.kind='hook'
            AND prior.status NOT IN ('succeeded','failed','cancelled') AND prior.sequence<j.sequence
        ))`;
        params = [input.kind, now(), now()];
      } else {
        // An expired send lease is ambiguous, including after process death.
        await c.execute("UPDATE bridge_outbox SET status='unknown',lease_token=NULL,lease_owner=NULL WHERE status='running' AND lease_expires_at<=? ORDER BY lease_expires_at,id LIMIT 100", [now()]);
        condition = `((j.status='pending' AND j.next_attempt_at<=?) OR
          (j.status='unknown' AND j.kind IN ('create','reply','artifact_send') AND j.first_attempt_at>? AND j.next_attempt_at<=?))
          AND (j.predecessor_id IS NULL OR EXISTS (
            SELECT 1 FROM bridge_outbox predecessor WHERE predecessor.id=j.predecessor_id AND predecessor.status='sent'
          ))`;
        params = [now(), now()-55*60*1000, now()];
      }
      const [rows] = await c.execute(`SELECT j.* FROM ${table} j WHERE ${condition} ORDER BY j.created_at,j.id LIMIT ${take} FOR UPDATE SKIP LOCKED`, params);
      const result = [];
      for (const row of rows) {
        const token = randomUUID();
        await c.execute(`UPDATE ${table} SET status='running',attempts=attempts+1,lease_owner=?,lease_token=?,lease_expires_at=?,updated_at=?${table === 'bridge_outbox' ? ',first_attempt_at=COALESCE(first_attempt_at,?)' : ''} WHERE id=?`, [input.owner,token,now()+input.leaseMs,now(),...(table === 'bridge_outbox' ? [now()] : []),row.id]);
        result.push(decode({
          ...row, status: 'running', attempts: row.attempts + 1,
          lease_token: token, lease_expires_at: now() + input.leaseMs, lease_owner: input.owner,
          ...(table === 'bridge_outbox' ? { first_attempt_at: row.first_attempt_at ?? now() } : {}),
        }));
      }
      return result;
    });
  }
  return {
    ...recoveryOperations({ read, write, now, hash, decode, claimThread }),
    ...rotationOperations({write,now,hash,owned}),
    ...steeringOperations({read,write,now,hash,decode}),
    assertCurrent: () => assertSchemaCurrent(pool),
    async close() { await writer.close(); await pool.end(); },
    acceptInbound(input) {
      return write(async (c) => {
        const [connectionId, conversationId] = scope(input);
        const source = input.source ?? input.payload?.source ?? 'live';
        const conversationType = input.conversationType ?? input.payload?.conversationType ?? 'unknown';
        if (!['live', 'history_catchup'].includes(source) || !['p2p', 'group', 'unknown'].includes(conversationType)
          || (input.payload?.source && input.payload.source !== source)
          || (input.payload?.conversationType && input.payload.conversationType !== conversationType)) {
          throw new StoreError('invalid_inbound_source');
        }
        await lockRegistration(c, connectionId, conversationId);
        if (conversationType !== 'unknown') {
          await c.execute(`INSERT INTO bridge_conversations (connection_id,conversation_id,conversation_type)
            VALUES (?,?,?) ON DUPLICATE KEY UPDATE conversation_id=conversation_id`, [connectionId, conversationId, conversationType]);
          const [[known]] = await c.execute(`SELECT conversation_type FROM bridge_conversations
            WHERE connection_id=? AND conversation_id=?`, [connectionId, conversationId]);
          if (known.conversation_type !== conversationType) throw new StoreError('conversation_type_conflict');
        }
        const canonical = input.eventType === 'message.received';
        let receipt;
        if (canonical) {
          text(input.messageId);
          [[receipt]] = await c.execute(`SELECT first_event_id FROM bridge_message_receipts
            WHERE connection_id=? AND conversation_id=? AND message_id=?`, [connectionId, conversationId, input.messageId]);
        }
        const payloadHash = hash(input.semanticPayload ?? input.payload);
        const id = randomUUID();
        await c.execute(`INSERT INTO bridge_inbox (id,connection_id,event_key,event_type,message_id,revision,conversation_id,occurred_at,payload_hash,payload,policy_version,passive_context,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id`, [
          id, connectionId, text(input.eventKey), text(input.eventType,64), input.messageId ?? '', input.revision ?? '',
          conversationId, input.occurredAt ?? now(), payloadHash, json({...input.payload, source, conversationType}),
          text(input.policyVersion,128), !receipt && input.passiveContext === true, now(),
        ]);
        const [[row]] = await c.execute('SELECT id,sequence,payload_hash FROM bridge_inbox WHERE connection_id=? AND event_key=?', [connectionId,input.eventKey]);
        // History is a snapshot, not an edit event. A changed later snapshot
        // cannot replace the first receipt or create another consumer job.
        if (row.payload_hash !== payloadHash && !(receipt && source === 'history_catchup')) throw new StoreError('inbound_conflict');
        const duplicateCanonical = Boolean(receipt);
        if (canonical && !receipt) {
          await c.execute(`INSERT INTO bridge_message_receipts (connection_id,conversation_id,message_id,first_event_id)
            VALUES (?,?,?,?)`, [connectionId, conversationId, input.messageId, row.id]);
        }
        if (row.id !== id || duplicateCanonical) {
          const firstEventId = receipt?.first_event_id ?? row.id;
          const [[first]] = await c.execute('SELECT sequence FROM bridge_inbox WHERE id=?', [firstEventId]);
          const [jobs] = await c.execute('SELECT id,kind FROM bridge_jobs WHERE event_id=?', [firstEventId]);
          return {
            eventId: firstEventId, sequence: first.sequence, duplicate: true, firstReceipt: false, duplicateCanonical,
            agentJobId: jobs.find(job => job.kind === 'agent')?.id ?? null,
            hookJobIds: jobs.filter(job => job.kind === 'hook').map(job => job.id),
          };
        }
        if (input.recalledMessageId) {
          await c.execute(`INSERT INTO bridge_message_tombstones (connection_id,message_id,created_at)
            VALUES (?,?,?) ON DUPLICATE KEY UPDATE message_id=message_id`, [connectionId,text(input.recalledMessageId),now()]);
        }
        const common = { connectionId,conversationId,eventId:id,sourceSequence:row.sequence,idempotencyKey:input.eventKey };
        const agent = input.agentJob ? await insertJob(c,{...common,kind:'agent',payload:input.agentJob.payload}) : null;
        const hooks = [];
        for (const hook of input.hooks ?? []) {
          hooks.push((await insertJob(c,{...common,kind:'hook',hookId:hook.hookId,payload:hook.payload ?? input.payload})).id);
        }
        return {eventId:id,sequence:row.sequence,duplicate:false,firstReceipt:true,duplicateCanonical:false,agentJobId:agent?.id ?? null,hookJobIds:hooks};
      });
    },
    listKnownConversations(input) {
      return read(async (c) => {
        const take = limit(input.limit);
        if (input.conversationType !== 'p2p') throw new StoreError('invalid_conversation_type');
        const [rows] = await c.execute(`SELECT conversation_id,conversation_type FROM bridge_conversations
          WHERE connection_id=? AND conversation_type='p2p' AND conversation_id>?
          ORDER BY conversation_id LIMIT ${take + 1}`, [text(input.connectionId,128), input.afterConversationId === undefined ? '' : text(input.afterConversationId)]);
        const items = rows.slice(0,take).map(decode);
        return {items,nextCursor:rows.length>take ? items.at(-1).conversationId : null};
      });
    },
    enqueueJob: (input) => write((c)=>insertJob(c,input)),
    recordOutbox: (input) => write((c)=>insertOutbox(c,input)),
    claimJobs: (input) => claim('bridge_jobs',input),
    claimOutbox: (input) => claim('bridge_outbox',input),
    renewJob(input) {
      return write(async (c) => {
        await owned(c, 'bridge_jobs', input);
        if (!Number.isInteger(input.leaseMs) || input.leaseMs < 100 || input.leaseMs > 300000) {
          throw new StoreError('invalid_lease');
        }
        await c.execute('UPDATE bridge_jobs SET lease_expires_at=? WHERE id=?', [now() + input.leaseMs, input.id]);
        return { renewed: true };
      });
    },
    finishJobWithOutbox(input) {
      return write(async (c) => {
        const row = await owned(c, 'bridge_jobs', input);
        await releaseAttempt(c, row.id);
        const outbox = [];
        let predecessorId = null;
        let predecessorKey;
        for (const effect of input.outbox ?? []) {
          if (effect.predecessorIdempotencyKey !== undefined && effect.predecessorIdempotencyKey !== predecessorKey) {
            throw new StoreError('invalid_outbox_predecessor');
          }
          const recorded = await insertOutbox(c, {
            ...effect, predecessorId, connectionId: row.connection_id,
            conversationId: row.conversation_id, jobId: row.id,
          });
          outbox.push(recorded);
          predecessorId = recorded.id;
          predecessorKey = effect.idempotencyKey;
        }
        const status = outbox.length ? 'reply_pending' : 'succeeded';
        await c.execute(`UPDATE bridge_jobs SET status=?,result=?,lease_token=NULL,
          lease_owner=NULL,updated_at=? WHERE id=?`, [status, json(input.result ?? null), now(), input.id]);
        return { status, outbox };
      });
    },
    holdAgentAttempt(input) {
      return write(async (c) => {
        const row = await owned(c, 'bridge_jobs', input);
        if (row.kind !== 'agent') throw new StoreError('invalid_job_kind');
        await c.execute(`UPDATE bridge_jobs SET status='unknown',error_code=?,
          lease_token=NULL,lease_owner=NULL,updated_at=? WHERE id=?`, [text(input.errorCode, 64), now(), input.id]);
        return { status: 'unknown' };
      });
    },
    retryJob(input) {
      return write(async (c) => {
        const row = await owned(c, 'bridge_jobs', input);
        if (input.terminal) await releaseAttempt(c, row.id);
        await c.execute(`UPDATE bridge_jobs SET status=?,next_attempt_at=?,error_code=?,
          lease_token=NULL,lease_owner=NULL,updated_at=? WHERE id=?`, [
          input.terminal ? 'failed' : 'pending', input.nextAttemptAt ?? now(),
          text(input.errorCode, 64), now(), input.id,
        ]);
        return { updated: true };
      });
    },
    settleOutbox(input) {
      return write(async (c) => {
        const row = await owned(c, 'bridge_outbox', input);
        if (!['sent', 'unknown', 'failed', 'pending'].includes(input.status)) {
          throw new StoreError('invalid_outbox_status');
        }
        await c.execute(`UPDATE bridge_outbox SET status=?,result=?,error_code=?,next_attempt_at=?,
          cleanup_pending=IF(kind='artifact_send' AND ?='sent',TRUE,cleanup_pending),lease_token=NULL,lease_owner=NULL,updated_at=? WHERE id=?`, [
          input.status, json(input.result ?? null), input.errorCode ?? null,
          input.nextAttemptAt ?? now(), input.status, now(), input.id,
        ]);
        if (row.job_id && input.status === 'sent') {
          await c.execute(`UPDATE bridge_jobs SET status='succeeded',updated_at=?
            WHERE id=? AND status='reply_pending' AND NOT EXISTS (
              SELECT 1 FROM bridge_outbox WHERE job_id=? AND status<>'sent'
            )`, [now(), row.job_id, row.job_id]);
        }
        if (row.job_id && input.status === 'failed') {
          await c.execute(`UPDATE bridge_jobs SET status='delivery_failed',updated_at=?
            WHERE id=? AND status='reply_pending'`, [now(), row.job_id]);
        }
        return { status: input.status };
      });
    },
    beginAgentAttempt(input) {
      return write(async (c) => {
        const job = await owned(c, 'bridge_jobs', input);
        if (job.kind !== 'agent') throw new StoreError('invalid_job_kind');
        const [[existing]] = await c.execute(`SELECT job_id,connection_id,conversation_id,agent_id,
          generation,native_thread_id,native_turn_id,created_at FROM bridge_attempts WHERE job_id=?`, [job.id]);
        if (existing) return { ...decode(existing), recoveryRequired: true };
        const [[steering]] = await c.execute(`SELECT status FROM bridge_steering
          WHERE guidance_job_id=? AND status IN ('intent','unknown') LIMIT 1`, [job.id]);
        if (steering) throw new StoreError('steer_recovery_required');
        const key = [job.connection_id, job.conversation_id, text(input.agentId, 128)];
        await c.execute(`INSERT INTO bridge_sessions (connection_id,conversation_id,agent_id,updated_at)
          VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE agent_id=agent_id`, [...key, now()]);
        const [[session]] = await c.execute(`SELECT generation,native_thread_id,active_run_id FROM bridge_sessions
          WHERE connection_id=? AND conversation_id=? AND agent_id=? FOR UPDATE`, key);
        if (session.active_run_id) throw new StoreError('session_busy');
        await c.execute(`UPDATE bridge_sessions SET active_run_id=?,updated_at=?
          WHERE connection_id=? AND conversation_id=? AND agent_id=?`, [job.id, now(), ...key]);
        await c.execute(`INSERT INTO bridge_attempts
          (job_id,connection_id,conversation_id,agent_id,generation,native_thread_id,created_at)
          VALUES (?,?,?,?,?,?,?)`, [job.id, ...key, session.generation, session.native_thread_id, now()]);
        return {
          jobId: job.id, generation: session.generation,
          nativeThreadId: session.native_thread_id, recoveryRequired: false,
        };
      });
    },
    bindAgentAttempt(input) {
      return write(async (c) => {
        await owned(c, 'bridge_jobs', input);
        const [[attempt]] = await c.execute(`SELECT connection_id,conversation_id,agent_id,
          generation,native_thread_id,native_turn_id,created_at FROM bridge_attempts WHERE job_id=? FOR UPDATE`, [input.id]);
        if (!attempt || String(attempt.generation) !== String(input.expectedGeneration)) {
          throw new StoreError('session_conflict');
        }
        if (attempt.native_thread_id && attempt.native_thread_id !== input.nativeThreadId) {
          throw new StoreError('thread_conflict');
        }
        if (attempt.native_turn_id && attempt.native_turn_id !== (input.nativeTurnId ?? attempt.native_turn_id)) {
          throw new StoreError('turn_conflict');
        }
        const [result] = await c.execute(`UPDATE bridge_sessions SET native_thread_id=?,updated_at=?,
          last_message_at=IF(? IS NOT NULL,GREATEST(COALESCE(last_message_at,0),?),last_message_at)
          WHERE connection_id=? AND conversation_id=? AND agent_id=? AND generation=? AND active_run_id=?`, [
          text(input.nativeThreadId), now(), input.nativeTurnId ?? null, attempt.created_at, attempt.connection_id, attempt.conversation_id,
          attempt.agent_id, input.expectedGeneration, input.id,
        ]);
        if (!result.affectedRows) throw new StoreError('session_conflict');
        await claimThread(c, attempt.connection_id, attempt.conversation_id, attempt.agent_id, input.nativeThreadId);
        await c.execute(`UPDATE bridge_attempts SET native_thread_id=?,
          native_turn_id=COALESCE(?,native_turn_id) WHERE job_id=?`, [input.nativeThreadId, input.nativeTurnId ?? null, input.id]);
        return { bound: true };
      });
    },
    bufferNativeEvent(input) { return write(async(c)=>{
      const digest=hash(input.payload);await c.execute('INSERT INTO bridge_native_events (connection_id,event_key,native_thread_id,native_turn_id,payload_hash,payload,created_at) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE sequence=sequence',[text(input.connectionId,128),text(input.eventKey),input.nativeThreadId ?? null,input.nativeTurnId ?? null,digest,json(input.payload),now()]);
      const [[row]]=await c.execute('SELECT sequence,payload_hash FROM bridge_native_events WHERE connection_id=? AND event_key=?',[input.connectionId,input.eventKey]);if(row.payload_hash!==digest)throw new StoreError('native_event_conflict');return {sequence:row.sequence};
    }); },
    readNativeEvents: (input) => read(async (c) => {
      const turnFilter = input.nativeTurnId !== undefined;
      const [rows] = await c.execute(`SELECT sequence,native_thread_id,native_turn_id,payload,created_at
        FROM bridge_native_events WHERE connection_id=? AND native_thread_id=?
          ${turnFilter ? 'AND native_turn_id=?' : ''} AND sequence>?
        ORDER BY sequence LIMIT ${limit(input.limit)}`, [
        text(input.connectionId,128), text(input.nativeThreadId),
        ...(turnFilter ? [text(input.nativeTurnId)] : []), input.afterSequence ?? 0,
      ]);
      return rows.map(decode);
    }),
    getJob: (input)=>read(async(c)=>{const [[row]]=await c.execute('SELECT * FROM bridge_jobs WHERE id=?',[text(input.id,36)]);return decode(row) ?? null;}),
    getOutbox: (input) => read(async (c) => {
      const [[row]] = await c.execute(`SELECT effect.*, predecessor.status AS predecessor_status, predecessor.result AS predecessor_result,
        (effect.predecessor_id IS NOT NULL AND (predecessor.id IS NULL OR predecessor.status<>'sent')) AS blocked
        FROM bridge_outbox effect LEFT JOIN bridge_outbox predecessor ON predecessor.id=effect.predecessor_id
        WHERE effect.id=?`, [text(input.id, 36)]);
      return row ? { ...decode(row), blocked: Boolean(row.blocked), predecessorResult: row.predecessor_status === 'sent' ? row.predecessor_result : null } : null;
    }),
    listPendingCleanup(input = {}) {
      const take = limit(input.limit);
      const cursor = input.afterId == null ? '' : text(input.afterId,36);
      return read(async (c) => {
        const [rows] = await c.execute(`SELECT id,connection_id,conversation_id,job_id,payload
          FROM bridge_outbox WHERE cleanup_pending=TRUE AND id>?
          ORDER BY id LIMIT ${take + 1}`, [cursor]);
        const items = rows.slice(0,take).map(decode);
        return {items,nextCursor:rows.length>take ? items.at(-1).id : null};
      });
    },
    completeOutboxCleanup(input) {
      const key = [text(input.id,36),...scope(input)];
      return write(async (c) => {
        const [[row]] = await c.execute(`SELECT id FROM bridge_outbox WHERE id=? AND connection_id=?
          AND conversation_id=? AND status='sent' AND kind='artifact_send'`, key);
        if (!row) throw new StoreError('cleanup_conflict');
        await c.execute(`UPDATE bridge_outbox SET cleanup_pending=FALSE WHERE id=?
          AND connection_id=? AND conversation_id=? AND status='sent' AND kind='artifact_send'`, key);
        return {completed:true};
      });
    },
    getSession: (input)=>read(async(c)=>{const [[row]]=await c.execute('SELECT * FROM bridge_sessions WHERE connection_id=? AND conversation_id=? AND agent_id=?',[...scope(input),text(input.agentId,128)]);return decode(row) ?? null;}),
    setSession(input) {
      return write(async (c) => {
        const key = [...scope(input), text(input.agentId,128)];
        if (input.expectedGeneration === 0) {
          try {
            await c.execute(`INSERT INTO bridge_sessions
              (connection_id,conversation_id,agent_id,native_thread_id,active_run_id,updated_at)
              VALUES (?,?,?,?,?,?)`, [...key,input.nativeThreadId ?? null,input.activeRunId ?? null,now()]);
          } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') throw new StoreError('session_conflict');
            throw error;
          }
          await claimThread(c,...key,input.nativeThreadId ?? null);
          return {generation:1};
        }
        const [result] = await c.execute(`UPDATE bridge_sessions SET native_thread_id=?,active_run_id=?,updated_at=?
          WHERE connection_id=? AND conversation_id=? AND agent_id=? AND generation=? AND active_run_id IS NULL`, [
          input.nativeThreadId ?? null,input.activeRunId ?? null,now(),...key,input.expectedGeneration,
        ]);
        if (!result.affectedRows) throw new StoreError('session_conflict');
        await claimThread(c,...key,input.nativeThreadId ?? null);
        return {generation:input.expectedGeneration};
      });
    },
    resetSession(input) { return write(async(c)=>{const [result]=await c.execute('UPDATE bridge_sessions SET generation=generation+1,native_thread_id=NULL,updated_at=? WHERE connection_id=? AND conversation_id=? AND agent_id=? AND generation=? AND active_run_id IS NULL',[now(),...scope(input),text(input.agentId,128),input.expectedGeneration]);if(!result.affectedRows)throw new StoreError('session_busy_or_conflict');return {generation:Number(input.expectedGeneration)+1};}); },
    appendRunEvent(input) { return write(async(c)=>{const digest=hash({type:input.type,payload:input.payload}); await c.execute('INSERT INTO bridge_run_events (run_id,event_key,type,payload_hash,payload,created_at) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE sequence=sequence',[text(input.runId,36),text(input.eventKey),text(input.type,64),digest,json(input.payload),now()]);const [[row]]=await c.execute('SELECT sequence,payload_hash FROM bridge_run_events WHERE run_id=? AND event_key=?',[input.runId,input.eventKey]);if(row.payload_hash!==digest)throw new StoreError('run_event_conflict');return {sequence:row.sequence};}); },
    readRunEvents: (input)=>read(async(c)=>{const [rows]=await c.execute(`SELECT sequence,run_id,event_key,type,payload,created_at FROM bridge_run_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ${limit(input.limit)}`,[text(input.runId,36),input.afterSequence ?? 0]);return rows.map(decode);}),
    readPassiveContext: (input)=>read(async(c)=>{const [rows]=await c.execute(`SELECT sequence,id,message_id,payload,occurred_at FROM bridge_inbox WHERE connection_id=? AND conversation_id=? AND passive_context=TRUE AND context_run_id IS NULL AND NOT EXISTS (SELECT 1 FROM bridge_message_tombstones t WHERE t.connection_id=bridge_inbox.connection_id AND t.message_id=bridge_inbox.message_id) AND sequence>? ORDER BY sequence LIMIT ${limit(input.limit)}`,[...scope(input),input.afterSequence ?? 0]);return rows.map(decode);}),
    consumePassiveContext(input) { return write(async(c)=>{await c.execute('UPDATE bridge_inbox SET context_run_id=? WHERE connection_id=? AND conversation_id=? AND passive_context=TRUE AND context_run_id IS NULL AND sequence<=?',[text(input.runId,36),...scope(input),input.throughSequence]);return {consumed:true};}); },
    excludeMessage(input) { return write(async(c)=>{await c.execute('INSERT INTO bridge_message_tombstones (connection_id,message_id,created_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE message_id=message_id',[text(input.connectionId,128),text(input.messageId),now()]);return {excluded:true};}); },
    getCursor: (input)=>read(async(c)=>{const [[row]]=await c.execute('SELECT version,value FROM bridge_cursors WHERE connection_id=? AND cursor_key=?',[text(input.connectionId,128),text(input.key)]);return row ?? null;}),
    setCursor(input) { return write(async(c)=>{const key=[text(input.connectionId,128),text(input.key)];if(input.expectedVersion===0){try{await c.execute('INSERT INTO bridge_cursors (connection_id,cursor_key,version,value,updated_at) VALUES (?,?,1,?,?)',[...key,json(input.value),now()]);}catch(e){if(e.code==='ER_DUP_ENTRY')throw new StoreError('cursor_conflict');throw e;}}else{const [r]=await c.execute('UPDATE bridge_cursors SET version=version+1,value=?,updated_at=? WHERE connection_id=? AND cursor_key=? AND version=?',[json(input.value),now(),...key,input.expectedVersion]);if(!r.affectedRows)throw new StoreError('cursor_conflict');}return {version:Number(input.expectedVersion)+1};}); },
  };
}
