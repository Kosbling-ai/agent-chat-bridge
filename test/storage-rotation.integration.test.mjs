import test from 'node:test';
import assert from 'node:assert/strict';
import {createPoolFromEnvironment} from '../src/storage/connection.mjs';
import {migrate} from '../src/storage/migrations.mjs';
import {createMysqlStore} from '../src/storage/store.mjs';
const refs=Object.fromEntries(['host','port','user','password','database'].map(key=>[`${key}Env`,`BRIDGE_TEST_${key.toUpperCase()}`]));
test('real MySQL idle rotation fences activity and preserves only confirmed-admission timestamps',{
  skip:!process.env.BRIDGE_TEST_PASSWORD,timeout:30000,
},async()=>{
  const pool=createPoolFromEnvironment(refs);await migrate(pool);
  let clock=Date.now();const store=await createMysqlStore({connectionId:'rotation',pool,now:()=>clock});
  const scope=conversationId=>({connectionId:'rotation',conversationId,agentId:'codex'});
  async function job(conversationId,idempotencyKey=conversationId){
    const added=await store.enqueueJob({...scope(conversationId),kind:'agent',idempotencyKey,payload:{}});
    const [claimed]=await store.claimJobs({kind:'agent',owner:'worker',leaseMs:300000});assert.equal(claimed.id,added.id);return claimed;
  }
  const rotate=(chat,extra={})=>store.rotateIdleSession({...scope(chat),expectedGeneration:1,expectedThreadId:`thread-${chat}`,reason:'session_idle',idempotencyKey:`rotate-${chat}`,...extra});
  try{
    await store.setSession({...scope('time'),expectedGeneration:0,nativeThreadId:'thread-time'});
    const first=await job('time');const started=clock;
    const attempt=await store.beginAgentAttempt({...first,agentId:'codex'});
    assert.equal((await store.getSession(scope('time'))).lastMessageAt,null);
    await store.bindAgentAttempt({...first,expectedGeneration:attempt.generation,nativeThreadId:'thread-time'});
    assert.equal((await store.getSession(scope('time'))).lastMessageAt,null);
    clock+=1000;
    await store.bindAgentAttempt({...first,expectedGeneration:attempt.generation,nativeThreadId:'thread-time',nativeTurnId:'turn-time'});
    assert.equal(Number((await store.getSession(scope('time'))).lastMessageAt),started);
    clock+=1000;
    await store.bindAgentAttempt({...first,expectedGeneration:attempt.generation,nativeThreadId:'thread-time',nativeTurnId:'turn-time'});
    assert.equal(Number((await store.getSession(scope('time'))).lastMessageAt),started);
    await assert.rejects(rotate('time',{expectedLastMessageAt:started}),{code:'session_busy'});
    await store.finishJobWithOutbox(first);
    // A later attempt rejected before a turn admission must not erase the idle gap.
    const rejected=await job('time','rejected-before-admission');await store.beginAgentAttempt({...rejected,agentId:'codex'});
    await store.retryJob({...rejected,terminal:true,errorCode:'rpc_rejected'});
    assert.equal(Number((await store.getSession(scope('time'))).lastMessageAt),started);
    await assert.rejects(rotate('time',{expectedLastMessageAt:started+1}),{code:'session_conflict'});
    const pair=await Promise.all([rotate('time',{expectedLastMessageAt:started}),rotate('time',{expectedLastMessageAt:started})]);
    assert.deepEqual(pair,[{generation:2,retiredThreadId:'thread-time'},{generation:2,retiredThreadId:'thread-time'}]);
    assert.equal((await store.getSession(scope('time'))).nativeThreadId,null);
    await assert.rejects(rotate('time',{reason:'rules_updated',expectedLastMessageAt:started}),{code:'rotation_conflict'});
    await assert.rejects(store.setSession({...scope('different'),expectedGeneration:0,nativeThreadId:'thread-time'}),{code:'thread_scope_conflict'});
    const [[audit]]=await pool.query("SELECT COUNT(*) AS n FROM bridge_session_rotations WHERE conversation_id='time'");assert.equal(Number(audit.n),1);
    // Both valid orderings preserve fencing: rotate first -> new generation attempt;
    // begin first -> rotation refuses the active session.
    await store.setSession({...scope('race'),expectedGeneration:0,nativeThreadId:'thread-race'});
    const racing=await job('race');
    const result=await Promise.allSettled([rotate('race',{expectedLastMessageAt:null}),store.beginAgentAttempt({...racing,agentId:'codex'})]);
    assert.equal(result[1].status,'fulfilled');
    if(result[0].status==='fulfilled'){
      assert.equal(Number(result[1].value.generation),2);assert.equal(result[1].value.nativeThreadId,null);
    }else{
      assert.equal(result[0].reason.code,'session_busy');assert.equal(Number(result[1].value.generation),1);
    }
    await store.holdAgentAttempt({...racing,errorCode:'rpc_unknown'});
    const raceSession=await store.getSession(scope('race'));
    if(raceSession.nativeThreadId)await assert.rejects(rotate('race'),{code:'session_busy'});
    const recovery=await store.enqueueRecovery({runId:racing.id,callerId:'admin',idempotencyKey:'adopt-race',expectedGeneration:raceSession.generation,action:'adopt_turn',evidence:'synthetic verified',nativeThreadId:raceSession.nativeThreadId??'new-race',nativeTurnId:'known-turn'});
    const [management]=await store.claimRecoveries({owner:'admin',leaseMs:1000});assert.equal(management.id,recovery.id);
    const originalAttempt=await store.getAgentAttempt({id:racing.id});clock+=500;
    await store.finishRecovery({...management,outcome:'applied',verifiedNative:{threadId:management.nativeThreadId,turnId:management.nativeTurnId}});
    assert.equal(Number((await store.getSession(scope('race'))).lastMessageAt),Number(originalAttempt.createdAt));
    // Retiring an archived but idle binding is a DB intent only; commit loss is replayable.
    await store.setSession({...scope('archived'),expectedGeneration:0,nativeThreadId:'thread-archived'});
    const originalGet=pool.getConnection.bind(pool);let inject=true;
    pool.getConnection=async()=>{const connection=await originalGet();if(inject){inject=false;const commit=connection.commit.bind(connection);connection.commit=async()=>{connection.commit=commit;await commit();throw new Error('synthetic commit response loss');};}return connection;};
    await assert.rejects(rotate('archived',{reason:'thread_archived'}),{code:'commit_unknown'});pool.getConnection=originalGet;
    assert.deepEqual(await rotate('archived',{reason:'thread_archived'}),{generation:2,retiredThreadId:'thread-archived'});
  }finally{await store.close();}
});
