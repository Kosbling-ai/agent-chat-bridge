import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';
import { createLogger, createErrorReporter } from '../src/logger.mjs';
import { boundedFeishuHttp, startService } from '../src/service.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../src/core/runtime.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';

const config = {
  schemaVersion: 1, storage: Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `TEST_${key.toUpperCase()}`])),
  codex: { bin: './codex', cwd: './workspace', envNames: ['PATH'] },
  feishu: { connectionId: 'test', appIdEnv: 'TEST_APP', appSecretEnv: 'TEST_SECRET', botOpenId: 'bot' },
  routing: { version: '1', privateUserIds: ['human'], groups: [{ conversationId: 'chat', userIds: ['human'], trigger: 'mention', passiveContext: true }] },
};
test('runtime configuration is explicit and rejects scope/secret overrides', () => {
  assert.equal(validateConfig(config).feishu.connectionId, 'test');
  assert.equal(validateConfig(config).runtime.unhealthyExitMs, 30_000);
  assert.deepEqual(validateConfig(config).storage.writer, { probeIntervalMs: 500, probeTimeoutMs: 5_000, probeMaxMisses: 2, lostShutdownMs: 10_000 });
  assert.equal(validateConfig(config).feishu.catchup, true);
  assert.equal(validateConfig(config).feishu.replyAsPost, true);
  assert.equal(validateConfig(config).feishu.maxOutputChars, 3500);
  assert.equal(validateConfig(config).feishu.processingReaction, true);
  assert.equal(validateConfig(config).feishu.processingReactionEmoji, 'Typing');
  assert.equal(validateConfig(config).feishu.processingFallbackText, '收到，正在查询。');
  assert.equal(validateConfig(config).feishu.mediaEnabled, true);
  assert.equal(validateConfig(config).feishu.mediaMaxBytes, 20 * 1024 * 1024);
  assert.equal(validateConfig({ ...config, feishu: { ...config.feishu, replyAsPost: false, maxOutputChars: 7000 } }).feishu.replyAsPost, false);
  assert.equal(validateConfig(config).codex.jobRetryMs, 60_000);
  assert.equal(validateConfig(config).codex.jobMaxAttempts, 3);
  assert.equal(validateConfig(config).codex.idleCloseMs, 60_000);
  assert.equal(validateConfig(config).codex.rolloverIdleMs, 5 * 24 * 60 * 60 * 1000);
  assert.equal(validateConfig(config).codex.closeGraceMs, 5_000);
  assert.equal(validateConfig(config).codex.rpcTimeoutMs, 2 * 60 * 1000);
  assert.equal(validateConfig(config).codex.turnTimeoutMs, 12 * 60 * 60 * 1000);
  assert.equal(validateConfig(config).codex.approvalPolicy, 'on-request');
  assert.equal(validateConfig(config).codex.approvalsReviewer, 'auto_review');
  assert.equal(validateConfig(config).codex.requestUserInput, false);
  assert.equal(validateConfig({ ...config, codex: { ...config.codex, requestUserInput: false } }).codex.requestUserInput, false);
  assert.equal(validateConfig({ ...config, codex: { ...config.codex, requestUserInput: true } }).codex.requestUserInput, true);
  assert.equal(validateConfig(config).codex.memoryMaxRssBytes, 1536 * 1024 * 1024);
  assert.equal(validateConfig(config).codex.memoryMaxHeapUsedBytes, 1024 * 1024 * 1024);
  assert.equal(validateConfig({ ...config, codex: { ...config.codex, memoryCheckIntervalMs: 0, memoryMaxRssMb: 0, memoryMaxHeapUsedMb: 0 } }).codex.memoryMaxRssBytes, 0);
  assert.equal(validateConfig({ ...config, codex: { ...config.codex, idleCloseMs: 0 } }).codex.idleCloseMs, 0);
  assert.equal(validateConfig({ ...config, feishu: { ...config.feishu, catchup: false } }).feishu.catchup, false);
  for (const invalid of [
    { ...config, codex: { ...config.codex, networkAccess: 'yes' } },
    { ...config, codex: { ...config.codex, jobRetryMs: 9_999 } },
    { ...config, codex: { ...config.codex, jobMaxAttempts: 0 } },
    { ...config, codex: { ...config.codex, idleCloseMs: -1 } },
    { ...config, feishu: { ...config.feishu, replyAsPost: 'yes' } },
    { ...config, feishu: { ...config.feishu, maxOutputChars: 0 } },
    { ...config, feishu: { ...config.feishu, processingReaction: 'yes' } },
    { ...config, feishu: { ...config.feishu, mediaMaxBytes: -1 } },
    { ...config, auth: { tokenEnv: 'TEST_TOKEN' } },
    { ...config, auth: { clients: [{ id: 'caller', tokenEnv: 'TEST_TOKEN', conversationIds: ['chat'], admin: true }] } },
    { ...config, auth: {} },
    { ...config, feishu: { ...config.feishu, appSecret: 'synthetic' } },
    { ...config, hooks: [{ id: 'h', url: 'https://user:synthetic@example.invalid', tokenEnv: 'TEST_HOOK', conversationIds: [] }] },
    { ...config, errorReporting: { url: 'file:///tmp/report', tokenEnv: 'TEST_REPORT' } },
  ]) assert.throws(() => validateConfig(invalid));
});
test('history identity needed for allowlist/mention routing cannot consume canonical receipt', async () => {
  let accepted = 0;
  const groups = [{ conversationId: 'group', trigger: 'all', passiveContext: true }];
  const settings = { ...validateConfig(config), routing: { version: '1', privateUserIds: ['human'], groups } };
  const runtime = createRuntime({ config: settings, store: { acceptInbound: async () => { accepted++; return {}; } }, codex: {}, chat: {} });
  const event = { source: 'history_catchup', type: 'message.received', conversationId: 'group', conversationType: 'group', actor: { type: 'user', userId: 'internal' }, message: { kind: 'text', content: '{"text":"fixture"}', parsedContent: { text: 'fixture' }, mentions: [] } };
  await runtime.ingest(event);
  assert.equal(accepted, 1, 'group-level admission does not invent an open-id requirement');
  groups[0].userIds = ['human'];
  await assert.rejects(runtime.ingest(event), { code: 'history_authorization_identity_missing' });
  delete groups[0].userIds;
  groups[0].trigger = 'mention';
  await assert.rejects(runtime.ingest({ ...event, message: { ...event.message, mentions: [{ userId: 'internal-bot' }] } }), { code: 'history_authorization_identity_missing' });
  assert.equal(accepted, 1);
});
test('group defaults allow all human members; explicit member filter does not limit hooks', async () => {
  const observed = [];
  const forwarded = [];
  const groupConfig = validateConfig({ ...config, routing: { ...config.routing, groups: [{ conversationId: 'chat', trigger: 'all', passiveContext: true }] }, hooks: [{ id: 'h', url: 'http://example.invalid/hook', tokenEnv: 'TEST_HOOK', conversationIds: ['chat'] }] });
  const runtime = createCommunicationRuntime({ config: groupConfig, store: { acceptInbound: async value => { observed.push(value); return {}; } }, forward:{handleMessage:async value=>{forwarded.push(value);return{execution:{terminal:'completed'}};}},chat: {} });
  const event = { connectionId: 'test', eventKey: 'synthetic', type: 'message.received', conversationId: 'chat', conversationType: 'group', messageId: 'm', actor: { type: 'user', openId: 'not-enumerated' }, message: { kind: 'text', content: '{"text":"synthetic"}', parsedContent: { text: 'synthetic' } } };
  await runtime.ingest(event);
  await new Promise(setImmediate);
  assert.equal(forwarded.length,1);assert.equal(observed[0].forwardJob,undefined); assert.equal(observed[0].hooks.length, 1);
  const restricted = createCommunicationRuntime({ config: { ...groupConfig, routing: { ...groupConfig.routing, groups: [{ ...groupConfig.routing.groups[0], userIds: [] }] } }, store: { acceptInbound: async value => { observed.push(value); return {}; } }, forward:{handleMessage:async value=>{forwarded.push(value);}},chat: {} });
  await restricted.ingest(event);
  await new Promise(setImmediate);
  assert.equal(forwarded.length,1);assert.equal(observed[1].forwardJob, undefined); assert.equal(observed[1].hooks.length, 1);
});
test('error reporter is bounded, sanitized and cannot recursively report failures', async () => {
  const output = [];
  const warning = createLogger({ write: value => output.push(JSON.parse(value)) });
  const waits = [];
  const reporter = createErrorReporter({ url: 'http://synthetic.invalid', token: 'synthetic', warn: warning, fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).payload, undefined);
    await new Promise(resolve => waits.push(resolve));
    throw new Error('SECRET_SYNTHETIC');
  } });
  const log = createLogger({ write: value => output.push(JSON.parse(value)) }, { reportError: reporter.report });
  for (let i = 0; i < 8; i++) log('error', 'worker', 'failed', { code: 'fixed_code', payload: 'SECRET_SYNTHETIC' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(waits.length, 4);
  waits.forEach(resolve => resolve());
  await reporter.close();
  assert.equal(output.filter(event => event.code === 'report_failed').length, 4);
  assert(!JSON.stringify(output).includes('SECRET_SYNTHETIC'));
});
test('structured retry logs retain only bounded safe execution facts', () => {
  const output = [];
  const log = createLogger({ write: value => output.push(JSON.parse(value)) });
  log('warning', 'forward_execution', 'waiting', {
    code: 'CODEX_THREAD_BUSY', rpcMethod: 'thread/resume', stage: 'pre_admission',
    runId: '12345678-1234-1234-1234-123456789abc', attempt: 1, maxAttempts: 3,
    nextRetryAt: 1_789_331_035_417, providerMessage: 'SYNTHETIC_SECRET',
  });
  assert.deepEqual(output[0], {
    timestamp: output[0].timestamp, level: 'warning', module: 'bridge', component: 'service',
    operation: 'forward_execution', status: 'waiting', code: 'CODEX_THREAD_BUSY',
    rpc_method: 'thread/resume', stage: 'pre_admission', run_id: '12345678-1234-1234-1234-123456789abc',
    attempt: 1, max_attempts: 3, next_retry_at: 1_789_331_035_417,
  });
  assert.equal(JSON.stringify(output).includes('SYNTHETIC_SECRET'), false);
});
test('SDK request wrapper enforces time, redirects and size without retries', async () => {
  let calls = 0;
  const client = boundedFeishuHttp({ request: async options => { calls++; assert.equal(options.timeout, 10000); assert.equal(options.maxRedirects, 0); return {}; } });
  await client.request({ timeout: 0, maxRedirects: 5 });
  assert.equal(calls, 1);
});
test('service rejects configured and inherited Codex homes that differ', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-service-home-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeConfig = validateConfig({
    ...config,
    codex: { bin: process.execPath, cwd: directory, sharedHome: join(directory, 'configured'), envNames: [] },
  });
  await assert.rejects(startService({
    config: runtimeConfig,
    configPath: join(directory, 'config.json'),
    env: {
      HOME: directory,
      CODEX_HOME: join(directory, 'inherited'),
      TEST_TOKEN: 'synthetic-token-for-service-only',
      TEST_APP: 'synthetic',
      TEST_SECRET: 'synthetic',
    },
  }), { code: 'CODEX_HOME_CONFLICT' });
});
test('explicit service env does not fall back to ambient CODEX_HOME', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-service-ambient-home-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.CODEX_HOME;
  const hadPrevious = Object.hasOwn(process.env, 'CODEX_HOME');
  process.env.CODEX_HOME = '/synthetic/ambient-codex-home';
  const reachedPool = new Error('synthetic_pool_boundary');
  try {
    const runtimeConfig = validateConfig({
      ...config,
      codex: { bin: process.execPath, cwd: directory, sharedHome: join(directory, '.codex'), envNames: [] },
    });
    await assert.rejects(startService({
      config: runtimeConfig,
      configPath: join(directory, 'config.json'),
      env: {
        HOME: directory,
        TEST_TOKEN: 'synthetic-token-for-service-only',
        TEST_APP: 'synthetic',
        TEST_SECRET: 'synthetic',
      },
      dependencies: { pool() { throw reachedPool; } },
    }), error => error === reachedPool);
  } finally {
    if (hadPrevious) process.env.CODEX_HOME = previous;
    else delete process.env.CODEX_HOME;
  }
});
test('failed async warning sinks never become unhandled rejections', async () => {
  const reporter = createErrorReporter({ url: 'http://synthetic.invalid', token: 'synthetic', warn: async () => { throw new Error('synthetic warning failure'); }, fetchImpl: async () => { throw new Error('synthetic HTTP failure'); } });
  for (let i = 0; i < 6; i++) reporter.report({ code: 'fixture' });
  await reporter.close();
  await new Promise(resolve => setImmediate(resolve));
});
test('startup cancellation closes an idle executor while Feishu start is pending', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-service-start-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, 'fixture.mjs');
  await writeFile(fixture, "import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});");
  let executorClosed = false, storeClosed = false, socketStopped = false, enter;
  const entered = new Promise(resolve => { enter = resolve; });
  const controller = new AbortController();
  const runtimeConfig = validateConfig({ ...config, codex: { bin: process.execPath, cwd: directory, envNames: [] } });
  const started = startService({ config: runtimeConfig, configPath: join(directory, 'config.json'), env: { TEST_TOKEN: 'synthetic-token-for-service-only', TEST_APP: 'synthetic', TEST_SECRET: 'synthetic' }, signal: controller.signal, log: async () => { throw new Error('synthetic log'); }, dependencies: {
    pool: () => ({}), store: async () => ({ close: async () => { storeClosed = true; } }),
    executor: () => ({status:()=>({closing:false,restartPending:null}),close:async()=>{executorClosed=true;}}),
    sdk: { Client: class {}, WSClient: class {}, defaultHttpInstance: {} }, chat: () => ({ downloadResource: async () => { throw new Error('unexpected download'); }, uploadImage() {}, uploadFile() {}, sendMessage() {} }),
    media: async () => ({ prepare() {}, release() {} }),
    typing: () => ({ start() {}, cleanup() {} }),
    feishu: () => ({ start: () => { enter(); return new Promise(() => {}); }, stop: () => { socketStopped = true; } }),
  } });
  const rejected = assert.rejects(started, { code: 'startup_cancelled' });
  await entered;
  controller.abort();
  await rejected;
  assert(storeClosed); assert(socketStopped); assert(executorClosed);
});

