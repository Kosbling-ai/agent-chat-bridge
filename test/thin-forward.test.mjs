import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { validateConfig } from '../src/config.mjs';
import { createForwardRuntime, publicRun } from '../src/core/forward-runtime.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';
import { createExecutionFeedback } from '../src/channels/feishu/execution-feedback.mjs';
import { renderExecutionCard } from '../src/channels/feishu/execution-card.mjs';
import { createApi } from '../src/core/api.mjs';
import { deriveExecutionScope } from '../src/agents/codex/thread-scope.mjs';

const base={schemaVersion:1,storage:Object.fromEntries(['host','port','user','password','database'].map(k=>[`${k}Env`,`TEST_${k.toUpperCase()}`])),codex:{bin:'./codex',cwd:'./workspace',envNames:[]},feishu:{connectionId:'test',appIdEnv:'TEST_APP',appSecretEnv:'TEST_SECRET',botOpenId:'bot'},routing:{version:'1',privateUserIds:[],groups:[{conversationId:'chat',trigger:'mention',passiveContext:true}]},auth:{clients:[{id:'caller',tokenEnv:'TEST_TOKEN',conversationIds:['chat'],admin:true}]},hooks:[]};
const flush=()=>new Promise(resolve=>setTimeout(resolve,20));

async function communicationDeliveryFailure(error) {
  let claimed = false;
  let settlement;
  const logs = [];
  const row = { id: 'effect', kind: 'create', payload: { kind: 'interactive', content: { schema: '2.0' } },
    platformUuid: 'uuid', conversationId: 'chat', leaseToken: 'lease' };
  const store = {
    async claimJobs() { return []; },
    async claimOutbox() { if (claimed) return []; claimed = true; return [row]; },
    async settleOutbox(value) { settlement = value; },
    async getOutbox() { return null; },
  };
  const runtime = createCommunicationRuntime({ config: validateConfig(base), store,
    chat: { async sendMessage() { throw error; } }, log: (...entry) => logs.push(entry) });
  runtime.start();
  for (let attempt = 0; attempt < 20 && !settlement; attempt += 1) await flush();
  await runtime.stop();
  assert.ok(settlement);
  return { settlement, logs };
}

test('group capabilities default to both and allow either side or neither',()=>{
  assert.deepEqual(validateConfig(base).routing.groups[0].capabilities,['bridge','hook']);
  for(const capabilities of [['bridge'],['hook'],[]])assert.deepEqual(validateConfig({...base,routing:{...base.routing,groups:[{...base.routing.groups[0],capabilities}]}}).routing.groups[0].capabilities,capabilities);
  assert.throws(()=>validateConfig({...base,routing:{...base.routing,groups:[{...base.routing.groups[0],capabilities:['unknown']}]}}),{code:'invalid_group_capabilities'});
});

test('delivery persists definite Feishu rejection separately from write uncertainty', async () => {
  for (const [error, status, code] of [
    [Object.assign(new Error('provider secret'), { code: 'feishu_api_rejected', outcome: 'failed' }), 'failed', 'feishu_api_rejected'],
    [Object.assign(new Error('local detail'), { code: 'invalid_message_content', outcome: 'failed' }), 'failed', 'invalid_content'],
    [Object.assign(new Error('other detail'), { code: 'other_failure', outcome: 'failed' }), 'failed', 'chat_delivery_failed'],
    [Object.assign(new Error('network secret'), { code: 'feishu_transport_error', outcome: 'unknown' }), 'unknown', 'chat_delivery_unconfirmed'],
  ]) {
    const { settlement, logs } = await communicationDeliveryFailure(error);
    assert.equal(settlement.status, status);
    assert.equal(settlement.errorCode, code);
    assert.equal(JSON.stringify(logs).includes('secret'), false);
  }
});

test('group mention can register forward and hook branches without either consuming the other',async()=>{
  const accepted=[];const forwarded=[];let receipts=0;const config=validateConfig({...base,hooks:[{id:'h',url:'https://example.invalid/h',tokenEnv:'TEST_HOOK',conversationIds:['chat']}]});
  const runtime=createCommunicationRuntime({config,store:{acceptInbound:async input=>{accepted.push(input);receipts++;return{duplicate:receipts>1,hookJobIds:['hook']};}},
    forward:{handleMessage:async input=>{forwarded.push(input);return{accepted:true};}},chat:{}});
  const event={connectionId:'test',source:'live',eventKey:'event',type:'message.received',conversationId:'chat',conversationType:'group',messageId:'message',occurredAt:Date.now(),actor:{type:'user',openId:'human',name:'Human'},message:{kind:'text',content:'{"text":"<at>bot</at> hello"}',parsedContent:{text:'<at>bot</at> hello'},mentions:[{openId:'bot',key:'<at>bot</at>'}]}};
  await runtime.ingest(event);await runtime.ingest(event);
  await new Promise(setImmediate);
  assert(accepted.every(item=>item.forwardJob===undefined&&item.hooks.length===1));
  assert.equal(forwarded.length,2,'forward upsert owns Agent terminal deduplication after an inbox replay');
  assert.equal(forwarded[0].prompt,'【提到你的消息 来自 Human（open_id=human）】\nhello');
});

test('hook-only, bridge-only and both capabilities keep independent routing',async()=>{
  for(const [capabilities,expectedHooks,expectedForwards] of [[['hook'],1,0],[['bridge'],0,1],[['bridge','hook'],1,1]]) {
    const accepted=[];const forwarded=[];
    const config=validateConfig({...base,routing:{...base.routing,groups:[{...base.routing.groups[0],capabilities}]},
      hooks:[{id:'h',url:'https://example.invalid/h',tokenEnv:'TEST_HOOK',conversationIds:['chat']}]});
    const runtime=createCommunicationRuntime({config,store:{acceptInbound:async input=>{accepted.push(input);return{duplicate:false};}},
      forward:{handleMessage:async input=>{forwarded.push(input);return{accepted:true};}},chat:{}});
    await runtime.ingest({connectionId:'test',source:'live',eventKey:`event-${capabilities.join('-')}`,type:'message.received',conversationId:'chat',conversationType:'group',messageId:`message-${capabilities.join('-')}`,occurredAt:Date.now(),actor:{type:'user',openId:'human',name:'Human'},message:{kind:'text',content:'{"text":"<at>bot</at> hello"}',mentions:[{openId:'bot',key:'<at>bot</at>'}]}});
    await new Promise(setImmediate);
    assert.equal(accepted[0].hooks.length,expectedHooks);
    assert.equal(forwarded.length,expectedForwards);
  }
});

