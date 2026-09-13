import {randomUUID} from 'node:crypto';
import {StoreError} from './errors.mjs';

export function rotationOperations({write,now,hash}) {
  const field = (value,max=255) => {
    if(typeof value!=='string'||!value.length||value.length>max) throw new StoreError('invalid_rotation');
    return value;
  };
  return {
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