test('memory restart callback runs only after the service has completed ordered shutdown', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-service-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = []; let requestRestart;
  const runtimeConfig = validateConfig({ ...config, listen: { host: '127.0.0.1', port: 0 }, codex: { bin: process.execPath, cwd: directory, envNames: [] }, feishu: { ...config.feishu, catchup: false } });
  const worker = { start() {}, beginStop() { events.push('forward-stop-ingress'); }, async stop() { events.push('worker-stop'); }, status: () => ({ running: true }) };
  const service = await startService({
    config: runtimeConfig, configPath: join(directory, 'config.json'),
    env: { TEST_TOKEN: 'synthetic-token-for-service-only', TEST_APP: 'synthetic', TEST_SECRET: 'synthetic' },
    onRestartRequired: async reason => { events.push(`exit:${reason}`); },
    dependencies: {
      pool: () => ({}), store: async () => ({ async assertCurrent() {}, async close() { events.push('store-close'); } }),
      sessions: () => ({}), jobs: () => ({}), inbound: () => ({}),
      executor: input => { requestRestart = input.onRestartRequired; return { status: () => ({ closing: false, restartPending: null, fault: null }), async close() { events.push('executor-close'); } }; },
      feedback: () => ({ handleCardAction() {} }), replies: () => ({}), communication: () => worker, forward: () => worker,
      media: async () => ({}), outbound: async () => ({}), chat: () => ({}),
      sdk: { Client: class {}, WSClient: class {}, defaultHttpInstance: {} },
      feishu: () => ({ async start() {}, async stop() { events.push('feishu-stop'); }, status: () => ({ connected: true }) }),
    },
  });
  await requestRestart('rss threshold');
  assert.equal(events.at(-1), 'exit:rss threshold');
  assert.ok(events.indexOf('executor-close') < events.indexOf('exit:rss threshold'));
  assert.ok(events.indexOf('store-close') < events.indexOf('exit:rss threshold'));
  await service.close();
});