test('stale group input is skipped while private history catchup keeps the original exception',async()=>{
  const forwarded=[];const config=validateConfig({...base,routing:{...base.routing,privateUserIds:['human'],groups:[{...base.routing.groups[0],trigger:'all',capabilities:['bridge']}]}});
  const runtime=createCommunicationRuntime({config,store:{acceptInbound:async()=>({duplicate:false})},
    forward:{handleMessage:async input=>{forwarded.push(input);return{accepted:true};}},chat:{},now:()=>1_000_000});
  const message={kind:'text',content:'{"text":"old"}',mentions:[]};
  await runtime.ingest({connectionId:'test',source:'live',eventKey:'stale-group',type:'message.received',conversationId:'chat',conversationType:'group',messageId:'stale-group',occurredAt:1,actor:{type:'user',openId:'human',name:'Human'},message});
  await runtime.ingest({connectionId:'test',source:'history_catchup',eventKey:'stale-private',type:'message.received',conversationId:'private',conversationType:'p2p',messageId:'stale-private',occurredAt:1,actor:{type:'user',openId:'human',name:'Human'},message});
  await new Promise(setImmediate);
  assert.equal(forwarded.length,1);
  assert.equal(forwarded[0].message.messageId,'stale-private');
});

test('private image-only post reaches media preparation and empty group mention can use prior context',async()=>{
  const forwarded=[];
  const config=validateConfig({...base,routing:{...base.routing,privateUserIds:['human']}});
  const runtime=createCommunicationRuntime({config,store:{acceptInbound:async()=>({duplicate:false})},
    inbound:{async loadRecentGroupContext(){return[{messageId:'prior',prompt:'prior context',senderOpenId:'other',senderName:'Other',createdAt:1}];}},
    forward:{handleMessage:async input=>{forwarded.push(input);return{execution:{terminal:'completed'}};}},chat:{}});
  await runtime.ingest({connectionId:'test',source:'live',eventKey:'private-post',type:'message.received',conversationId:'private',conversationType:'p2p',messageId:'private-post',occurredAt:Date.now(),actor:{type:'user',openId:'human',name:'Human'},message:{kind:'post',content:'{"content":[[{"tag":"img","image_key":"image"}]]}',mentions:[]}});
  await runtime.ingest({connectionId:'test',source:'live',eventKey:'group-empty',type:'message.received',conversationId:'chat',conversationType:'group',messageId:'group-empty',occurredAt:Date.now(),actor:{type:'user',openId:'human',name:'Human'},message:{kind:'text',content:'{"text":"<at>bot</at>"}',mentions:[{openId:'bot',key:'<at>bot</at>'}]}});
  await new Promise(setImmediate);
  assert.equal(forwarded.length,2);
  assert.equal(forwarded[0].message.type,'post');
  assert.match(forwarded[1].prompt,/prior context/);
});

test('failed forward keeps recent group context until a later accepted execution',async()=>{
  const prompts=[];let attempt=0;
  const config=validateConfig(base);
  const runtime=createCommunicationRuntime({config,store:{acceptInbound:async()=>({duplicate:false})},
    forward:{handleMessage:async input=>{prompts.push(input.prompt);attempt+=1;return attempt===1?{failed:true}:{execution:{terminal:'completed'}};}},chat:{}});
  const event=(id,text,mentioned=false)=>({connectionId:'test',source:'live',eventKey:id,type:'message.received',conversationId:'chat',conversationType:'group',messageId:id,occurredAt:Date.now(),actor:{type:'user',openId:'human',name:'Human'},message:{kind:'text',content:JSON.stringify({text:mentioned?`<at>bot</at> ${text}`:text}),mentions:mentioned?[{openId:'bot',key:'<at>bot</at>'}]:[]}});
  await runtime.ingest(event('context','keep me'));
  await runtime.ingest(event('first','first',true));await new Promise(setImmediate);
  await runtime.ingest(event('second','second',true));await new Promise(setImmediate);
  assert.match(prompts[0],/keep me/);
  assert.match(prompts[1],/keep me/);
});

function memoryJobs(initial){
  let job={id:'run',internalId:'1',callerId:'caller',chatId:'chat',chatType:'group',messageId:'message',senderOpenId:'system:scope',senderName:'Caller',deliveryMode:'caller',executionNamespace:'daily',prompt:'work',attempts:1,result:{},createdAt:1,leaseOwner:'',...initial};
  const calls=[];
  const unsafe=()=>{const execution=job.result?.execution||{};return execution.unconfirmed===true||['start_intent','bound','unknown'].includes(execution.status)||execution.intent||execution.threadId||execution.turnId;};
  const finish=async({status,result})=>{calls.push(['finished',status]);job={...job,status,result,replySentAt:null};};
  const due=()=>job.nextAttemptAt==null||job.nextAttemptAt<=Date.now();
  const claim=async({owner})=>{if(job.status!=='pending'||!due()||unsafe())return null;job={...job,status:'running',leaseOwner:owner,attempts:job.attempts+1};return job;};
  return{calls,get job(){return job;},upsert:async()=>({...job,duplicate:false}),getByMessageId:async()=>null,
    loadRecoverable:async()=>job.status==='pending'&&due()&&!unsafe()?[job]:[],claimById:claim,claimReplyById:async({owner})=>job.status==='reply_pending'?(job={...job,leaseOwner:owner}):null,
    claimReplyPending:async({owner})=>job.status==='reply_pending'?[(job={...job,leaseOwner:owner})]:[],claim:async input=>{const value=await claim(input);return value?[value]:[];},
    renew:async()=>({renewed:true}),patchPreparedInput:async({execution})=>{calls.push(['prepared',execution]);job={...job,result:{...job.result,execution}};return job;},
    patchExecution:async({execution})=>{calls.push(['execution',execution]);job={...job,result:{...job.result,execution}};},
    patchFeedback:async({key,value})=>{calls.push(['feedback',key]);job={...job,result:{...job.result,[key]:structuredClone(value)}};},
    markReplyPending:async({result})=>{const value=structuredClone(result);delete value.executionCard;delete value.typing;delete value.stop;
      calls.push(['reply_pending']);job={...job,status:'reply_pending',result:{...job.result,...value}};},markFinished:finish,markFinishedWithoutReply:finish,
    markRetry:async input=>{calls.push(['retry',input]);job={...job,status:input.held?'held':input.terminal?'failed':'pending',last_error:input.errorCode,nextAttemptAt:input.nextAttemptAt,leaseOwner:''};},
    getRun:async()=>job,readEvents:async()=>[]};
}

const bridgeInput={source:'live',callerId:'live',idempotencyKey:'message',conversationId:'chat',chatType:'p2p',actor:{openId:'human'},prompt:'work'};
const bridgeJob=()=>({status:'pending',callerId:'live',executionNamespace:null,deliveryMode:'bridge',sourceMessageId:'message',senderOpenId:'human',chatType:'p2p'});
const quietTyping={async start(){return null;},async cleanup(){}};

