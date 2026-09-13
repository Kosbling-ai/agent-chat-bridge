import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { acquireWriter } from '../src/storage/writer.mjs';

function connection(query) {
  return { connection: new EventEmitter(), query, destroyed: false, destroy() { this.destroyed = true; } };
}
for (const stage of ['acquire', 'database', 'lock']) {
  test(`writer startup has a real connection deadline at ${stage}`, {timeout:1000}, async () => {
    let resolveAcquire;
    const conn = connection(async (sql) => {
      if (stage === 'database' || (stage === 'lock' && sql.includes('GET_LOCK'))) return new Promise(() => {});
      return [[{name:'synthetic'}]];
    });
    const pool = {getConnection: () => stage === 'acquire' ? new Promise(resolve => { resolveAcquire = resolve; }) : Promise.resolve(conn)};
    await assert.rejects(acquireWriter(pool, undefined, {timeoutMs:20}), {code:'writer_start_timeout'});
    if (resolveAcquire) { resolveAcquire(conn); await new Promise(setImmediate); }
    assert.equal(conn.destroyed,true);
  });
}
test('writer loss contains asynchronous observer failure', {timeout:1000}, async () => {
  const conn=connection(async(sql)=>sql.includes('DATABASE')?[[{name:'synthetic'}]]:[[{acquired:1}]]);
  const writer=await acquireWriter({getConnection:async()=>conn},async()=>{throw new Error('synthetic callback rejection');});
  conn.connection.emit('error',new Error('synthetic socket loss'));
  await new Promise(setImmediate);
  assert.throws(()=>writer.assert(),{code:'writer_lock_lost'});
  await writer.close();
});
