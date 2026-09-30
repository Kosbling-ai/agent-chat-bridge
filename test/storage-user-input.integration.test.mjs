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
    await jobs.markReplyPending({id:created.id,leaseOwner:'worker',result:{answer:'done',userInput:{status:'pending'}},execution:result.execution});
    await pool.execute("UPDATE assistant_codex_forward_jobs SET lease_owner='worker',lease_expires_at=999999 WHERE connection_id='user-input' AND public_run_id=?",[created.id]);
    await jobs.patchReplyResult({id:created.id,leaseOwner:'worker',result:{answer:'done',userInput:{status:'pending'}}});
    await jobs.markFinished({id:created.id,leaseOwner:'worker',status:'completed',result:{answer:'done',userInput:{status:'submitting'}}});
    const saved=await jobs.getRun({id:created.id});assert.equal(saved.result.userInput.status,'submitted');assert.equal(saved.result.userInput.answers.q.answers[0],'user_note: a');

    const secondJob=await jobs.upsert({callerId:'live',idempotencyKey:randomUUID(),conversationId:'chat',messageId:`message-${randomUUID()}`,
      sourceMessageId:'source-2',bindingOpenId:'actor',chatType:'p2p',senderOpenId:'actor',prompt:'ask'});
    await pool.execute("UPDATE assistant_codex_forward_jobs SET status='running',lease_owner='worker',lease_expires_at=999999,result_json=? WHERE connection_id='user-input' AND public_run_id=?",[JSON.stringify(result),secondJob.id]);
    await jobs.beginUserInput({id:secondJob.id,messageId:secondJob.messageId,threadId:'thread',turnId:'turn',itemId:'item',requestKey:'string:second',cardUuid:'card-uuid-2',questions:[{id:'q',header:'h',question:'q',options:[],isOther:false}]});
    await jobs.finishUserInputCard({id:secondJob.id,requestKey:'string:second',status:'confirmed',cardMessageId:'card-2'});
    const begun=await jobs.beginUserInputAnswer({id:secondJob.id,requestKey:'string:second',itemId:'item',actor:'actor',chatId:'chat',cardMessageId:'card-2',answers:{q:{answers:['user_note: b']}},operationId:randomUUID()});
    await jobs.finishUserInput({id:secondJob.id,requestKey:'string:second',operationId:begun.userInput.operationId,status:'submitted'});
    await jobs.markFinishedWithoutReply({id:secondJob.id,leaseOwner:'worker',status:'completed',result:{deferred:true,userInput:{status:'submitting'}}});
    assert.equal((await jobs.getRun({id:secondJob.id})).result.userInput.status,'submitted');
  }finally{await pool.end();}
});

test('live card admission atomically binds thin-forward jobs but cannot replace native identity',{skip:!process.env.BRIDGE_TEST_PASSWORD,timeout:40_000},async()=>{
  const pool=createPoolFromEnvironment(refs);try{
    await migrate(pool);const jobs=createForwardJobStore({pool,connectionId:'user-input-thin',now:()=>2000});
    const created=await jobs.upsert({callerId:'live',idempotencyKey:randomUUID(),conversationId:'chat',messageId:`message-${randomUUID()}`,
      bindingOpenId:'actor',chatType:'p2p',senderOpenId:'actor',prompt:'ask',initialResult:{execution:{inputStatus:'ready',preparedPrompt:'ask'}}});
    await pool.execute("UPDATE assistant_codex_forward_jobs SET status='running',lease_owner='worker',lease_expires_at=999999 WHERE connection_id='user-input-thin' AND public_run_id=?",[created.id]);
    const request={id:created.id,messageId:created.messageId,threadId:'thread',turnId:'turn',itemId:'item',requestKey:'number:0',
      cardUuid:'uuid',questions:[{id:'q',header:'h',question:'q',options:[],isOther:false}]};
    assert.equal((await jobs.beginUserInput(request)).outcome,'stale');
    assert.equal((await jobs.beginUserInput({...request,bindExecution:true,messageId:'wrong'})).outcome,'stale');
    assert.equal((await jobs.getRun({id:created.id})).result.userInput,undefined);
    assert.equal((await jobs.beginUserInput({...request,bindExecution:true})).outcome,'new');
    const saved=await jobs.getRun({id:created.id});
    assert.equal(saved.result.execution.threadId,'thread');assert.equal(saved.result.execution.turnId,'turn');
    assert.equal(saved.result.execution.preparedPrompt,'ask');assert.equal(saved.result.execution.bindingOpenId,'actor');
    assert.equal((await jobs.beginUserInput({...request,bindExecution:true,threadId:'different'})).outcome,'stale');
    assert.equal((await jobs.beginUserInput({...request,bindExecution:true,turnId:'different'})).outcome,'stale');
    assert.equal((await jobs.beginUserInput({...request,bindExecution:true})).outcome,'replay');
    await jobs.finishUserInputCard({id:created.id,requestKey:'number:0',status:'confirmed',cardMessageId:'card'});
    const input={id:created.id,requestKey:'number:0',itemId:'item',actor:'actor',chatId:'chat',cardMessageId:'card',answers:{q:{answers:['user_note: yes']}},operationId:randomUUID()};
    assert.equal((await jobs.beginUserInputAnswer({...input,actor:'other'})).outcome,'stale');
    assert.equal((await jobs.beginUserInputAnswer(input)).outcome,'new');
    await jobs.finishUserInput({id:created.id,requestKey:'number:0',operationId:input.operationId,status:'submitted'});
    assert.equal((await jobs.getRun({id:created.id})).result.userInput.status,'submitted');
  }finally{await pool.end();}
});