test('successful live and recovered steering do not create a synthetic execution card',async()=>{
  for(const recovered of [false,true]){
    const jobs=memoryJobs(bridgeJob());let creates=0;
    const sessions={async loadBinding(){return null;},async readPublicProgress(){return[];}};
    const feedback=createExecutionFeedback({jobs,sessions,typing:quietTyping,
      cardClient:{im:{v1:{message:{async create(){creates+=1;return{code:0,data:{message_id:'card'}};}}}}}});
    const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1},jobs,sessions,feedback,
      executor:{async execute(){return{threadId:'thread',turnId:'turn',answer:'steered',rawAnswer:'steered',attachments:[],deferred:true,accepted:true};}},
      replies:{},authorize:async()=>true});
    if(recovered)await runtime.recover();else await runtime.handleMessage(bridgeInput);
    await runtime.stop();
    assert.equal(jobs.job.status,'deferred',recovered?'recovered':'live');
    assert.equal(creates,0,recovered?'recovered':'live');
    assert.equal(jobs.calls.filter(([name])=>name==='feedback').length,0,recovered?'recovered':'live');
  }
});

test('real started progress creates a stoppable card and normal completion updates it',async()=>{
  const jobs=memoryJobs(bridgeJob());const cards=[];let releaseCreate;
  const created=new Promise(resolve=>{releaseCreate=resolve;});let deliveredProgress=false;
  const sessions={async loadBinding(){return{codexSessionId:'thread'};},async readPublicProgress(){
    if(deliveredProgress)return[];deliveredProgress=true;
    return[{id:1,created_at:2,detail_json:{kind:'started',turnId:'turn'}}];
  }};
  const feedback=createExecutionFeedback({jobs,sessions,typing:quietTyping,
    cardClient:{im:{v1:{message:{
      async create(input){cards.push(JSON.parse(input.data.content));releaseCreate();return{code:0,data:{message_id:'card'}};},
      async patch(input){cards.push(JSON.parse(input.data.content));return{code:0};},
    }}}}});
  const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1},jobs,sessions,feedback,
    executor:{async execute(){await created;return{threadId:'thread',turnId:'turn',answer:'done',rawAnswer:'done',attachments:[]};}},
    replies:{async prepare(_job,result){return result;},async deliver(){return{status:'sent'};}},authorize:async()=>true});
  await runtime.handleMessage(bridgeInput);await runtime.stop();
  assert.equal(cards.length,2);
  assert.match(JSON.stringify(cards[0]),/stop_execution/);
  assert.equal(cards.at(-1).header.template,'green');
  assert.match(JSON.stringify(cards.at(-1)),/done/);
});

test('normal completion without progress still creates one terminal card',async()=>{
  const jobs=memoryJobs(bridgeJob());const cards=[];
  const sessions={async loadBinding(){return null;},async readPublicProgress(){return[];}};
  const feedback=createExecutionFeedback({jobs,sessions,typing:quietTyping,
    cardClient:{im:{v1:{message:{async create(input){cards.push(JSON.parse(input.data.content));return{code:0,data:{message_id:'card'}};}}}}}});
  const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1},jobs,sessions,feedback,
    executor:{async execute(){return{threadId:'thread',turnId:'turn',answer:'done',rawAnswer:'done',attachments:[]};}},
    replies:{async prepare(_job,result){return result;},async deliver(){return{status:'sent'};}},authorize:async()=>true});
  await runtime.handleMessage(bridgeInput);await runtime.stop();
  assert.equal(cards.length,1);
  assert.equal(cards[0].header.template,'green');
  assert.match(JSON.stringify(cards[0]),/done/);
});

test('forward runtime uses only its response waiter signal and persists caller result',async()=>{
  const jobs=memoryJobs({status:'pending'});const options=[];const executor={execute:async(_input,value)=>{options.push(value);return{threadId:'thread',turnId:'turn',answer:'shown',rawAnswer:'full machine answer',attachments:[]};}};
  const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1,leaseMs:10000},jobs,sessions:{},executor,replies:{readResource:async()=>null},feedback:null,authorize:async()=>true});runtime.start();await flush();await runtime.stop();
  assert.deepEqual(jobs.calls.map(x=>x[0]),['reply_pending','finished']);
  assert.equal(jobs.job.result.rawAnswer,'full machine answer');assert.equal(jobs.job.status,'completed');
  assert.deepEqual(Object.keys(options[0]),['signal']);
});

test('a new unconfirmed native outcome follows the ordinary failed reply path',async()=>{
  const jobs=memoryJobs({status:'pending'});let calls=0;const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1},jobs,sessions:{},executor:{execute:async()=>{calls++;throw Object.assign(new Error('lost'),{code:'CODEX_TURN_START_UNCONFIRMED',outcome:'unknown',threadId:'thread'});}},replies:{readResource:async()=>null},authorize:async()=>true});runtime.start();await flush();await runtime.stop();assert.equal(calls,1);assert.equal(jobs.job.status,'failed');assert.equal(jobs.calls.filter(x=>x[0]==='retry').length,0);assert.equal(jobs.job.result.execution.terminal,'failed');
});

test('original transport network errors retain the bounded retry classification',async()=>{
  for (const error of [
    new TypeError('fetch failed'),
    Object.assign(new Error('write failed'),{code:'EPIPE'}),
    Object.assign(new Error('request failed'),{cause:new Error('network unavailable')}),
    new Error('stream disconnected before completion'),
    new Error('error sending request'),
  ]) {
    const jobs=memoryJobs({status:'pending',attempts:0});
    const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1},jobs,sessions:{},executor:{execute:async()=>{throw error;}},replies:{readResource:async()=>null},authorize:async()=>true});
    await runtime.handleMessage({source:'api',callerId:'caller',idempotencyKey:'network',conversationId:'chat',executionNamespace:'daily',deliveryMode:'caller',prompt:'work'});
    await runtime.stop();
    assert.equal(jobs.job.status,'pending',`${error.code||error.message} should retry`);
    assert.equal(jobs.calls.filter(([name])=>name==='retry').length,1);
    assert.equal(jobs.calls.filter(([name])=>name==='reply_pending').length,0);
  }
});

test('bridge delivery cleans Typing after replies and cleanup failure does not undo completion',async()=>{
  const effects=[];let claimed=false;
  const job={id:'run',leaseOwner:'owner',status:'reply_pending',callerId:'live',chatId:'chat',chatType:'p2p',messageId:'message',sourceMessageId:'message',deliveryMode:'bridge',result:{answer:'done'},createdAt:1};
  const jobs={async claimReplyPending(){if(claimed)return[];claimed=true;return[job];},async claim(){return[];},async renew(){},async markFinished(){effects.push('finished');job.status='completed';}};
  const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1},jobs,sessions:{},executor:{},
    feedback:{async finish(){effects.push('card');return false;},async cleanup(){effects.push('typing:cleanup');throw new Error('synthetic cleanup failure');}},
    replies:{async prepare(_job,result){return result;},async deliver(){effects.push('reply');return{status:'sent'};},async readResource(){return null;}},authorize:async()=>true});
  runtime.start();await flush();await runtime.stop();
  assert.equal(job.status,'completed');assert.deepEqual(effects,['card','reply','finished','typing:cleanup']);
});

