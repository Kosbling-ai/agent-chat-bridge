import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { validateConfig } from '../src/config.mjs';
import { createForwardRuntime, publicRun } from '../src/core/forward-runtime.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';
import { createApi } from '../src/core/api.mjs';
import { deriveExecutionScope } from '../src/agents/codex/thread-scope.mjs';

const base={schemaVersion:1,storage:Object.fromEntries(['host','port','user','password','database'].map(k=>[`${k}Env`,`TEST_${k.toUpperCase()}`])),codex:{bin:'./codex',cwd:'./workspace',envNames:[]},feishu:{connectionId:'test',appIdEnv:'TEST_APP',appSecretEnv:'TEST_SECRET',botOpenId:'bot'},routing:{version:'1',privateUserIds:[],groups:[{conversationId:'chat',trigger:'mention',passiveContext:true}]},auth:{clients:[{id:'caller',tokenEnv:'TEST_TOKEN',conversationIds:['chat'],admin:true}]},hooks:[]};
const flush=()=>new Promise(resolve=>setTimeout(resolve,20));

test('group capabilities default to both and allow either side or neither',()=>{
  assert.deepEqual(validateConfig(base).routing.groups[0].capabilities,['bridge','hook']);
  for(const capabilities of [['bridge'],['hook'],[]])assert.deepEqual(validateConfig({...base,routing:{...base.routing,groups:[{...base.routing.groups[0],capabilities}]}}).routing.groups[0].capabilities,capabilities);
  assert.throws(()=>validateConfig({...base,routing:{...base.routing,groups:[{...base.routing.groups[0],capabilities:['unknown']}]}}),{code:'invalid_group_capabilities'});
});

test('group mention can register forward and hook branches without either consuming the other',async()=>{
  const accepted=[];const forwarded=[];let receipts=0;const config=validateConfig({...base,hooks:[{id:'h',url:'https://example.invalid/h',tokenEnv:'TEST_HOOK',conversationIds:['chat']}]});
  const runtime=createCommunicationRuntime({config,store:{acceptInbound:async input=>{accepted.push(input);receipts++;return{duplicate:receipts>1,hookJobIds:['hook']};}},
    forward:{handleMessage:async input=>{forwarded.push(input);return{accepted:true};}},chat:{}});
  const event={connectionId:'test',source:'live',eventKey:'event',type:'message.received',conversationId:'chat',conversationType:'group',messageId:'message',occurredAt:Date.now(),actor:{type:'user',openId:'human',name:'Human'},message:{kind:'text',content:'{"text":"<at>bot</at> hello"}',parsedContent:{text:'<at>bot</at> hello'},mentions:[{openId:'bot',key:'<at>bot</at>'}]}};
  await runtime.ingest(event);await runtime.ingest(event);
  await new Promise(setImmediate);
  assert(accepted.every(item=>item.forwardJob===undefined&&item.hooks.length===1));
  assert.equal(forwarded.length,1);
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

function memoryJobs(initial){let job={id:'run',internalId:'1',callerId:'caller',chatId:'chat',chatType:'group',messageId:'message',senderOpenId:'system:scope',senderName:'Caller',deliveryMode:'caller',executionNamespace:'daily',prompt:'work',attempts:1,result:{},createdAt:1,leaseOwner:'owner',...initial};const calls=[];const finish=async({status,result})=>{calls.push(['finished',status]);job={...job,status,result,replySentAt:null};};return{calls,get job(){return job;},upsert:async()=>({...job,duplicate:false}),claimReplyPending:async()=>job.status==='reply_pending'?[job]:[],claim:async()=>job.status==='pending'?[job={...job,status:'running',leaseOwner:'owner'}]:[],renew:async()=>({renewed:true}),patchExecution:async({execution})=>{calls.push(['execution',execution]);job={...job,result:{...job.result,execution}};},patchFeedback:async()=>{},markReplyPending:async({result})=>{calls.push(['reply_pending']);job={...job,status:'reply_pending',result};},markFinished:finish,markFinishedWithoutReply:finish,markRetry:async input=>{calls.push(['retry',input]);job={...job,status:input.held?'held':input.terminal?'failed':'pending',last_error:input.errorCode};},getRun:async()=>job,readEvents:async()=>[]};}

test('forward runtime persists start/bound, caller result and known-turn inspect-only resume',async()=>{
  const jobs=memoryJobs({status:'pending'});const options=[];const executor={execute:async(_input,value)=>{options.push(value);await value.onStartIntent({binding:{feishuOpenId:'group:binding'},threadId:'thread',messageId:'message',startedAt:2});await value.onBound({threadId:'thread',turnId:'turn',startedAt:2});return{threadId:'thread',turnId:'turn',answer:'shown',rawAnswer:'full machine answer',attachments:[]};}};
  const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1,leaseMs:10000},jobs,sessions:{},executor,replies:{readResource:async()=>null},feedback:null,authorize:async()=>true});runtime.start();await flush();await runtime.stop();
  assert.deepEqual(jobs.calls.map(x=>x[0]),['execution','execution','reply_pending','finished']);
  assert.equal(jobs.job.result.rawAnswer,'full machine answer');assert.equal(jobs.job.status,'completed');assert.equal(options[0].resume,undefined);
  const recovered=memoryJobs({status:'pending',result:{execution:{threadId:'thread',turnId:'turn',startedAt:2}}});const resumes=[];const again=createForwardRuntime({config:{owner:'owner',pollMs:1},jobs:recovered,sessions:{},executor:{execute:async(_input,value)=>{resumes.push(value.resume);return{threadId:'thread',turnId:'turn',answer:'done',rawAnswer:'done',attachments:[]};}},replies:{readResource:async()=>null},authorize:async()=>true});again.start();await flush();await again.stop();assert.deepEqual(resumes,[{threadId:'thread',turnId:'turn',startedAt:2}]);
});

