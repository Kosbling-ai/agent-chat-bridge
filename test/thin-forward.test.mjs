import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { validateConfig } from '../src/config.mjs';
import { createForwardRuntime } from '../src/core/forward-runtime.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';
import { createApi } from '../src/core/api.mjs';

const base={schemaVersion:1,storage:Object.fromEntries(['host','port','user','password','database'].map(k=>[`${k}Env`,`TEST_${k.toUpperCase()}`])),codex:{bin:'./codex',cwd:'./workspace',envNames:[]},feishu:{connectionId:'test',appIdEnv:'TEST_APP',appSecretEnv:'TEST_SECRET',botOpenId:'bot'},routing:{version:'1',privateUserIds:[],groups:[{conversationId:'chat',trigger:'mention',passiveContext:true}]},auth:{clients:[{id:'caller',tokenEnv:'TEST_TOKEN',conversationIds:['chat'],admin:true}]},hooks:[]};
const flush=()=>new Promise(resolve=>setTimeout(resolve,20));

test('group capabilities default to both and allow either side or neither',()=>{
  assert.deepEqual(validateConfig(base).routing.groups[0].capabilities,['bridge','hook']);
  for(const capabilities of [['bridge'],['hook'],[]])assert.deepEqual(validateConfig({...base,routing:{...base.routing,groups:[{...base.routing.groups[0],capabilities}]}}).routing.groups[0].capabilities,capabilities);
  assert.throws(()=>validateConfig({...base,routing:{...base.routing,groups:[{...base.routing.groups[0],capabilities:['unknown']}]}}),{code:'invalid_group_capabilities'});
});

test('group mention can register forward and hook branches without either consuming the other',async()=>{
  const accepted=[];const config=validateConfig({...base,hooks:[{id:'h',url:'https://example.invalid/h',tokenEnv:'TEST_HOOK',conversationIds:['chat']}]});
  const runtime=createCommunicationRuntime({config,store:{acceptInbound:async input=>{accepted.push(input);return{forwardRunId:'run',hookJobIds:['hook']};}},chat:{}});
  const event={connectionId:'test',source:'live',eventKey:'event',type:'message.received',conversationId:'chat',conversationType:'group',messageId:'message',occurredAt:10,actor:{type:'user',openId:'human',name:'Human'},message:{kind:'text',parsedContent:{text:'<at>bot</at> hello'},mentions:[{openId:'bot',key:'<at>bot</at>'}]}};
  await runtime.ingest(event);await runtime.ingest(event);
  assert(accepted.every(item=>item.forwardJob&&item.hooks.length===1));
  assert.equal(accepted[0].forwardJob.prompt,'Human：hello');
});

function memoryJobs(initial){let job={id:'run',internalId:'1',callerId:'caller',chatId:'chat',chatType:'group',messageId:'message',senderOpenId:'system:scope',senderName:'Caller',deliveryMode:'caller',executionNamespace:'daily',prompt:'work',attempts:1,result:{},createdAt:1,leaseOwner:'owner',...initial};const calls=[];return{calls,get job(){return job;},upsert:async()=>({...job,duplicate:false}),claimReplyPending:async()=>job.status==='reply_pending'?[job]:[],claim:async()=>job.status==='pending'?[job={...job,status:'running',leaseOwner:'owner'}]:[],renew:async()=>({renewed:true}),patchExecution:async({execution})=>{calls.push(['execution',execution]);job={...job,result:{...job.result,execution}};},patchFeedback:async()=>{},markReplyPending:async({result})=>{calls.push(['reply_pending']);job={...job,status:'reply_pending',result};},markFinished:async({status,result})=>{calls.push(['finished',status]);job={...job,status,result,replySentAt:null};},markRetry:async input=>{calls.push(['retry',input]);job={...job,status:input.held?'held':input.terminal?'failed':'pending',last_error:input.errorCode};},getRun:async()=>job,readEvents:async()=>[]};}

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

test('run API freezes namespace/delivery mode and rejects ledger management after scope checks',async()=>{
  const token='synthetic-token-at-least-24-characters';const submitted=[];const current={id:'run',conversationId:'chat',status:'completed'};const forwardRuntime={submit:async input=>{submitted.push(input);return{id:'run',duplicate:false};},getRun:async()=>current,readRunEvents:async()=>[],getResource:async()=>null};const api=createApi({config:validateConfig(base),store:{},chat:{},tokens:{caller:token},forwardRuntime});
  const request=(method,url,value)=>Object.assign(Readable.from(value?[Buffer.from(JSON.stringify(value))]:[]),{method,url,headers:{authorization:`Bearer ${token}`}});
  assert.equal((await api(request('POST','/v1/runs',{conversationId:'chat',idempotencyKey:'daily:1',text:'prompt',executionNamespace:'daily',deliveryMode:'caller'}))).status,202);assert.equal(submitted[0].deliveryMode,'caller');
  await assert.rejects(api(request('GET','/v1/runs/run/attempt')),{status:409,code:'unsupported_execution_model'});
  await assert.rejects(api(request('POST','/v1/sessions/reset',{conversationId:'chat',generation:1})),{status:409,code:'unsupported_execution_model'});
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

test('system busy returns to pending without consuming a failure attempt', async () => {
  const jobs = memoryJobs({ status: 'pending', attempts: 99, executionNamespace: 'daily' });
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1, maxAttempts: 1 }, jobs, sessions: {},
    executor: { async execute() { throw Object.assign(new Error('busy'), { code: 'CODEX_THREAD_BUSY', retryable: true }); } },
    replies: { readResource: async () => null }, authorize: async () => true,
  });
  runtime.start(); await flush(); await runtime.stop();
  const retry = jobs.calls.find(([name]) => name === 'retry')[1];
  assert.equal(retry.preserveAttempt, true);
  assert.equal(jobs.job.status, 'pending');
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
  const jobs = memoryJobs({ status: 'pending' });
  let renewals = 0;
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
    replies: { readResource: async () => null }, authorize: async () => true,
  });
  runtime.start(); await flush(); await runtime.stop();
  assert.ok(renewals > 1);
  assert.deepEqual(jobs.calls.map(([name]) => name), ['execution', 'execution']);
  assert.equal(jobs.job.status, 'running');
});
