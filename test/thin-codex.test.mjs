import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexExecutor } from '../src/agents/codex/executor.mjs';
import { CodexAppServerClient, codexAppServerArgs } from '../src/agents/codex/app-server-client.mjs';
import { IdleLifecycle } from '../src/agents/codex/idle-lifecycle.mjs';
import { deriveExecutionScope, codexBindingOpenId } from '../src/agents/codex/thread-scope.mjs';
import { createCodexSessionStore } from '../src/storage/codex-sessions.mjs';

class FakeStream extends EventEmitter {
  setEncoding() {}
}

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
    async readPublicProgress() { return []; },
  };
}

function fakeRuntime({ resumeTurns = [], readTurns = [], completeStarts = true, raceCompletionBeforeResponse = false, rejectTurnStart = false } = {}) {
  let threadNumber = 0; let turnNumber = 0;
  const children = []; const calls = []; const envs = []; const args = [];
  const spawnImpl = (_bin, childArgs, options) => {
    args.push(childArgs); envs.push(options.env);
    const child = new FakeChild((message, instance) => {
      calls.push(message);
      const respond = (result) => setImmediate(() => instance.send({ id: message.id, result }));
      if (message.method === 'initialize') respond({});
      else if (message.method === 'thread/start') respond({ thread: { id: `thread-${++threadNumber}` } });
      else if (message.method === 'thread/resume') respond({ thread: { id: message.params.threadId, turns: resumeTurns } });
      else if (message.method === 'thread/read') respond({ thread: { id: message.params.threadId, turns: readTurns } });
      else if (message.method === 'turn/start') {
        if (rejectTurnStart) { setImmediate(() => instance.send({ id: message.id, error: { code: -32000, message: 'synthetic transport uncertainty' } })); return; }
        const id = `turn-${++turnNumber}`;
        const completed = { method: 'turn/completed', params: { threadId: message.params.threadId, turnId: id, turn: { id, status: 'completed', items: [{ id: `answer-${id}`, type: 'agentMessage', phase: 'final_answer', text: `answer ${id}` }] } } };
        if (completeStarts && raceCompletionBeforeResponse) instance.send(completed);
        respond({ turn: { id } });
        if (completeStarts && !raceCompletionBeforeResponse) setTimeout(() => instance.send(completed), 5);
      } else if (message.method === 'turn/steer' || message.method === 'turn/interrupt') respond({});
    });
    children.push(child); return child;
  };
  return { spawnImpl, children, calls, envs, args };
}

