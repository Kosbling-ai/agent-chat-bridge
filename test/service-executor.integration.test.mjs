import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateConfig } from '../src/config.mjs';
import { startService } from '../src/service.mjs';
import { createCodexExecutor } from '../src/agents/codex/executor.mjs';
import { createForwardRuntime } from '../src/core/forward-runtime.mjs';
import { createLogger } from '../src/logger.mjs';

function sessionStore() {
  const bindings = new Map();
  const events = [];
  const key = value => `${value.feishuOpenId}:${value.chatId}`;
  return {
    async loadBinding(identity) { return bindings.get(key(identity)) || null; },
    async saveCodexBinding(binding) { bindings.set(key(binding), { ...binding, created: false }); },
    async touchCodexBinding(binding) { bindings.set(key(binding), { ...binding, created: false }); },
    async saveCodexRealtimeEvent(binding, event) { events.push({ binding, ...event }); },
    async findAcceptedMessageEvent() { return null; },
    async loadSteerEvents() { return []; },
    async readPublicProgress() { return []; },
  };
}

test('service launches the real executor child with mapped config and closes an active turn', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-service-executor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = join(directory, 'codex-fixture.mjs');
  const observed = join(directory, 'observed.json');
  await writeFile(child, `#!/usr/bin/env node
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);
 if(message.method==='initialize') { writeFileSync(process.env.OBSERVED_FILE,JSON.stringify(process.env)); send({id:message.id,result:{}}); }
 else if(message.method==='thread/start') send({id:message.id,result:{thread:{id:'thread-1'}}});
 else if(message.method==='thread/resume'&&message.params.threadId==='log-reject') send({id:message.id,error:{code:-32000,message:'active writer SYNTHETIC_SECRET'}});
 else if(message.method==='turn/start') { writeFileSync(process.env.OBSERVED_FILE+'.turn','started'); send({id:message.id,result:{turn:{id:'turn-1'}}}); }
 else if(message.method==='thread/read') send({id:message.id,result:{thread:{id:'thread-1',turns:[{id:'turn-1',status:'inProgress',items:[]}]}}});
 else if(message.method==='turn/steer') { writeFileSync(process.env.OBSERVED_FILE+'.steer','steered'); send({id:message.id,result:{}}); }
 else send({id:message.id,result:{}});
});
`);
  await chmod(child, 0o755);

  const raw = {
    schemaVersion: 1,
    listen: { host: '127.0.0.1', port: 0 },
    storage: { hostEnv: 'DB_HOST', portEnv: 'DB_PORT', userEnv: 'DB_USER', passwordEnv: 'DB_PASSWORD', databaseEnv: 'DB_DATABASE' },
    codex: { bin: child, cwd: directory, envNames: ['PATH', 'OBSERVED_FILE'], rulesFiles: ['AGENTS.md'], rolloverOnRulesUpdate: true },
    feishu: { connectionId: 'fixture', appIdEnv: 'APP_ID', appSecretEnv: 'APP_SECRET', botOpenId: 'bot', catchup: false },
    routing: { version: '1', privateUserIds: [], groups: [{ conversationId: 'chat', trigger: 'mention', passiveContext: true, capabilities: ['bridge'] }] },
    auth: { clients: [{ id: 'caller', tokenEnv: 'API_TOKEN', conversationIds: ['api-chat'], admin: false }] },
    hooks: [],
  };
  const env = {
    DB_HOST: 'unused', DB_PORT: '3306', DB_USER: 'unused', DB_PASSWORD: 'unused', DB_DATABASE: 'unused',
    APP_ID: 'app', APP_SECRET: 'secret', API_TOKEN: 'synthetic-token-at-least-24-characters',
    PATH: process.env.PATH, HOME: directory, OBSERVED_FILE: observed, UNSELECTED_SECRET: 'must-not-enter-child',
  };
  let executorConfig;
  let executorInstance;
  let forwardConfig;
  let sessions;
  const logEvents = [];
  const forwardJobs = [
    { id: 'run-1', callerId: 'live', chatId: 'chat', chatType: 'group', messageId: 'message-1', senderOpenId: 'human', senderName: 'Human', deliveryMode: 'caller', executionNamespace: null, prompt: 'first', attempts: 1, result: {}, createdAt: 1, leaseOwner: '' },
    { id: 'run-2', callerId: 'live', chatId: 'chat', chatType: 'group', messageId: 'message-2', senderOpenId: 'human', senderName: 'Human', deliveryMode: 'caller', executionNamespace: null, prompt: 'second', attempts: 1, result: {}, createdAt: 2, leaseOwner: '' },
  ];
  let claimed = false;
  const jobStore = {
    async claimReplyPending() { return []; },
    async claim({ owner }) { if (claimed) return []; claimed = true; return forwardJobs.map(job => Object.assign(job, { status: 'running', leaseOwner: owner })); },
    async renew() { return { renewed: true }; },
    async patchExecution({ id, execution }) { const job = forwardJobs.find(item => item.id === id); job.result = { ...job.result, execution }; },
    async markReplyPending({ id, result }) { const job = forwardJobs.find(item => item.id === id); Object.assign(job, { status: 'reply_pending', result }); },
    async markFinished({ id, status, result }) { const job = forwardJobs.find(item => item.id === id); Object.assign(job, { status, result }); },
    async markFinishedWithoutReply({ id, status, result }) { const job = forwardJobs.find(item => item.id === id); Object.assign(job, { status, result }); },
    async markRetry({ id, held }) { const job = forwardJobs.find(item => item.id === id); job.status = held ? 'held' : 'pending'; },
    async getRun() { return null; }, async readEvents() { return []; },
  };
  const inertWorker = { start() {}, beginStop() {}, async stop() {}, status: () => ({ running: true }) };
  const service = await startService({ config: validateConfig(raw), configPath: join(directory, 'bridge.json'), env,
    log: createLogger({ write(value) { logEvents.push(JSON.parse(value)); } }), dependencies: {
    pool: () => ({ async query() {}, async end() {} }),
    store: async () => ({ async assertCurrent() {}, async close() {} }),
    sessions: () => (sessions = sessionStore()),
    jobs: () => jobStore, inbound: () => ({}), feedback: () => ({}), replies: () => ({}),
    communication: () => inertWorker,
    executor: input => {
      executorConfig = input.config;
      executorInstance = createCodexExecutor(input);
      return executorInstance;
    },
    forward: input => { forwardConfig = input.config; return createForwardRuntime(input); },
    media: async () => ({}), outbound: async () => ({}), chat: () => ({}),
    sdk: { Client: class {}, WSClient: class {}, defaultHttpInstance: {} },
    feishu: () => ({ async start() {}, async stop() {}, status: () => ({ connected: true }) }),
  } });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(`${observed}.steer`); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  await access(`${observed}.steer`);
  const childEnv = JSON.parse(await readFile(observed, 'utf8'));
  assert.equal(childEnv.UNSELECTED_SECRET, undefined);
  assert.equal(childEnv.HOME, undefined);
  assert.equal(childEnv.CODEX_HOME, join(directory, '.codex'));
  assert.deepEqual(executorConfig.rulesPaths, ['AGENTS.md']);
  assert.equal(executorConfig.idleCloseMs, 60_000);
  assert.deepEqual([...executorConfig.allowedGroupChatIds].sort(), ['api-chat', 'chat']);
  assert.equal(forwardConfig.retryDelayMs, 60_000);
  assert.equal(forwardConfig.maxAttempts, 3);
  await sessions.saveCodexBinding({feishuOpenId:'system:log',chatId:'log-chat',chatType:'group',codexSessionId:'log-reject',threadName:'log',created:false});
  await assert.rejects(executorInstance.execute({bindingOpenId:'system:log',chatId:'log-chat',chatType:'group',messageId:'log-message',prompt:'work',busyPolicy:'reject'}), {code:'CODEX_THREAD_BUSY'});
  const rpcLog = logEvents.find(event => event.operation === 'rpc_request');
  assert.deepEqual({code:rpcLog.code,rpcMethod:rpcLog.rpc_method}, {code:'CODEX_THREAD_BUSY',rpcMethod:'thread/resume'});
  assert.equal(JSON.stringify(logEvents).includes('SYNTHETIC_SECRET'), false);
  assert.equal(forwardJobs[1].status, 'deferred');
  await service.close();
  assert.equal(forwardJobs[0].status, 'running');
});