test('run API freezes namespace/delivery mode and rejects ledger management after scope checks',async()=>{
  const token='synthetic-token-at-least-24-characters';const submitted=[];const current={id:'run',conversationId:'chat',status:'completed'};const forwardRuntime={submit:async input=>{submitted.push(input);return{id:'run',duplicate:false};},getRun:async()=>current,readRunEvents:async()=>({items:[{sequence:'9007199254740993',payload:{type:'progress'}}],nextCursor:'9007199254740993'}),getResource:async({index})=>index===0?{fileName:'answer.txt',kind:'file',size:6,base64:'YW5zd2Vy'}:null};const api=createApi({config:validateConfig(base),store:{getRecovery:async()=>({id:'recovery',connectionId:'test',conversationId:'chat',status:'applied'})},chat:{},tokens:{caller:token},forwardRuntime});
  const request=(method,url,value)=>Object.assign(Readable.from(value?[Buffer.from(JSON.stringify(value))]:[]),{method,url,headers:{authorization:`Bearer ${token}`}});
  assert.equal((await api(request('POST','/v1/runs',{conversationId:'chat',idempotencyKey:'daily:1',text:'prompt',executionNamespace:'daily',deliveryMode:'caller'}))).status,202);assert.equal(submitted[0].deliveryMode,'caller');
  assert.equal(submitted[0].message.messageId,undefined);
  await assert.rejects(api(request('POST','/v1/runs',{conversationId:'chat',idempotencyKey:'long',text:'prompt',executionNamespace:'a'.repeat(129)})),{status:400,code:'invalid_execution_namespace'});
  assert.equal((await api(request('POST','/v1/runs',{conversationId:'chat',idempotencyKey:'slash',text:'prompt',executionNamespace:'team/daily'}))).status,202);
  const events=await api(request('GET','/v1/runs/run/events?after=9007199254740992'));
  assert.equal(events.body.events[0].sequence,'9007199254740993');assert.equal(events.body.nextCursor,'9007199254740993');
  assert.equal((await api(request('GET','/v1/runs/run/resources/0'))).body.fileName,'answer.txt');
  assert.equal((await api(request('GET','/v1/recoveries/recovery'))).body.status,'applied');
  await assert.rejects(api(request('GET','/v1/runs/run/attempt')),{status:409,code:'unsupported_execution_model'});
  await assert.rejects(api(request('POST','/v1/recoveries',{runId:'run'})),{status:409,code:'unsupported_execution_model'});
  await assert.rejects(api(request('POST','/v1/sessions/reset',{conversationId:'chat'})),{status:409,code:'unsupported_execution_model'});
});

test('public run keeps result contract and separates execution from delivery status', () => {
  const pending = publicRun({ id:'run',chatId:'chat',status:'pending',deliveryMode:'bridge',executionNamespace:'daily',result:{},createdAt:1,updatedAt:1 });
  assert.equal(pending.executionStatus,'pending');
  assert.equal(pending.result.delivery.status,'waiting');
  const failed = publicRun({ id:'run',chatId:'chat',status:'reply_pending',deliveryMode:'bridge',executionNamespace:'daily',last_error:'CODEX_TURN_FAILED',result:{failed:true,turnStatus:'failed',answer:'failed'},createdAt:1,updatedAt:2 });
  assert.equal(failed.executionStatus,'failed');
  assert.equal(failed.result.answer,'failed');
  assert.equal(failed.errorCode,'CODEX_TURN_FAILED');
  const withResource = publicRun({
    id: 'resource-run', chatId: 'chat', status: 'completed', deliveryMode: 'caller',
    result: { attachments: [{ ref: { artifactId: 'internal-secret' }, fileName: 'answer.txt', size: 6, kind: 'file' }] },
    createdAt: 1, updatedAt: 2,
  });
  assert.deepEqual(withResource.attachments, [{ id: '0', fileName: 'answer.txt', size: 6, kind: 'file' }]);
});

test('unknown reply stays pending and a failed reply never records a successful inbound answer', async () => {
  async function runDelivery(status) {
    const calls = [];
    let claimed = false;
    const job = {
      id: `delivery-${status}`, leaseOwner: 'delivery-worker', status: 'reply_pending',
      callerId: 'live', chatId: 'chat', chatType: 'group', messageId: 'message',
      sourceMessageId: 'message', deliveryMode: 'bridge', result: { answer: 'answer' }, createdAt: 1,
    };
    const jobs = {
      async claimReplyPending() { if (claimed) return []; claimed = true; return [job]; },
      async claim() { return []; },
      async renew() {},
      async markRetry(value) { calls.push(['retry', value]); },
      async markFinished(value) { calls.push(['finished', value]); },
    };
    const runtime = createForwardRuntime({
      config: { owner: 'delivery-worker', pollMs: 1, leaseMs: 10_000 }, jobs, sessions: {}, executor: {},
      feedback: { async finish() { return false; } },
      replies: { async prepare(_job, result) { return result; }, async deliver() { return { status }; } },
      inbound: { async recordReply() { calls.push(['recorded']); } },
    });
    runtime.start(); await flush(); await runtime.stop();
    return calls;
  }

  const unknown = await runDelivery('unknown');
  assert.equal(unknown.some(([name]) => name === 'finished'), false);
  assert.equal(unknown.find(([name]) => name === 'retry')[1].replyPending, true);
  const failed = await runDelivery('failed');
  assert.equal(failed.some(([name]) => name === 'recorded'), false);
  const finished = failed.find(([name]) => name === 'finished')[1];
  assert.equal(finished.replySent, false);
  assert.equal(finished.errorCode, 'reply_delivery_failed');
});

test('persisted start intent stays isolated without a new executor call', async () => {
  const jobs = memoryJobs({ status: 'pending', result: { execution: { threadId: 'thread', startedAt: 2, status: 'start_intent', unconfirmed: true } } });
  let executions = 0;
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1 }, jobs, sessions: {},
    executor: { async execute() { executions += 1; } },
    replies: { readResource: async () => null }, authorize: async () => true,
  });
  runtime.start(); await flush(); await runtime.stop();
  assert.equal(executions, 0);
  assert.equal(jobs.job.status, 'pending');
  assert.deepEqual(jobs.calls, []);
});

test('persisted known native identity stays isolated without restore or resume', async () => {
  const jobs = memoryJobs({ status: 'pending', deliveryMode: 'bridge', result: { execution: { bindingOpenId: 'group:binding', threadId: 'thread', turnId: 'turn', startedAt: 2 } } });
  const calls = [];
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1 }, jobs, sessions: {},
    executor: { async execute() { calls.push(['execute']); } },
    feedback: {
      async restore() { calls.push(['restore']); return { card: {} }; },
      observe(_job, _state, execution) { calls.push(['observe', execution.turnId]); },
      async prepare() {}, async finish() { return true; },
    },
    replies: { readResource: async () => null }, authorize: async () => true,
  });
  runtime.start(); await flush(); await runtime.stop();
  assert.deepEqual(calls, []);
  assert.equal(jobs.job.status,'pending');
});

