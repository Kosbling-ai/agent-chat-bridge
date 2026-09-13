import { StoreError } from './errors.mjs';

// Filesystem work happens after this durable seal, never inside a database transaction.
export function resourceOperations({ read, write, now, decode }) {
  const terminal = "('succeeded','failed','cancelled','delivery_failed')";
  function field(value, max = 128) {
    if (typeof value !== 'string' || !value.length || value.length > max) throw new StoreError('invalid_retirement');
    return value;
  }
  function kindColumn(kind) {
    if (!['input','output'].includes(kind)) throw new StoreError('invalid_retirement');
    return `${kind}_resource_state`;
  }
  const facts = `SELECT p.id AS run_id,p.connection_id,p.conversation_id,
    p.input_resource_state AS input_state,p.output_resource_state AS output_state,
    COALESCE(a.native_thread_id,s.native_thread_id) AS native_thread_id,
    COALESCE(a.agent_id,s.agent_id) AS agent_id,
    (p.status='succeeded' AND NOT EXISTS (SELECT 1 FROM bridge_outbox o WHERE o.job_id=p.id
      AND (o.status<>'sent' OR o.cleanup_pending=1))) AS output_retirable,
    (p.status IN ${terminal} AND (
      COALESCE(a.native_thread_id,s.native_thread_id) IS NULL OR (
        NOT EXISTS (SELECT 1 FROM bridge_sessions cs WHERE cs.connection_id=p.connection_id
          AND cs.native_thread_id=COALESCE(a.native_thread_id,s.native_thread_id))
        AND NOT EXISTS (SELECT 1 FROM bridge_attempts ar JOIN bridge_jobs jr ON jr.id=ar.job_id
          WHERE ar.connection_id=p.connection_id AND ar.native_thread_id=COALESCE(a.native_thread_id,s.native_thread_id)
          AND jr.status NOT IN ${terminal})
        AND NOT EXISTS (SELECT 1 FROM bridge_steering sr JOIN bridge_jobs jg ON jg.id=sr.guidance_job_id
          WHERE sr.connection_id=p.connection_id AND sr.native_thread_id=COALESCE(a.native_thread_id,s.native_thread_id)
          AND sr.status IN ('intent','unknown','accepted') AND jg.status NOT IN ${terminal})
        AND NOT EXISTS (SELECT 1 FROM bridge_recoveries r WHERE r.connection_id=p.connection_id
          AND r.native_thread_id=COALESCE(a.native_thread_id,s.native_thread_id) AND r.status IN ('pending','running'))
      ))) AS input_retirable
    FROM candidates p LEFT JOIN bridge_attempts a ON a.job_id=p.id
    LEFT JOIN bridge_steering s ON s.guidance_job_id=p.id AND s.sequence=(
      SELECT MAX(latest.sequence) FROM bridge_steering latest WHERE latest.guidance_job_id=p.id)`;
  function result(row) {
    const value = decode(row);
    return { ...value, inputRetirable: Number(row.input_retirable) === 1, outputRetirable: Number(row.output_retirable) === 1 };
  }
  async function locked(c, runId) {
    const [[job]] = await c.execute(`SELECT id,kind,connection_id,conversation_id,status,input_resource_state,output_resource_state
      FROM bridge_jobs WHERE id=? FOR UPDATE`, [runId]);
    if (!job || job.kind !== 'agent') throw new StoreError('retirement_conflict');
    return job;
  }
  return {
    listRetirableResources({ connectionId, afterRunId = '', limit = 100 }) {
      field(connectionId);
      if (afterRunId) field(afterRunId,36);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new StoreError('invalid_retirement');
      return read(async c => {
        const [rows] = await c.execute(`WITH candidates AS (SELECT id,connection_id,conversation_id,status,
          input_resource_state,output_resource_state FROM bridge_jobs
          WHERE connection_id=? AND kind='agent' AND id>? AND status IN ${terminal}
          AND (input_resource_state<>'complete' OR output_resource_state<>'complete')
          ORDER BY id LIMIT ${limit}) ${facts} ORDER BY p.id`, [connectionId,afterRunId]);
        return { items: rows.map(result), nextCursor: rows.length === limit ? rows.at(-1).run_id : null };
      });
    },
    sealResourceRetirement({ runId, kind }) {
      field(runId,36); const column = kindColumn(kind);
      return write(async c => {
        const job = await locked(c,runId);
        if (job[column] === 'complete') return { runId, connectionId: job.connection_id, conversationId: job.conversation_id, state: 'complete' };
        if (kind === 'input') {
          // Use locking reads before the eligibility snapshot, so a waited-on adopt
          // cannot become invisible through an earlier REPEATABLE READ snapshot.
          const [[attempt]] = await c.execute('SELECT agent_id,native_thread_id FROM bridge_attempts WHERE job_id=? FOR UPDATE',[runId]);
          const [[steer]] = await c.execute(`SELECT agent_id,native_thread_id FROM bridge_steering
            WHERE guidance_job_id=? ORDER BY sequence DESC LIMIT 1 FOR UPDATE`,[runId]);
          const thread = attempt?.native_thread_id ?? steer?.native_thread_id;
          const agent = attempt?.agent_id ?? steer?.agent_id;
          if (thread) {
            await c.execute(`SELECT generation FROM bridge_sessions WHERE connection_id=? AND conversation_id=? AND agent_id=? FOR UPDATE`,
              [job.connection_id,job.conversation_id,agent]);
            const [[owner]] = await c.execute(`SELECT conversation_id,agent_id FROM bridge_thread_owners
              WHERE connection_id=? AND native_thread_id=? FOR UPDATE`,[job.connection_id,thread]);
            if (!owner || owner.conversation_id !== job.conversation_id || owner.agent_id !== agent) throw new StoreError('retirement_conflict');
          }
        }
        const [sessions] = await c.execute(`SELECT active_run_id FROM bridge_sessions
          WHERE connection_id=? AND conversation_id=? FOR UPDATE`,[job.connection_id,job.conversation_id]);
        if (sessions.some(session => session.active_run_id != null)) throw new StoreError('retirement_conflict');
        const [[guidance]] = await c.execute(`SELECT EXISTS(SELECT 1 FROM bridge_steering s
          JOIN bridge_jobs j ON j.id=s.guidance_job_id WHERE s.connection_id=? AND s.conversation_id=?
          AND s.status IN ('intent','unknown') AND j.status IN ('pending','running','unknown')) AS unresolved`,
          [job.connection_id,job.conversation_id]);
        if (Number(guidance.unresolved) === 1) throw new StoreError('retirement_conflict');
        if (job[column] === 'sealed') return { runId, connectionId: job.connection_id, conversationId: job.conversation_id, state: 'sealed' };
        const [[row]] = await c.execute(`WITH candidates AS (SELECT id,connection_id,conversation_id,status,
          input_resource_state,output_resource_state FROM bridge_jobs WHERE id=?) ${facts}`,[runId]);
        if (Number(row[`${kind}_retirable`]) !== 1) throw new StoreError('retirement_conflict');
        if (kind === 'input' && row.native_thread_id) {
          await c.execute(`UPDATE bridge_thread_owners SET resource_retired_at=COALESCE(resource_retired_at,?)
            WHERE connection_id=? AND native_thread_id=?`,[now(),job.connection_id,row.native_thread_id]);
        }
        await c.execute(`UPDATE bridge_jobs SET ${column}='sealed' WHERE id=?`,[runId]);
        return { runId, connectionId: job.connection_id, conversationId: job.conversation_id, nativeThreadId: row.native_thread_id, state: 'sealed' };
      });
    },
    completeResourceRetirement({ runId, kind }) {
      field(runId,36); const column = kindColumn(kind);
      return write(async c => {
        const job = await locked(c,runId);
        if (job[column] === 'pending') throw new StoreError('retirement_conflict');
        await c.execute(`UPDATE bridge_jobs SET ${column}='complete' WHERE id=?`,[runId]);
        return { state: 'complete' };
      });
    },
  };
}
