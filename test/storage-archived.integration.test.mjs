import test from 'node:test';
import assert from 'node:assert/strict';
import {createPoolFromEnvironment} from '../src/storage/connection.mjs';
import {migrate} from '../src/storage/migrations.mjs';
import {createMysqlStore} from '../src/storage/store.mjs';
const refs=Object.fromEntries(['host','port','user','password','database'].map(key=>[`${key}Env`,`BRIDGE_TEST_${key.toUpperCase()}`]));
test('real MySQL explicit archived rejection replaces only an unadmitted attempt and cannot replay creation',{
  skip:!process.env.BRIDGE_TEST_PASSWORD,timeout:30000,
},async()=>{
  let pool=createPoolFromEnvironment(refs);await migrate(pool);let store=await createMysqlStore({pool});
  const scope=chat=>({connectionId:'archived',conversationId:chat,agentId:'codex'});
  async function start(chat){
    await store.setSession({...scope(chat),expectedGeneration:0,nativeThreadId:`old-${chat}`});
    const added=await store.enqueueJob({...scope(chat),kind:'agent',idempotencyKey:chat,payload:{}});
    const [row]=await store.claimJobs({kind:'agent',owner:'worker',leaseMs:300000});assert.equal(row.id,added.id);
    const attempt=await store.beginAgentAttempt({...row,agentId:'codex'});
    return {...row,expectedGeneration:attempt.generation,expectedThreadId:`old-${chat}`,reason:'thread_archived'};
  }
  try{
    const job=await start('first');
    const pair=await Promise.all([store.resetRejectedThreadAdmission(job),store.resetRejectedThreadAdmission(job)]);
    assert.equal(pair.filter(row=>row.recoveryRequired===false).length,1);
    assert.equal(pair.filter(row=>row.recoveryRequired===true).length,1);
    assert.equal((await store.getSession(scope('first'))).activeRunId,job.id);
    assert.equal(Number((await store.getSession(scope('first'))).generation),2);
    assert.equal((await store.getAgentAttempt({id:job.id})).nativeThreadId,null);
    const [[audit]]=await pool.query('SELECT retired_thread_id,previous_generation,generation FROM bridge_session_rotations WHERE run_id=?',[job.id]);
    assert.equal(audit.retired_thread_id,'old-first');assert.equal(Number(audit.previous_generation),1);assert.equal(Number(audit.generation),2);
    await assert.rejects(store.setSession({...scope('foreign'),expectedGeneration:0,nativeThreadId:'old-first'}),{code:'thread_scope_conflict'});
    await store.bindAgentAttempt({...job,expectedGeneration:2,nativeThreadId:'replacement-first'});
    const repeated=await store.resetRejectedThreadAdmission(job);
    assert.equal(repeated.recoveryRequired,true);assert.equal(repeated.nativeThreadId,'replacement-first');
    await store.holdAgentAttempt({...job,errorCode:'thread_admission_unknown'});
    await assert.rejects(store.resetRejectedThreadAdmission(job),{code:'stale_lease'});
    // Reset commit loss is a recoverable DB fact, never permission for another create.
    const lost=await start('lost');const originalGet=pool.getConnection.bind(pool);let inject=true;
    pool.getConnection=async()=>{const connection=await originalGet();if(inject){inject=false;const commit=connection.commit.bind(connection);connection.commit=async()=>{connection.commit=commit;await commit();throw new Error('synthetic commit loss');};}return connection;};
    await assert.rejects(store.resetRejectedThreadAdmission(lost),{code:'commit_unknown'});pool.getConnection=originalGet;
    assert.equal((await store.resetRejectedThreadAdmission(lost)).recoveryRequired,true);
    await store.close();pool=createPoolFromEnvironment(refs);store=await createMysqlStore({pool});
    const recovered=await store.beginAgentAttempt({...lost,agentId:'codex'});
    assert.equal(recovered.recoveryRequired,true);assert.equal(recovered.nativeThreadId,null);assert.equal(Number(recovered.generation),2);
    await store.holdAgentAttempt({...lost,errorCode:'thread_creation_uncertain'});
    // Once a native turn exists, even a supplied archived reason cannot replace it.
    const admitted=await start('admitted');
    await store.bindAgentAttempt({...admitted,nativeThreadId:admitted.expectedThreadId,nativeTurnId:'accepted-turn'});
    await assert.rejects(store.resetRejectedThreadAdmission(admitted),{code:'rejected_thread_conflict'});
    assert.equal(Number((await store.getSession(scope('admitted'))).generation),1);
    assert.equal((await store.getAgentAttempt({id:admitted.id})).nativeTurnId,'accepted-turn');
  }finally{await store.close();}
});
