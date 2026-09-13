import test from 'node:test';
import assert from 'node:assert/strict';
import {createPoolFromEnvironment} from '../src/storage/connection.mjs';
import {migrate} from '../src/storage/migrations.mjs';
import {createMysqlStore} from '../src/storage/store.mjs';
const refs=Object.fromEntries(['host','port','user','password','database'].map(key=>[`${key}Env`,`BRIDGE_TEST_${key.toUpperCase()}`]));
test('real MySQL conversation activity retains unknown native and guidance facts without a lock',{
  skip:!process.env.BRIDGE_TEST_PASSWORD,timeout:30000,
},async()=>{
  const pool=createPoolFromEnvironment(refs);await migrate(pool);const store=await createMysqlStore({pool});
  const scope=conversationId=>({connectionId:'activity',conversationId,agentId:'codex'});
  let sequence=0;
  async function create(chat){
    const job=await store.enqueueJob({...scope(chat),kind:'agent',idempotencyKey:`${++sequence}`,payload:{}});
    const [lease]=await store.claimJobs({kind:'agent',owner:'worker',leaseMs:300000});assert.equal(lease.id,job.id);return lease;
  }
  async function parent(chat){
    const row=await create(chat);const attempt=await store.beginAgentAttempt({...row,agentId:'codex'});
    await store.bindAgentAttempt({...row,expectedGeneration:attempt.generation,nativeThreadId:`thread-${chat}`,nativeTurnId:`turn-${chat}`});return row;
  }
  try{
    const [[raw]]=await pool.query('SELECT EXISTS(SELECT 1 WHERE FALSE) AS no_match, EXISTS(SELECT 1) AS has_match');
    assert.equal(raw.no_match,'0'); assert.equal(raw.has_match,'1');
    assert.deepEqual(await store.getConversationActivity(scope('missing')),{activeRunId:null,unresolvedGuidance:false});
    const active=await parent('first');assert.deepEqual(await store.getConversationActivity(scope('first')),{activeRunId:active.id,unresolvedGuidance:false});
    const guidance=await create('first');await store.beginSteerAttempt({...guidance,agentId:'codex'});
    assert.deepEqual(await store.getConversationActivity(scope('first')),{activeRunId:active.id,unresolvedGuidance:true});
    await store.finishSteerAttempt({...guidance,outcome:'accepted'});
    assert.deepEqual(await store.getConversationActivity(scope('first')),{activeRunId:active.id,unresolvedGuidance:false});
    await store.holdAgentAttempt({...active,errorCode:'unknown_native'});
    assert.deepEqual(await store.getConversationActivity(scope('first')),{activeRunId:active.id,unresolvedGuidance:false});
    const other=await parent('second');const unknown=await create('second');await store.beginSteerAttempt({...unknown,agentId:'codex'});
    await store.finishSteerAttempt({...unknown,outcome:'unknown',errorCode:'unknown_guidance'});
    await store.finishJobWithOutbox(other);
    assert.deepEqual(await store.getConversationActivity(scope('second')),{activeRunId:null,unresolvedGuidance:true});
    assert.deepEqual(await store.getConversationActivity({...scope('second'),agentId:'other'}),{activeRunId:null,unresolvedGuidance:false});
    const [[index]]=await pool.query("SELECT COUNT(*) AS n FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='bridge_steering' AND index_name='steering_scope'");
    assert.equal(Number(index.n),5);
  }finally{await store.close();}
});
