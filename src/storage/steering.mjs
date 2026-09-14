import {StoreError} from './errors.mjs';

export function steeringOperations({read,write,now,hash,decode,connectionId}) {
  function field(value,max=255) {
    if(typeof value!=='string'||!value.length||value.length>max) throw new StoreError('invalid_steer');
    return value;
  }
  const columns=`guidance_job_id,target_run_id,connection_id,conversation_id,agent_id,generation,
    native_thread_id,native_turn_id,client_message_id,status,error_code,created_at`;
  async function lockJob(c,input) {
    field(input.id,36);field(input.leaseToken,36);
    const [[job]]=await c.execute(`SELECT id,kind,connection_id,conversation_id,status,lease_token,lease_expires_at
      FROM bridge_jobs WHERE id=? AND connection_id=? FOR UPDATE`,[input.id,connectionId]);
    return job;
  }
  function assertLease(job,input) {
    if(!job||job.status!=='running'||job.lease_token!==input.leaseToken||Number(job.lease_expires_at)<=now()) throw new StoreError('stale_lease');
    if(job.kind!=='agent') throw new StoreError('invalid_job_kind');
  }
  function admission(row,kind) {
    return {kind,targetRunId:row.target_run_id,generation:row.generation,
      nativeThreadId:row.native_thread_id,nativeTurnId:row.native_turn_id,clientMessageId:row.client_message_id};
  }
  async function lockParent(c,targetRunId) {
    // Parent job serializes execution settlement and all of its guidance writes.
    const [[parent]]=await c.execute('SELECT status FROM bridge_jobs WHERE id=? AND connection_id=? FOR UPDATE',[targetRunId,connectionId]);
    const [[attempt]]=await c.execute(`SELECT connection_id,conversation_id,agent_id,generation,native_thread_id,native_turn_id
      FROM bridge_attempts WHERE job_id=? FOR UPDATE`,[targetRunId]);
    if(!attempt)return {parent};
    const key=[attempt.connection_id,attempt.conversation_id,attempt.agent_id];
    const [[session]]=await c.execute(`SELECT generation,native_thread_id,active_run_id FROM bridge_sessions
      WHERE connection_id=? AND conversation_id=? AND agent_id=? FOR UPDATE`,key);
    return {parent,attempt,session,key};
  }
  return {
    beginSteerAttempt(input) {
      field(input.agentId,128);
      return write(async(c)=>{
        const job=await lockJob(c,input);assertLease(job,input);
        const [[native]]=await c.execute('SELECT job_id FROM bridge_attempts WHERE job_id=?',[input.id]);
        if(native)return {kind:'inactive'};
        const [[previous]]=await c.execute(`SELECT ${columns} FROM bridge_steering
          WHERE guidance_job_id=? ORDER BY sequence DESC LIMIT 1`,[input.id]);
        if(previous&&['intent','unknown'].includes(previous.status))return admission(previous,'recovery_required');
        const [[snapshot]]=await c.execute(`SELECT active_run_id FROM bridge_sessions
          WHERE connection_id=? AND conversation_id=? AND agent_id=?`,[job.connection_id,job.conversation_id,input.agentId]);
        if(!snapshot?.active_run_id||snapshot.active_run_id===job.id)return {kind:'inactive'};
        const targetRunId=snapshot.active_run_id;
        const {parent,attempt,session}=await lockParent(c,targetRunId);
        if(!parent||!['running','pending'].includes(parent.status)||!attempt||!session
            ||attempt.connection_id!==job.connection_id||attempt.conversation_id!==job.conversation_id
            ||attempt.agent_id!==input.agentId||!attempt.native_thread_id||!attempt.native_turn_id
            ||session.active_run_id!==targetRunId||String(session.generation)!==String(attempt.generation)
            ||session.native_thread_id!==attempt.native_thread_id)return {kind:'inactive'};
        const [[sameTarget]]=await c.execute(`SELECT status FROM bridge_steering
          WHERE guidance_job_id=? AND target_run_id=? FOR UPDATE`,[input.id,targetRunId]);
        if(sameTarget)return {kind:'inactive'}; // Explicitly rejected targets are never resent.
        const [[unresolved]]=await c.execute(`SELECT guidance_job_id FROM bridge_steering
          WHERE target_run_id=? AND status IN ('intent','unknown') ORDER BY sequence LIMIT 1 FOR UPDATE`,[targetRunId]);
        if(unresolved)return {kind:'inactive'};
        const row={guidance_job_id:job.id,target_run_id:targetRunId,connection_id:job.connection_id,
          conversation_id:job.conversation_id,agent_id:input.agentId,generation:attempt.generation,
          native_thread_id:attempt.native_thread_id,native_turn_id:attempt.native_turn_id,client_message_id:job.id};
        await c.execute(`INSERT INTO bridge_steering
          (guidance_job_id,target_run_id,connection_id,conversation_id,agent_id,generation,
           native_thread_id,native_turn_id,client_message_id,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[job.id,targetRunId,job.connection_id,job.conversation_id,
          input.agentId,attempt.generation,attempt.native_thread_id,attempt.native_turn_id,job.id,now(),now()]);
        return admission(row,'new');
      });
    },
    finishSteerAttempt(input) {
      if(!['accepted','rejected','unknown'].includes(input.outcome))throw new StoreError('invalid_steer');
      const errorCode=input.errorCode==null?null:field(input.errorCode,64);
      if(errorCode&&!/^[a-z][a-z0-9_]*$/.test(errorCode))throw new StoreError('invalid_steer');
      const digest=hash({outcome:input.outcome,errorCode});
      return write(async(c)=>{
        const job=await lockJob(c,input);
        const [[settled]]=await c.execute(`SELECT status,result_hash FROM bridge_steering
          WHERE guidance_job_id=? AND connection_id=? AND settled_lease_token=?`,[input.id,connectionId,input.leaseToken]);
        if(settled){
          if(settled.result_hash!==digest)throw new StoreError('steer_conflict');
          return {status:settled.status};
        }
        assertLease(job,input);
        const [[row]]=await c.execute(`SELECT ${columns} FROM bridge_steering
          WHERE guidance_job_id=? ORDER BY sequence DESC LIMIT 1`,[input.id]);
        if(!row||row.status!=='intent')throw new StoreError('steer_conflict');
        const {attempt}=await lockParent(c,row.target_run_id);
        if(!attempt)throw new StoreError('steer_conflict');
        await c.execute(`UPDATE bridge_steering SET status=?,error_code=?,settled_lease_token=?,result_hash=?,updated_at=?
          WHERE guidance_job_id=? AND target_run_id=?`,[input.outcome,errorCode,input.leaseToken,digest,now(),input.id,row.target_run_id]);
        const status={accepted:'succeeded',rejected:'pending',unknown:'unknown'}[input.outcome];
        const result=input.outcome==='accepted'?{deferred:true,targetRunId:row.target_run_id,nativeTurnId:row.native_turn_id}:null;
        await c.execute(`UPDATE bridge_jobs SET status=?,result=?,error_code=?,next_attempt_at=?,
          lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?`,[
          status,JSON.stringify(result),errorCode,input.outcome==='rejected'?now()+1000:now(),now(),input.id,
        ]);
        if(input.outcome==='accepted'){
          // An acknowledged steer remains a fact even if the parent just finished.
          // Never refresh a replacement generation or move activity backwards.
          await c.execute(`UPDATE bridge_sessions SET last_message_at=GREATEST(COALESCE(last_message_at,0),?)
            WHERE connection_id=? AND conversation_id=? AND agent_id=? AND generation=? AND native_thread_id=?`,[
            row.created_at,row.connection_id,row.conversation_id,row.agent_id,row.generation,row.native_thread_id,
          ]);
        }
        return {status:input.outcome};
      });
    },
    getSteerAttempt({id}) {
      field(id,36);
      return read(async(c)=>{
        const [[row]]=await c.execute(`SELECT ${columns} FROM bridge_steering
          WHERE guidance_job_id=? AND connection_id=? ORDER BY sequence DESC LIMIT 1`,[id,connectionId]);
        return decode(row)??null;
      });
    },
  };
}
