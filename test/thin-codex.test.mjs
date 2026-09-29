import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexExecutor, projectCodexItem } from '../src/agents/codex/executor.mjs';
import { CodexAppServerClient, codexAppServerArgs } from '../src/agents/codex/app-server-client.mjs';
import { IdleLifecycle } from '../src/agents/codex/idle-lifecycle.mjs';
import { steerTurnWithMismatchRecovery, TurnRecoverySupersededError } from '../src/agents/codex/codex-turn-recovery.mjs';
import { deriveExecutionScope, codexBindingOpenId } from '../src/agents/codex/thread-scope.mjs';
import { createCodexSessionStore } from '../src/storage/codex-sessions.mjs';
import { outboxRelativeDirectory } from '../src/agents/codex/prompt.mjs';
import { createForwardRuntime } from '../src/core/forward-runtime.mjs';

class FakeStream extends EventEmitter {
  setEncoding() {}
}

test('requestUserInput is unavailable when the executor option is omitted',async t=>{
  const cwd=mkdtempSync(join(tmpdir(),'bridge-codex-input-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  mkdirSync(join(cwd,'home'));const runtime=fakeRuntime({completeStarts:false,serverRequestsOnStart:[{id:'disabled'}]});let opens=0;
  const executor=createCodexExecutor({config:config(cwd),sessionStore:memoryStore(),spawnImpl:runtime.spawnImpl,
    spawnSyncImpl:()=>({status:0,stdout:'default_mode_request_user_input under_development false\n'}),onUserInput:async()=>{opens++;}});
  const running=executor.execute({bindingOpenId:'human',chatId:'chat',chatType:'p2p',messageId:'message',prompt:'work'});running.catch(()=>{});
  while(!runtime.calls.some(message=>message.id==='disabled'&&message.error))await new Promise(resolve=>setImmediate(resolve));
  assert.equal(opens,0);assert.equal(runtime.calls.find(message=>message.id==='disabled').error.code,-32601);
  assert(runtime.args[0].includes('features.default_mode_request_user_input=false'));
  await executor.close();await assert.rejects(running);
});

test('requestUserInput resolved before turn admission never opens a card', async t => {
  const cwd=mkdtempSync(join(tmpdir(),'bridge-codex-input-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  mkdirSync(join(cwd,'home'));const runtime=fakeRuntime({completeStarts:false,serverRequestsOnStart:[{id:0}],resolveServerRequestBeforeResponse:true});let opens=0;
  const executor=createCodexExecutor({config:{...config(cwd),requestUserInput:true},sessionStore:memoryStore(),spawnImpl:runtime.spawnImpl,
    spawnSyncImpl:()=>({status:0,stdout:'default_mode_request_user_input under_development false\n'}),onUserInput:async()=>{opens++;}});
  const running=executor.execute({bindingOpenId:'human',chatId:'chat',chatType:'p2p',messageId:'message',prompt:'work'});running.catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(opens,0);
  await executor.close();await assert.rejects(running,{code:'CODEX_OBSERVATION_LOST'});
});

test('concurrent requestUserInput requests are ordered and the superseded request is answered only with an error', async t => {
  const cwd=mkdtempSync(join(tmpdir(),'bridge-codex-input-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  mkdirSync(join(cwd,'home'));const runtime=fakeRuntime({completeStarts:false,serverRequestsOnStart:[{id:'first'},{id:'second'}]});const opens=[];const closed=[];
  const executor=createCodexExecutor({config:{...config(cwd),requestUserInput:true},sessionStore:memoryStore(),spawnImpl:runtime.spawnImpl,
    spawnSyncImpl:()=>({status:0,stdout:'default_mode_request_user_input under_development false\n'}),onUserInput:async request=>opens.push(request.itemId),onUserInputClosed:async request=>closed.push(request.itemId)});
  const running=executor.execute({bindingOpenId:'human',chatId:'chat',chatType:'p2p',messageId:'message',prompt:'work'});running.catch(()=>{});
  while(opens.length<2)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(opens,['item-0','item-1']);assert.deepEqual(closed,['item-0']);
  assert(runtime.calls.some(message=>message.id==='first'&&message.error));
  await executor.close();await assert.rejects(running,{code:'CODEX_OBSERVATION_LOST'});
});

test('active requestUserInput writes exactly one nested qid answer for numeric request id zero', async t => {
  const cwd=mkdtempSync(join(tmpdir(),'bridge-codex-input-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));mkdirSync(join(cwd,'home'));
  const runtime=fakeRuntime({completeStarts:false,serverRequestsOnStart:[{id:0}]});let opened;
  const executor=createCodexExecutor({config:{...config(cwd),requestUserInput:true},sessionStore:memoryStore(),spawnImpl:runtime.spawnImpl,
    spawnSyncImpl:()=>({status:0,stdout:'default_mode_request_user_input under_development false\n'}),onUserInput:async request=>{opened=request;}});
  const running=executor.execute({bindingOpenId:'human',chatId:'chat',chatType:'p2p',messageId:'message',prompt:'work'});running.catch(()=>{});
  while(!opened)await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await executor.answerUserInput({threadId:opened.threadId,turnId:opened.turnId,requestId:0,itemId:opened.itemId,messageId:'message',answers:{q:{answers:['A']}}})).status,'submitted');
  assert(runtime.calls.some(message=>message.id===0&&message.result?.answers?.q?.answers?.[0]==='A'));
  assert.equal((await executor.answerUserInput({threadId:opened.threadId,turnId:opened.turnId,requestId:0,itemId:opened.itemId,messageId:'message',answers:{q:{answers:['A']}}})).status,'expired');
  await executor.close();await assert.rejects(running,{code:'CODEX_OBSERVATION_LOST'});
});

test('secret requestUserInput is rejected without exposing questions to the card sink', async t => {
  const cwd=mkdtempSync(join(tmpdir(),'bridge-codex-input-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));mkdirSync(join(cwd,'home'));
  const runtime=fakeRuntime({completeStarts:false,serverRequestsOnStart:[{id:'secret',params:{questions:[{id:'secret',header:'Secret',question:'Sensitive',isSecret:true}]}}]});let opens=0;
  const executor=createCodexExecutor({config:{...config(cwd),requestUserInput:true},sessionStore:memoryStore(),spawnImpl:runtime.spawnImpl,
    spawnSyncImpl:()=>({status:0,stdout:'default_mode_request_user_input under_development false\n'}),onUserInput:async()=>{opens++;}});
  const running=executor.execute({bindingOpenId:'human',chatId:'chat',chatType:'p2p',messageId:'message',prompt:'work'});running.catch(()=>{});
  while(!runtime.calls.some(message=>message.id==='secret'&&message.error))await new Promise(resolve=>setImmediate(resolve));assert.equal(opens,0);
  while(executor.status().activeTurns!==1)await new Promise(resolve=>setImmediate(resolve));
  await executor.close();await assert.rejects(running,{code:'CODEX_OBSERVATION_LOST'});
});

test('resolved request ids from an idle child cannot expire a reused id in its replacement',async t=>{
  const cwd=mkdtempSync(join(tmpdir(),'bridge-codex-input-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));mkdirSync(join(cwd,'home'));
  const runtime=fakeRuntime({completeStarts:false,serverRequestsOnStart:[{id:7}]});const opened=[];
  const executor=createCodexExecutor({config:{...config(cwd),requestUserInput:true,idleCloseMs:10},sessionStore:memoryStore(),spawnImpl:runtime.spawnImpl,
    spawnSyncImpl:()=>({status:0,stdout:'default_mode_request_user_input under_development false\n'}),onUserInput:async request=>opened.push(request)});
  const first=executor.execute({bindingOpenId:'human',chatId:'chat',chatType:'p2p',messageId:'first',prompt:'work'});while(opened.length<1)await new Promise(resolve=>setImmediate(resolve));
  await executor.answerUserInput({threadId:'thread-1',turnId:'turn-1',requestId:7,itemId:'item-0',messageId:'first',answers:{q:{answers:['A']}}});
  runtime.children[0].send({method:'serverRequest/resolved',params:{threadId:'thread-1',requestId:7}});
  runtime.children[0].send({method:'turn/completed',params:{threadId:'thread-1',turnId:'turn-1',turn:{id:'turn-1',status:'completed',items:[]}}});await first;
  while(runtime.children[0].stdin.writable)await new Promise(resolve=>setTimeout(resolve,2));
  const second=executor.execute({bindingOpenId:'human',chatId:'chat',chatType:'p2p',messageId:'second',prompt:'more'});second.catch(()=>{});
  while(opened.length<2)await new Promise(resolve=>setImmediate(resolve));assert.equal(opened[1].requestId,7);assert.equal(opened[1].turnId,'turn-2');
  await executor.close();await assert.rejects(second,{code:'CODEX_OBSERVATION_LOST'});
});

class FakeChild extends EventEmitter {
  constructor(handler) {
    super(); this.exitCode = null; this.signalCode = null;
    this.stdout = new FakeStream(); this.stderr = new FakeStream(); this.stderr.resume = () => {};
    this.stdin = new FakeStream(); this.stdin.writable = true; this.stdin.writableLength = 0;
    this.stdin.write = (line) => { handler(JSON.parse(line), this); return true; };
    this.stdin.end = () => { this.stdin.writable = false; setImmediate(() => { this.exitCode = 0; this.emit('exit', 0, null); }); };
    this.kill = (signal) => { this.signalCode = signal; setImmediate(() => this.emit('exit', null, signal)); };
  }
  send(value) { this.stdout.emit('data', `${JSON.stringify(value)}\n`); }
}

function memoryStore(initial = []) {
  const bindings = new Map(initial.map((binding) => [`${binding.feishuOpenId}:${binding.chatId}`, binding]));
  const events = [];
  return {
    bindings, events,
    async loadBinding(identity) { return bindings.get(`${identity.feishuOpenId}:${identity.chatId}`) || null; },
    async saveCodexBinding(binding) { bindings.set(`${binding.feishuOpenId}:${binding.chatId}`, { ...binding, created: false }); },
    async touchCodexBinding(binding) { bindings.set(`${binding.feishuOpenId}:${binding.chatId}`, { ...binding, created: false }); },
    async saveCodexRealtimeEvent(binding, event) { const row = { ...event, event_key: event.eventKey, event_type: event.eventType, detail_json: JSON.stringify(event.detail || {}), id: events.length + 1, binding }; const index = events.findIndex((x) => x.binding.codexSessionId === binding.codexSessionId && x.event_key === row.event_key); if (index >= 0) events[index] = row; else events.push(row); },
    async findAcceptedMessageEvent(binding, messageId, { includeInFlight = false } = {}) { return [...events].reverse().find((row) => row.binding.codexSessionId === binding.codexSessionId && row.messageId === messageId && (row.event_key.startsWith('assistant-final:') || row.event_key.startsWith('error:') || (includeInFlight && row.event_key.startsWith('user-steer-confirmed:')))) || null; },
    async loadSteerEvents(binding, messageId) { return events.filter((row) => row.binding.codexSessionId === binding.codexSessionId && row.event_key.endsWith(`:${messageId}`) && row.event_key.startsWith('user-steer-')); },
    async loadCodexEvent(binding, eventKey) { return events.find((row) => row.binding.codexSessionId === binding.codexSessionId && row.event_key === eventKey) || null; },
    async readPublicProgress() { return []; },
  };
}

function fakeRuntime({ resumeTurns = [], readTurns = [], readThread = {}, forkThread, completeStarts = true, raceCompletionBeforeResponse = false, rejectTurnStart = false, archiveTurnStartOnce = false, rejectMethods = new Map(), hangMethods = new Set(), strictThreadLoading = false, resumeDelayMs = 0, archiveResumeThreadIds = new Set(), serverRequestsOnStart = [], resolveServerRequestBeforeResponse = false, turnItemsFor = () => [] } = {}) {
  let threadNumber = 0; let turnNumber = 0;
  const children = []; const calls = []; const envs = []; const args = [];
  const spawnImpl = (_bin, childArgs, options) => {
    args.push(childArgs); envs.push(options.env);
    const loaded = new Set();
    const child = new FakeChild((message, instance) => {
      calls.push(message);
      if (hangMethods.has(message.method)) return;
      const respond = (result, delayMs = 0) => setTimeout(() => instance.send({ id: message.id, result }), delayMs);
      if (message.method === 'initialize') respond({});
      else if (rejectMethods.has(message.method)) {
        const error = rejectMethods.get(message.method);
        setImmediate(() => instance.send({ id: message.id, error: typeof error === 'function' ? error(message) : error }));
      }
      else if (['thread/start', 'thread/resume', 'turn/start'].includes(message.method)
        && Object.hasOwn(message.params, 'approvalsReviewer')
        && !['user', 'auto_review', 'guardian_subagent'].includes(message.params.approvalsReviewer)) {
        instance.send({ id: message.id, error: { code: -32602, message: 'SYNTHETIC_SECRET invalid approvalsReviewer' } });
      }
      else if (message.method === 'thread/start') {
        const id = `thread-${++threadNumber}`; loaded.add(id); respond({ thread: { id } });
      } else if (message.method === 'thread/resume') {
        if (archiveResumeThreadIds.has(message.params.threadId)) { setImmediate(() => instance.send({ id: message.id, error: { code: -32000, message: `session ${message.params.threadId} is archived` } })); return; }
        loaded.add(message.params.threadId); respond({ thread: { id: message.params.threadId, turns: resumeTurns } }, resumeDelayMs);
      }
      else if (message.method === 'thread/read') respond({ thread: { ...readThread, id: message.params.threadId, turns: readTurns } });
      else if (message.method === 'thread/fork') {
        const id = `fork-${++threadNumber}`; loaded.add(id);
        respond({ thread: forkThread === undefined ? { id, cwd: message.params.cwd, ephemeral: message.params.ephemeral, forkedFromId: message.params.threadId, turns: [] } : forkThread });
      }
      else if (message.method === 'turn/start') {
        if (strictThreadLoading && !loaded.has(message.params.threadId)) { setImmediate(() => instance.send({ id: message.id, error: { code: -32000, message: 'thread was not loaded by this child' } })); return; }
        if (archiveTurnStartOnce) { archiveTurnStartOnce = false; setImmediate(() => instance.send({ id: message.id, error: { code: -32000, message: `session ${message.params.threadId} is archived` } })); return; }
        if (rejectTurnStart) { setImmediate(() => instance.send({ id: message.id, error: { code: -32000, message: 'synthetic transport uncertainty' } })); return; }
        const id = `turn-${++turnNumber}`;
        for (const [index,request] of serverRequestsOnStart.entries()) instance.send({id:request.id,method:'item/tool/requestUserInput',params:{threadId:message.params.threadId,turnId:id,itemId:`item-${index}`,questions:[{id:'q',header:'Choice',question:'Pick',options:[{label:'A',description:'a'}]}],isBlocking:true,...request.params}});
        if(resolveServerRequestBeforeResponse&&serverRequestsOnStart[0])instance.send({method:'serverRequest/resolved',params:{threadId:message.params.threadId,requestId:serverRequestsOnStart[0].id}});
        const completed = { method: 'turn/completed', params: { threadId: message.params.threadId, turnId: id, turn: { id, status: 'completed', items: [...turnItemsFor(turnNumber), { id: `answer-${id}`, type: 'agentMessage', phase: 'final_answer', text: `answer ${id}` }] } } };
        if (completeStarts && raceCompletionBeforeResponse) instance.send(completed);
        respond({ turn: { id } });
        if (completeStarts && !raceCompletionBeforeResponse) setTimeout(() => instance.send(completed), 5);
      } else if (message.method === 'turn/steer' || message.method === 'turn/interrupt' || message.method === 'thread/inject_items') respond({});
    });
    children.push(child); return child;
  };
  return { spawnImpl, children, calls, envs, args };
}

function config(cwd) {
  return { bin: '/synthetic/codex', cwd, sharedHome: join(cwd, 'home'), rpcTimeoutMs: 1000, closeGraceMs: 20, idleCloseMs: 10, networkAccess: false, model: 'gpt-test', reasoningEffort: 'medium', sandbox: 'workspace-write', approvalPolicy: 'auto', approvalsReviewer: 'auto_review', allowedGroupChatIds: new Set() };
}

test('system scopes are caller/namespace isolated while chat remains in the binding key', () => {
  const a = deriveExecutionScope('caller-a', 'daily');
  assert.equal(a, deriveExecutionScope('caller-a', 'daily'));
  assert.notEqual(a, deriveExecutionScope('caller-a', 'weekly'));
  assert.notEqual(a, deriveExecutionScope('caller-b', 'daily'));
  assert.equal(deriveExecutionScope('caller-a', undefined), '');
  assert.throws(() => deriveExecutionScope('caller-a', 'bad namespace'));
  assert.equal(codexBindingOpenId({ feishuOpenId: a, chatId: 'chat-a', chatType: 'group' }), a);
});

test('app-server starts lazily with a controlled environment and explicit policy arguments', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const runtime = fakeRuntime();
    const client = new CodexAppServerClient({ config: { ...config(cwd), idleCloseMs: undefined }, childEnv: { PATH: '/safe/bin', HTTPS_PROXY: 'http://proxy.invalid' }, spawnImpl: runtime.spawnImpl });
    assert.equal(runtime.children.length, 0);
    assert.equal(client.lifecycle.idleMs, 60_000);
    await client.request('thread/start', {});
    assert.deepEqual(runtime.envs[0], { PATH: '/safe/bin', HTTPS_PROXY: 'http://proxy.invalid', CODEX_HOME: join(cwd, 'home') });
    assert.ok(runtime.args[0].includes('sandbox_workspace_write.network_access=false'));
    assert.ok(runtime.args[0].includes('shell_environment_policy.inherit=all'));
    await client.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('executor uses the schema reviewer enum for new and resumed threads and turns', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  const input = { bindingOpenId: 'ou-human', chatId: 'chat', chatType: 'p2p', messageId: 'm1', senderOpenId: 'ou-human', senderName: 'User', prompt: 'hello', busyPolicy: 'steer' };
  try {
    const defaultConfig = config(cwd);
    delete defaultConfig.approvalsReviewer;
    const createdRuntime = fakeRuntime();
    const created = createCodexExecutor({ config: defaultConfig, sessionStore: memoryStore(), childEnv: { PATH: '/safe/bin' }, spawnImpl: createdRuntime.spawnImpl });
    await created.execute(input);
    for (const method of ['thread/start', 'turn/start']) {
      assert.equal(createdRuntime.calls.find(call => call.method === method).params.approvalsReviewer, 'auto_review');
    }
    await created.close();

    const resumedRuntime = fakeRuntime();
    const resumedStore = memoryStore([{ feishuOpenId: 'ou-human', chatId: 'chat', chatType: 'p2p', codexSessionId: 'thread-existing', created: false }]);
    const resumed = createCodexExecutor({ config: defaultConfig, sessionStore: resumedStore, childEnv: { PATH: '/safe/bin' }, spawnImpl: resumedRuntime.spawnImpl });
    await resumed.execute({ ...input, messageId: 'm2' });
    for (const method of ['thread/resume', 'turn/start']) {
      assert.equal(resumedRuntime.calls.find(call => call.method === method).params.approvalsReviewer, 'auto_review');
    }
    await resumed.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('RPC rejection keeps internal provider detail while structured logs stay sanitized', async () => {
  const logs = [];
  const child = new FakeChild((message, instance) => {
    if (message.method === 'initialize') instance.send({ id: message.id, result: {} });
    else instance.send({ id: message.id, error: { code: -32602, message: 'SYNTHETIC_SECRET provider detail' } });
  });
  const client = new CodexAppServerClient({ config: config('/private/tmp'), spawnImpl: () => child, log: (...args) => logs.push(args) });
  await assert.rejects(client.request('thread/resume', { threadId: 'thread-existing' }), error => {
    assert.equal(error.code, 'CODEX_RPC_REJECTED');
    assert.equal(error.rpcMethod, 'thread/resume');
    assert.equal(error.outcome, 'rejected');
    assert.equal(error.message, 'SYNTHETIC_SECRET provider detail');
    return true;
  });
  assert.doesNotMatch(JSON.stringify(logs), /SYNTHETIC_SECRET/);
  assert.match(JSON.stringify(logs), /CODEX_RPC_REJECTED/);
  assert.match(JSON.stringify(logs), /thread\/resume/);
  await client.close();
});

test('client-safe RPC reasons retain mismatch recovery boundaries', async () => {
  const expected = '01a0130b-c44b-7923-bd40-aecef0e86ff8';
  const older = '01a00f75-2d21-7163-912d-bdfb80d328b4';
  const oldest = '019fffff-0000-7000-8000-000000000001';
  const newer = '01a01339-f7dc-76a2-becf-d9188b65870d';

  function clientFor(handler) {
    const child = new FakeChild((message, instance) => {
      if (message.method === 'initialize') instance.send({ id: message.id, result: {} });
      else handler(message, instance);
    });
    return new CodexAppServerClient({ config: config('/private/tmp'), spawnImpl: () => child });
  }

  let steerAttempts = 0;
  const recovering = clientFor((message, child) => {
    if (message.method === 'turn/interrupt') {
      child.send({ id: message.id, error: { code: -32000, message: `expected active turn id \`${older}\` but found \`${oldest}\`` } });
    } else if (++steerAttempts === 1) {
      child.send({ id: message.id, error: { code: -32000, message: `expected active turn id \`${expected}\` but found \`${older}\`` } });
    } else if (steerAttempts === 2) {
      child.send({ id: message.id, error: { code: -32000, message: 'no active turn to steer' } });
    } else child.send({ id: message.id, result: { turnId: expected } });
  });
  assert.equal((await steerTurnWithMismatchRecovery({
    request: recovering.request.bind(recovering), threadId: 'thread', expectedTurnId: expected,
    input: [{ type: 'text', text: 'synthetic' }], wait: async () => {},
  })).turnId, expected);
  await recovering.close();

  const superseded = clientFor((message, child) => {
    child.send({ id: message.id, error: { code: -32000, message: `expected active turn id \`${expected}\` but found \`${newer}\`` } });
  });
  await assert.rejects(steerTurnWithMismatchRecovery({
    request: superseded.request.bind(superseded), threadId: 'thread', expectedTurnId: expected,
    input: [{ type: 'text', text: 'synthetic' }], wait: async () => {},
  }), TurnRecoverySupersededError);
  await superseded.close();
});

test('idle lifecycle gates new work until owned close finishes', async () => {
  let finish; let entered = false;
  const lifecycle = new IdleLifecycle({ close: () => new Promise((resolve) => { finish = resolve; }), idleMs: 50 });
  const closing = lifecycle.closeIfIdle();
  await new Promise((resolve) => setImmediate(resolve));
  const incoming = lifecycle.run(() => { entered = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entered, false);
  finish(); await closing; await incoming; assert.equal(entered, true); lifecycle.stop();
});

test('zero idle timeout keeps the app-server open until explicit shutdown', async () => {
  let closes = 0;
  const lifecycle = new IdleLifecycle({
    close: async () => { closes += 1; },
    idleMs: 0,
    setTimer() { throw new Error('disabled idle close scheduled a timer'); },
  });
  await lifecycle.run(async () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 0);
  lifecycle.stop();
});

test('executor binds and completes from the production notification order', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const runtime = fakeRuntime(); const store = memoryStore(); const callbacks = [];
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: store, childEnv: { PATH: '/safe/bin' }, spawnImpl: runtime.spawnImpl });
    const result = await executor.execute({ bindingOpenId: 'ou-human', chatId: 'chat', chatType: 'p2p', messageId: 'm1', senderOpenId: 'ou-human', senderName: 'User', prompt: 'hello', busyPolicy: 'steer' }, {
      onStartIntent: (value) => callbacks.push(['intent', value]), onBound: (value) => callbacks.push(['bound', value]),
    });
    assert.equal(result.answer, 'answer turn-1');
    assert.deepEqual(callbacks.map(([name]) => name), ['intent', 'bound']);
    const threadStart = runtime.calls.find((call) => call.method === 'thread/start');
    const turnStart = runtime.calls.find((call) => call.method === 'turn/start');
    assert.equal(threadStart.params.approvalPolicy, 'on-request');
    assert.equal(threadStart.params.approvalsReviewer, 'auto_review');
    assert.equal(threadStart.params.sandbox, 'workspace-write');
    assert.equal(threadStart.params.model, 'gpt-test');
    assert.equal(threadStart.params.config.model_reasoning_effort, 'medium');
    assert.equal(turnStart.params.model, 'gpt-test');
    assert.equal(turnStart.params.effort, 'medium');
    assert.ok(store.events.some((event) => event.event_key === 'assistant-final:m1'));
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('explicit busy fork copies history without starting or interrupting a turn', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-fork-'));
  try {
    const binding = { feishuOpenId: 'human', chatId: 'chat', chatType: 'p2p', codexSessionId: 'source-thread', created: false };
    const runtime = fakeRuntime();
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore([binding]), spawnImpl: runtime.spawnImpl });
    let committed;
    const result = await executor.forkBinding({ binding, expectedSourceThreadId: 'source-thread',
      onForked: async value => { committed = value; return { outcome: 'succeeded' }; } });
    assert.equal(result.targetThreadId, 'fork-1');
    assert.deepEqual(committed, { sourceThreadId: 'source-thread', targetThreadId: 'fork-1' });
    const fork = runtime.calls.find(call => call.method === 'thread/fork');
    assert.deepEqual(fork.params, { cwd, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write',
      model: 'gpt-test', threadId: 'source-thread', ephemeral: false, deferGoalContinuation: true,
      config: { model_reasoning_effort: 'medium' } });
    assert.equal(runtime.calls.some(call => ['thread/resume','turn/start','turn/interrupt'].includes(call.method)), false);
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('fork keeps the binding admission lock through durable CAS and prevents a second native fork', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-fork-lock-'));
  try {
    const binding = { feishuOpenId: 'human', chatId: 'chat', chatType: 'p2p', codexSessionId: 'source-thread', created: false };
    const store = memoryStore([binding]);
    const runtime = fakeRuntime();
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: store, spawnImpl: runtime.spawnImpl });
    let release;
    const durable = new Promise(resolve => { release = resolve; });
    const first = executor.forkBinding({ binding, expectedSourceThreadId: 'source-thread', onForked: async ({ targetThreadId }) => {
      await durable;
      await store.saveCodexBinding({ ...binding, codexSessionId: targetThreadId });
      return { outcome: 'succeeded' };
    } });
    while (!runtime.calls.some(call => call.method === 'thread/fork')) await new Promise(resolve => setImmediate(resolve));
    const second = executor.forkBinding({ binding, expectedSourceThreadId: 'source-thread', onForked: async () => {
      throw new Error('second fork must not commit');
    } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtime.calls.filter(call => call.method === 'thread/fork').length, 1);
    release();
    await first;
    await assert.rejects(second, { code: 'CODEX_FORK_SOURCE_CHANGED', outcome: 'rejected' });
    assert.equal(runtime.calls.filter(call => call.method === 'thread/fork').length, 1);
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('unverified native fork responses never switch the durable binding', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-fork-invalid-'));
  try {
    const binding = { feishuOpenId: 'human', chatId: 'chat', chatType: 'p2p', codexSessionId: 'source-thread', created: false };
    for (const forkThread of [
      { cwd, ephemeral: false, forkedFromId: 'source-thread' },
      { id: 'source-thread', cwd, ephemeral: false, forkedFromId: 'source-thread' },
      { id: 'new-thread', cwd: join(cwd, 'other'), ephemeral: false, forkedFromId: 'source-thread' },
      { id: 'new-thread', cwd, ephemeral: true, forkedFromId: 'source-thread' },
      { id: 'new-thread', cwd, ephemeral: false, forkedFromId: 'other-thread' },
    ]) {
      const runtime = fakeRuntime({ forkThread });
      const executor = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore([binding]), spawnImpl: runtime.spawnImpl });
      let commits = 0;
      await assert.rejects(executor.forkBinding({ binding, expectedSourceThreadId: 'source-thread', onForked: async () => { commits += 1; } }),
        { code: 'CODEX_FORK_UNCONFIRMED', outcome: 'unknown' });
      assert.equal(commits, 0);
      await executor.close();
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('fork refuses a binding with an active local turn without interrupting it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-fork-active-'));
  try {
    const binding = { feishuOpenId: 'human', chatId: 'chat', chatType: 'p2p', codexSessionId: 'source-thread', created: false };
    const runtime = fakeRuntime({ completeStarts: false });
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore([binding]), spawnImpl: runtime.spawnImpl });
    const active = executor.execute({ bindingOpenId: 'human', chatId: 'chat', chatType: 'p2p', messageId: 'active-message', prompt: 'work', busyPolicy: 'reject' });
    while (!runtime.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(executor.forkBinding({ binding, expectedSourceThreadId: 'source-thread', onForked: async () => {} }),
      { code: 'CODEX_THREAD_BUSY', outcome: 'rejected' });
    assert.equal(runtime.calls.some(call => call.method === 'thread/fork'), false);
    assert.equal(runtime.calls.some(call => call.method === 'turn/interrupt'), false);
    active.catch(() => {});
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('steer and duplicate paths do not create a second start intent', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const runtime = fakeRuntime({ completeStarts: false }); const store = memoryStore(); let intents = 0;
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: store, childEnv: {}, spawnImpl: runtime.spawnImpl });
    const first = executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'root', prompt: 'root', busyPolicy: 'steer' }, { onStartIntent: () => { intents++; } });
    while (!runtime.calls.some((call) => call.method === 'turn/start')) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'system-job', prompt: 'work', busyPolicy: 'reject' }), { code: 'CODEX_THREAD_BUSY', retryable: true });
    const steered = await executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'follow', prompt: 'more', busyPolicy: 'steer' }, { onStartIntent: () => { intents++; } });
    assert.equal(steered.accepted, true); assert.equal(intents, 1);
    runtime.children[0].send({ method: 'turn/completed', params: { turnId: 'turn-1', turn: { id: 'turn-1', status: 'completed', items: [{ id: 'a', type: 'agentMessage', phase: 'final_answer', text: 'done' }] } } });
    await first;
    const duplicate = await executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'root', prompt: 'root', busyPolicy: 'steer' }, { onStartIntent: () => { intents++; } });
    assert.equal(duplicate.duplicate, true); assert.equal(intents, 1);
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('a takeover waiter does not occupy the steering queue while it waits for final', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const runtime = fakeRuntime({ completeStarts: false }); const executor = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore(), spawnImpl: runtime.spawnImpl });
    const rootController = new AbortController();
    const root = executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'root', prompt: 'root' }, { signal: rootController.signal });
    while (executor.status().activeTurns !== 1) await new Promise((resolve) => setImmediate(resolve));
    rootController.abort(); await assert.rejects(root, { code: 'CODEX_WAIT_ABORTED' });
    const first = executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'follow-1', prompt: 'one' });
    while (runtime.calls.filter((call) => call.method === 'turn/steer').length < 1) await new Promise((resolve) => setImmediate(resolve));
    const second = executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'follow-2', prompt: 'two' });
    const secondResult = await Promise.race([second, new Promise((_, reject) => setTimeout(() => reject(new Error('second steer stayed behind takeover waiter')), 100))]);
    assert.equal(secondResult.deferred, true);
    assert.equal(runtime.calls.filter((call) => call.method === 'turn/steer').length, 2);
    runtime.children[0].send({ method: 'turn/completed', params: { turnId: 'turn-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
    assert.equal((await first).takeover, true);
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('the steering takeover waiter receives and releases its caller abort signal', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const runtime = fakeRuntime({ completeStarts: false }); const executor = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore(), spawnImpl: runtime.spawnImpl });
    const rootController = new AbortController();
    const root = executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'root', prompt: 'root' }, { signal: rootController.signal });
    while (executor.status().activeTurns !== 1) await new Promise((resolve) => setImmediate(resolve));
    rootController.abort(); await assert.rejects(root, { code: 'CODEX_WAIT_ABORTED' });
    const takeoverController = new AbortController();
    const takeover = executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'follow', prompt: 'more' }, { signal: takeoverController.signal });
    while (!runtime.calls.some((call) => call.method === 'turn/steer')) await new Promise((resolve) => setImmediate(resolve));
    takeoverController.abort();
    await assert.rejects(takeover, { code: 'CODEX_WAIT_ABORTED' });
    assert.equal(executor.status().activeTurnResponseWaiters, 0);
    runtime.children[0].send({ method: 'turn/completed', params: { turnId: 'turn-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
    while (executor.status().activeTurns) await new Promise((resolve) => setImmediate(resolve));
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('started progress persistence is best effort after native admission', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const store = memoryStore(); const save = store.saveCodexRealtimeEvent;
    store.saveCodexRealtimeEvent = async (binding, event) => {
      if (event.eventKey === 'public:turn-1:started') throw new Error('synthetic started persistence failure');
      return save(binding, event);
    };
    const logs = []; const executor = createCodexExecutor({ config: config(cwd), sessionStore: store, spawnImpl: fakeRuntime().spawnImpl, log: (level, detail) => logs.push([level, detail]) });
    assert.equal((await executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'root', prompt: 'work' })).answer, 'answer turn-1');
    assert.ok(logs.some(([level, detail]) => level === 'warning' && detail.operation === 'publish_started' && detail.turnId === 'turn-1'));
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('confirmed steering receipt persistence failure remains delivery-unconfirmed', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const store = memoryStore(); const save = store.saveCodexRealtimeEvent;
    store.saveCodexRealtimeEvent = async (binding, event) => {
      if (event.eventKey === 'user-steer-confirmed:follow') throw new Error('synthetic receipt store failure');
      return save(binding, event);
    };
    const runtime = fakeRuntime({ completeStarts: false }); const executor = createCodexExecutor({ config: config(cwd), sessionStore: store, spawnImpl: runtime.spawnImpl });
    const root = executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'root', prompt: 'root' });
    while (executor.status().activeTurns !== 1) await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'follow', prompt: 'more' }), { code: 'CODEX_STEER_UNCONFIRMED', outcome: 'unknown' });
    runtime.children[0].send({ method: 'turn/completed', params: { turnId: 'turn-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
    await root;
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('normal resume interrupts orphan activity before starting while the transition adapter observes a known turn', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const binding = { feishuOpenId: 'system:x', chatId: 'chat', chatType: 'group', codexSessionId: 'thread-existing', threadName: 'system', created: false };
    const heldRuntime = fakeRuntime({ resumeTurns: [{ id: 'other-turn', status: 'inProgress' }] });
    const held = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore([binding]), childEnv: {}, spawnImpl: heldRuntime.spawnImpl });
    const restored = await held.execute({ bindingOpenId: 'system:x', chatId: 'chat', chatType: 'group', messageId: 'job', prompt: 'work', busyPolicy: 'reject' });
    assert.equal(restored.answer, 'answer turn-1');
    assert.equal(heldRuntime.calls.filter((call) => call.method === 'turn/interrupt').length, 1);
    assert.equal(heldRuntime.calls.filter((call) => call.method === 'turn/start').length, 1); await held.close();

    const knownRuntime = fakeRuntime({ resumeTurns: [{ id: 'known-turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'known' }] }] });
    const known = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore([binding]), childEnv: {}, spawnImpl: knownRuntime.spawnImpl });
    let intents = 0;
    const result = await known.execute({ bindingOpenId: 'system:x', chatId: 'chat', chatType: 'group', messageId: 'job', prompt: 'work', busyPolicy: 'reject' }, { resume: { threadId: 'thread-existing', turnId: 'known-turn', startedAt: 1 }, onStartIntent: () => { intents++; } });
    assert.equal(result.answer, 'known'); assert.equal(intents, 0);
    assert.equal(knownRuntime.calls.filter((call) => call.method === 'turn/start').length, 0); await known.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('executor classifies admission busy separately from uncertain bound and steer observations', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  const activeWriter = { code: -32000, message: 'thread has an active writer' };
  const binding = { feishuOpenId: 'ou', chatId: 'chat', chatType: 'p2p', codexSessionId: 'thread-existing', threadName: 'human', created: false };
  const input = { bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'message', prompt: 'work', busyPolicy: 'steer' };
  try {
    const admissionRuntime = fakeRuntime({ rejectMethods: new Map([['thread/resume', activeWriter]]) });
    const admission = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore([binding]), spawnImpl: admissionRuntime.spawnImpl });
    await assert.rejects(admission.execute(input), error => {
      assert.equal(error.code, 'CODEX_THREAD_BUSY');
      assert.equal(error.outcome, 'rejected');
      assert.equal(error.phase, 'pre_admission');
      assert.equal(error.rpcMethod, 'thread/resume');
      return true;
    });
    assert.equal(admissionRuntime.calls.filter(call => call.method === 'turn/start').length, 0);
    await admission.close();

    const resumeRuntime = fakeRuntime({ rejectMethods: new Map([['thread/resume', activeWriter]]) });
    const resume = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore([binding]), spawnImpl: resumeRuntime.spawnImpl });
    await assert.rejects(resume.execute(input, { resume: { threadId: 'thread-existing', turnId: 'turn-known', startedAt: 10 } }), error => {
      assert.equal(error.code, 'CODEX_THREAD_BUSY');
      assert.equal(error.outcome, 'unknown');
      assert.equal(error.phase, 'known_resume');
      assert.equal(error.threadId, 'thread-existing');
      assert.equal(error.turnId, 'turn-known');
      assert.equal(error.startedAt, 10);
      assert.deepEqual(error.intent, { kind: 'observe', messageId: 'message' });
      return true;
    });
    assert.equal(resumeRuntime.calls.filter(call => call.method === 'turn/start').length, 0);
    await resume.close();

    const steerStore = memoryStore([binding]);
    await steerStore.saveCodexRealtimeEvent(binding, {
      messageId: 'message', eventKey: 'user-steer-attempt:message', eventType: 'user_message',
      detail: { attemptId: 'attempt-1', turnId: 'root-turn', rootMessageId: 'root-message', baselineIds: [] },
    });
    const steerRuntime = fakeRuntime({ rejectMethods: new Map([['thread/read', activeWriter]]) });
    const steer = createCodexExecutor({ config: config(cwd), sessionStore: steerStore, spawnImpl: steerRuntime.spawnImpl });
    await assert.rejects(steer.execute(input), error => {
      assert.equal(error.code, 'CODEX_THREAD_BUSY');
      assert.equal(error.outcome, 'unknown');
      assert.equal(error.phase, 'steer_confirmation');
      assert.equal(error.threadId, 'thread-existing');
      assert.equal(error.turnId, 'root-turn');
      assert.deepEqual(error.intent, { kind: 'steer', attemptId: 'attempt-1', messageId: 'message' });
      return true;
    });
    assert.equal(steerRuntime.calls.filter(call => ['turn/start', 'turn/steer'].includes(call.method)).length, 0);
    await steer.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('human and two system identities in one chat receive independent bindings', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const runtime = fakeRuntime(); const store = memoryStore();
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: store, childEnv: {}, spawnImpl: runtime.spawnImpl });
    const identities = ['group:human', deriveExecutionScope('caller-a', 'daily'), deriveExecutionScope('caller-a', 'weekly')];
    const results = await Promise.all(identities.map((bindingOpenId, index) => executor.execute({ bindingOpenId, chatId: 'same-chat', chatType: 'group', messageId: `m${index}`, prompt: 'work', busyPolicy: bindingOpenId.startsWith('system:') ? 'reject' : 'steer' })));
    assert.equal(new Set(results.map((result) => result.threadId)).size, 3);
    assert.equal(store.bindings.size, 3);
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('an existing binding with an empty stored thread name restores its derived name on touch', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const binding = { feishuOpenId: 'ou-human', chatId: 'chat', chatType: 'p2p', codexSessionId: 'thread-existing', threadName: '', created: false };
    const store = memoryStore([binding]);
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: store, spawnImpl: fakeRuntime().spawnImpl });
    await executor.execute({ bindingOpenId: 'ou-human', chatId: 'chat', chatType: 'p2p', messageId: 'message', prompt: 'work' });
    assert.equal(store.bindings.get('ou-human:chat').threadName, 'bridge-p2p-ou-human');
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('interrupt and timeout target only the exact known task turn', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const runtime = fakeRuntime({ completeStarts: false }); const store = memoryStore();
    const executor = createCodexExecutor({ config: { ...config(cwd), turnTimeoutMs: 15 }, sessionStore: store, childEnv: {}, spawnImpl: runtime.spawnImpl });
    const running = executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'm', prompt: 'work', busyPolicy: 'steer' });
    while (!runtime.calls.some((call) => call.method === 'turn/start')) await new Promise((resolve) => setImmediate(resolve));
    const binding = store.bindings.get('ou:chat');
    assert.deepEqual(await executor.interrupt({ binding, threadId: 'thread-1', turnId: 'turn-1', messageId: 'wrong' }), { status: 'unconfirmed' });
    assert.deepEqual(await executor.interrupt({ binding, threadId: 'thread-1', turnId: 'turn-1', messageId: 'm' }), { status: 'requested' });
    await assert.rejects(running, { code: 'CODEX_TURN_TIMEOUT' });
    const interrupts = runtime.calls.filter((call) => call.method === 'turn/interrupt');
    assert.ok(interrupts.length >= 2);
    assert.ok(interrupts.every((call) => call.params.threadId === 'thread-1' && call.params.turnId === 'turn-1'));
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('memory guard waits for the native turn and lifecycle barrier before requesting ordered shutdown', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const runtime = fakeRuntime({ completeStarts: false });
    let check; const restarts = [];
    const executor = createCodexExecutor({
      config: { ...config(cwd), memoryCheckIntervalMs: 60_000, memoryMaxRssBytes: 10, memoryMaxHeapUsedBytes: 10,
        memoryUsage: () => ({ rss: 20, heapUsed: 5 }) },
      sessionStore: memoryStore(), spawnImpl: runtime.spawnImpl,
      setIntervalImpl(callback) { check = callback; return { unref() {} }; }, clearIntervalImpl() {},
      onRestartRequired: async (reason) => { restarts.push(reason); },
    });
    const running = executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'memory', prompt: 'work' });
    while (executor.status().activeTurns !== 1) await new Promise((resolve) => setImmediate(resolve));
    check();
    assert.equal(executor.status().restartPending, 'rss 20 >= 10');
    assert.deepEqual(restarts, []);
    runtime.children[0].send({ method: 'turn/completed', params: { turnId: 'turn-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
    await running;
    while (!restarts.length) await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(restarts, ['rss 20 >= 10']);
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('caller abort and onBound failure never stop or replay the native turn', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const runtime = fakeRuntime({ completeStarts: false }); const store = memoryStore();
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: store, childEnv: {}, spawnImpl: runtime.spawnImpl });
    const controller = new AbortController();
    const waiting = executor.execute({ bindingOpenId: 'ou-abort', chatId: 'chat', chatType: 'p2p', messageId: 'abort', prompt: 'work', busyPolicy: 'steer' }, { signal: controller.signal });
    while (!runtime.calls.some((call) => call.method === 'turn/start')) await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(waiting, { code: 'CODEX_WAIT_ABORTED' });
    assert.equal(executor.status().activeTurns, 1);
    assert.equal(executor.status().activeTurnResponseWaiters, 0);
    assert.equal(runtime.calls.filter((call) => call.method === 'turn/interrupt').length, 0);
    const takeover = executor.execute({ bindingOpenId: 'ou-abort', chatId: 'chat', chatType: 'p2p', messageId: 'follow', prompt: 'continue', busyPolicy: 'steer' });
    while (!runtime.calls.some((call) => call.method === 'turn/steer')) await new Promise((resolve) => setImmediate(resolve));
    runtime.children[0].send({ method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-1', turn: { id: 'turn-1', status: 'completed', items: [{ id: 'takeover-answer', type: 'agentMessage', phase: 'final_answer', text: 'takeover answer' }] } } });
    const takeoverResult = await takeover;
    assert.equal(takeoverResult.takeover, true);
    assert.ok(store.events.some((event) => event.event_key === 'assistant-final:follow'));
    while (executor.status().activeTurns) await new Promise((resolve) => setImmediate(resolve));

    const boundInput = { bindingOpenId: 'ou-bound', chatId: 'chat', chatType: 'p2p', messageId: 'bound', prompt: 'work', busyPolicy: 'steer' };
    const boundError = await executor.execute(boundInput, { onBound: () => { throw new Error('fixture persistence failure'); } }).then(() => null, (error) => error);
    assert.equal(boundError.code, 'CODEX_BINDING_UNCERTAIN');
    assert.deepEqual([boundError.threadId, boundError.turnId], ['thread-2', 'turn-2']);
    await assert.rejects(executor.execute(boundInput), { code: 'CODEX_BINDING_UNCERTAIN' });
    assert.equal(runtime.calls.filter((call) => call.method === 'turn/start').length, 2);
    assert.equal(runtime.calls.filter((call) => call.method === 'turn/interrupt').length, 0);
    runtime.children[0].send({ method: 'turn/completed', params: { threadId: 'thread-2', turnId: 'turn-2', turn: { id: 'turn-2', status: 'completed', items: [] } } });
    while (executor.status().activeTurns) await new Promise((resolve) => setImmediate(resolve));
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('forward lease loss abandons feedback through the real executor abort path', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const appServer = fakeRuntime({ completeStarts: false });
    const sessions = memoryStore();
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: sessions, childEnv: {}, spawnImpl: appServer.spawnImpl });
    let claimed = false;
    let observerStarted = false;
    let abandoned = 0;
    let resolveAbandoned;
    const abandonedSignal = new Promise(resolve => { resolveAbandoned = resolve; });
    const job = {
      id: '00000000-0000-4000-8000-000000000001', callerId: 'live', chatId: 'chat', chatType: 'p2p',
      messageId: 'message', sourceMessageId: 'message', senderOpenId: 'person', senderName: 'Person',
      deliveryMode: 'bridge', prompt: 'work', attempts: 1, result: {}, createdAt: 1,
    };
    const jobs = {
      async claimReplyPending() { return []; },
      async claimFeedbackPending() { return []; },
      async claim({ owner }) {
        if (claimed) return [];
        claimed = true;
        job.leaseOwner = owner;
        return [job];
      },
      async renew() {
        if (observerStarted) throw Object.assign(new Error('lost'), { code: 'forward_lease_lost' });
        return { renewed: true };
      },
      async patchExecution({ execution }) { job.result.execution = structuredClone(execution); },
      async markReplyPending() { throw new Error('aborted execution must not become reply pending'); },
      async markRetry() { throw new Error('aborted execution must not be retried by the stale owner'); },
    };
    const feedback = {
      async restore() { return { observer: { active: true }, card: { active: true } }; },
      observe() { observerStarted = true; },
      abandon(state) {
        abandoned += 1;
        state.observer = null;
        state.card = null;
        resolveAbandoned();
      },
    };
    const runtime = createForwardRuntime({
      config: { owner: 'process', pollMs: 1, leaseMs: 100, heartbeatMs: 5 },
      jobs, sessions, executor, feedback, replies: {}, authorize: async () => true,
    });
    runtime.start();
    await abandonedSignal;
    assert.equal(abandoned, 1);
    assert.equal(executor.status().activeTurns, 1);
    appServer.children[0].send({ method: 'turn/completed', params: {
      threadId: 'thread-1', turnId: 'turn-1', turn: { id: 'turn-1', status: 'completed', items: [] },
    } });
    while (executor.status().activeTurns) await new Promise(resolve => setImmediate(resolve));
    await runtime.stop();
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('an unconfirmed turn start is reported once and never retried inside execute', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const runtime = fakeRuntime({ completeStarts: false, rejectTurnStart: true });
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore(), childEnv: {}, spawnImpl: runtime.spawnImpl });
    await assert.rejects(executor.execute({ bindingOpenId: 'system:x', chatId: 'chat', chatType: 'group', messageId: 'job', prompt: 'work', busyPolicy: 'reject' }), { code: 'CODEX_TURN_START_UNCONFIRMED', outcome: 'unknown' });
    assert.equal(runtime.calls.filter((call) => call.method === 'turn/start').length, 1);
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('session store uses injected schema and public progress exact identity filter', async () => {
  const calls = [];
  const pool = { async query(sql, params) { calls.push([sql, params]); return [[]]; } };
  const store = createCodexSessionStore({connectionId:'fixture', pool, schema: 'bridge_dev', now: () => 7 });
  await store.readPublicProgress({ binding: { feishuOpenId: 'system:a', chatId: 'chat-a' }, threadId: 'thread-a', messageId: 'message-a', cursor: 3, limit: 999 });
  await store.readPublicProgress({ binding: { feishuOpenId: 'system:a', chatId: 'chat-a' }, threadId: 'thread-a', messageId: 'message-a', cursor: '9007199254740993', limit: 999 });
  assert.match(calls[0][0], /`bridge_dev`\.`assistant_codex_events`/);
  assert.match(calls[0][0], /feishu_open_id = \? AND chat_id = \? AND codex_session_id = \? AND message_id = \?/);
  assert.deepEqual(calls[0][1], ['fixture', 'system:a', 'chat-a', 'thread-a', 'message-a', 0, 0, '3', 250]);
  assert.deepEqual(calls[1][1], ['fixture', 'system:a', 'chat-a', 'thread-a', 'message-a', 0, 0, '9007199254740993', 250]);
});

test('migration contains only the two first-ticket production tables', async () => {
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(new URL('../src/storage/migrations/002-codex-sessions.sql', import.meta.url), 'utf8');
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  assert.deepEqual(tables, ['assistant_codex_sessions', 'assistant_codex_events']);
  assert.match(sql, /idx_assistant_codex_events_public \(feishu_open_id, chat_id, codex_session_id, message_id, id\)/);
  assert.match(sql, /idx_assistant_codex_events_progress \(feishu_open_id, chat_id, codex_session_id, message_id, created_at, id\)/);
});

test('child exit, RPC reset, and close settle active observers as unknown without replay', async (t) => {
  const input = { bindingOpenId: 'system:x', chatId: 'chat', chatType: 'group', messageId: 'job', prompt: 'work', busyPolicy: 'reject' };
  await t.test('child exit', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
    try {
      const runtime = fakeRuntime({ completeStarts: false });
      const executor = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore(), spawnImpl: runtime.spawnImpl });
      const running = executor.execute(input);
      while (executor.status().activeTurns !== 1) await new Promise((resolve) => setImmediate(resolve));
      runtime.children[0].emit('exit', 1, null);
      const error = await running.then(() => null, (reason) => reason);
      assert.equal(error.code, 'CODEX_OBSERVATION_LOST');
      assert.deepEqual([error.threadId, error.turnId, error.outcome], ['thread-1', 'turn-1', 'unknown']);
      assert.equal(runtime.calls.filter((call) => call.method === 'turn/start').length, 1);
      await executor.close();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  await t.test('another RPC timeout', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
    try {
      const runtime = fakeRuntime({ completeStarts: false, hangMethods: new Set(['thread/read']) });
      const executor = createCodexExecutor({ config: { ...config(cwd), rpcTimeoutMs: 10 }, sessionStore: memoryStore(), spawnImpl: runtime.spawnImpl });
      const running = executor.execute(input);
      while (!runtime.calls.some((call) => call.method === 'turn/start')) await new Promise((resolve) => setImmediate(resolve));
      await assert.rejects(executor.inspect({ binding: { feishuOpenId: 'system:x', chatId: 'chat', codexSessionId: 'thread-1' }, threadId: 'thread-1', turnId: 'turn-1' }), { code: 'CODEX_RPC_TIMEOUT' });
      await assert.rejects(running, { code: 'CODEX_OBSERVATION_LOST', outcome: 'unknown' });
      assert.equal(runtime.calls.filter((call) => call.method === 'turn/start').length, 1);
      await executor.close();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  await t.test('active close', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
    try {
      const runtime = fakeRuntime({ completeStarts: false });
      const executor = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore(), spawnImpl: runtime.spawnImpl });
      const running = executor.execute(input);
      while (executor.status().activeTurns !== 1) await new Promise((resolve) => setImmediate(resolve));
      await executor.close();
      await assert.rejects(running, { code: 'CODEX_OBSERVATION_LOST', outcome: 'unknown' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

test('observation persistence failures retain the original unknown identity', async (t) => {
  const input = { bindingOpenId: 'system:x', chatId: 'chat', chatType: 'group', messageId: 'job', prompt: 'work', busyPolicy: 'reject' };
  for (const stage of ['event', 'touch']) {
    await t.test(stage, async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
      try {
        const store = memoryStore(); const logs = [];
        if (stage === 'event') {
          const save = store.saveCodexRealtimeEvent;
          store.saveCodexRealtimeEvent = async (binding, event) => {
            if (event.eventKey.startsWith('error:')) throw new Error('synthetic observation event failure');
            return save(binding, event);
          };
        } else {
          store.touchCodexBinding = async () => { throw new Error('synthetic observation touch failure'); };
        }
        const runtime = fakeRuntime({ completeStarts: false });
        const executor = createCodexExecutor({ config: config(cwd), sessionStore: store, spawnImpl: runtime.spawnImpl, log: (level, detail) => logs.push([level, detail]) });
        const running = executor.execute(input);
        while (executor.status().activeTurns !== 1) await new Promise((resolve) => setImmediate(resolve));
        runtime.children[0].emit('exit', 1, null);
        const error = await running.then(() => null, (reason) => reason);
        assert.equal(error.code, 'CODEX_OBSERVATION_LOST');
        assert.equal(error.outcome, 'unknown');
        assert.deepEqual([error.threadId, error.turnId], ['thread-1', 'turn-1']);
        assert.ok(Number.isFinite(error.startedAt));
        assert.ok(logs.some(([level, detail]) => level === 'error' && detail.operation === 'persist_observation_loss' && detail.stage === stage && detail.threadId === 'thread-1' && detail.turnId === 'turn-1'));
        assert.equal(runtime.calls.filter((call) => call.method === 'turn/start').length, 1);
        while (executor.status().activeTurns) await new Promise((resolve) => setImmediate(resolve));
        await executor.close();
      } finally { rmSync(cwd, { recursive: true, force: true }); }
    });
  }
});

test('a fresh child resumes its binding after idle close before starting another turn', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const runtime = fakeRuntime({ strictThreadLoading: true });
    const executor = createCodexExecutor({ config: { ...config(cwd), idleCloseMs: 5 }, sessionStore: memoryStore(), spawnImpl: runtime.spawnImpl });
    await executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'one', prompt: 'one', busyPolicy: 'steer' });
    for (let count = 0; count < 50 && executor.status().ready; count++) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(executor.status().ready, false);
    await executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'two', prompt: 'two', busyPolicy: 'steer' });
    assert.equal(runtime.children.length, 2);
    assert.ok(runtime.calls.some((call) => call.method === 'thread/resume' && call.params.threadId === 'thread-1'));
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('disabled idle close reuses one child and explicit executor shutdown closes it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const runtime = fakeRuntime({ strictThreadLoading: true });
    const executor = createCodexExecutor({ config: { ...config(cwd), idleCloseMs: 0 }, sessionStore: memoryStore(), spawnImpl: runtime.spawnImpl });
    await executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'one', prompt: 'one', busyPolicy: 'steer' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(executor.status().ready, true);
    await executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'two', prompt: 'two', busyPolicy: 'steer' });
    assert.equal(runtime.children.length, 1);
    await executor.close();
    assert.equal(runtime.children[0].exitCode, 0);
    assert.equal(executor.status().ready, false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('binding remains occupied through shared final persistence and cannot be rolled back', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const binding = { feishuOpenId: 'system:x', chatId: 'chat', chatType: 'group', codexSessionId: 'thread-old', threadName: 'system', lastMessageAt: 100, created: false };
    const store = memoryStore([binding]);
    let releaseTouch; let enteredTouch;
    const touchGate = new Promise((resolve) => { releaseTouch = resolve; });
    const touchEntered = new Promise((resolve) => { enteredTouch = resolve; });
    const touch = store.touchCodexBinding;
    store.touchCodexBinding = async (eventBinding, options) => {
      if (options.messageId === 'first') { enteredTouch(); await touchGate; }
      return touch(eventBinding, options);
    };
    let clock = 100;
    const runtime = fakeRuntime();
    const executor = createCodexExecutor({ config: { ...config(cwd), rolloverOnRulesUpdate: false, rolloverIdleMs: 500 }, sessionStore: store, spawnImpl: runtime.spawnImpl, now: () => clock });
    const firstInput = { bindingOpenId: 'system:x', chatId: 'chat', chatType: 'group', messageId: 'first', prompt: 'work', busyPolicy: 'reject' };
    const first = executor.execute(firstInput);
    await touchEntered;
    const retry = executor.execute(firstInput);
    clock = 1000;
    await assert.rejects(executor.execute({ ...firstInput, messageId: 'second' }), { code: 'CODEX_THREAD_BUSY' });
    assert.equal(runtime.calls.filter((call) => call.method === 'turn/start').length, 1);
    releaseTouch();
    const [a, b] = await Promise.all([first, retry]);
    assert.equal(a.turnId, b.turnId);
    await executor.execute({ ...firstInput, messageId: 'second' });
    assert.equal(store.bindings.get('system:x:chat').codexSessionId, 'thread-1');
    assert.equal(runtime.calls.filter((call) => call.method === 'turn/start').length, 2);
    assert.equal(runtime.calls.filter((call) => call.method === 'thread/start').length, 1); // rollover creates the replacement thread
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('successful finalization requires the binding touch and releases the binding', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const store = memoryStore();
    store.touchCodexBinding = async () => { throw new Error('synthetic session touch failure'); };
    const runtime = fakeRuntime();
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: store, spawnImpl: runtime.spawnImpl });
    const input = { bindingOpenId: 'system:x', chatId: 'chat', chatType: 'group', messageId: 'job', prompt: 'work', busyPolicy: 'reject' };
    const one = executor.execute(input); const two = executor.execute(input);
    await assert.rejects(one, /synthetic session touch failure/);
    assert.equal((await two).deferred, true);
    while (executor.status().activeTurns) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.calls.filter((call) => call.method === 'turn/start').length, 1);
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('concurrent exact resumes share one observer while mismatched resume cannot steer an active turn', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const binding = { feishuOpenId: 'ou', chatId: 'chat', chatType: 'p2p', codexSessionId: 'thread-existing', threadName: 'human', created: false };
    const runtime = fakeRuntime({ completeStarts: false, resumeDelayMs: 15, resumeTurns: [{ id: 'known', status: 'inProgress' }] });
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore([binding]), spawnImpl: runtime.spawnImpl });
    const input = { bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'job', prompt: 'work', busyPolicy: 'steer' };
    const options = { resume: { threadId: 'thread-existing', turnId: 'known', startedAt: 10 } };
    const one = executor.execute(input, options); const two = executor.execute(input, options);
    while (executor.status().activeTurns !== 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.calls.filter((call) => call.method === 'thread/resume').length, 1);
    await assert.rejects(executor.execute(input, { resume: { threadId: 'thread-existing', turnId: 'wrong', startedAt: 10 } }), { code: 'CODEX_THREAD_HELD' });
    assert.equal(runtime.calls.filter((call) => call.method === 'turn/steer').length, 0);
    assert.equal(runtime.calls.filter((call) => call.method === 'turn/start').length, 0);
    runtime.children[0].send({ method: 'turn/completed', params: { threadId: 'thread-existing', turnId: 'known', turn: { id: 'known', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'restored' }] } } });
    const results = await Promise.all([one, two]);
    assert.deepEqual(results.map((result) => result.answer), ['restored', 'restored']);
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('transition resume leaves normal production resume to clean native orphan turns', async (t) => {
  const binding = { feishuOpenId: 'system:x', chatId: 'chat', chatType: 'group', codexSessionId: 'thread-existing', threadName: 'system', created: false };
  const resumeInput = { bindingOpenId: 'system:x', chatId: 'chat', chatType: 'group', messageId: 'old-job', prompt: 'old', busyPolicy: 'reject' };
  const nextInput = { ...resumeInput, messageId: 'new-job', prompt: 'new' };
  await t.test('completed requested turn plus unbound active turn', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
    try {
      const runtime = fakeRuntime({ resumeTurns: [
        { id: 'known', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'known result' }] },
        { id: 'unbound', status: 'inProgress' },
      ] });
      const executor = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore([binding]), spawnImpl: runtime.spawnImpl });
      const result = await executor.execute(resumeInput, { resume: { threadId: 'thread-existing', turnId: 'known', startedAt: 10 } });
      assert.equal(result.rawAnswer, 'known result');
      assert.equal((await executor.execute(nextInput)).answer, 'answer turn-1');
      assert.equal(runtime.calls.filter((call) => call.method === 'thread/resume').length, 2);
      assert.equal(runtime.calls.filter((call) => call.method === 'turn/interrupt').length, 1);
      assert.equal(runtime.calls.filter((call) => call.method === 'turn/start').length, 1);
      await executor.close();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  await t.test('missing requested turn plus unbound active turn', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
    try {
      const runtime = fakeRuntime({ resumeTurns: [{ id: 'unbound', status: 'inProgress' }] });
      const executor = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore([binding]), spawnImpl: runtime.spawnImpl });
      await assert.rejects(executor.execute(resumeInput, { resume: { threadId: 'thread-existing', turnId: 'missing', startedAt: 10 } }), { code: 'CODEX_TURN_UNKNOWN', outcome: 'unknown' });
      assert.equal((await executor.execute(nextInput)).answer, 'answer turn-1');
      assert.equal(runtime.calls.filter((call) => call.method === 'thread/resume').length, 2);
      assert.equal(runtime.calls.filter((call) => call.method === 'turn/interrupt').length, 1);
      assert.equal(runtime.calls.filter((call) => call.method === 'turn/start').length, 1);
      await executor.close();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