test('media preparation feeds a durable image addendum to executor input', async () => {
  const jobs = memoryJobs({ status: 'pending', prompt: 'User：', result: { inputEvent: { messageId: 'message', message: { kind: 'image' } } } });
  let prompt;const order=[];
  const patchPreparedInput=jobs.patchPreparedInput.bind(jobs);jobs.patchPreparedInput=async input=>{order.push('prepare');return patchPreparedInput(input);};
  const claimById=jobs.claimById.bind(jobs);jobs.claimById=async input=>{order.push('claim');return claimById(input);};
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1 }, jobs, sessions: {},
    media: { async prepare() { return { status: 'ready', text: '', addendum: '（图片路径：safe/image.png）' }; } },
    executor: { async execute(input) { prompt = input.prompt; return { threadId: 'thread', turnId: 'turn', answer: 'done', rawAnswer: 'done', attachments: [] }; } },
    replies: { readResource: async () => null }, authorize: async () => true,
  });
  runtime.start(); await flush(); await runtime.stop();
  assert.match(prompt, /safe\/image\.png/);
  assert.deepEqual(order.slice(0,2),['prepare','claim']);
  assert.equal(jobs.calls.filter(([name]) => name === 'prepared')[0][1].inputStatus, 'ready');
});

test('API registration returns before its internal execute waiter completes',async()=>{
  const jobs=memoryJobs({status:'pending'});let release;
  const runtime=createForwardRuntime({config:{owner:'owner',pollMs:30_000},jobs,sessions:{},
    executor:{execute:async()=>new Promise(resolve=>{release=()=>resolve({threadId:'thread',turnId:'turn',answer:'done',rawAnswer:'done',attachments:[]});})},
    replies:{},authorize:async()=>true});
  const registered=await runtime.submit({source:'api',callerId:'caller',idempotencyKey:'one',conversationId:'chat',executionNamespace:'daily',deliveryMode:'caller',prompt:'work'});
  assert.equal(registered.id,'run');
  await new Promise(setImmediate);assert.equal(typeof release,'function');
  release();await flush();await runtime.stop();
});

test('live replay lets the existing forward row decide terminal duplication',async()=>{
  const existing={id:'existing',status:'completed',messageId:'same',chatId:'chat',chatType:'p2p',deliveryMode:'bridge',result:{answer:'done',execution:{terminal:'completed'}}};
  let upserts=0;let claims=0;
  const runtime=createForwardRuntime({jobs:{async getByMessageId(){return existing;},async upsert(){upserts+=1;},async getRun(){return existing;},async claimById(){claims+=1;},async claimReplyById(){return null;},async readEvents(){return[];}},sessions:{},executor:{},replies:{},authorize:async()=>true});
  const result=await runtime.handleMessage({source:'live',callerId:'live',idempotencyKey:'same',message:{messageId:'same',conversationId:'chat',conversationType:'p2p',type:'text'},actor:{openId:'human'},prompt:'changed context'});
  assert.equal(result.answer,'done');assert.equal(upserts,0);assert.equal(claims,1);
});

test('prepared media prompt is reused without downloading again', async () => {
  const jobs = memoryJobs({ status: 'pending', result: { inputEvent: { messageId: 'message', message: { kind: 'image' } }, execution: { inputStatus: 'ready', preparedPrompt: 'User：\n\n（图片路径：safe/image.png）' } } });
  let preparations = 0;
  let prompt;
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1 }, jobs, sessions: {},
    media: { async prepare() { preparations += 1; throw new Error('must_not_prepare_again'); } },
    executor: { async execute(input) { prompt = input.prompt; return { threadId: 'thread', turnId: 'turn', answer: 'done', rawAnswer: 'done', attachments: [] }; } },
    replies: {}, authorize: async () => true,
  });
  runtime.start(); await flush(); await runtime.stop();
  assert.equal(preparations, 0);
  assert.match(prompt, /safe\/image\.png/);
});

test('ordinary live and API busy failures deliver on the first attempt without retrying', async () => {
  for (const [callerId, facts] of [
    ['live', { outcome: 'rejected', phase: 'pre_admission', rpcMethod: 'thread/resume' }],
    ['api', { outcome: 'rejected', phase: 'pre_admission', rpcMethod: 'thread/resume' }],
    ['live', { outcome: 'unknown', phase: 'turn_start', rpcMethod: 'turn/start' }],
    ['api', {}],
  ]) {
    const jobs = memoryJobs({ status: 'pending', attempts: 0, callerId, executionNamespace: null, deliveryMode: 'bridge',
      sourceMessageId: 'message', senderOpenId: 'human', chatType: 'p2p', result: {} });
    let admissions = 0;
    let deliveries = 0;
    const error = Object.assign(new Error('busy'), { code: 'CODEX_THREAD_BUSY', retryable: true, ...facts });
    const runtime = createForwardRuntime({
      config: { owner: 'owner', pollMs: 1 }, jobs, sessions: { async loadBinding() { return { codexSessionId: 'source-thread' }; } },
      executor: { async execute() { admissions += 1; throw error; } },
      feedback: { async start() { return {}; }, async prepare() {}, async finish() { return false; } },
      replies: { async prepare(_job, result) { return result; }, async deliver() { deliveries += 1; return { status: 'sent' }; } }, authorize: async () => true,
    });
    runtime.start(); await flush(); await runtime.stop();
    assert.equal(admissions, 1, callerId);
    assert.equal(jobs.job.attempts, 1);
    assert.equal(jobs.calls.filter(([name]) => name === 'retry').length, 0);
    assert.equal(jobs.calls.filter(([name]) => name === 'reply_pending').length, 1);
    assert.equal(deliveries, 1);
    assert.equal(jobs.job.status, 'failed');
    assert.equal(jobs.job.result.failed, true);
    assert.match(jobs.job.result.answer, /会话被其他客户端占用/);
    assert.deepEqual(jobs.job.result.busyFork, { sourceThreadId: 'source-thread', bindingOpenId: 'human', chatId: 'chat' });
    assert.equal(jobs.job.result.execution.terminal, 'failed');
    assert.equal(error.outcome, facts.outcome);
  }
});

test('only a failed busy card with a frozen source thread renders the explicit fork button', () => {
  const baseState = { status: 'failed', jobId: 'run', entries: [] };
  const busy = renderExecutionCard({ ...baseState, forkSourceThreadId: 'source-thread' }, 'busy');
  const value = busy.body.elements.flatMap(element => element.behaviors || []).find(item => item.value?.action === 'fork_busy_session')?.value;
  assert.deepEqual(value, { action: 'fork_busy_session', jobId: 'run', expectedSourceThreadId: 'source-thread' });
  assert.equal(JSON.stringify(renderExecutionCard(baseState, 'failed')).includes('fork_busy_session'), false);
  assert.equal(JSON.stringify(renderExecutionCard({ ...baseState, status: 'completed', forkSourceThreadId: 'source-thread' }, 'done')).includes('fork_busy_session'), false);
});