test('unknown native outcome becomes held and is not submitted again',async()=>{
  const jobs=memoryJobs({status:'pending'});let calls=0;const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1},jobs,sessions:{},executor:{execute:async()=>{calls++;throw Object.assign(new Error('lost'),{code:'CODEX_TURN_START_UNCONFIRMED',outcome:'unknown',threadId:'thread'});}},replies:{readResource:async()=>null},authorize:async()=>true});runtime.start();await flush();await runtime.stop();assert.equal(calls,1);assert.equal(jobs.job.status,'held');assert.equal(jobs.calls.filter(x=>x[0]==='retry').length,1);
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

test('persisted start intent without a turn is held without a new executor call', async () => {
  const jobs = memoryJobs({ status: 'pending', result: { execution: { threadId: 'thread', startedAt: 2, status: 'start_intent', unconfirmed: true } } });
  let executions = 0;
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1 }, jobs, sessions: {},
    executor: { async execute() { executions += 1; } },
    replies: { readResource: async () => null }, authorize: async () => true,
  });
  runtime.start(); await flush(); await runtime.stop();
  assert.equal(executions, 0);
  assert.equal(jobs.job.status, 'held');
  assert.equal(jobs.calls.at(-1)[1].errorCode, 'native_start_unconfirmed');
});

test('known recovery restores and observes feedback before inspect-only execution', async () => {
  const jobs = memoryJobs({ status: 'pending', deliveryMode: 'bridge', result: { execution: { bindingOpenId: 'group:binding', threadId: 'thread', turnId: 'turn', startedAt: 2 } } });
  const calls = [];
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1 }, jobs, sessions: {},
    executor: { async execute(_input, options) { calls.push(['execute', options.resume]); return { threadId: 'thread', turnId: 'turn', answer: 'done', rawAnswer: 'done', attachments: [] }; } },
    feedback: {
      async restore() { calls.push(['restore']); return { card: {} }; },
      observe(_job, _state, execution) { calls.push(['observe', execution.turnId]); },
      async prepare() {}, async finish() { return true; },
    },
    replies: { readResource: async () => null }, authorize: async () => true,
  });
  runtime.start(); await flush(); await runtime.stop();
  assert.deepEqual(calls.slice(0, 3), [['restore'], ['observe', 'turn'], ['execute', { threadId: 'thread', turnId: 'turn', startedAt: 2 }]]);
});

test('media preparation feeds a durable image addendum to executor input', async () => {
  const jobs = memoryJobs({ status: 'pending', prompt: 'User：', result: { inputEvent: { messageId: 'message', message: { kind: 'image' } } } });
  let prompt;
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1 }, jobs, sessions: {},
    media: { async prepare() { return { status: 'ready', text: '', addendum: '（图片路径：safe/image.png）' }; } },
    executor: { async execute(input) { prompt = input.prompt; return { threadId: 'thread', turnId: 'turn', answer: 'done', rawAnswer: 'done', attachments: [] }; } },
    replies: { readResource: async () => null }, authorize: async () => true,
  });
  runtime.start(); await flush(); await runtime.stop();
  assert.match(prompt, /safe\/image\.png/);
  assert.equal(jobs.calls.filter(([name]) => name === 'execution')[0][1].inputStatus, 'ready');
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

test('manual pre-admission busy fails once with an explicit reply and no retry', async () => {
  const jobs = memoryJobs({ status: 'pending', callerId: 'live', executionNamespace: null, deliveryMode: 'bridge', result: {} });
  let admissions = 0;
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1 }, jobs, sessions: {},
    executor: { async execute() { admissions += 1; throw Object.assign(new Error('busy'), { code: 'CODEX_THREAD_BUSY', retryable: true, outcome: 'rejected', phase: 'pre_admission', rpcMethod: 'thread/resume' }); } },
    feedback: { async start() { return {}; }, async prepare() {}, async finish() { return false; } },
    replies: { async prepare(_job, result) { return result; }, async deliver() { return { status: 'sent' }; }, readResource: async () => null }, authorize: async () => true,
  });
  runtime.start(); await flush(); await runtime.stop();
  assert.equal(admissions, 1);
  assert.equal(jobs.calls.some(([name]) => name === 'retry'), false);
  assert.equal(jobs.calls.filter(([name]) => name === 'reply_pending').length, 1);
  assert.equal(jobs.job.status, 'failed');
  assert.match(jobs.job.result.answer, /其他客户端占用/);
  assert.equal(jobs.job.result.execution.notStarted, true);
});

