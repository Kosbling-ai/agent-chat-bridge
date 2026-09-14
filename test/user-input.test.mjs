import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CodexAppServerClient} from '../src/agents/codex/app-server-client.mjs';
import {answersFromForm,renderUserInputCard} from '../src/channels/feishu/user-input-card.mjs';
import {createUserInputRuntime} from '../src/channels/feishu/user-input-runtime.mjs';
import {normalizeUserInputAnswers} from '../src/agents/codex/user-input-request.mjs';

class Stream extends EventEmitter{setEncoding(){}}
class Child extends EventEmitter{
  constructor(handler){super();this.stdout=new Stream();this.stderr=new Stream();this.stderr.resume=()=>{};this.stdin=new Stream();this.stdin.writable=true;
    this.stdin.write=(line,callback)=>{handler(JSON.parse(line),this);callback?.();return true;};
    this.stdin.end=()=>{this.stdin.writable=false;setImmediate(()=>this.emit('exit',0,null));};this.kill=signal=>setImmediate(()=>this.emit('exit',null,signal));}
  send(value){this.stdout.emit('data',`${JSON.stringify(value)}\n`);}
}

test('app-server enables a discovered Default-mode feature and preserves typed inbound request ids',async()=>{
  const writes=[];let child;let inbound;
  const client=new CodexAppServerClient({config:{bin:'/codex',cwd:'/tmp',sharedHome:'/tmp/home',requestUserInput:true,rpcTimeoutMs:100},
    spawnSyncImpl:()=>({status:0,stdout:'default_mode_request_user_input under_development false\n'}),
    spawnImpl:(_bin,args)=>{child=new Child((message,instance)=>{writes.push(message);if(message.method==='initialize')instance.send({id:message.id,result:{}});});assert(args.includes('features.default_mode_request_user_input=true'));return child;},
    serverRequestSink:request=>{inbound=request;}});
  await client.ensureStarted(); child.send({id:0,method:'item/tool/requestUserInput',params:{}});
  while(!inbound)await new Promise(resolve=>setImmediate(resolve));
  await inbound.respondResult({answers:{}});
  assert(writes.some(value=>value.id===0&&value.result));
  await client.close();
});

test('closing app-server does not wait for a backpressured server-response write',async()=>{
  let child;let inbound;
  const client=new CodexAppServerClient({config:{bin:'/codex',cwd:'/tmp',sharedHome:'/tmp/home',rpcTimeoutMs:100,closeGraceMs:20},spawnSyncImpl:()=>({status:1}),
    spawnImpl:()=>{child=new Child((message,instance)=>{if(message.method==='initialize')instance.send({id:message.id,result:{}});});return child;},
    serverRequestSink:request=>{inbound=request;return request.respondError(-32002,'expired');}});
  await client.ensureStarted();const original=child.stdin.write;child.stdin.write=(line,callback)=>{const message=JSON.parse(line);if(message.id==='blocked'&&!message.method)return false;return original(line,callback);};
  child.send({id:'blocked',method:'item/tool/requestUserInput',params:{}});while(!inbound)await new Promise(resolve=>setImmediate(resolve));
  await Promise.race([client.close(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('close hung')),100))]);
  assert.equal(child.stdin.writable,false);
});

test('card maps protocol choices and free text to one answer per qid without prototype loss',()=>{
  const userInput={jobId:'run',requestKey:'string:"r"',itemId:'item',questions:[
    {id:'choice',header:'选择',question:'选一个',options:[{label:'A',description:''}],isOther:true},
    {id:'__proto__',header:'填写',question:'写内容',options:[],isOther:false},
  ]};
  const card=renderUserInputCard(userInput);assert.equal(card.body.elements[0].tag,'form');
  const answers=answersFromForm(userInput,{q_0_choice:'o_0',q_0_other:'',q_1_other:'hello'});
  const normalized=normalizeUserInputAnswers(userInput.questions,answers);
  assert.deepEqual(normalized.answers.choice.answers,['A']);
  assert.deepEqual(Object.getOwnPropertyDescriptor(normalized.answers,'__proto__').value.answers,['user_note: hello']);
  assert.throws(()=>answersFromForm(userInput,{q_0_choice:'o_0',q_0_other:'also',q_1_other:'hello'}));
});

