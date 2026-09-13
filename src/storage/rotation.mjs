import {randomUUID} from 'node:crypto';
import {StoreError} from './errors.mjs';

export function rotationOperations({write,now,hash,owned}) {
  const field = (value,max=255) => {
    if(typeof value!=='string'||!value.length||value.length>max) throw new StoreError('invalid_rotation');
    return value;
  };
  return {
    resetRejectedThreadAdmission(input) {
      const expectedThreadId=field(input.expectedThreadId);
      const expectedGeneration=Number(input.expectedGeneration);
      if(input.reason!=='thread_archived'||!/^[1-9][0-9]*$/.test(String(input.expectedGeneration))
          ||!Number.isSafeInteger(expectedGeneration)||expectedGeneration>=Number.MAX_SAFE_INTEGER) throw new StoreError('invalid_rotation');
      return write(async(c)=>{
        const job=await owned(c,'bridge_jobs',input);
        if(job.kind!=='agent')throw new StoreError('invalid_job_kind');
        const [[attempt]]=await c.execute(`SELECT connection_id,conversation_id,agent_id,generation,native_thread_id,native_turn_id
          FROM bridge_attempts WHERE job_id=? FOR UPDATE`,[input.id]);
        if(!attempt)throw new StoreError('rejected_thread_conflict');
        const key=[attempt.connection_id,attempt.conversation_id,attempt.agent_id];
        const digest=hash({runId:input.id,expectedGeneration,expectedThreadId,reason:input.reason});
        const idempotencyKey=`rejected-admission:${digest}`;
        const [[existing]]=await c.execute(`SELECT payload_hash FROM bridge_session_rotations
          WHERE connection_id=? AND conversation_id=? AND agent_id=? AND idempotency_key=?`,[...key,idempotencyKey]);
        if(existing){
          if(existing.payload_hash!==digest)throw new StoreError('rotation_conflict');
          // A repeated reset is not a second permission to create a native thread.
          return {generation:Number(attempt.generation),nativeThreadId:attempt.native_thread_id,
            nativeTurnId:attempt.native_turn_id,recoveryRequired:true};
        }
        const [[session]]=await c.execute(`SELECT generation,native_thread_id,active_run_id FROM bridge_sessions
          WHERE connection_id=? AND conversation_id=? AND agent_id=? FOR UPDATE`,key);
        if(Number(attempt.generation)!==expectedGeneration||attempt.native_thread_id!==expectedThreadId
            ||attempt.native_turn_id!==null||!session||Number(session.generation)!==expectedGeneration
            ||session.native_thread_id!==expectedThreadId||session.active_run_id!==input.id) throw new StoreError('rejected_thread_conflict');
        const generation=expectedGeneration+1;
        await c.execute(`INSERT INTO bridge_session_rotations
          (id,connection_id,conversation_id,agent_id,idempotency_key,payload_hash,reason,
           previous_generation,generation,retired_thread_id,run_id,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,[randomUUID(),...key,idempotencyKey,digest,input.reason,
          expectedGeneration,generation,expectedThreadId,input.id,now()]);
        await c.execute(`UPDATE bridge_sessions SET generation=?,native_thread_id=NULL,updated_at=?
          WHERE connection_id=? AND conversation_id=? AND agent_id=?`,[generation,now(),...key]);
        await c.execute(`UPDATE bridge_attempts SET generation=?,native_thread_id=NULL
          WHERE job_id=?`,[generation,input.id]);
        return {generation,nativeThreadId:null,recoveryRequired:false};
      });
    },
    rotateIdleSession(input) {
      const key=[field(input.connectionId,128),field(input.conversationId),field(input.agentId,128)];
      const idempotencyKey=field(input.idempotencyKey);
      const threadId=field(input.expectedThreadId);
      const generation=Number(input.expectedGeneration);
      if(!/^[1-9][0-9]*$/.test(String(input.expectedGeneration))||!Number.isSafeInteger(generation)||generation<1||generation>=Number.MAX_SAFE_INTEGER
          ||!['session_idle','rules_updated','thread_archived'].includes(input.reason)) throw new StoreError('invalid_rotation');
      const hasActivity=Object.hasOwn(input,'expectedLastMessageAt');
      const activity=input.expectedLastMessageAt;
      if(hasActivity&&activity!==null&&(!/^[0-9]+$/.test(String(activity))||!Number.isSafeInteger(Number(activity))||Number(activity)<0)) throw new StoreError('invalid_rotation');
      const digest=hash({generation,threadId,reason:input.reason,hasActivity,activity:hasActivity&&activity!==null?String(activity):null});
      return write(async(c)=>{
        const id=randomUUID();
        // The audit row also serializes identical retries, including after COMMIT loss.
        await c.execute(`INSERT INTO bridge_session_rotations
          (id,connection_id,conversation_id,agent_id,idempotency_key,payload_hash,reason,
           previous_generation,generation,retired_thread_id,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE id=id`,[
          id,...key,idempotencyKey,digest,input.reason,generation,generation+1,threadId,now(),
        ]);
        const [[record]]=await c.execute(`SELECT id,payload_hash,generation,retired_thread_id
          FROM bridge_session_rotations WHERE connection_id=? AND conversation_id=? AND agent_id=? AND idempotency_key=?`,[...key,idempotencyKey]);
        if(record.payload_hash!==digest) throw new StoreError('rotation_conflict');
        if(record.id!==id) return {generation:Number(record.generation),retiredThreadId:record.retired_thread_id};
        const [[session]]=await c.execute(`SELECT generation,native_thread_id,active_run_id,last_message_at
          FROM bridge_sessions WHERE connection_id=? AND conversation_id=? AND agent_id=? FOR UPDATE`,key);
        if(!session||Number(session.generation)!==generation||session.native_thread_id!==threadId
            ||(hasActivity&&String(session.last_message_at)!==String(activity))) throw new StoreError('session_conflict');
        if(session.active_run_id) throw new StoreError('session_busy');
        await c.execute(`UPDATE bridge_sessions SET generation=generation+1,native_thread_id=NULL,updated_at=?
          WHERE connection_id=? AND conversation_id=? AND agent_id=?`,[now(),...key]);
        // Permanent native ownership intentionally survives this retirement.
        return {generation:generation+1,retiredThreadId:threadId};
      });
    },
  };
}
