import test from 'node:test';import assert from 'node:assert/strict';
import {attachStorageDiagnostics,recordStorageDiagnostic,isStorageDiagnosticsEnabled} from '../src/storage/diagnostics.mjs';
import {createLogger} from '../src/logger.mjs';

test('storage logs allow only numeric diagnostic fields and omit raw content',()=>{
 const events=[];const log=createLogger({write:l=>events.push(JSON.parse(l))});
 log('warning','storage_operation','failed',{stage:'commit',durationMs:1805,commitMs:1700,poolWaitMs:2,
  timeoutMs:1800,timeoutOvershootMs:5,dbConnectionId:42,transaction:true,eventLoopDelayMaxMs:9,
  operationMs:NaN,poolQueued:-1,dbThreadsRunning:'SECRET',sql:'SECRET',params:['SECRET'],message:'SECRET',stack:'SECRET'});
 assert.equal(events[0].commit_ms,1700);assert.equal(events[0].db_connection_id,42);
 assert.equal(events[0].transaction,true);assert.equal(events[0].timeout_overshoot_ms,5);
 assert.equal(events[0].operation_ms,undefined);assert.equal(events[0].pool_queued,undefined);
 assert.equal(JSON.stringify(events).includes('SECRET'),false);
});

test('slow operation bursts are limited, summarized and detached on close',async()=>{
 let clock=0;const events=[];const pool={pool:{_allConnections:[1,2],_freeConnections:[1],_connectionQueue:[]}};
 const log=createLogger({write:l=>events.push(JSON.parse(l))});
 const diagnostics=attachStorageDiagnostics(pool,{log,now:()=>clock,burstLimit:2,sampleServer:async()=>[
  {Variable_name:'Threads_running',Value:'3'},{Variable_name:'Uptime',Value:'100'},
  {Variable_name:'unknown_password',Value:'SECRET'}]});
 try{
  assert.equal(isStorageDiagnosticsEnabled(pool),true);
  for(let i=0;i<5;i++)recordStorageDiagnostic(pool,{status:'slow',code:'storage_operation_slow',stage:'commit',commitMs:600});
  await diagnostics.snapshot();clock=1000;await diagnostics.snapshot();
  const operations=events.filter(e=>e.operation==='storage_operation');
  assert.equal(operations.length,2);assert.equal(operations[0].pool_connections,2);
  assert.ok(events.some(e=>e.operation==='storage_snapshot'&&e.diagnostic_suppressed===3));
  assert.ok(events.some(e=>e.db_threads_running===3));assert.equal(JSON.stringify(events).includes('SECRET'),false);
  clock=60001;recordStorageDiagnostic(pool,{status:'slow',stage:'operation',durationMs:800});
  assert.equal(events.filter(e=>e.operation==='storage_operation').length,3);
 }finally{await diagnostics.close();}
 assert.equal(isStorageDiagnosticsEnabled(pool),false);
 const count=events.length;recordStorageDiagnostic(pool,{status:'failed'});await diagnostics.snapshot();assert.equal(events.length,count);
});

test('observer and snapshot failures cannot escape into business operations',async()=>{
 const pool={};let snapshots=0;
 const diagnostics=attachStorageDiagnostics(pool,{log:()=>{throw new Error('private');},sampleServer:async()=>{snapshots++;throw Object.assign(new Error('SECRET'),{code:'ECONNRESET'});}});
 assert.doesNotThrow(()=>recordStorageDiagnostic(pool,{status:'failed',stage:'commit'}));
 await diagnostics.snapshot();assert.equal(snapshots,1);await diagnostics.close();
});
