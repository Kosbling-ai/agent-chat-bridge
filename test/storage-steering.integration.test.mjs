import test from 'node:test';
import assert from 'node:assert/strict';
import {createPoolFromEnvironment} from '../src/storage/connection.mjs';
import {migrate} from '../src/storage/migrations.mjs';
import {createMysqlStore} from '../src/storage/store.mjs';
const refs=Object.fromEntries(['host','port','user','password','database'].map(key=>[`${key}Env`,`BRIDGE_TEST_${key.toUpperCase()}`]));
test('real MySQL steering is serial, durable and never replays an uncertain guidance',{
  skip:!process.env.BRIDGE_TEST_PASSWORD,timeout:30000,
},async()=>{
  let pool=createPoolFromEnvironment(refs);await migrate(pool);let clock=Date.now();
  let store=await createMysqlStore({connectionId:'steering',pool,now:()=>clock});
  const scope=conversationId=>({connectionId:'steering',conversationId,agentId:'codex'});
  let sequence=0;
  async function enqueue(chat){return store.enqueueJob({...scope(chat),kind:'agent',idempotencyKey:`job-${++sequence}`,payload:{}});}
  const claim=(leaseMs=300000)=>store.claimJobs({kind:'agent',owner:'worker',leaseMs});
  async function parent(chat){
    const added=await enqueue(chat);const [row]=await claim();assert.equal(row.id,added.id);
    const attempt=await store.beginAgentAttempt({...row,agentId:'codex'});
    const thread=attempt.nativeThreadId??`thread-${chat}`;
    await store.bindAgentAttempt({...row,expectedGeneration:attempt.generation,nativeThreadId:thread,nativeTurnId:`turn-${row.id}`});
    return {...row,generation:attempt.generation,thread};
  }
  const begin=row=>store.beginSteerAttempt({...row,agentId:'codex'});
  const finish=(row,outcome)=>store.finishSteerAttempt({...row,outcome,...(outcome!=='accepted'?{errorCode:'synthetic_outcome'}:{})});
  try{
    const active=await parent('serial');
    assert.deepEqual(await begin(active),{kind:'inactive'});
    await enqueue('serial');await enqueue('serial');const guidance=await claim();assert.equal(guidance.length,2);
    const starts=await Promise.all(guidance.map(begin));
    const firstIndex=starts.findIndex(result=>result.kind==='new');assert.ok(firstIndex>=0);
    assert.equal(starts.filter(result=>result.kind==='inactive').length,1);
    const first=guidance[firstIndex],second=guidance[1-firstIndex];
    assert.equal(starts[firstIndex].clientMessageId,first.id);
    assert.equal((await begin(first)).kind,'recovery_required');
    const admittedAt=Number((await store.getSteerAttempt({id:first.id})).createdAt);clock+=100;
    assert.deepEqual(await finish(first,'accepted'),{status:'accepted'});
    assert.deepEqual(await finish(first,'accepted'),{status:'accepted'});
    assert.deepEqual((await store.getJob({id:first.id})).result,{deferred:true,targetRunId:active.id,nativeTurnId:`turn-${active.id}`});
    assert.equal((await store.getSession(scope('serial'))).activeRunId,active.id);
    assert.equal(Number((await store.getSession(scope('serial'))).lastMessageAt),admittedAt);
    assert.equal((await begin(second)).kind,'new');await finish(second,'rejected');clock+=1001;
    const [retry]=await claim();assert.equal(retry.id,second.id);assert.deepEqual(await begin(retry),{kind:'inactive'});
    await assert.rejects(store.beginAgentAttempt({...retry,agentId:'codex'}),{code:'session_busy'});
    await store.finishJobWithOutbox(active);
    assert.deepEqual(await begin(retry),{kind:'inactive'});
    await store.beginAgentAttempt({...retry,agentId:'codex'});await store.finishJobWithOutbox(retry);
    const [[effects]]=await pool.query('SELECT COUNT(*) AS n FROM bridge_outbox');assert.equal(Number(effects.n),0);
    // Crash after durable intent: a fresh worker must hold, never emit the RPC again.
    const uncertainParent=await parent('unknown');await enqueue('unknown');const [uncertain]=await claim(100);
    assert.equal((await begin(uncertain)).kind,'new');
    await store.close();pool=createPoolFromEnvironment(refs);store=await createMysqlStore({connectionId:'steering',pool,now:()=>clock});clock+=101;
    const [recovered]=await claim();assert.equal(recovered.id,uncertain.id);
    assert.equal((await begin(recovered)).kind,'recovery_required');
    await assert.rejects(finish(uncertain,'accepted'),{code:'stale_lease'});
    await finish(recovered,'unknown');
    assert.equal((await store.getJob({id:uncertain.id})).status,'unknown');
    assert.equal((await store.getSession(scope('unknown'))).activeRunId,uncertainParent.id);
    await enqueue('unknown');const [blocked]=await claim();assert.deepEqual(await begin(blocked),{kind:'inactive'});
    await store.finishJobWithOutbox(uncertainParent);
    await store.beginAgentAttempt({...blocked,agentId:'codex'});await store.finishJobWithOutbox(blocked);
    assert.deepEqual(await claim(),[]);
    // Late acceptance remains true after parent completion and even after retirement.
    const lateParent=await parent('late');await enqueue('late');const [late]=await claim();assert.equal((await begin(late)).kind,'new');
    await store.finishJobWithOutbox(lateParent);
    await assert.rejects(store.beginAgentAttempt({...late,agentId:'codex'}),{code:'steer_recovery_required'});
    await store.rotateIdleSession({...scope('late'),expectedGeneration:lateParent.generation,expectedThreadId:lateParent.thread,reason:'session_idle',idempotencyKey:'late-retirement'});
    const retired=await store.getSession(scope('late'));
    const originalGet=pool.getConnection.bind(pool);let inject=true;
    pool.getConnection=async()=>{const connection=await originalGet();if(inject){inject=false;const commit=connection.commit.bind(connection);connection.commit=async()=>{connection.commit=commit;await commit();throw new Error('synthetic commit loss');};}return connection;};
    await assert.rejects(finish(late,'accepted'),{code:'commit_unknown'});pool.getConnection=originalGet;
    assert.deepEqual(await finish(late,'accepted'),{status:'accepted'});
    assert.equal((await store.getJob({id:late.id})).status,'succeeded');
    assert.equal((await store.getSession(scope('late'))).lastMessageAt,retired.lastMessageAt);
    // A proven rejection may target a genuinely different parent; keep both audits.
    const older=await parent('different-target');await enqueue('different-target');const [instruction]=await claim();
    await begin(instruction);await finish(instruction,'rejected');await store.finishJobWithOutbox(older);
    const newer=await parent('different-target');clock+=1001;const [again]=await claim();assert.equal(again.id,instruction.id);
    const newIntent=await begin(again);assert.equal(newIntent.kind,'new');assert.equal(newIntent.targetRunId,newer.id);
    await finish(again,'accepted');
    const [[audits]]=await pool.query('SELECT COUNT(*) AS n FROM bridge_steering WHERE guidance_job_id=?',[instruction.id]);assert.equal(Number(audits.n),2);
  }finally{await store.close();}
});