function config(cwd) {
  return { bin: '/synthetic/codex', cwd, sharedHome: join(cwd, 'home'), rpcTimeoutMs: 1000, closeGraceMs: 20, idleCloseMs: 10, networkAccess: false, model: 'gpt-test', reasoningEffort: 'medium', sandbox: 'workspace-write', approvalPolicy: 'auto', approvalsReviewer: 'auto', allowedGroupChatIds: new Set() };
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
    const client = new CodexAppServerClient({ config: config(cwd), childEnv: { PATH: '/safe/bin', HTTPS_PROXY: 'http://proxy.invalid' }, spawnImpl: runtime.spawnImpl });
    assert.equal(runtime.children.length, 0);
    await client.request('thread/start', {});
    assert.deepEqual(runtime.envs[0], { PATH: '/safe/bin', HTTPS_PROXY: 'http://proxy.invalid', CODEX_HOME: join(cwd, 'home') });
    assert.ok(runtime.args[0].includes('sandbox_workspace_write.network_access=false'));
    assert.ok(runtime.args[0].includes('shell_environment_policy.inherit=none'));
    await client.close();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
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

test('executor binds, records start intent/bound, and completes from an event racing the response', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const runtime = fakeRuntime({ raceCompletionBeforeResponse: true }); const store = memoryStore(); const callbacks = [];
    const executor = createCodexExecutor({ config: config(cwd), sessionStore: store, childEnv: { PATH: '/safe/bin' }, spawnImpl: runtime.spawnImpl });
    const result = await executor.execute({ bindingOpenId: 'ou-human', chatId: 'chat', chatType: 'p2p', messageId: 'm1', senderOpenId: 'ou-human', senderName: 'User', prompt: 'hello', busyPolicy: 'steer' }, {
      onStartIntent: (value) => callbacks.push(['intent', value]), onBound: (value) => callbacks.push(['bound', value]),
    });
    assert.equal(result.answer, 'answer turn-1');
    assert.deepEqual(callbacks.map(([name]) => name), ['intent', 'bound']);
    const threadStart = runtime.calls.find((call) => call.method === 'thread/start');
    const turnStart = runtime.calls.find((call) => call.method === 'turn/start');
    assert.equal(threadStart.params.approvalPolicy, 'auto');
    assert.equal(threadStart.params.approvalsReviewer, 'auto');
    assert.equal(threadStart.params.sandbox, 'workspace-write');
    assert.equal(threadStart.params.model, 'gpt-test');
    assert.equal(threadStart.params.config.model_reasoning_effort, 'medium');
    assert.equal(turnStart.params.model, 'gpt-test');
    assert.equal(turnStart.params.effort, 'medium');
    assert.ok(store.events.some((event) => event.event_key === 'assistant-final:m1'));
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

test('unknown resumed activity is held and known resume is inspect-only', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bridge-codex-'));
  try {
    const binding = { feishuOpenId: 'system:x', chatId: 'chat', chatType: 'group', codexSessionId: 'thread-existing', threadName: 'system', created: false };
    const heldRuntime = fakeRuntime({ resumeTurns: [{ id: 'other-turn', status: 'inProgress' }] });
    const held = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore([binding]), childEnv: {}, spawnImpl: heldRuntime.spawnImpl });
    await assert.rejects(held.execute({ bindingOpenId: 'system:x', chatId: 'chat', chatType: 'group', messageId: 'job', prompt: 'work', busyPolicy: 'reject' }), { code: 'CODEX_THREAD_HELD' });
    assert.equal(heldRuntime.calls.filter((call) => call.method === 'turn/start').length, 0); await held.close();

    const knownRuntime = fakeRuntime({ resumeTurns: [{ id: 'known-turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: 'known' }] }] });
    const known = createCodexExecutor({ config: config(cwd), sessionStore: memoryStore([binding]), childEnv: {}, spawnImpl: knownRuntime.spawnImpl });
    let intents = 0;
    const result = await known.execute({ bindingOpenId: 'system:x', chatId: 'chat', chatType: 'group', messageId: 'job', prompt: 'work', busyPolicy: 'reject' }, { resume: { threadId: 'thread-existing', turnId: 'known-turn', startedAt: 1 }, onStartIntent: () => { intents++; } });
    assert.equal(result.answer, 'known'); assert.equal(intents, 0);
    assert.equal(knownRuntime.calls.filter((call) => call.method === 'turn/start').length, 0); await known.close();
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
    assert.equal(runtime.calls.filter((call) => call.method === 'turn/interrupt').length, 0);
    runtime.children[0].send({ method: 'turn/completed', params: { threadId: 'thread-1', turnId: 'turn-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
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
  const store = createCodexSessionStore({ pool, schema: 'bridge_dev', now: () => 7 });
  await store.readPublicProgress({ binding: { feishuOpenId: 'system:a', chatId: 'chat-a' }, threadId: 'thread-a', messageId: 'message-a', cursor: 3, limit: 999 });
  assert.match(calls[0][0], /`bridge_dev`\.`assistant_codex_events`/);
  assert.match(calls[0][0], /feishu_open_id = \? AND chat_id = \? AND codex_session_id = \? AND message_id = \?/);
  assert.deepEqual(calls[0][1], ['system:a', 'chat-a', 'thread-a', 'message-a', 3, 250]);
});

test('migration contains only the two first-ticket production tables', async () => {
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(new URL('../src/storage/migrations/002-codex-sessions.sql', import.meta.url), 'utf8');
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  assert.deepEqual(tables, ['assistant_codex_sessions', 'assistant_codex_events']);
  assert.match(sql, /idx_assistant_codex_events_public/);
});