test('busy fork callback validates the original sender and runs one durable fork intent', async () => {
  const job = {
    id: '00000000-0000-0000-0000-000000000001', callerId: 'live', chatId: 'chat', chatType: 'p2p',
    messageId: 'message', senderOpenId: 'human', status: 'failed', last_error: 'CODEX_THREAD_BUSY',
    result: { busyFork: { sourceThreadId: 'source-thread', bindingOpenId: 'human', chatId: 'chat' },
      executionCard: { messageId: 'card-message', status: 'failed', entries: [], forkSourceThreadId: 'source-thread' } },
  };
  let intent;
  let forks = 0;
  let pending;
  const jobs = {
    async getRun() { return job; },
    async beginFork(input) { intent = input; return { outcome: 'new', fork: { operationId: input.operationId, status: 'pending' } }; },
    async finishFork(input) { return { outcome: input.status, fork: input }; },
    async patchFeedback() {},
  };
  const feedback = createExecutionFeedback({
    jobs, sessions: {}, typing: {}, authorize: async ({ operation }) => operation === 'fork',
    executor: { async forkBinding(input) { forks += 1; return { committed: await input.onForked({ targetThreadId: 'target-thread' }) }; } },
    runAsync(operation) { pending = Promise.resolve().then(operation); return pending; },
    cardClient: { im: { v1: { message: { async patch() { return { code: 0 }; } } } } },
  });
  const stale = await feedback.handleCardAction({ action: { value: { action: 'fork_busy_session', jobId: job.id, expectedSourceThreadId: 'source-thread' } },
    operator: { open_id: 'other' }, context: { open_chat_id: 'chat', open_message_id: 'card-message' } });
  assert.match(stale.toast.content, /失效/);
  assert.equal(forks, 0);
  const accepted = await feedback.handleCardAction({ action: { value: { action: 'fork_busy_session', jobId: job.id, expectedSourceThreadId: 'source-thread' } },
    operator: { open_id: 'human' }, context: { open_chat_id: 'chat', open_message_id: 'card-message' } });
  assert.match(accepted.toast.content, /正在创建/);
  await pending;
  assert.equal(forks, 1);
  assert.equal(intent.bindingOpenId, 'human');
  assert.equal(intent.cardMessageId, 'card-message');
});

test('busy fork reconciles durable outcomes and reports an undelivered terminal card', async () => {
  const original = {
    id: '00000000-0000-0000-0000-000000000001', callerId: 'live', chatId: 'chat', chatType: 'p2p',
    messageId: 'message', senderOpenId: 'human', status: 'failed', last_error: 'CODEX_THREAD_BUSY',
    result: { busyFork: { sourceThreadId: 'source', bindingOpenId: 'human', chatId: 'chat' },
      executionCard: { messageId: 'card', status: 'failed', delivery: 'fallback', entries: [], forkSourceThreadId: 'source' } },
  };
  const payload = { action: { value: { action: 'fork_busy_session', jobId: original.id, expectedSourceThreadId: 'source' } },
    operator: { open_id: 'human' }, context: { open_chat_id: 'chat', open_message_id: 'card' } };
  for (const mode of ['commit_ack_lost','reconcile_failed','card_rejected','superseded']) {
    let pending; let forks = 0; let durable = { operationId: '', status: 'pending' }; const cards = []; const logs = [];
    const jobs = {
      async getRun() { return structuredClone(original); },
      async beginFork(input) { durable.operationId = input.operationId; return { outcome: 'new', fork: { ...durable } }; },
      async finishFork(input) {
        if (mode === 'reconcile_failed') throw Object.assign(new Error('storage unavailable'), { code: 'store_unavailable' });
        if (durable.status !== 'pending') return { outcome: 'replay', fork: { ...durable } };
        durable = { ...durable, status: mode === 'superseded' ? 'superseded' : 'succeeded', targetThreadId: 'target' };
        if (mode === 'commit_ack_lost') throw Object.assign(new Error('commit unknown'), { code: 'commit_unknown' });
        return { outcome: durable.status, fork: { ...durable } };
      },
    };
    const feedback = createExecutionFeedback({ jobs, sessions: {}, authorize: async () => true,
      log: (...event) => logs.push(event), runAsync(operation) { pending = Promise.resolve().then(operation); },
      executor: { async forkBinding(input) {
        forks += 1;
        try { return { targetThreadId: 'target', committed: await input.onForked({ targetThreadId: 'target' }) }; }
        catch (error) { error.outcome = 'unknown'; error.forkTargetThreadId = 'target'; throw error; }
      } },
      cardClient: { im: { v1: { message: { async patch(input) {
        cards.push(JSON.parse(input.data.content)); return { code: mode === 'card_rejected' ? 999 : 0 };
      } } } } },
    });
    await feedback.handleCardAction(payload); await pending;
    assert.equal(forks, 1, mode);
    if (cards.length) assert.doesNotMatch(JSON.stringify(cards.at(-1)), /结果将通过普通消息送达/);
    if (mode === 'commit_ack_lost') assert.match(JSON.stringify(cards.at(-1)), /已保留历史并切换/);
    if (mode === 'reconcile_failed') {
      assert.match(JSON.stringify(cards.at(-1)), /状态未确认/);
      assert.doesNotMatch(JSON.stringify(cards.at(-1)), /原会话绑定保持不变/);
    }
    if (mode === 'card_rejected') {
      assert.equal(durable.status, 'succeeded');
      assert.equal(cards.length, 1);
      assert(logs.some(([level,operation,status]) => level === 'error' && operation === 'busy_session_fork_delivery' && status === 'failed'));
    }
    if (mode === 'superseded') assert.match(JSON.stringify(cards.at(-1)), /当前会话绑定已变化/);
  }
});

