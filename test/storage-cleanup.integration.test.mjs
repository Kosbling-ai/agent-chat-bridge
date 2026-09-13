import test from 'node:test';
import assert from 'node:assert/strict';
import {createPoolFromEnvironment} from '../src/storage/connection.mjs';
import {migrate} from '../src/storage/migrations.mjs';
import {createMysqlStore} from '../src/storage/store.mjs';
const refs=Object.fromEntries(['host','port','user','password','database'].map(key=>[`${key}Env`,`BRIDGE_TEST_${key.toUpperCase()}`]));
test('real MySQL artifact effects retain UUID/order and cleanup is durable without resending',{
  skip:!process.env.BRIDGE_TEST_PASSWORD,timeout:30000,
},async()=>{
  let pool=createPoolFromEnvironment(refs);await migrate(pool);
  let clock=Date.now();let store=await createMysqlStore({pool,now:()=>clock});
  async function createRun(chat,count=1){
    const run=await store.enqueueJob({connectionId:'media',conversationId:chat,kind:'agent',idempotencyKey:chat,payload:{}});
    const [job]=await store.claimJobs({kind:'agent',owner:'agent',leaseMs:1000});assert.equal(job.id,run.id);
    const scope={connectionId:'media',conversationId:chat,runId:run.id};
    const outbox=[];
    for(let i=0;i<count;i++){
      const payload={scope,ref:{...scope,artifactId:`artifact-${i}`}};
      outbox.push({kind:'artifact_upload',idempotencyKey:`${chat}-${i}-upload`,payload},{kind:'artifact_send',idempotencyKey:`${chat}-${i}-send`,payload});
    }
    const finished=await store.finishJobWithOutbox({...job,outbox});
    return {run,scope,effects:finished.outbox};
  }
  const claim=async()=> (await store.claimOutbox({owner:'sender',limit:100,leaseMs:1000}));
  const settle=(row,status,result)=>store.settleOutbox({id:row.id,leaseToken:row.leaseToken,status,result});
  try{
    const first=await createRun('first',2);
    let [upload]=await claim();assert.equal(upload.kind,'artifact_upload');
    assert.deepEqual(await claim(),[]);
    assert.equal((await store.getOutbox({id:first.effects[1].id})).predecessorResult,null);
    await settle(upload,'sent',{file_key:'synthetic-key'});
    assert.deepEqual((await store.getOutbox({id:first.effects[1].id})).predecessorResult,{file_key:'synthetic-key'});
    let [send]=await claim();assert.equal(send.kind,'artifact_send');
    const uuid=send.platformUuid;await settle(send,'unknown');
    assert.deepEqual(await store.listPendingCleanup(),{items:[],nextCursor:null});
    [send]=await claim();assert.equal(send.platformUuid,uuid);assert.equal(send.id,first.effects[1].id);
    // Sent and cleanup marker survive a lost COMMIT response together.
    const originalGet=pool.getConnection.bind(pool);let inject=true;
    pool.getConnection=async()=>{const connection=await originalGet();if(inject){inject=false;const commit=connection.commit.bind(connection);connection.commit=async()=>{connection.commit=commit;await commit();throw new Error('synthetic commit loss');};}return connection;};
    await assert.rejects(settle(send,'sent',{message_id:'synthetic-message'}),{code:'commit_unknown'});pool.getConnection=originalGet;
    assert.equal((await store.getOutbox({id:send.id})).status,'sent');
    const [secondUpload]=await claim();assert.equal(secondUpload.kind,'artifact_upload');await settle(secondUpload,'sent',{image_key:'synthetic-image'});
    const [secondSend]=await claim();await settle(secondSend,'sent',{message_id:'synthetic-message-2'});
    assert.equal((await store.getJob({id:first.run.id})).status,'succeeded');
    await store.close();pool=createPoolFromEnvironment(refs);store=await createMysqlStore({pool,now:()=>clock});
    const page=await store.listPendingCleanup({limit:1});assert.equal(page.items.length,1);assert.ok(page.nextCursor);
    const tail=await store.listPendingCleanup({limit:1,afterId:page.nextCursor});assert.equal(tail.items.length,1);assert.equal(tail.nextCursor,null);
    assert.notEqual(page.items[0].id,tail.items[0].id);
    assert.deepEqual(await claim(),[]);
    // A cleanup failure means no acknowledgement, never a status rollback or send retry.
    assert.deepEqual((await store.listPendingCleanup()).items.map(row=>row.id),[...page.items,...tail.items].map(row=>row.id));
    for(const row of [...page.items,...tail.items]){
      assert.equal(row.jobId,first.run.id);assert.equal(row.payload.ref.runId,first.run.id);
      await assert.rejects(store.completeOutboxCleanup({...row,conversationId:'wrong'}),{code:'cleanup_conflict'});
      assert.deepEqual(await store.completeOutboxCleanup(row),{completed:true});
      assert.deepEqual(await store.completeOutboxCleanup(row),{completed:true});
      assert.equal((await store.getOutbox({id:row.id})).status,'sent');
    }
    assert.deepEqual(await store.listPendingCleanup(),{items:[],nextCursor:null});
    const unknown=await createRun('unknown-upload');[upload]=await claim();await settle(upload,'unknown');
    assert.deepEqual(await claim(),[]);assert.equal((await store.getOutbox({id:unknown.effects[1].id})).blocked,true);
    await assert.rejects(store.completeOutboxCleanup({id:unknown.effects[1].id,connectionId:'media',conversationId:'unknown-upload'}),{code:'cleanup_conflict'});
    const expired=await createRun('expired-send');[upload]=await claim();await settle(upload,'sent',{file_key:'key'});[send]=await claim();await settle(send,'unknown');
    clock+=55*60*1000+1;assert.deepEqual(await claim(),[]);
    assert.equal((await store.getOutbox({id:expired.effects[1].id})).status,'unknown');
    assert.deepEqual(await store.listPendingCleanup(),{items:[],nextCursor:null});
    const failed=await createRun('failed-send');[upload]=await claim();await settle(upload,'sent',{file_key:'key'});[send]=await claim();await settle(send,'failed');
    assert.equal((await store.getJob({id:failed.run.id})).status,'delivery_failed');
    assert.deepEqual(await store.listPendingCleanup(),{items:[],nextCursor:null});
  }finally{await store.close();}
});