test('Computer Use request reaches a card and authenticated response through real MySQL',{skip:!process.env.BRIDGE_TEST_PASSWORD,timeout:40_000},async()=>{
  const {createUserInputRuntime}=await import('../src/channels/feishu/user-input-runtime.mjs');
  const {normalizeComputerUseApproval}=await import('../src/agents/codex/computer-use-approval.mjs');
  const pool=createPoolFromEnvironment(refs);let runtime;try{
    await migrate(pool);const jobs=createForwardJobStore({pool,connectionId:'cua-card-live',now:()=>2000});
    const created=await jobs.upsert({callerId:'live',idempotencyKey:randomUUID(),conversationId:'chat',messageId:`message-${randomUUID()}`,
      bindingOpenId:'actor',chatType:'p2p',senderOpenId:'actor',prompt:'read app'});
    await pool.execute("UPDATE assistant_codex_forward_jobs SET status='running',lease_owner='worker',lease_expires_at=999999 WHERE connection_id='cua-card-live' AND public_run_id=?",[created.id]);
    const request=normalizeComputerUseApproval({requestId:0,generation:1,params:{threadId:'thread',turnId:'turn',serverName:'cua_repl',mode:'form',requestedSchema:{type:'object',properties:{}},
      _meta:{codex_approval_kind:'mcp_tool_call',connector_id:'computer-use',tool_name:'get_app_state',tool_params:{app:'com.example.fixture'},persist:['session'],riskLevel:'low'}}});
    const operations=[];const cards=[];const responses=[];
    runtime=createUserInputRuntime({jobs,executor:{async answerUserInput(input){responses.push(input);return{status:'submitted'};}},
      cardClient:{im:{v1:{message:{async create(input){cards.push(input);return{code:0,data:{message_id:'card'}};},async patch(){return{code:0};}}}}},
      runAsync:operation=>{const promise=Promise.resolve().then(operation);operations.push(promise);promise.catch(()=>{});}});
    await runtime.open({...request,messageId:created.messageId,requestKey:'number:0',binding:{codexSessionId:'thread',chatId:'chat'}});
    assert.equal(cards.length,1);assert.equal(cards[0].data.receive_id,'chat');assert.match(cards[0].data.content,/com.example.fixture/);
    const callback={operator:{open_id:'actor'},context:{open_chat_id:'chat',open_message_id:'card'},action:{value:{action:'submit_user_input',jobId:created.id,requestKey:'number:0',itemId:request.itemId},form_value:{q_0_choice:'o_0'}}};
    await runtime.handleCardAction({...callback,operator:{open_id:'other'}});assert.equal(responses.length,0);
    await runtime.handleCardAction(callback);await Promise.all(operations);
    assert.equal(responses.length,1);assert.equal(responses[0].answers.computer_use.answers[0],'拒绝');
    assert.equal((await jobs.getRun({id:created.id})).result.userInput.status,'submitted');
    await runtime.handleCardAction(callback);assert.equal(responses.length,1);
  }finally{await runtime?.close();await pool.end();}
});