test('completed resume verifies native identity and scans attachments even with a stored final event', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const binding = { feishuOpenId: 'ou', chatId: 'chat', chatType: 'p2p', codexSessionId: 'thread-existing', threadName: 'human', created: false };
    const store = memoryStore([binding]);
    await store.saveCodexRealtimeEvent(binding, { messageId: 'job', eventKey: 'assistant-final:job', eventType: 'agent_message', role: 'assistant', text: 'stored', detail: {} });
    const startedAt = Date.now() - 5_000;
    const directory = join(cwd, outboxRelativeDirectory({ chatId: 'chat', bindingOpenId: 'ou' }));
    mkdirSync(directory, { recursive: true });
    const attachment = join(directory, 'result.txt'); writeFileSync(attachment, 'fixture');
    const runtime = fakeRuntime({ resumeTurns: [{ id: 'known', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'native' }] }] });
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: store, spawnImpl: runtime.spawnImpl });
    const result = await executor.execute({ bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'job', prompt: 'work', busyPolicy: 'steer' }, { resume: { threadId: 'thread-existing', turnId: 'known', startedAt } });
    assert.equal(result.answer, 'native');
    assert.equal(result.rawAnswer, 'native');
    assert.deepEqual(result.attachments, [attachment]);
    assert.equal(runtime.calls.filter((call) => call.method === 'thread/resume').length, 1);
    assert.equal(runtime.calls.filter((call) => call.method === 'turn/start').length, 0);
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('normal and duplicate final results retain rawAnswer beyond the display limit', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const store = memoryStore(); const runtime = fakeRuntime();
    const executor = createCodexExecutor({ config: { ...config(cwd), maxOutputChars: 5 }, sessionStore: store, spawnImpl: runtime.spawnImpl });
    const input = { bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'job', prompt: 'work', busyPolicy: 'steer' };
    const result = await executor.execute(input);
    assert.equal(result.answer, 'answe'); assert.equal(result.rawAnswer, 'answer turn-1');
    const duplicate = await executor.execute(input);
    assert.equal(duplicate.answer, 'answe'); assert.equal(duplicate.rawAnswer, 'answer turn-1');
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('completed item projection keeps production event types and removes raw tool payloads', () => {
  assert.deepEqual(projectCodexItem({ type: 'message', role: 'assistant', phase: 'final_answer', content: ['a', { input_text: 'b' }] }).text, 'a\nb');
  assert.deepEqual(projectCodexItem({ type: 'plan', text: 'next' }).eventType, 'plan');
  assert.deepEqual(projectCodexItem({ type: 'reasoning', summary: ['safe'] }).eventType, 'reasoning');
  assert.deepEqual(projectCodexItem({ type: 'fileChange', changes: [{ kind: 'update', path: 'a.js' }] }).eventType, 'file_change');
  assert.deepEqual(projectCodexItem({ type: 'webSearch', query: 'query' }).eventType, 'web_search');
  assert.deepEqual(projectCodexItem({ type: 'contextCompaction' }).eventType, 'context_compaction');
  const call = projectCodexItem({ type: 'function_call', name: 'secretTool', arguments: { secret: true } });
  const output = projectCodexItem({ type: 'function_call_output', output: 'secret output' });
  const command = projectCodexItem({ type: 'commandExecution', command: 'secret command', aggregatedOutput: 'secret output', cwd: '/secret', status: 'completed', exitCode: 0 });
  const mcp = projectCodexItem({ type: 'mcpToolCall', server: 'server', tool: 'tool', arguments: { secret: true } });
  assert.equal(call.text, ''); assert.equal(output.text, ''); assert.equal(command.text, ''); assert.equal(mcp.text, '');
  assert.deepEqual(command.detail, { status: 'completed', exitCode: 0 });
});

test('rules, idle, and archived rollover preserve distinct production text and detail', async (t) => {
  const baseBinding = { feishuOpenId: 'ou', chatId: 'chat', chatType: 'p2p', codexSessionId: 'thread-old', threadName: 'human', lastMessageAt: 100, created: false };
  const input = { bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'next', prompt: 'work', busyPolicy: 'steer' };
  await t.test('rules', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
    try {
      writeFileSync(join(cwd, 'RULES.fixture'), 'rules');
      const store = memoryStore([baseBinding]);
      const runtime = fakeRuntime({ readThread: { createdAt: 1, path: '/native/thread' } });
      const executor = createCodexExecutor({ config: { ...config(cwd), rulesPaths: ['RULES.fixture'], rolloverIdleMs: 0 }, sessionStore: store, spawnImpl: runtime.spawnImpl });
      await executor.execute(input);
      const event = store.events.find((row) => row.event_key.startsWith('rollover-out:'));
      assert.match(event.text, /规则文件已更新/); assert.equal(JSON.parse(event.detail_json).threadPath, '/native/thread');
      await executor.close();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  await t.test('idle', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
    try {
      const store = memoryStore([baseBinding]); const runtime = fakeRuntime();
      const executor = createCodexExecutor({ config: { ...config(cwd), rolloverOnRulesUpdate: false, rolloverIdleMs: 600_000 }, sessionStore: store, spawnImpl: runtime.spawnImpl, now: () => 700_100 });
      await executor.execute(input);
      const event = store.events.find((row) => row.event_key.startsWith('rollover-out:'));
      assert.match(event.text, /600 秒/); assert.equal(JSON.parse(event.detail_json).thresholdMs, 600_000);
      await executor.close();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  await t.test('archived', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
    try {
      const store = memoryStore([baseBinding]); const runtime = fakeRuntime({ archiveResumeThreadIds: new Set(['thread-old']) });
      const executor = createCodexExecutor({ config: { ...config(cwd), rolloverOnRulesUpdate: false, rolloverIdleMs: 0 }, sessionStore: store, spawnImpl: runtime.spawnImpl });
      await executor.execute(input);
      const event = store.events.find((row) => row.event_key.startsWith('rollover-out:'));
      assert.match(event.text, /原会话已归档/); assert.equal(JSON.parse(event.detail_json).archivedCodexSessionId, 'thread-old');
      await executor.close();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
  await t.test('archived during turn start', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
    try {
      const store = memoryStore([baseBinding]); const runtime = fakeRuntime({ archiveTurnStartOnce: true });
      const executor = createCodexExecutor({ config: { ...config(cwd), rolloverOnRulesUpdate: false, rolloverIdleMs: 0 }, sessionStore: store, spawnImpl: runtime.spawnImpl });
      const result = await executor.execute(input);
      assert.equal(result.answer, 'answer turn-1');
      assert.equal(runtime.calls.filter((call) => call.method === 'turn/start').length, 2);
      const event = store.events.find((row) => row.event_key.startsWith('rollover-out:'));
      assert.equal(JSON.parse(event.detail_json).archivedCodexSessionId, 'thread-old');
      await executor.close();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});

for (const path of ['error', 'turn/completed', 'resume']) {
  test(`usage limit classification survives ${path} without raw provider text or turn replay`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'bridge-limit-'));
    const binding = { feishuOpenId: 'ou', chatId: 'chat', chatType: 'p2p', codexSessionId: 'thread-existing', created: false };
    const upstream = { message: 'SECRET token=private usage details', codexErrorInfo: 'usageLimitExceeded', additionalDetails: 'SECRET' };
    const runtime = fakeRuntime({ completeStarts: false, readTurns: path === 'resume' ? [{ id: 'known', status: 'failed', error: upstream }] : [], resumeTurns: path === 'resume' ? [{ id: 'known', status: 'failed', error: upstream }] : [] });
    const store = memoryStore([binding]);
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: store, spawnImpl: runtime.spawnImpl });
    try {
      const input = { bindingOpenId: 'ou', chatId: 'chat', chatType: 'p2p', messageId: 'limit-job', prompt: 'work' };
      const running = executor.execute(input, path === 'resume' ? { resume: { threadId: 'thread-existing', turnId: 'known', startedAt: 10 } } : {});
      const rejected = assert.rejects(running, error => error.code === 'CODEX_USAGE_LIMIT_EXCEEDED' && !error.message.includes('SECRET'));
      if (path !== 'resume') {
        while (!runtime.calls.some(call => call.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setTimeout(resolve, 10));
        runtime.children[0].send({ method: path, params: { threadId: runtime.calls.find(call => call.method === 'turn/start').params.threadId, turnId: 'turn-1', willRetry: false, error: upstream, turn: { id: 'turn-1', status: 'failed', error: upstream } } });
      }
      await rejected;
      const duplicate = await executor.execute(input);
      assert.equal(duplicate.failed, true);
      assert.equal(duplicate.errorCode, 'CODEX_USAGE_LIMIT_EXCEEDED');
      assert.equal(runtime.calls.filter(call => call.method === 'turn/start').length, path === 'resume' ? 0 : 1);
      assert.equal(JSON.stringify(duplicate).includes('SECRET'), false);
      assert.equal(JSON.stringify(store.events).includes('SECRET'), false);
    } finally { await executor.close(); rmSync(cwd, { recursive: true, force: true }); }
  });
}

const injectCalls = runtime => runtime.calls.filter(call => call.method === 'thread/inject_items');
const turnText = (runtime, index) => runtime.calls.filter(call => call.method === 'turn/start')[index].params.input[0].text;
const groupTurn = messageId => ({ bindingOpenId: 'group:oc_group', chatId: 'oc_group', chatType: 'group', messageId, prompt: 'work' });

test('configured group instructions enter a group thread once per fingerprint, after changes and after compaction', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-instructions-'));
  try {
    const store = memoryStore();
    let current = { text: 'rules v1', hash: 'h1', bytes: 8, sources: 1 };
    const provider = { configured: chatId => chatId === 'oc_group', forChat: async chatId => (chatId === 'oc_group' ? current : null) };
    let compactOnTurn = 0;
    const runtime = fakeRuntime({ turnItemsFor: turn => (turn === compactOnTurn ? [{ id: 'compact', type: 'contextCompaction' }] : []) });
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: store, spawnImpl: runtime.spawnImpl, groupInstructions: provider });
    await executor.execute(groupTurn('m1'));
    assert.deepEqual(injectCalls(runtime).map(call => call.params), [{ threadId: 'thread-1',
      items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules v1' }] }] }]);
    assert.deepEqual(runtime.calls.map(call => call.method).filter(method => ['thread/inject_items', 'turn/start'].includes(method)), ['thread/inject_items', 'turn/start']);
    assert.equal(turnText(runtime, 0).includes('rules v1'), false, 'instructions are not repeated in the user turn');
    await executor.execute(groupTurn('m2'));
    assert.equal(injectCalls(runtime).length, 1, 'an unchanged fingerprint is not injected again');
    current = { text: 'rules v2', hash: 'h2', bytes: 8, sources: 1 };
    await executor.execute(groupTurn('m3'));
    assert.equal(injectCalls(runtime).length, 2);
    assert.equal(injectCalls(runtime)[1].params.items[0].content[0].text, 'rules v2');
    compactOnTurn = 4;
    await executor.execute(groupTurn('m4'));
    assert.equal(injectCalls(runtime).length, 2);
    await executor.execute(groupTurn('m5'));
    assert.equal(injectCalls(runtime).length, 3, 'compaction invalidates the injected fingerprint');
    await executor.execute({ bindingOpenId: 'ou_human', chatId: 'oc_group', chatType: 'p2p', messageId: 'p1', prompt: 'hello' });
    await executor.execute({ bindingOpenId: deriveExecutionScope('hook', 'scope:1'), chatId: 'oc_group', chatType: 'group', messageId: 's1', prompt: 'event' });
    await executor.execute({ bindingOpenId: 'group:oc_plain', chatId: 'oc_plain', chatType: 'group', messageId: 'g1', prompt: 'work' });
    assert.equal(injectCalls(runtime).length, 3, 'private, system and unconfigured group threads are untouched');
    await executor.close();

    const marker = store.events.find(row => row.event_key === 'injection:group-instructions');
    assert.deepEqual(JSON.parse(marker.detail_json), { mode: 'append', bytes: 8, sources: 1, state: 'injected', hash: 'h2' });
    assert.equal(marker.text, '', 'instruction content is not copied into the event store');
    const restartedRuntime = fakeRuntime();
    const restarted = createCodexExecutor({ config: config(cwd), sessionStore: store, spawnImpl: restartedRuntime.spawnImpl, groupInstructions: provider });
    await restarted.execute(groupTurn('m6'));
    assert.equal(injectCalls(restartedRuntime).length, 0, 'the durable fingerprint survives a restart');
    await restarted.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('group instruction failures are warnings that never block the turn', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-instructions-'));
  try {
    const logs = [];
    let fail = 'inject';
    const provider = { configured: () => true, forChat: async () => { if (fail === 'load') throw new Error('SYNTHETIC_SECRET path'); return { text: 'SYNTHETIC_SECRET rules', hash: 'h1', bytes: 1, sources: 1 }; } };
    const runtime = fakeRuntime({ rejectMethods: new Map([['thread/inject_items', () => {
      if (fail === 'inject') return { code: -32601, message: 'SYNTHETIC_SECRET method not found' };
      return undefined;
    }]]) });
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore(), spawnImpl: runtime.spawnImpl, groupInstructions: provider, log: (...entry) => logs.push(entry) });
    assert.equal((await executor.execute(groupTurn('m1'))).answer, 'answer turn-1');
    assert(logs.some(([level, event]) => level === 'warning' && event.operation === 'context_injection' && event.stage === 'group_instructions_inject' && event.rpc_method === 'thread/inject_items'));
    fail = 'load';
    assert.equal((await executor.execute(groupTurn('m2'))).answer, 'answer turn-2');
    assert(logs.some(([level, event]) => level === 'warning' && event.stage === 'group_instructions_load'));
    assert.equal(injectCalls(runtime).length, 1, 'a failed injection is retried by a later turn only when instructions load');
    assert.doesNotMatch(JSON.stringify(logs), /SYNTHETIC_SECRET/);
    await executor.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('system task preamble is sent on the first turn and again only when it changes or after compaction', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-preamble-'));
  try {
    const store = memoryStore();
    const scope = deriveExecutionScope('hook', 'scope:1');
    const event = (executor, messageId, chatId = 'oc_delivery') => executor.execute({ bindingOpenId: scope, chatId, chatType: 'group', messageId, prompt: '【业务事件】\ntype：mail.inbound' });
    const runtime = fakeRuntime({ turnItemsFor: turn => (turn === 3 ? [{ id: 'compact', type: 'contextCompaction' }] : []) });
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: store, spawnImpl: runtime.spawnImpl });
    await event(executor, 'e1');
    assert.match(turnText(runtime, 0), /^【独立系统任务】\n任务：system:[0-9a-f]+\n结果投递群：oc_delivery\n[^\n]+\n回发文件目录：data\/feishu-outbox\/system-[0-9a-f]+\/oc_delivery\n\n【业务事件】\ntype：mail\.inbound$/);
    await event(executor, 'e2');
    assert.equal(turnText(runtime, 1), '【业务事件】\ntype：mail.inbound');
    await event(executor, 'e3');
    assert.equal(turnText(runtime, 2), '【业务事件】\ntype：mail.inbound');
    await event(executor, 'e4');
    assert.match(turnText(runtime, 3), /^【独立系统任务】/, 'compaction sends the preamble again');
    await event(executor, 'e5', 'oc_other');
    assert.match(turnText(runtime, 4), /^【独立系统任务】\n[^\n]+\n结果投递群：oc_other\n/, 'a changed delivery group receives its own preamble');
    await event(executor, 'e6', 'oc_other');
    assert.equal(turnText(runtime, 5), '【业务事件】\ntype：mail.inbound');
    await executor.close();

    const restartedRuntime = fakeRuntime();
    const restarted = createCodexExecutor({ config: config(cwd), sessionStore: store, spawnImpl: restartedRuntime.spawnImpl });
    await event(restarted, 'e7');
    assert.equal(turnText(restartedRuntime, 0), '【业务事件】\ntype：mail.inbound', 'a restart does not repeat an unchanged preamble');
    await restarted.close();

    const movedRuntime = fakeRuntime();
    const moved = createCodexExecutor({ config: { ...config(cwd), outboxRelativeRoot: 'data/other-outbox' }, sessionStore: store, spawnImpl: movedRuntime.spawnImpl });
    await event(moved, 'e8');
    assert.equal(movedRuntime.calls.find(call => call.method === 'turn/start').params.threadId, 'thread-1');
    assert.match(turnText(movedRuntime, 0), /^【独立系统任务】[\s\S]*回发文件目录：data\/other-outbox\/system-/, 'a changed result directory is sent to the same thread');
    await moved.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('replace-mode instructions drop only the default group wording once the thread holds them', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-mode-'));
  try {
    const context = { chatId: 'oc_group', name: '默认群名', description: '默认介绍' };
    const turn = (messageId, chatId = 'oc_group') => ({ bindingOpenId: `group:${chatId}`, chatId, chatType: 'group', messageId,
      prompt: `【提到你的消息 来自 Bob（open_id=ou_b）】\n[msg message_id=${messageId} chat_id=${chatId}]\nwork`, groupChatContext: { ...context, chatId } });
    const run = async ({ mode, rejectInject = false }) => {
      const runtime = fakeRuntime(rejectInject ? { rejectMethods: new Map([['thread/inject_items', { code: -32601, message: 'unsupported' }]]) } : {});
      const provider = { configured: () => true, forChat: async () => ({ text: `rules ${mode}`, hash: `h-${mode}`, mode, bytes: 1, sources: 1 }) };
      const executor = createCodexExecutor({ config: { ...config(cwd), allowedGroupChatIds: new Set(['oc_group']) }, sessionStore: memoryStore(), spawnImpl: runtime.spawnImpl, groupInstructions: provider });
      await executor.execute(turn('m1'));
      await executor.execute({ bindingOpenId: deriveExecutionScope('hook', 'scope:1'), chatId: 'oc_group', chatType: 'group', messageId: 's1', prompt: 'event' });
      await executor.close();
      return { first: turnText(runtime, 0), system: turnText(runtime, 1) };
    };
    const structural = prompt => {
      assert.match(prompt, /^【飞书群聊上下文】\n/);
      assert.match(prompt, /\nchat_id：oc_group\n/);
      assert.match(prompt, /\n回发文件目录：data\/feishu-outbox\/oc_group\n说明：需要给当前群回发文件时/);
      assert.match(prompt, /\n\n【提到你的消息 来自 Bob（open_id=ou_b）】\n\[msg message_id=m1 chat_id=oc_group\]\nwork$/);
    };
    const appended = await run({ mode: 'append' });
    structural(appended.first);
    assert.match(appended.first, /群名称：默认群名\n群介绍：默认介绍\nchat_id：oc_group\n说明：这是本 Codex 会话绑定的飞书群/);
    const replaced = await run({ mode: 'replace' });
    structural(replaced.first);
    assert.doesNotMatch(replaced.first, /默认群名|默认介绍|这是本 Codex 会话绑定的飞书群/);
    const fallback = await run({ mode: 'replace', rejectInject: true });
    structural(fallback.first);
    assert.match(fallback.first, /群名称：默认群名/, 'default wording stays when replacement instructions were not delivered');
    for (const result of [appended, replaced, fallback]) assert.match(result.system, /^【独立系统任务】\n/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