test('only a persisted caller-derived system binding gets the 60-second wait policy', async () => {
  let clock = 100_000;
  const bindingOpenId = deriveExecutionScope('caller', 'daily');
  const job = {
    id: 'run', callerId: 'caller', chatId: 'chat', chatType: 'group', messageId: 'message',
    senderOpenId: bindingOpenId, senderName: 'Caller', deliveryMode: 'caller', executionNamespace: 'daily',
    prompt: 'work', attempts: 0, status: 'pending', result: { execution: { bindingOpenId } },
    createdAt: 1, leaseOwner: '', nextAttemptAt: clock,
  };
  const calls = [];
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
    await options.onStartIntent({ binding: { feishuOpenId: bindingOpenId }, threadId: 'thread', messageId: 'message', startedAt: clock });
    await options.onBound({ threadId: 'thread', turnId: 'turn', startedAt: clock });
    return { threadId: 'thread', turnId: 'turn', answer: 'done', rawAnswer: 'done', attachments: [] };
  } };
  const runtime = createForwardRuntime({ config: { owner: 'owner', pollMs: 1, retryDelayMs: 60_000 }, jobs, sessions: {}, executor, feedback: { async prepare() {} }, replies: {}, now: () => clock });
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
    { executionNamespace: '', senderOpenId: 'system:pretend', result: { execution: { bindingOpenId: 'system:pretend' } } },
    { executionNamespace: 'daily', senderOpenId: bindingOpenId, result: { execution: { bindingOpenId: 'system:mismatch' } } },
  ]) {
    const spoofJobs = memoryJobs({ status: 'pending', deliveryMode: 'caller', ...spoof });
    const one = createForwardRuntime({ config: { owner: 'owner', pollMs: 1 }, jobs: spoofJobs, sessions: {}, executor: { async execute() { throw Object.assign(new Error('busy'), { code: 'CODEX_THREAD_BUSY', retryable: true, outcome: 'rejected', phase: 'pre_admission' }); } }, replies: {} });
    one.start(); await flush(); await one.stop();
    assert.equal(spoofJobs.calls.some(([name]) => name === 'retry'), false);
    assert.equal(spoofJobs.job.status, 'failed');
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
    executor: { async execute() { admissions += 1; throw Object.assign(new Error('closing'), { code: 'CODEX_EXECUTOR_CLOSING', retryable: true, phase: 'pre_admission' }); } },
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

test('claim failure marks the only worker unhealthy', async () => {
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1 },
    jobs: { async claimReplyPending() { throw new Error('database unavailable'); } },
    sessions: {}, executor: {}, replies: {},
  });
  runtime.start(); await flush();
  assert.equal(runtime.status().healthy, false);
  await runtime.stop();
});

test('one forward worker admits another human job while the first turn is active', async () => {
  const baseJob = { internalId: '1', callerId: 'live', chatId: 'chat', chatType: 'group', senderOpenId: 'human', senderName: 'Human', deliveryMode: 'caller', executionNamespace: null, prompt: 'work', attempts: 1, result: {}, createdAt: 1, leaseOwner: 'owner' };
  const queued = [{ ...baseJob, id: 'run-1', messageId: 'message-1' }, { ...baseJob, id: 'run-2', internalId: '2', messageId: 'message-2' }];
  let claimed = false;
  let releaseFirst;
  let secondEntered;
  const second = new Promise(resolve => { secondEntered = resolve; });
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
    if (input.messageId === 'message-2') { secondEntered(); return { threadId: 'thread', turnId: 'turn-2', answer: 'steered', rawAnswer: 'steered', attachments: [], deferred: true }; }
    return new Promise(resolve => { releaseFirst = () => resolve({ threadId: 'thread', turnId: 'turn-1', answer: 'done', rawAnswer: 'done', attachments: [] }); });
  } };
  const runtime = createForwardRuntime({ config: { owner: 'owner', pollMs: 1, maxActive: 5 }, jobs, sessions: {}, executor, replies: {}, authorize: async () => true });
  runtime.start();
  await second;
  assert.equal(typeof releaseFirst, 'function');
  releaseFirst();
  await flush();
  await runtime.stop();
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
      await options.onStartIntent({ binding: { feishuOpenId: 'group:binding' }, threadId: 'thread', messageId: 'message', startedAt: 2 });
      await options.onBound({ threadId: 'thread', turnId: 'turn', startedAt: 2 });
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
  assert.deepEqual(jobs.calls.map(([name]) => name), ['execution', 'execution']);
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