function fixture(){
  const job={id:'run-1',callerId:'live',status:'running',chatId:'chat',senderOpenId:'actor',messageId:'source',result:{execution:{threadId:'thread',turnId:'turn'}}};
  const creates=[];const patches=[];const asyncOps=[];let nativeCalls=0;
  const cardClient={im:{v1:{message:{async create(input){creates.push(input);return{code:0,data:{message_id:'card'}};},async patch(input){patches.push(input);return{code:0};}}}}};
  const executor={async answerUserInput(){nativeCalls++;return{status:'submitted'};}};
  const jobs={
    async getByMessageId(){return job;},async getRun(){return job;},
    async beginUserInput(input){job.result.userInput={requestKey:input.requestKey,itemId:input.itemId,threadId:input.threadId,turnId:input.turnId,messageId:input.messageId,actor:'actor',chatId:'chat',questions:input.questions,status:'pending',card:{uuid:input.cardUuid,status:'intent'}};return{outcome:'new',userInput:job.result.userInput};},
    async finishUserInputCard(input){job.result.userInput.card={...job.result.userInput.card,status:input.status,messageId:input.cardMessageId};return{outcome:input.status,userInput:job.result.userInput};},
    async beginUserInputAnswer(input){if(job.result.userInput.status!=='pending')return{outcome:'replay',userInput:job.result.userInput};job.result.userInput={...job.result.userInput,status:'submitting',answers:input.answers,operationId:input.operationId};return{outcome:'new',userInput:job.result.userInput};},
    async finishUserInput(input){job.result.userInput={...job.result.userInput,status:input.status};return{outcome:input.status,userInput:job.result.userInput};},
    async expireUserInput(){job.result.userInput.status='expired';return{outcome:'expired',userInput:job.result.userInput};},
  };
  const runtime=createUserInputRuntime({jobs,executor,authorize:async()=>true,cardClient,
    runAsync:operation=>{const promise=Promise.resolve().then(operation);asyncOps.push(promise);promise.catch(()=>{});}});
  return{job,jobs,runtime,cardClient,executor,creates,patches,asyncOps,get nativeCalls(){return nativeCalls;}};
}

test('user-input runtime authenticates exact card identity and submits once asynchronously',async()=>{
  const f=fixture();const request={messageId:'source',threadId:'thread',turnId:'turn',itemId:'item',requestId:0,requestKey:'number:0',
    questions:[{id:'q',header:'选择',question:'选一个',options:[{label:'A',description:''}],isOther:false}]};
  await f.runtime.open(request);assert.equal(f.creates.length,1);
  const payload={operator:{open_id:'actor'},context:{open_chat_id:'chat',open_message_id:'card'},action:{value:{action:'submit_user_input',jobId:'run-1',requestKey:'number:0',itemId:'item'},form_value:{q_0_choice:'o_0',q_0_other:''}}};
  assert.equal((await f.runtime.handleCardAction({...payload,operator:{open_id:'other'}})).toast.content,'该提问已失效');
  assert.equal((await f.runtime.handleCardAction(payload)).toast.content,'回答已提交');
  await Promise.allSettled(f.asyncOps);assert.equal(f.nativeCalls,1);assert.equal(f.job.result.userInput.status,'submitted');assert.equal(f.patches.length,1);
  assert.equal((await f.runtime.handleCardAction(payload)).toast.content,'回答已提交');assert.equal(f.nativeCalls,1);
  await f.runtime.close();
});

test('a durable card from an earlier process cannot submit into a new executor',async()=>{
  const f=fixture();const request={messageId:'source',threadId:'thread',turnId:'turn',itemId:'item',requestId:'old',requestKey:'string:"old"',
    questions:[{id:'q',header:'填写',question:'内容',options:[],isOther:false}]};await f.runtime.open(request);
  const restarted=createUserInputRuntime({jobs:f.jobs,executor:f.executor,cardClient:f.cardClient,authorize:async()=>true});
  const response=await restarted.handleCardAction({operator:{open_id:'actor'},context:{open_chat_id:'chat',open_message_id:'card'},
    action:{value:{action:'submit_user_input',jobId:'run-1',requestKey:'string:"old"',itemId:'item'},form_value:{q_0_other:'answer'}}});
  assert.equal(response.toast.content,'该提问已失效');assert.equal(f.nativeCalls,0);assert.equal(f.job.result.userInput.status,'pending');
  await restarted.close();await f.runtime.close();
});
