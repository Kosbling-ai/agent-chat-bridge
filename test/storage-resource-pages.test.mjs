import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceOperations } from '../src/storage/resources.mjs';

test('resource page requests require a bounded explicit kind before database access', () => {
  let accessed=false;
  const store=resourceOperations({read(){accessed=true;throw Error('unexpected database access');}});
  for(const input of [
    {connectionId:'c'}, {connectionId:'c',kind:'both'},
    {connectionId:'c',kind:'output',limit:101}, {connectionId:'c',kind:'input',limit:0},
  ]) assert.throws(()=>store.listRetirableResources(input),{code:'invalid_retirement'});
  assert.equal(accessed,false);
});

test('independent kind pages preserve the scanned cursor even for retained input', async () => {
  const calls=[];
  const store=resourceOperations({
    read:fn=>fn({execute:async(sql,params)=>{
      calls.push({sql,params});
      return [[{run_id:params[1]?'next':'first',input_retirable:'0',output_retirable:'1'}]];
    }}),
    decode:row=>({runId:row.run_id}),
  });
  const input=await store.listRetirableResources({connectionId:'c',kind:'input',limit:1});
  assert.equal(input.items[0].inputRetirable,false);assert.equal(input.nextCursor,'first');
  const output=await store.listRetirableResources({connectionId:'c',kind:'output',limit:1});
  assert.equal(output.items[0].outputRetirable,true);assert.equal(output.nextCursor,'first');
  await store.listRetirableResources({connectionId:'c',kind:'input',afterRunId:input.nextCursor,limit:1});
  assert.deepEqual(calls.map(call=>call.params),[['c',''],['c',''],['c','first']]);
  assert.match(calls[0].sql,/FORCE INDEX \(jobs_input_resources\)/);
  assert.match(calls[1].sql,/output_resource_state IN \('pending','sealed'\)/);
  assert.match(calls[1].sql,/status='succeeded'/);
});