test('ordinary busy finishes the real feedback card and stops its observer and lease timer', async () => {
  const originalSetInterval=globalThis.setInterval;const originalClearInterval=globalThis.clearInterval;
  const timers=new Map();let sequence=0;let reads=0;const cards=[];
  globalThis.setInterval=(callback,ms)=>{const token={id:++sequence,unref(){}};timers.set(token,{callback,ms});return token;};
  globalThis.clearInterval=token=>timers.delete(token);
  try {
    const jobs=memoryJobs({status:'pending',callerId:'live',executionNamespace:null,deliveryMode:'bridge',sourceMessageId:'message',senderOpenId:'human',
      result:{execution:{bindingOpenId:'human'}}});
    const sessions={async loadBinding(){reads+=1;return{codexSessionId:'thread'};},async readPublicProgress(){return[];}};
    const feedback=createExecutionFeedback({jobs,sessions,typing:{async start(){return null;},async cleanup(){}},
      cardClient:{im:{v1:{message:{async create(input){cards.push(JSON.parse(input.data.content));return{code:0,data:{message_id:'card-message'}};}}}}}});
    const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1},jobs,sessions,feedback,
      executor:{async execute(){throw Object.assign(new Error('busy'),{code:'CODEX_THREAD_BUSY'});}},
      replies:{async prepare(_job,result){return result;},async deliver(){return{status:'sent'};}},authorize:async()=>true});
    await runtime.handleMessage({source:'live',callerId:'live',idempotencyKey:'message',conversationId:'chat',chatType:'p2p',actor:{openId:'human'},prompt:'work'});
    await new Promise(setImmediate);
    const readsAfterFailure=reads;
    assert.equal(timers.size,0);
    for(const {callback} of timers.values())await callback();
    assert.equal(reads,readsAfterFailure);
    assert.equal(jobs.calls.filter(([name])=>name==='retry').length,0);
    assert.equal(jobs.job.status,'failed');
    assert.equal(jobs.job.result.busyFork?.sourceThreadId,'thread');
    assert.equal(jobs.job.result.executionCard?.forkSourceThreadId,'thread');
    assert(cards.some(card=>card.header.template==='red'&&JSON.stringify(card).includes('会话被其他客户端占用')));
    assert.match(JSON.stringify(cards.at(-1)),/fork_busy_session/);
    await runtime.stop();
    assert.equal(timers.size,0);
  } finally {
    globalThis.setInterval=originalSetInterval;globalThis.clearInterval=originalClearInterval;
  }
});

test('only a persisted caller-derived system binding gets the 60-second wait policy', async () => {
  let clock = 100_000;
  const bindingOpenId = deriveExecutionScope('caller', 'daily');
  const job = {
    id: 'run', callerId: 'caller', chatId: 'chat', chatType: 'group', messageId: 'message',
    senderOpenId: bindingOpenId, senderName: 'Caller', deliveryMode: 'caller', executionNamespace: 'daily',
    prompt: 'work', attempts: 0, status: 'pending', result: { execution: { bindingOpenId }, policy: { queueIfBusy: true } },
    createdAt: 1, leaseOwner: '', nextAttemptAt: clock,
  };
  const calls = [];
  const jobs = {
    async claimReplyPending({ owner }) {
      if (job.status !== 'reply_pending') return [];
      Object.assign(job, { leaseOwner: owner });
      return [{ ...job, result: structuredClone(job.result) }];
    },
    async loadRecoverable() { return job.status==='pending'&&job.nextAttemptAt<=clock?[{...job,result:structuredClone(job.result)}]:[]; },
    async claimById({ owner }) {
      if (job.status !== 'pending' || job.nextAttemptAt > clock) return null;
      Object.assign(job, { status: 'running', leaseOwner: owner, attempts: job.attempts + 1 });
      return { ...job, result: structuredClone(job.result) };
    },
    async claim({owner}) { const value=await this.claimById({owner});return value?[value]:[]; },
    async claimReplyById(){return null;},async getRun(){return job;},
    async renew() {},
    async patchExecution({ execution }) {
      job.result = { ...job.result, execution };
      calls.push(['execution', structuredClone(execution)]);
    },
    async patchFeedback() {},
    async markRetry(input) {
      calls.push(['retry', input]);
      if (input.preserveAttempt) job.attempts = Math.max(0, job.attempts - 1);
      Object.assign(job, { status: input.held ? 'held' : 'pending', last_error: input.errorCode, nextAttemptAt: input.nextAttemptAt, leaseOwner: '' });
    },
    async markReplyPending({ result }) { Object.assign(job, { status: 'reply_pending', result }); },
    async markFinishedWithoutReply({ status, result }) { Object.assign(job, { status, result }); },
    async markFinished({ status, result }) { Object.assign(job, { status, result }); },
  };
  let admissions = 0;
  const executor = { async execute(_input, options) {
    admissions += 1;
    if (admissions < 3) throw Object.assign(new Error('busy'), { code: 'CODEX_THREAD_BUSY', retryable: true, outcome: 'rejected', phase: 'pre_admission', rpcMethod: 'thread/resume' });
    return { threadId: 'thread', turnId: 'turn', answer: 'done', rawAnswer: 'done', attachments: [] };
  } };
  const runtime = createForwardRuntime({ config: { owner: 'owner', pollMs: 1, retryDelayMs: 60_000 }, jobs, sessions: {}, executor, feedback: { async prepare() {} }, replies: {}, allowBusyQueue:async()=>true,now: () => clock });
  const settled = async () => {
    for (let count = 0; count < 100 && job.status === 'running'; count += 1) await new Promise(resolve => setImmediate(resolve));
  };
  runtime.start(); await flush(); await settled();
  assert.equal(admissions, 1); assert.equal(job.nextAttemptAt, 160_000); assert.equal(job.attempts, 0);
  clock = 160_000; await flush(); await settled();
  assert.equal(admissions, 2); assert.equal(job.nextAttemptAt, 220_000); assert.equal(job.attempts, 0);
  clock = 220_000; await flush(); await settled();
  for (let count = 0; count < 100 && job.status === 'reply_pending'; count += 1) await new Promise(resolve => setImmediate(resolve));
  await runtime.stop();
  assert.equal(admissions, 3); assert.equal(job.status, 'completed');
  assert(calls.filter(([name]) => name === 'retry').every(([, input]) => input.preserveAttempt === true));

  for(const spoof of [
    { executionNamespace: '', senderOpenId: 'system:pretend', result: { execution: { bindingOpenId: 'system:pretend' },policy:{queueIfBusy:true} } },
    { executionNamespace: 'daily', senderOpenId: bindingOpenId, result: { execution: { bindingOpenId: 'system:mismatch' },policy:{queueIfBusy:true} } },
    { executionNamespace: 'daily', senderOpenId: bindingOpenId, result: { execution: { bindingOpenId },policy:{queueIfBusy:true} }, busyFacts: { outcome: 'unknown', phase: 'turn_start' } },
  ]) {
    const spoofJobs = memoryJobs({ status: 'pending', deliveryMode: 'caller', ...spoof });
    const one = createForwardRuntime({ config: { owner: 'owner', pollMs: 1 }, jobs: spoofJobs, sessions: {}, executor: { async execute() { throw Object.assign(new Error('busy'), { code: 'CODEX_THREAD_BUSY', retryable: true, outcome: 'rejected', phase: 'pre_admission', ...spoof.busyFacts }); } }, replies: {},allowBusyQueue:async()=>true });
    one.start(); await flush(); await one.stop();
    assert.equal(spoofJobs.calls.filter(([name]) => name === 'retry').length, 0);
    assert.equal(spoofJobs.job.status, 'failed');
    assert.match(spoofJobs.job.result.answer, /会话被其他客户端占用/);
  }
});

