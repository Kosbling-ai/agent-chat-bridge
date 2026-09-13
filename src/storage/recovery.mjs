import { randomUUID } from 'node:crypto';
import { StoreError } from './errors.mjs';

// Recovery is a small durable administrative action, not an Agent retry queue.
export function recoveryOperations({ read, write, now, hash, decode, claimThread }) {
  function field(value, max = 255) {
    if (typeof value !== 'string' || !value.length || value.length > max) throw new StoreError('invalid_recovery');
    return value;
  }
  const columns = `id,run_id,connection_id,conversation_id,caller_id,action,expected_generation,
    native_thread_id,native_turn_id,evidence,status,lease_token,lease_expires_at,error_code,created_at`;
  async function target(c, runId, generation, action) {
    if (action === 'abandon_guidance_verified') {
      // Serialize against steering settlement, but never lock or mutate its parent.
      const [[job]] = await c.execute('SELECT status FROM bridge_jobs WHERE id=? FOR UPDATE', [runId]);
      const [[attempt]] = await c.execute(`SELECT connection_id,conversation_id,agent_id,generation,status
        FROM bridge_steering WHERE guidance_job_id=? ORDER BY sequence DESC LIMIT 1 FOR UPDATE`, [runId]);
      if (!job || job.status !== 'unknown' || !attempt || attempt.status !== 'unknown'
          || String(attempt.generation) !== String(generation)) throw new StoreError('recovery_conflict');
      return { attempt };
    }
    // Same lock order as execution: job, attempt, then session.
    const [[job]] = await c.execute('SELECT status FROM bridge_jobs WHERE id=? FOR UPDATE', [runId]);
    const [[attempt]] = await c.execute(`SELECT connection_id,conversation_id,agent_id,generation,
      native_thread_id,native_turn_id,created_at FROM bridge_attempts WHERE job_id=? FOR UPDATE`, [runId]);
    if (!job || !attempt || job.status !== 'unknown' || String(attempt.generation) !== String(generation)) {
      throw new StoreError('recovery_conflict');
    }
    const key = [attempt.connection_id, attempt.conversation_id, attempt.agent_id];
    const [[session]] = await c.execute(`SELECT generation,active_run_id FROM bridge_sessions
      WHERE connection_id=? AND conversation_id=? AND agent_id=? FOR UPDATE`, key);
    if (!session || String(session.generation) !== String(generation) || session.active_run_id !== runId) {
      throw new StoreError('recovery_conflict');
    }
    return { attempt, key };
  }
  return {
    getAgentAttempt({ id }) {
      field(id, 36);
      return read(async (c) => {
        const [[row]] = await c.execute(`SELECT a.job_id AS run_id,a.connection_id,a.conversation_id,
          a.agent_id,a.generation,a.native_thread_id,a.native_turn_id,a.created_at,j.status
          FROM bridge_attempts a JOIN bridge_jobs j ON j.id=a.job_id WHERE a.job_id=?`, [id]);
        return decode(row) ?? null;
      });
    },
    enqueueRecovery(input) {
      const runId = field(input.runId, 36);
      const callerId = field(input.callerId, 128);
      const key = field(input.idempotencyKey);
      if (!['adopt_turn', 'abandon_verified', 'abandon_guidance_verified'].includes(input.action)
          || !/^[1-9][0-9]{0,19}$/.test(String(input.expectedGeneration))) throw new StoreError('invalid_recovery');
      const evidence = field(input.evidence, 4096);
      const threadId = input.nativeThreadId == null ? null : field(input.nativeThreadId);
      const turnId = input.nativeTurnId == null ? null : field(input.nativeTurnId);
      if (input.action === 'abandon_guidance_verified' && (threadId || turnId)) throw new StoreError('invalid_recovery');
      if (input.action === 'adopt_turn' && (!threadId || !turnId)) throw new StoreError('invalid_recovery');
      const digest = hash({ runId, action: input.action, generation: String(input.expectedGeneration), evidence, threadId, turnId });
      return write(async (c) => {
        // Serialize retries before checking the target; a completed request stays replayable.
        const id = randomUUID();
        await c.execute(`INSERT INTO bridge_recoveries
          (id,run_id,caller_id,idempotency_key,payload_hash,action,expected_generation,
           native_thread_id,native_turn_id,evidence,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id`, [
          id, runId, callerId, key, digest, input.action, input.expectedGeneration, threadId, turnId, evidence, now(), now(),
        ]);
        const [[row]] = await c.execute(`SELECT id,payload_hash FROM bridge_recoveries
          WHERE caller_id=? AND idempotency_key=?`, [callerId, key]);
        if (row.payload_hash !== digest) throw new StoreError('recovery_conflict');
        if (row.id !== id) return { id: row.id, duplicate: true };
        const { attempt } = await target(c, runId, input.expectedGeneration, input.action);
        await c.execute('UPDATE bridge_recoveries SET connection_id=?,conversation_id=? WHERE id=?', [
          attempt.connection_id, attempt.conversation_id, id,
        ]);
        return { id, duplicate: false };
      });
    },
    claimRecoveries(input) {
      const take = input.limit ?? 50;
      if (!Number.isInteger(take) || take < 1 || take > 100
          || !Number.isInteger(input.leaseMs) || input.leaseMs < 100 || input.leaseMs > 300000) throw new StoreError('invalid_recovery');
      field(input.owner, 128);
      return write(async (c) => {
        const [rows] = await c.execute(`SELECT ${columns} FROM bridge_recoveries
          WHERE status='pending' OR (status='running' AND lease_expires_at<=?)
          ORDER BY created_at,id LIMIT ${take} FOR UPDATE SKIP LOCKED`, [now()]);
        for (const row of rows) {
          row.lease_token = randomUUID();
          row.lease_expires_at = now() + input.leaseMs;
          row.status = 'running';
          await c.execute(`UPDATE bridge_recoveries SET status='running',lease_owner=?,lease_token=?,
            lease_expires_at=?,updated_at=? WHERE id=?`, [input.owner, row.lease_token, row.lease_expires_at, now(), row.id]);
        }
        return rows.map(decode);
      });
    },
    finishRecovery(input) {
      field(input.id, 36); field(input.leaseToken, 36);
      if (!['applied', 'rejected'].includes(input.outcome)) throw new StoreError('invalid_recovery');
      const errorCode = input.errorCode == null ? null : field(input.errorCode, 64);
      if (errorCode && !/^[a-z][a-z0-9_]*$/.test(errorCode)) throw new StoreError('invalid_recovery');
      const verified = input.verifiedNative == null ? null : {
        threadId: field(input.verifiedNative.threadId), turnId: field(input.verifiedNative.turnId),
      };
      const digest = hash({ outcome: input.outcome, errorCode, verified });
      return write(async (c) => {
        const [[row]] = await c.execute(`SELECT ${columns},result_hash FROM bridge_recoveries WHERE id=? FOR UPDATE`, [input.id]);
        if (!row) throw new StoreError('recovery_not_found');
        if (row.lease_token !== input.leaseToken) throw new StoreError('stale_lease');
        if (['applied', 'rejected'].includes(row.status)) {
          if (row.result_hash !== digest) throw new StoreError('recovery_conflict');
          return { status: row.status };
        }
        if (row.status !== 'running' || Number(row.lease_expires_at) <= now()) throw new StoreError('stale_lease');
        if (input.outcome === 'applied') {
          const { attempt, key } = await target(c, row.run_id, row.expected_generation, row.action);
          if (row.action === 'abandon_guidance_verified') {
            if (verified) throw new StoreError('invalid_recovery');
            // Cancellation is an administrative decision, not proof the provider did not execute.
            await c.execute(`UPDATE bridge_jobs SET status='cancelled',lease_token=NULL,lease_owner=NULL,
              lease_expires_at=NULL,updated_at=? WHERE id=?`, [now(), row.run_id]);
          } else if (row.action === 'adopt_turn') {
            if (!verified || verified.threadId !== row.native_thread_id || verified.turnId !== row.native_turn_id
                || (attempt.native_thread_id && attempt.native_thread_id !== verified.threadId)
                || (attempt.native_turn_id && attempt.native_turn_id !== verified.turnId)) throw new StoreError('recovery_conflict');
            await claimThread(c, ...key, verified.threadId);
            await c.execute('UPDATE bridge_attempts SET native_thread_id=?,native_turn_id=? WHERE job_id=?', [verified.threadId, verified.turnId, row.run_id]);
            await c.execute(`UPDATE bridge_sessions SET native_thread_id=?,updated_at=?,
              last_message_at=GREATEST(COALESCE(last_message_at,0),?)
              WHERE connection_id=? AND conversation_id=? AND agent_id=?`, [verified.threadId, now(), attempt.created_at, ...key]);
            await c.execute(`UPDATE bridge_jobs SET status='pending',next_attempt_at=?,lease_token=NULL,
              lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?`, [now(), now(), row.run_id]);
          } else {
            await c.execute(`UPDATE bridge_sessions SET generation=generation+1,active_run_id=NULL,
              native_thread_id=NULL,updated_at=? WHERE connection_id=? AND conversation_id=? AND agent_id=?`, [now(), ...key]);
            await c.execute(`UPDATE bridge_jobs SET status='cancelled',lease_token=NULL,lease_owner=NULL,
              lease_expires_at=NULL,updated_at=? WHERE id=?`, [now(), row.run_id]);
          }
        }
        await c.execute(`UPDATE bridge_recoveries SET status=?,error_code=?,result_hash=?,
          updated_at=? WHERE id=?`, [input.outcome, errorCode, digest, now(), row.id]);
        return { status: input.outcome };
      });
    },
    getRecovery({ id }) {
      field(id, 36);
      return read(async (c) => {
        const [[row]] = await c.execute(`SELECT id,run_id,connection_id,conversation_id,status,action,error_code,
          created_at,updated_at FROM bridge_recoveries WHERE id=?`, [id]);
        return decode(row) ?? null;
      });
    },
  };
}
