import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPoolFromEnvironment} from '../src/storage/connection.mjs';
import {migrate} from '../src/storage/migrations.mjs';
import {createForwardJobStore} from '../src/storage/forward-jobs.mjs';

const refs=Object.fromEntries(['host','port','user','password','database'].map(key=>[`${key}Env`,`BRIDGE_TEST_${key.toUpperCase()}`]));

test('user-input sidecar CAS accepts one answer and survives production reply merge',{skip:!process.env.BRIDGE_TEST_PASSWORD,timeout:40_000},async()=>{
  const pool=createPoolFromEnvironment(refs);try{
    await migrate(pool);const jobs=createForwardJobStore({pool,connectionId:'user-input',now:()=>2000});
    const created=await jobs.upsert({callerId:'live',idempotencyKey:randomUUID(),conversationId:'chat',messageId:`message-${randomUUID()}`,
      sourceMessageId:'source',bindingOpenId:'actor',chatType:'p2p',senderOpenId:'actor',prompt:'ask'});
    const result={execution:{bindingOpenId:'actor',threadId:'thread',turnId:'turn'}};
    await pool.execute("UPDATE assistant_codex_forward_jobs SET status='running',lease_owner='worker',lease_expires_at=999999,result_json=? WHERE connection_id='user-input' AND public_run_id=?",[JSON.stringify(result),created.id]);
    const opened=await jobs.beginUserInput({id:created.id,messageId:created.messageId,threadId:'thread',turnId:'turn',itemId:'item',requestKey:'number:0',
      cardUuid:'card-uuid',questions:[{id:'q',header:'h',question:'q',options:[],isOther:false}]});
    assert.equal(opened.outcome,'new');await jobs.finishUserInputCard({id:created.id,requestKey:'number:0',status:'confirmed',cardMessageId:'card'});
    const input={id:created.id,requestKey:'number:0',itemId:'item',actor:'actor',chatId:'chat',cardMessageId:'card',answers:{q:{answers:['user_note: a']}},operationId:randomUUID()};
    const [first,second]=await Promise.all([jobs.beginUserInputAnswer(input),jobs.beginUserInputAnswer({...input,operationId:randomUUID()})]);
    assert.deepEqual([first.outcome,second.outcome].sort(),['new','replay']);
    const operation=first.outcome==='new'?first.userInput.operationId:second.userInput.operationId;
    assert.equal((await jobs.finishUserInput({id:created.id,requestKey:'number:0',operationId:operation,status:'submitted'})).outcome,'submitted');
    await jobs.markReplyPending({id:created.id,leaseOwner:'worker',result:{answer:'done'},execution:result.execution});
    const saved=await jobs.getRun({id:created.id});assert.equal(saved.result.userInput.status,'submitted');assert.equal(saved.result.userInput.answers.q.answers[0],'user_note: a');
  }finally{await pool.end();}
});
