import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';
import { createApi } from '../src/core/api.mjs';
import { createLogger, createErrorReporter } from '../src/logger.mjs';
import { boundedFeishuHttp } from '../src/service.mjs';
import { Readable } from 'node:stream';
import { createRuntime } from '../src/core/runtime.mjs';

const config = {
  schemaVersion: 1, storage: Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `TEST_${key.toUpperCase()}`])),
  codex: { bin: './codex', cwd: './workspace', envNames: ['PATH'] },
  feishu: { connectionId: 'test', appIdEnv: 'TEST_APP', appSecretEnv: 'TEST_SECRET', botOpenId: 'bot' },
  routing: { version: '1', privateUserIds: ['human'], groups: [{ conversationId: 'chat', userIds: ['human'], trigger: 'mention', passiveContext: true }] },
  auth: { clients: [{ id: 'tester', tokenEnv: 'TEST_TOKEN', conversationIds: ['chat'], admin: false }] },
};
test('runtime configuration is explicit and rejects scope/secret overrides', () => {
  assert.equal(validateConfig(config).feishu.connectionId, 'test');
  for (const invalid of [
    { ...config, codex: { ...config.codex, approvalPolicy: 'never' } },
    { ...config, auth: { tokenEnv: 'TEST_TOKEN' } },
    { ...config, feishu: { ...config.feishu, appSecret: 'synthetic' } },
    { ...config, hooks: [{ id: 'h', url: 'https://user:synthetic@example.invalid', tokenEnv: 'TEST_HOOK', conversationIds: [] }] },
    { ...config, errorReporting: { url: 'file:///tmp/report', tokenEnv: 'TEST_REPORT' } },
  ]) assert.throws(() => validateConfig(invalid));
});
test('API tokens must be distinct and sufficiently long', () => {
  const validated = validateConfig(config);
  assert.throws(() => createApi({ config: validated, store: {}, chat: {}, tokens: { tester: 'short' } }), { code: 'invalid_auth_environment' });
});
test('group defaults allow all human members; explicit member filter does not limit hooks', async () => {
  const observed = [];
  const groupConfig = validateConfig({ ...config, routing: { ...config.routing, groups: [{ conversationId: 'chat', trigger: 'all', passiveContext: true }] }, hooks: [{ id: 'h', url: 'http://example.invalid/hook', tokenEnv: 'TEST_HOOK', conversationIds: ['chat'] }] });
  const runtime = createRuntime({ config: groupConfig, store: { acceptInbound: async value => { observed.push(value); return {}; } }, codex: {}, chat: {} });
  const event = { connectionId: 'test', eventKey: 'synthetic', type: 'message.received', conversationId: 'chat', conversationType: 'group', messageId: 'm', actor: { type: 'user', openId: 'not-enumerated' }, message: { kind: 'text', parsedContent: { text: 'synthetic' } } };
  await runtime.ingest(event);
  assert(observed[0].agentJob); assert.equal(observed[0].hooks.length, 1);
  const restricted = createRuntime({ config: { ...groupConfig, routing: { ...groupConfig.routing, groups: [{ ...groupConfig.routing.groups[0], userIds: [] }] } }, store: { acceptInbound: async value => { observed.push(value); return {}; } }, codex: {}, chat: {} });
  await restricted.ingest(event);
  assert.equal(observed[1].agentJob, undefined); assert.equal(observed[1].hooks.length, 1);
});
test('run API accepts existing long cron prompts and caps UTF-8 bytes including JSON escape allowance', async () => {
  const accepted = [];
  const token = 'synthetic-long-token-for-local-test';
  const api = createApi({ config: validateConfig(config), tokens: { tester: token }, store: { enqueueJob: async value => { accepted.push(value); return { id: 'run' }; } }, chat: {} });
  const request = text => Object.assign(Readable.from([Buffer.from(JSON.stringify({ conversationId: 'chat', idempotencyKey: 'cron', text }))]), { method: 'POST', url: '/v1/runs', headers: { authorization: `Bearer ${token}` } });
  assert.equal((await api(request('中'.repeat(10000)))).status, 202);
  assert.equal((await api(request('\u0001'.repeat(64 * 1024)))).status, 202);
  await assert.rejects(api(request('中'.repeat(22000))), { status: 413, code: 'text_too_large' });
  assert.equal(accepted.length, 2);
});
test('chat effect registration covers media/reaction and checks reply membership', async () => {
  const effects = [];
  const token = 'synthetic-long-token-for-local-test';
  const api = createApi({ config: validateConfig(config), tokens: { tester: token }, store: { recordOutbox: async effect => { effects.push(effect); return { id: 'effect' }; } }, chat: { getMessage: async ({ messageId }) => ({ items: [{ message_id: messageId, chat_id: messageId === 'foreign' ? 'elsewhere' : 'chat' }] }) } });
  function request(value) { const request = Readable.from([Buffer.from(JSON.stringify(value))]); request.url = '/v1/deliveries'; request.method = 'POST'; request.headers = { authorization: `Bearer ${token}` }; return request; }
  for (const effect of [
    { kind: 'create', messageKind: 'image', content: { image_key: 'synthetic' } },
    { kind: 'reply', messageId: 'owned', messageKind: 'file', content: { file_key: 'synthetic' } },
    { kind: 'create', messageKind: 'post', content: { en_us: { title: 'synthetic', content: [] } } },
    { kind: 'create', messageKind: 'interactive', content: { elements: [] } },
    { kind: 'reaction', messageId: 'owned', emojiType: 'OK' },
    { kind: 'upload', mediaType: 'file', base64: Buffer.from('synthetic').toString('base64'), fileName: 'fixture.txt' },
  ]) assert.equal((await api(request({ ...effect, conversationId: 'chat', idempotencyKey: `effect-${effects.length}` }))).status, 202);
  assert.equal(effects.length, 6);
  await assert.rejects(api(request({ kind: 'reply', conversationId: 'chat', messageId: 'foreign', idempotencyKey: 'rejected', content: 'synthetic' })), { status: 403 });
  assert.equal(effects.length, 6);
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
test('SDK request wrapper enforces time, redirects and size without retries', async () => {
  let calls = 0;
  const client = boundedFeishuHttp({ request: async options => { calls++; assert.equal(options.timeout, 10000); assert.equal(options.maxRedirects, 0); return {}; } });
  await client.request({ timeout: 0, maxRedirects: 5 });
  assert.equal(calls, 1);
});