test('service close drains an accepted busy fork callback before closing its dependencies', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-service-fork-close-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = []; let callback, enterBegin, releaseBegin; let executorClosed = false, storeClosed = false;
  const entered = new Promise(resolve => { enterBegin = resolve; });
  const beginGate = new Promise(resolve => { releaseBegin = resolve; });
  const runtimeConfig = validateConfig({ ...config, listen: { host: '127.0.0.1', port: 0 },
    codex: { bin: process.execPath, cwd: directory, envNames: [] }, feishu: { ...config.feishu, catchup: false } });
  const job = { id: '00000000-0000-0000-0000-000000000001', callerId: 'live', chatId: 'chat', chatType: 'p2p',
    messageId: 'message', senderOpenId: 'human', status: 'failed', last_error: 'CODEX_THREAD_BUSY',
    result: { busyFork: { sourceThreadId: 'source', bindingOpenId: 'human', chatId: 'chat' },
      executionCard: { messageId: 'card', status: 'failed', entries: [], forkSourceThreadId: 'source' } } };
  const worker = { start() {}, beginStop() {}, async stop() {}, status: () => ({ running: true }) };
  const service = await startService({ config: runtimeConfig, configPath: join(directory, 'config.json'),
    env: { TEST_TOKEN: 'synthetic-token-for-service-only', TEST_APP: 'synthetic', TEST_SECRET: 'synthetic' }, dependencies: {
      pool: () => ({}), store: async () => ({ async assertCurrent() {}, async close() { storeClosed = true; events.push('store-close'); } }),
      sessions: () => ({}), inbound: () => ({}), jobs: () => ({
        async getRun() { events.push('get-run'); return job; },
        async beginFork(input) { enterBegin(); await beginGate; events.push('begin-return'); return { outcome: 'new', fork: { operationId: input.operationId, status: 'pending' } }; },
        async finishFork(input) { assert.equal(storeClosed, false); events.push('finish-fork'); return { outcome: 'succeeded', fork: { status: 'succeeded', targetThreadId: input.targetThreadId } }; },
      }),
      executor: () => ({ status: () => ({}), async close() { executorClosed = true; events.push('executor-close'); },
        async forkBinding(input) { assert.equal(executorClosed, false); events.push('native-fork'); return { targetThreadId: 'target', committed: await input.onForked({ targetThreadId: 'target' }) }; } }),
      replies: () => ({}), communication: () => worker, forward: () => worker, media: async () => ({}), outbound: async () => ({}), chat: () => ({}), typing: () => ({}),
      sdk: { Client: class { constructor() { this.im = { v1: { message: { async patch() { events.push('card-patch'); return { code: 0 }; } } } }; } }, WSClient: class {}, defaultHttpInstance: {} },
      feishu: ({ onCardAction }) => { callback = onCardAction; return { async start() {}, async stop() { events.push('feishu-stop'); }, status: () => ({ connected: true }) }; },
    } });
  const payload = { action: { value: { action: 'fork_busy_session', jobId: job.id, expectedSourceThreadId: 'source' } },
    operator: { open_id: 'human' }, context: { open_chat_id: 'chat', open_message_id: 'card' } };
  const cardReply = callback(payload); await entered;
  const closing = service.close(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(executorClosed, false); assert.equal(storeClosed, false);
  releaseBegin(); await cardReply; await closing;
  assert(events.indexOf('finish-fork') < events.indexOf('executor-close'));
  assert(events.indexOf('card-patch') < events.indexOf('store-close'));
  const rejected = await callback(payload);
  assert.match(rejected.toast.content, /服务正在关闭/);
  assert.equal(events.filter(event => event === 'get-run').length, 1);
});


test('card text file is opt-in and scoped to a workspace relative path', () => {
  assert.equal(validateConfig(config).feishu.cardTextFile, undefined);
  const withPath = path => ({ ...config, feishu: { ...config.feishu, cardTextFile: path } });
  assert.equal(validateConfig(withPath('.agent-chat-bridge/bot3-card-text.json')).feishu.cardTextFile, '.agent-chat-bridge/bot3-card-text.json');
  for (const path of ['', null, 1, '/tmp/card.json', '../card.json', 'a/../card.json', 'a\\b', 'a\nfile', './card.json']) {
    assert.throws(() => validateConfig(withPath(path)), /invalid_card_text_path/);
  }
});