test('other retryable admission failures stop after three 60-second-spaced claims', async () => {
  let clock = 10_000;
  const job = {
    id: 'bounded-run', callerId: 'live', chatId: 'chat', chatType: 'p2p', messageId: 'bounded-message',
    senderOpenId: 'human', deliveryMode: 'caller', executionNamespace: null, prompt: 'work',
    attempts: 0, status: 'pending', result: {}, createdAt: 1, leaseOwner: '', nextAttemptAt: clock,
  };
  const retries = [];
  let finalResults = 0;
  const jobs = {
    async claimReplyPending({ owner }) {
      if (job.status !== 'reply_pending') return [];
      Object.assign(job, { leaseOwner: owner });
      return [{ ...job, result: structuredClone(job.result) }];
    },
    async claim({ owner }) {
      if (job.status !== 'pending' || job.nextAttemptAt > clock) return [];
      Object.assign(job, { status: 'running', leaseOwner: owner, attempts: job.attempts + 1 });
      return [{ ...job, result: structuredClone(job.result) }];
    },
    async renew() {},
    async patchExecution({ execution }) { job.result = { ...job.result, execution }; },
    async markRetry(input) {
      retries.push(input);
      Object.assign(job, { status: 'pending', last_error: input.errorCode, nextAttemptAt: input.nextAttemptAt, leaseOwner: '' });
    },
    async markReplyPending({ result }) { finalResults += 1; Object.assign(job, { status: 'reply_pending', result }); },
    async markFinished({ status, result }) { Object.assign(job, { status, result }); },
  };
  let admissions = 0;
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1, retryDelayMs: 60_000, maxAttempts: 3 }, jobs, sessions: {},
    executor: { async execute() { admissions += 1; throw Object.assign(new Error('write failed'), { code: 'EPIPE' }); } },
    replies: {}, now: () => clock,
  });
  const settle = async () => {
    for (let count = 0; count < 100 && job.status === 'running'; count += 1) await new Promise(resolve => setImmediate(resolve));
  };
  runtime.start();
  await flush(); await settle();
  assert.equal(job.nextAttemptAt, 70_000);
  clock = 70_000; await flush(); await settle();
  assert.equal(job.nextAttemptAt, 130_000);
  clock = 130_000; await flush(); await settle();
  for (let count = 0; count < 100 && job.status === 'reply_pending'; count += 1) await new Promise(resolve => setImmediate(resolve));
  await runtime.stop();
  assert.equal(admissions, 3);
  assert.equal(job.attempts, 3);
  assert.equal(retries.length, 2);
  assert(retries.every(input => input.preserveAttempt !== true));
  assert.equal(finalResults, 1);
  assert.equal(job.status, 'failed');
});

test('a transient recovery claim failure is contained to one poll', async () => {
  let polls = 0;
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1 },
    jobs: {
      async claimReplyPending() { polls += 1; if (polls === 1) throw new Error('database unavailable'); return []; },
      async loadRecoverable() { return []; },
    },
    sessions: {}, executor: {}, replies: {},
  });
  runtime.start(); await flush();
  assert.ok(polls > 1);
  assert.equal(runtime.status().healthy, true);
  assert.equal(runtime.status().running, true);
  await runtime.stop();
});

test('recovery executes claimed jobs serially', async () => {
  const baseJob = { internalId: '1', callerId: 'live', chatId: 'chat', chatType: 'group', senderOpenId: 'human', senderName: 'Human', deliveryMode: 'caller', executionNamespace: null, prompt: 'work', attempts: 1, result: {}, createdAt: 1, leaseOwner: 'owner' };
  const queued = [{ ...baseJob, id: 'run-1', messageId: 'message-1' }, { ...baseJob, id: 'run-2', internalId: '2', messageId: 'message-2' }];
  let claimed = false;
  let releaseFirst;
  let secondEntered = false;
  const jobs = {
    async claimReplyPending() { return []; },
    async claim() { if (claimed) return []; claimed = true; return queued; },
    async renew() { return { renewed: true }; },
    async patchExecution() {},
    async markReplyPending() {},
    async markFinished() {},
    async markFinishedWithoutReply() {},
    async markRetry() {},
    async getRun() { return null; },
    async readEvents() { return []; },
  };
  const executor = { async execute(input) {
    if (input.messageId === 'message-2') { secondEntered = true; return { threadId: 'thread', turnId: 'turn-2', answer: 'steered', rawAnswer: 'steered', attachments: [], deferred: true }; }
    return new Promise(resolve => { releaseFirst = () => resolve({ threadId: 'thread', turnId: 'turn-1', answer: 'done', rawAnswer: 'done', attachments: [] }); });
  } };
  const runtime = createForwardRuntime({ config: { owner: 'owner', pollMs: 1, maxActive: 5 }, jobs, sessions: {}, executor, replies: {}, authorize: async () => true });
  runtime.start();
  await flush();
  assert.equal(typeof releaseFirst, 'function');
  assert.equal(secondEntered, false);
  releaseFirst();
  await flush();
  await runtime.stop();
  assert.equal(secondEntered, true);
});

test('lease loss after binding aborts observation without a terminal write', async () => {
  const jobs = memoryJobs({ status: 'pending', deliveryMode: 'bridge' });
  let renewals = 0;
  let abandoned = 0;
  jobs.renew = async () => {
    renewals += 1;
    if (renewals > 1) throw Object.assign(new Error('lost'), { code: 'forward_lease_lost' });
    return { renewed: true };
  };
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1, leaseMs: 100, heartbeatMs: 5 }, jobs, sessions: {},
    executor: { async execute(_input, options) {
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'CODEX_WAIT_ABORTED', outcome: 'unknown' })), { once: true }));
    } },
    feedback: {
      async start() { return { observer: { stop() {} }, card: { stop() {} } }; },
      observe() {},
      abandon(state) { abandoned += 1; state.observer = null; state.card = null; },
    },
    replies: { readResource: async () => null }, authorize: async () => true,
  });
  runtime.start(); await flush(); await runtime.stop();
  assert.ok(renewals > 1);
  assert.deepEqual(jobs.calls.map(([name]) => name), []);
  assert.equal(jobs.job.status, 'running');
  assert.equal(abandoned, 1);
});

test('every claim batch gets a distinct lease identity', async () => {
  const owners = [];
  let claims = 0;
  const jobs = {
    async claimReplyPending({ owner }) { owners.push(owner); return []; },
    async claim() { claims += 1; if (claims > 1) throw new Error('stop polling'); return []; },
  };
  const runtime = createForwardRuntime({
    config: { owner: 'process-worker', pollMs: 1 }, jobs, sessions: {}, executor: {}, replies: {},
  });
  runtime.start(); await flush(); await runtime.stop();
  assert(owners.length >= 2);
  assert.equal(new Set(owners).size, owners.length);
  assert(owners.every(owner => owner.startsWith('process-worker:')));
});
