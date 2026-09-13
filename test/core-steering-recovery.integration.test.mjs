// Regression based on the independent review's real Store expired-intent probe.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPoolFromEnvironment} from '../src/storage/connection.mjs';
import {migrate} from '../src/storage/migrations.mjs';
import {createMysqlStore} from '../src/storage/store.mjs';
import {createRuntime} from '../src/core/runtime.mjs';
const refs=Object.fromEntries(['host','port','user','password','database'].map(k=>[k+'Env','BRIDGE_TEST_'+k.toUpperCase()]));
test('unresolved steer intent survives input resource failure on restart',{skip:!process.env.BRIDGE_TEST_PASSWORD,timeout:10000},async()=>{
  const pool=createPoolFromEnvironment(refs);let store,runtime;let prepared=0,directories=0,nativeReads=0;
  try {
    await migrate(pool);store=await createMysqlStore({pool});
    const scope={connectionId:'fixture',conversationId:'chat'};
    const parent=await store.enqueueJob({...scope,kind:'agent',idempotencyKey:'parent',payload:{text:'parent'}
});
    const [p]=await store.claimJobs({kind:'agent',owner:'old',leaseMs:300000,limit:1});
    const attempt=await store.beginAgentAttempt({...p,agentId:'codex'});
    await store.bindAgentAttempt({...p,expectedGeneration:attempt.generation,nativeThreadId:'thread',nativeTurnId:'turn'});
    const guidance=await store.enqueueJob({...scope,kind:'agent',idempotencyKey:'guidance',payload:{unsupported:true,messageId:'image',event:{...scope,conversationType:'p2p',message:{kind:'image',content:'{}'}}}
});
    const [g]=await store.claimJobs({kind:'agent',owner:'old',leaseMs:100,limit:1});
    assert.equal((await store.beginSteerAttempt({...g,agentId:'codex'})).kind,'new');
    await new Promise(r=>setTimeout(r,120));
    const getAttempt=store.getAgentAttempt;store.getAgentAttempt=async input=>{nativeReads++;return getAttempt(input);};
    runtime=createRuntime({workspace:'/synthetic/workspace',config:{codex:{steering:false},feishu:{connectionId:'fixture'},routing:{groups:[]},hooks:[]},store,codex:{status:()=>({state:'ready'})},chat:{replyMessage:async()=>({message_id:'sent'})},outbound:{directory:async()=>{directories++;throw Error('must not touch output directory');}},media:{prepare:async()=>{prepared++;return {status:'failed',reason:'image_download_failed'};}}
});
    runtime.start();
    let row;for(let i=0;i<100;i++){row=await store.getJob({id:guidance.id});if(['succeeded','unknown'].includes(row.status))break;
    await new Promise(r=>setTimeout(r,20));}assert.equal((await store.getSteerAttempt({id:guidance.id})).status,'unknown');
    assert.equal(row.status,'unknown');
    assert.equal(prepared,0);
    assert.equal(directories,0);
    assert.equal(nativeReads,0);
  } finally {await runtime?.stop();if(store)await store.close();else await pool.end();}
});
