import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';

const enabled=Boolean(process.env.BRIDGE_TEST_PASSWORD);
const refs=Object.fromEntries(['host','port','user','password','database'].map(k=>[`${k}Env`,`BRIDGE_TEST_${k.toUpperCase()}`]));
const tick=()=>new Promise(r=>setTimeout(r,5));
test('real MySQL resumes one durable hook after a prolonged pool outage without worker restart',
  {skip:!enabled,timeout:20000},async()=>{
    const live=createPoolFromEnvironment(refs),closed=createPoolFromEnvironment(refs);
    await closed.end();
    let selected=live,clock=0,deliveries=0,releaseRetry,runtime;
    const proxy={getConnection:()=>selected.getConnection(),end:()=>live.end()};
    await migrate(live);
    const store=await createMysqlStore({pool:proxy,connectionId:'degraded-recovery'});
    try{
      const job=await store.enqueueJob({connectionId:'degraded-recovery',conversationId:'chat',kind:'hook',hookId:'hook',idempotencyKey:'one',payload:{synthetic:true}});
      const logs=[];
      runtime=createCommunicationRuntime({
        config:{feishu:{connectionId:'degraded-recovery',botOpenId:'bot'},codex:{},routing:{privateUserIds:[],groups:[]},hooks:[{id:'hook',url:'https://example.invalid'}]},
        store,chat:{},hookTokens:{hook:'synthetic'},now:()=>clock,log:(...args)=>logs.push(args),
        fetchImpl:async()=>{deliveries++;return{status:204};},
        wait:async ms=>{clock+=ms;if(selected===closed&&runtime.status().consecutiveFailures>=8)await new Promise(r=>{releaseRetry=r;});else await tick();},
      });
      selected=closed;runtime.start();
      for(let i=0;i<400&&!releaseRetry;i++)await tick();
      assert.ok(releaseRetry,'worker should keep probing beyond its former retry budget');
      assert.equal(runtime.status().running,true);assert.equal(runtime.status().degraded,true);
      assert.ok(clock>30000);assert.ok(runtime.status().consecutiveFailures>=8);assert.equal(deliveries,0);
      selected=live;releaseRetry();
      let stored;
      for(let i=0;i<400;i++){stored=await store.getJob({id:job.id});if(stored.status==='succeeded'&&!runtime.status().degraded)break;await tick();}
      assert.equal(stored.status,'succeeded');assert.equal(stored.attempts,1);assert.equal(deliveries,1);
      assert.equal(runtime.status().running,true);assert.equal(runtime.status().degraded,false);
      assert.equal(logs.filter(([,op,status])=>op==='communication_worker'&&status==='recovered').length,1);
    }finally{releaseRetry?.();await runtime?.stop();await store.close();}
  });
