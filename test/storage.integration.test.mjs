import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPoolFromEnvironment,withConnection} from '../src/storage/connection.mjs';
import {migrate,assertSchemaCurrent} from '../src/storage/migrations.mjs';
import {createMysqlStore} from '../src/storage/store.mjs';
const enabled=Boolean(process.env.BRIDGE_TEST_PASSWORD);
const refs=Object.fromEntries(['host','port','user','password','database'].map(k=>[`${k}Env`,`BRIDGE_TEST_${k.toUpperCase()}`]));
test('real isolated MySQL: migrations, atomic inbox/jobs, fencing, outbox, sessions and cursors',{skip:!enabled,timeout:40000},async()=>{
 const pool=createPoolFromEnvironment(refs);
 const [[version]]=await pool.query('SELECT VERSION() AS version');console.log('Isolated MySQL version:',version.version);
 await assert.rejects(assertSchemaCurrent(pool),{code:'schema_migration_required'});
 assert.equal((await migrate(pool)).applied,true);assert.equal((await migrate(pool)).applied,false);
 let clock=Date.now();const store=await createMysqlStore({connectionId:'c',pool,now:()=>clock,onWriterLost:async()=>{throw new Error('synthetic observer failure');}});
 try{
 const second=createPoolFromEnvironment(refs);await assert.rejects(createMysqlStore({connectionId:'c',pool:second}),{code:'writer_busy'});await second.end();
 // Hold the first registration COMMIT while a second registration is in flight.
 // The second must not become visible/claimable before the first commits.
 for (const mode of ['enqueue','inbound']) {
   const originalGet=pool.getConnection.bind(pool);
   let enter,release;
   const entered=new Promise(resolve=>{enter=resolve;});
   const gate=new Promise(resolve=>{release=resolve;});
   let gateNext=true;
   pool.getConnection=async()=>{
     const c=await originalGet();
     if(gateNext){gateNext=false;const commit=c.commit.bind(c);c.commit=async()=>{c.commit=commit;enter();await gate;return commit();};}
     return c;
   };
   const register=(key)=>mode==='enqueue'
     ? store.enqueueJob({kind:'hook',connectionId:'c',conversationId:mode,hookId:'h',idempotencyKey:`${mode}:${key}`,payload:{}})
     : store.acceptInbound({connectionId:'c',conversationId:mode,eventKey:`${mode}:${key}`,eventType:'message',payload:{},policyVersion:'v',hooks:[{hookId:'h'}]});
   let first,second;
   try {
     first=register('first');await Promise.race([entered,first.then(()=>{throw new Error('commit_not_intercepted');})]);
     let secondDone=false;
     second=register('second').then(value=>{secondDone=true;return value;});
     await new Promise(resolve=>setTimeout(resolve,50));
     assert.equal(secondDone,false);
     assert.deepEqual(await store.claimJobs({kind:'hook',owner:'ordering',leaseMs:1000}),[]);
     release();const firstResult=await first;const secondResult=await second;
     for(const registered of [firstResult,secondResult]) {
       const [job]=await store.claimJobs({kind:'hook',owner:'ordering',leaseMs:1000});
       assert.equal(job.id,registered.id ?? registered.hookJobIds[0]);
       await store.finishJobWithOutbox({id:job.id,leaseToken:job.leaseToken});
     }
   } finally {release();await first?.catch(()=>{});await second?.catch(()=>{});pool.getConnection=originalGet;}
 }
 const input={connectionId:'c',conversationId:'chat',eventKey:'event',eventType:'message',messageId:'m',payload:{text:'synthetic'},policyVersion:'v1',passiveContext:true,agentJob:{payload:{prompt:'synthetic'}},hooks:[{hookId:'h'}]};
 const event=await store.acceptInbound(input);assert.equal(event.duplicate,false);
 const repeated=await store.acceptInbound({...input,policyVersion:'v2'});assert.equal(repeated.duplicate,true);assert.equal(repeated.agentJobId,event.agentJobId);
 await assert.rejects(store.acceptInbound({...input,payload:{text:'changed'}}),{code:'inbound_conflict'});
 await store.enqueueJob({kind:'agent',connectionId:'c',conversationId:'chat',idempotencyKey:'agent:first',payload:{prompt:'synthetic'}});
 const [job]=await store.claimJobs({kind:'agent',owner:'one',limit:1,leaseMs:1000});
 clock+=1100;const [replacement]=await store.claimJobs({kind:'agent',owner:'two',limit:1,leaseMs:1000});
 await assert.rejects(store.finishJobWithOutbox({id:job.id,leaseToken:job.leaseToken}),{code:'stale_lease'});
 const completed=await store.finishJobWithOutbox({id:replacement.id,leaseToken:replacement.leaseToken,result:{ok:true},outbox:[{idempotencyKey:'reply',kind:'reply',payload:{text:'result'}}]});assert.equal(completed.status,'reply_pending');
 const [out]=await store.claimOutbox({owner:'one',limit:1,leaseMs:1000});await store.settleOutbox({id:out.id,leaseToken:out.leaseToken,status:'unknown'});
 const [retry]=await store.claimOutbox({owner:'two',limit:1,leaseMs:1000});assert.equal(retry.platformUuid,out.platformUuid);
 await store.settleOutbox({id:retry.id,leaseToken:retry.leaseToken,status:'sent'});assert.equal((await store.getJob({id:job.id})).status,'succeeded');
 const reaction=await store.recordOutbox({connectionId:'c',conversationId:'chat',idempotencyKey:'reaction',kind:'reaction',payload:{emoji:'OK'}});const [react]=await store.claimOutbox({owner:'one',leaseMs:1000});assert.equal(react.id,reaction.id);await store.settleOutbox({id:react.id,leaseToken:react.leaseToken,status:'unknown'});assert.deepEqual(await store.claimOutbox({owner:'two',leaseMs:1000}),[]);
 const key={connectionId:'c',conversationId:'chat',agentId:'codex'};await store.setSession({...key,expectedGeneration:0,nativeThreadId:'thread'});await store.resetSession({...key,expectedGeneration:1});await assert.rejects(store.setSession({...key,expectedGeneration:1,nativeThreadId:'old'}),{code:'session_conflict'});
 await store.setCursor({connectionId:'c',key:'history',expectedVersion:0,value:{page:'a'}});await assert.rejects(store.setCursor({connectionId:'c',key:'history',expectedVersion:0,value:{page:'b'}}),{code:'cursor_conflict'});
 const runId=job.id;await store.appendRunEvent({runId,eventKey:'1',type:'delta',payload:{text:'synthetic'}});assert.equal((await store.readRunEvents({runId})).length,1);
 assert.equal((await store.readPassiveContext(input)).length,1);await store.consumePassiveContext({...input,runId,throughSequence:event.sequence});assert.equal((await store.readPassiveContext(input)).length,0);
 const hookEvent=await store.acceptInbound({...input,eventKey:'event2'});
 const [hook1]=await store.claimJobs({kind:'hook',owner:'one',leaseMs:1000});assert.equal(hook1.id,event.hookJobIds[0]);assert.deepEqual(await store.claimJobs({kind:'hook',owner:'two',leaseMs:1000}),[]);
 await store.finishJobWithOutbox({id:hook1.id,leaseToken:hook1.leaseToken});const [hook2]=await store.claimJobs({kind:'hook',owner:'one',leaseMs:1000});assert.equal(hook2.id,hookEvent.hookJobIds[0]);
 await store.enqueueJob({kind:'agent',connectionId:'c',conversationId:'chat',idempotencyKey:'agent:second',payload:{prompt:'synthetic'}});
 const [agent2]=await store.claimJobs({kind:'agent',owner:'one',leaseMs:1000});const attempt=await store.beginAgentAttempt({id:agent2.id,leaseToken:agent2.leaseToken,agentId:'codex'});assert.equal(attempt.recoveryRequired,false);
 assert.equal((await store.beginAgentAttempt({id:agent2.id,leaseToken:agent2.leaseToken,agentId:'codex'})).recoveryRequired,true);
 await assert.rejects(store.resetSession({...key,expectedGeneration:2}),{code:'session_busy_or_conflict'});
 await store.bindAgentAttempt({id:agent2.id,leaseToken:agent2.leaseToken,expectedGeneration:attempt.generation,nativeThreadId:'thread2',nativeTurnId:'turn2'});
 await store.bufferNativeEvent({connectionId:'c',eventKey:'native1',nativeThreadId:'thread2',nativeTurnId:'turn2',payload:{type:'completed'}});assert.equal((await store.readNativeEvents({connectionId:'c',nativeThreadId:'thread2'})).length,1);
 await assert.rejects(store.finishJobWithOutbox({id:agent2.id,leaseToken:agent2.leaseToken,outbox:[{idempotencyKey:'reply',kind:'reply',payload:{text:'conflict'}}]}),{code:'outbox_conflict'});assert.equal((await store.getJob({id:agent2.id})).status,'running');assert.equal((await store.getSession(key)).activeRunId,agent2.id);
 await store.finishJobWithOutbox({id:agent2.id,leaseToken:agent2.leaseToken});assert.equal((await store.getSession(key)).activeRunId,null);
 // Actual COMMIT succeeds in MySQL; response is deliberately lost at driver boundary.
 const lostCommitPool={async getConnection(){const c=await pool.getConnection();const original=c.commit.bind(c);c.commit=async()=>{await original();throw new Error('synthetic lost response');};return c;}};
 await assert.rejects(withConnection(lostCommitPool,c=>c.execute('INSERT INTO bridge_cursors (connection_id,cursor_key,version,value,updated_at) VALUES (?,?,1,?,?)',['fault','commit',JSON.stringify({ok:true}),clock]),{transaction:true}),{code:'commit_unknown'});
 const [[faultCursor]]=await pool.query('SELECT value FROM bridge_cursors WHERE connection_id=? AND cursor_key=?',['fault','commit']);assert.deepEqual(faultCursor.value,{ok:true});
 await store.excludeMessage({connectionId:'c',messageId:'future'});await store.acceptInbound({...input,eventKey:'future',messageId:'future',agentJob:null,hooks:[]});assert.equal((await store.readPassiveContext(input)).some(row=>row.messageId==='future'),false);
 const unknownJob=await store.enqueueJob({kind:'agent',connectionId:'c',conversationId:'unknown',idempotencyKey:'unknown',payload:{}});const [unknownClaim]=await store.claimJobs({kind:'agent',owner:'one',leaseMs:1000});assert.equal(unknownClaim.id,unknownJob.id);await store.beginAgentAttempt({id:unknownClaim.id,leaseToken:unknownClaim.leaseToken,agentId:'codex'});await store.holdAgentAttempt({id:unknownClaim.id,leaseToken:unknownClaim.leaseToken,errorCode:'rpc_timeout'});assert.equal((await store.getJob({id:unknownClaim.id})).status,'unknown');assert.deepEqual(await store.claimJobs({kind:'agent',owner:'other',leaseMs:1000}),[]);
 const start=Date.now();await assert.rejects(withConnection(pool,c=>c.query('SELECT SLEEP(5)'),{timeoutMs:50}),{code:'store_timeout'});assert.ok(Date.now()-start<1000);await assertSchemaCurrent(pool);
 const backlog=Array.from({length:105},(_,i)=>[randomUUID(),'c','chat',`expired-${i}`,'reaction','0'.repeat(64),'{}',randomUUID(),'running',clock-1,clock-1,clock-1,clock,clock]);
 await pool.query('INSERT INTO bridge_outbox (id,connection_id,conversation_id,idempotency_key,kind,payload_hash,payload,platform_uuid,status,first_attempt_at,lease_expires_at,next_attempt_at,created_at,updated_at) VALUES ?',[backlog]);
 await store.claimOutbox({owner:'batch',leaseMs:1000});
 const [[remaining]]=await pool.query("SELECT COUNT(*) AS n FROM bridge_outbox WHERE connection_id='c' AND status='running'");assert.equal(Number(remaining.n),5);
 const [[lock]]=await pool.query("SELECT OWNER_THREAD_ID AS owner FROM performance_schema.metadata_locks WHERE OBJECT_TYPE='USER LEVEL LOCK' AND OBJECT_NAME LIKE 'bridge:writer:%'");
 const [[thread]]=await pool.query('SELECT PROCESSLIST_ID AS id FROM performance_schema.threads WHERE THREAD_ID=?',[lock.owner]);
 await pool.query(`KILL CONNECTION ${Number(thread.id)}`);
 await new Promise(r=>setTimeout(r,20));await assert.rejects(store.enqueueJob({kind:'agent',connectionId:'c',conversationId:'x',idempotencyKey:'after-lock-loss',payload:{}}),{code:'writer_lock_lost'});
 }finally{await store.close();}
});
