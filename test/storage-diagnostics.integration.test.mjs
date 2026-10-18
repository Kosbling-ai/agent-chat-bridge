import test from 'node:test';import assert from 'node:assert/strict';
import {createPoolFromEnvironment,withConnection} from '../src/storage/connection.mjs';
import {attachStorageDiagnostics} from '../src/storage/diagnostics.mjs';
import {createLogger} from '../src/logger.mjs';
const refs=Object.fromEntries(['host','port','user','password','database'].map(k=>[`${k}Env`,`BRIDGE_TEST_${k.toUpperCase()}`]));
test('real MySQL slow and timed-out calls retain timings and safe server snapshots',
 {skip:!process.env.BRIDGE_TEST_PASSWORD,timeout:10000},async()=>{
 const pool=createPoolFromEnvironment(refs),events=[];
 const diagnostics=attachStorageDiagnostics(pool,{log:createLogger({write:l=>events.push(JSON.parse(l))})});
 try{
  await withConnection(pool,async c=>{await c.query('SELECT SLEEP(0.55) AS SYNTHETIC_PRIVATE');},{transaction:true,timeoutMs:2000});
  const slow=events.find(e=>e.operation==='storage_operation'&&e.status==='slow');
  assert.ok(slow);assert.ok(slow.operation_ms>=500);assert.ok(slow.durationMs>=500);
  assert.ok(Number.isSafeInteger(slow.db_connection_id));assert.ok(Number.isSafeInteger(slow.commit_ms));
  await assert.rejects(withConnection(pool,c=>c.query('SELECT SLEEP(1) AS SYNTHETIC_PRIVATE'),{timeoutMs:30}),{code:'store_timeout'});
  const failed=events.find(e=>e.operation==='storage_operation'&&e.status==='failed');
  assert.equal(failed.stage,'operation');assert.equal(failed.reason,'operation_timeout');
  assert.ok(failed.operation_ms>=20);assert.ok(Number.isSafeInteger(failed.timeout_overshoot_ms));
  await diagnostics.snapshot();
  assert.ok(events.some(e=>e.operation==='storage_snapshot'&&e.db_threads_connected>=1));
  assert.equal(JSON.stringify(events).includes('SYNTHETIC_PRIVATE'),false);
 }finally{await diagnostics.close();await pool.end();}
});
