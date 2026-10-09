import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { createLogger } from '../src/logger.mjs';
import { createCardAuthorize, startService } from '../src/service.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';
import { admissionReplyUuid, createPrivateAdmission } from '../src/core/private-admission.mjs';

const URL_ = 'http://127.0.0.1:18820/api/internal/feishu-admission';
const ADMISSION = { url: URL_, tokenEnv: 'TEST_ADMISSION_TOKEN', denyText: '请先在看板注册', unavailableText: '暂时无法核对' };
const base = {
  schemaVersion: 1, storage: Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(k => [`${k}Env`, `TEST_${k.toUpperCase()}`])),
  codex: { bin: './codex', cwd: './workspace', envNames: [] },
  feishu: { connectionId: 'kosbling-auth', appIdEnv: 'TEST_APP', appSecretEnv: 'TEST_SECRET', botOpenId: 'ou_bot' },
  routing: { version: '1', privateUserIds: ['ou_listed'], privateAdmission: ADMISSION,
    groups: [{ conversationId: 'oc_group', trigger: 'mention', passiveContext: true }] },
  hooks: [],
};
const withAdmission = (privateAdmission, routing = {}) => ({ ...base, routing: { ...base.routing, ...routing, privateAdmission } });
const respond = (status, body) => new Response(status === 204 ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ALLOW = () => respond(200, { allowed: true, reason: 'active', colleagueId: 'colleague-1' });
const DENY = () => respond(200, { allowed: false, reason: 'not_enabled', colleagueId: null });
const flush = () => new Promise(resolve => setTimeout(resolve, 5));
const TOKEN = 'synthetic-admission-token';

let sequence = 0;
function privateEvent({ openId = 'ou_sender_1', unionId = 'on_sender_1', source = 'live', messageId, ...overrides } = {}) {
  const id = messageId ?? `om_${++sequence}`;
  return { connectionId: 'kosbling-auth', source, eventKey: `${source}:${id}`, type: 'message.received', conversationId: `oc_p2p_${openId}`,
    conversationType: 'p2p', messageId: id, occurredAt: Date.now(), actor: { type: 'user', openId, unionId, userId: '', name: 'Human' },
    message: { kind: 'text', content: '{"text":"private message body"}', mentions: [] }, ...overrides };
}

function harness({ raw = base, reply = ALLOW, replyMessage } = {}) {
  let time = 1_000_000;
  const calls = []; const accepted = []; const forwarded = []; const replies = []; const logs = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return reply(calls.length, init); };
  const config = validateConfig(raw);
  const log = (...entry) => logs.push(entry);
  const admission = createPrivateAdmission({ settings: config.routing.privateAdmission, connectionId: config.feishu.connectionId,
    token: TOKEN, fetchImpl, log, now: () => time });
  const chat = { replyMessage: replyMessage ?? (async input => { replies.push(input); return { message_id: 'om_reply' }; }) };
  const store = { acceptInbound: async input => { accepted.push(input); return { duplicate: false }; },
    recordOutbox: async () => { throw new Error('admission replies must not use the outbox'); } };
  const runtime = createCommunicationRuntime({ config, store, chat, privateAdmission: admission, now: () => time, log,
    forward: { handleMessage: async input => { forwarded.push(input); return { accepted: true }; } } });
  return { runtime, admission, calls, accepted, forwarded, replies, logs, advance: ms => { time += ms; }, now: () => time };
}
const admissionLogs = logs => logs.filter(([, operation]) => operation === 'private_admission');

// Configuration

test('private admission config fills defaults and leaves unconfigured routing unchanged', () => {
  assert.deepEqual(validateConfig(withAdmission({ url: URL_, tokenEnv: 'TEST_ADMISSION_TOKEN', denyText: '  拒绝  ' })).routing.privateAdmission,
    { url: URL_, tokenEnv: 'TEST_ADMISSION_TOKEN', timeoutMs: 1000, allowCacheMs: 300000, denyCacheMs: 60000, denyText: '拒绝', unavailableText: '拒绝' });
  assert.deepEqual(validateConfig(withAdmission({ ...ADMISSION, timeoutMs: 5000, allowCacheMs: 0, denyCacheMs: 86_400_000 })).routing.privateAdmission,
    { url: URL_, tokenEnv: 'TEST_ADMISSION_TOKEN', timeoutMs: 5000, allowCacheMs: 0, denyCacheMs: 86_400_000, denyText: '请先在看板注册', unavailableText: '暂时无法核对' });
  assert.equal(validateConfig(withAdmission({ ...ADMISSION, timeoutMs: 100 })).routing.privateAdmission.timeoutMs, 100);
  assert.equal(validateConfig(withAdmission(ADMISSION, { allowAllPrivateUsers: false })).routing.allowAllPrivateUsers, false);
  const { privateAdmission, ...unconfigured } = base.routing;
  assert.ok(privateAdmission);
  assert.equal(Object.hasOwn(validateConfig({ ...base, routing: unconfigured }).routing, 'privateAdmission'), false);
});

test('private admission config requires url, tokenEnv and denyText', () => {
  const rejects = (value, code) => assert.throws(() => validateConfig(withAdmission(value)), { code }, JSON.stringify(value));
  const { url, tokenEnv, denyText, ...rest } = ADMISSION;
  rejects({ tokenEnv, denyText, ...rest }, 'invalid_private_admission_url');
  for (const bad of ['', 'not a url', 'ftp://127.0.0.1/x', 'file:///tmp/x', 'http://user:pass@127.0.0.1/x', 'http://127.0.0.1/x#frag', 5, null])
    rejects({ ...ADMISSION, url: bad }, 'invalid_private_admission_url');
  rejects({ url, denyText, ...rest }, 'invalid_environment_reference');
  for (const bad of ['lower_case', '', null, 7]) rejects({ ...ADMISSION, tokenEnv: bad }, 'invalid_environment_reference');
  rejects({ url, tokenEnv, ...rest }, 'invalid_private_admission_text');
  for (const bad of ['', '   ', 'x'.repeat(2001), null, 3]) {
    rejects({ ...ADMISSION, denyText: bad }, 'invalid_private_admission_text');
    rejects({ ...ADMISSION, unavailableText: bad }, 'invalid_private_admission_text');
  }
  for (const bad of [99, 5001, 1.5, null, '1000']) rejects({ ...ADMISSION, timeoutMs: bad }, 'invalid_private_admission_timeout');
  for (const bad of [-1, 86_400_001, 1.5, null, '60000']) {
    rejects({ ...ADMISSION, allowCacheMs: bad }, 'invalid_private_admission_cache');
    rejects({ ...ADMISSION, denyCacheMs: bad }, 'invalid_private_admission_cache');
  }
});

test('private admission conflicts with allowAllPrivateUsers', () => {
  assert.throws(() => validateConfig(withAdmission(ADMISSION, { allowAllPrivateUsers: true })), { code: 'private_admission_conflicts_with_allow_all' });
});

test('private admission rejects unknown keys and non-object values', () => {
  for (const value of [{ ...ADMISSION, failOpen: true }, { ...ADMISSION, cacheTtlMs: 1 }, null, [], 'on'])
    assert.throws(() => validateConfig(withAdmission(value)), { code: 'invalid_private_admission_fields' }, JSON.stringify(value));
  assert.throws(() => validateConfig({ ...base, routing: { ...base.routing, privateAdmissionX: {} } }), { code: 'invalid_routing_fields' });
});

// Request shape and service assembly

test('admission request matches the contract field by field', async () => {
  const { runtime, calls } = harness();
  await runtime.ingest(privateEvent({ openId: 'ou_shape', unionId: 'on_shape', actor: { type: 'user', openId: 'ou_shape', unionId: 'on_shape', userId: 'u_shape', name: 'Human' } }));
  assert.equal(calls.length, 1);
  const [{ url, init, body }] = calls;
  assert.equal(url, URL_);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(init.headers, { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(body, { connectionId: 'kosbling-auth', chatId: 'oc_p2p_ou_shape', sender: { openId: 'ou_shape', unionId: 'on_shape', userId: 'u_shape' } });
  assert.deepEqual(Object.keys(body), ['connectionId', 'chatId', 'sender']);
  assert.deepEqual(Object.keys(body.sender), ['openId', 'unionId', 'userId']);
});

test('service reads the admission token from its environment reference', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-admission-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = validateConfig({ ...base, listen: { host: '127.0.0.1', port: 0 }, codex: { bin: process.execPath, cwd: directory, envNames: [] } });
  const env = { TEST_APP: 'synthetic-app', TEST_SECRET: 'synthetic-secret' };
  const unreachable = { pool() { throw new Error('pool must not be reached'); } };
  for (const value of [undefined, ''])
    await assert.rejects(startService({ config, configPath: join(directory, 'config.json'), env: { ...env, TEST_ADMISSION_TOKEN: value }, dependencies: unreachable }),
      { code: 'required_environment_missing' });
  let options;
  await assert.rejects(startService({ config, configPath: join(directory, 'config.json'), env: { ...env, TEST_ADMISSION_TOKEN: 'token-from-env' },
    dependencies: { privateAdmission: value => { options = value; return createPrivateAdmission(value); }, pool() { throw new Error('stop_after_admission'); } } }),
  { message: 'stop_after_admission' });
  assert.equal(options.token, 'token-from-env');
  assert.equal(options.connectionId, 'kosbling-auth');
  assert.equal(options.settings, config.routing.privateAdmission);
  const requests = [];
  const admission = createPrivateAdmission({ ...options, fetchImpl: async (_url, init) => { requests.push(init); return ALLOW(); } });
  await admission.check({ openId: 'ou_env', chatId: 'oc_env' });
  assert.equal(requests[0].headers.authorization, 'Bearer token-from-env');
  const { privateAdmission, ...routing } = base.routing;
  let created = false;
  await assert.rejects(startService({ config: validateConfig({ ...base, routing, codex: { bin: process.execPath, cwd: directory, envNames: [] } }),
    configPath: join(directory, 'config.json'), env, dependencies: { ...unreachable, privateAdmission: () => { created = true; } } }), { message: 'pool must not be reached' });
  assert.equal(created, false, 'an unconfigured bot neither needs the token nor creates the callback');
});

test('configured admission cannot start without the callback module', () => {
  assert.throws(() => createCommunicationRuntime({ config: validateConfig(base), store: {}, chat: {} }), { message: 'private_admission_unavailable' });
});

// Decision matrix

test('allowed sender is stored and starts the Agent thread', async () => {
  const { runtime, calls, accepted, forwarded, replies, logs } = harness();
  await runtime.ingest(privateEvent({ messageId: 'om_allowed' }));
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].messageId, 'om_allowed');
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].message.messageId, 'om_allowed');
  assert.deepEqual(forwarded[0].actor, { openId: 'ou_sender_1', unionId: 'on_sender_1', name: 'Human' });
  assert.equal(replies.length, 0);
  assert.equal(admissionLogs(logs).length, 1);
  const [level, , status, fields] = admissionLogs(logs)[0];
  assert.equal(level, 'info'); assert.equal(status, 'allow');
  assert.deepEqual({ ...fields, durationMs: undefined }, { decision: 'allow', reason: 'active', cached: false, openId: 'ou_sender_1', durationMs: undefined });
});

test('denied sender is not stored, gets the deny text once and is cached for denyCacheMs', async () => {
  const { runtime, calls, accepted, forwarded, replies, logs, advance } = harness({ reply: DENY });
  const first = await runtime.ingest(privateEvent({ messageId: 'om_denied_1' }));
  await flush();
  assert.deepEqual(first, { admitted: false, decision: 'deny' });
  assert.equal(calls.length, 1);
  assert.equal(accepted.length, 0);
  assert.equal(forwarded.length, 0);
  assert.deepEqual(replies, [{ messageId: 'om_denied_1', kind: 'text', content: { text: '请先在看板注册' }, uuid: admissionReplyUuid('om_denied_1') }]);
  assert.ok(replies[0].uuid.length <= 50);
  advance(59_999);
  await runtime.ingest(privateEvent({ messageId: 'om_denied_2' }));
  await flush();
  assert.equal(calls.length, 1, 'the cached denial does not call the endpoint');
  assert.equal(replies.length, 1, 'the deny text is sent once per cache period');
  assert.equal(accepted.length, 0);
  assert.deepEqual(admissionLogs(logs).map(([, , status, { reason, cached }]) => [status, reason, cached]),
    [['deny', 'not_enabled', false], ['deny', 'not_enabled', true]]);
  advance(1);
  await runtime.ingest(privateEvent({ messageId: 'om_denied_3' }));
  await flush();
  assert.equal(calls.length, 2, 'the denial expires after denyCacheMs');
  assert.equal(replies.length, 2);
  assert.equal(replies[1].messageId, 'om_denied_3');
  assert.equal(accepted.length + forwarded.length, 0);
});

test('unavailable endpoint fails closed with the unavailable text and is cached for denyCacheMs', async t => {
  const cases = [
    ['http_status', () => respond(503, { error: 'admission disabled' })],
    ['http_status', () => respond(204, '')],
    ['invalid_response', () => respond(200, 'not json')],
    ['invalid_response', () => respond(200, { allowed: 'yes' })],
    ['invalid_response', () => respond(200, [true])],
    ['invalid_response', () => respond(200, { allowed: true, padding: 'x'.repeat(5000) })],
    ['network_error', () => { throw new TypeError('fetch failed'); }],
    ['timeout', (_call, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))],
  ];
  for (const [reason, reply] of cases) {
    await t.test(reason, async () => {
      const { runtime, calls, accepted, forwarded, replies, logs, advance } = harness({ raw: withAdmission({ ...ADMISSION, timeoutMs: 100 }), reply });
      assert.deepEqual(await runtime.ingest(privateEvent({ messageId: 'om_unavailable_1' })), { admitted: false, decision: 'unavailable' });
      await flush();
      assert.equal(accepted.length + forwarded.length, 0);
      assert.deepEqual(replies.map(item => item.content.text), ['暂时无法核对']);
      const [[, , status, fields]] = admissionLogs(logs);
      assert.equal(status, 'unavailable'); assert.equal(fields.reason, reason); assert.equal(fields.cached, false);
      advance(59_999);
      await runtime.ingest(privateEvent({ messageId: 'om_unavailable_2' }));
      await flush();
      assert.equal(calls.length, 1, 'unavailable is cached for denyCacheMs');
      assert.equal(replies.length, 1);
      assert.equal(accepted.length, 0);
    });
  }
});

test('allowed result is cached for allowCacheMs', async () => {
  const { runtime, calls, accepted, advance } = harness();
  await runtime.ingest(privateEvent());
  advance(299_999);
  await runtime.ingest(privateEvent());
  assert.equal(calls.length, 1);
  advance(1);
  await runtime.ingest(privateEvent());
  assert.equal(calls.length, 2);
  assert.equal(accepted.length, 3);
});

test('existing threads are re-checked: a disabled sender is refused once the allow cache expires', async () => {
  let allowed = true;
  const { runtime, accepted, forwarded, replies, advance } = harness({ reply: () => (allowed ? ALLOW() : DENY()) });
  await runtime.ingest(privateEvent());
  allowed = false;
  advance(300_000);
  await runtime.ingest(privateEvent({ messageId: 'om_after_disable' }));
  await flush();
  assert.equal(accepted.length, 1);
  assert.equal(forwarded.length, 1);
  assert.equal(replies[0].messageId, 'om_after_disable');
});

test('concurrent messages from one sender share one request', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { runtime, calls, accepted, replies } = harness({ reply: async () => { await gate; return DENY(); } });
  const pending = [runtime.ingest(privateEvent({ messageId: 'om_c1' })), runtime.ingest(privateEvent({ messageId: 'om_c2' })),
    runtime.ingest(privateEvent({ messageId: 'om_c3', source: 'history_catchup' }))];
  await flush();
  assert.equal(calls.length, 1);
  release();
  assert.deepEqual((await Promise.all(pending)).map(item => item.decision), ['deny', 'deny', 'deny']);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(accepted.length, 0);
  assert.equal(replies.length, 1, 'concurrent refusals send one reply');
  const other = harness({ reply: async () => { await new Promise(setImmediate); return ALLOW(); } });
  await Promise.all([other.runtime.ingest(privateEvent({ messageId: 'om_a1' })), other.runtime.ingest(privateEvent({ messageId: 'om_a2' }))]);
  assert.equal(other.calls.length, 1);
  assert.equal(other.accepted.length, 2);
});

test('listed private users bypass the callback', async () => {
  const { runtime, calls, accepted, forwarded } = harness({ reply: DENY });
  await runtime.ingest(privateEvent({ openId: 'ou_listed' }));
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(accepted.length, 1);
  assert.equal(forwarded.length, 1);
});

test('group messages never call the callback', async () => {
  const { runtime, calls, accepted, forwarded, replies } = harness({ reply: DENY });
  await runtime.ingest(privateEvent({ conversationId: 'oc_group', conversationType: 'group',
    message: { kind: 'text', content: '{"text":"@bot hi"}', mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'bot' }] } }));
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(accepted.length, 1);
  assert.equal(forwarded.length, 1);
  assert.equal(replies.length, 0);
});

test('a live union_id is remembered for later events that lack one', async () => {
  const { runtime, calls, advance } = harness();
  await runtime.ingest(privateEvent({ openId: 'ou_memory', unionId: 'on_memory' }));
  advance(300_000);
  await runtime.ingest(privateEvent({ openId: 'ou_memory', unionId: '', source: 'history_catchup' }));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.sender.unionId, 'on_memory');
  assert.equal(calls[1].body.sender.unionId, 'on_memory');
});

test('group events also teach the union_id used for a later private check', async () => {
  const { runtime, calls } = harness();
  await runtime.ingest(privateEvent({ openId: 'ou_grouped', unionId: 'on_grouped', conversationId: 'oc_group', conversationType: 'group' }));
  await runtime.ingest(privateEvent({ openId: 'ou_grouped', unionId: '' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.sender.unionId, 'on_grouped');
});

test('without any union_id the request sends unionId null and userId null', async () => {
  const { runtime, calls } = harness({ reply: () => respond(200, { allowed: false, reason: 'no_union_id', colleagueId: null }) });
  await runtime.ingest(privateEvent({ openId: 'ou_no_union', unionId: '' }));
  assert.deepEqual(calls[0].body.sender, { openId: 'ou_no_union', unionId: null, userId: null });
});

test('a result obtained without union_id is re-checked once a live union_id arrives', async () => {
  const { runtime, calls, accepted, replies } = harness({
    reply: (_call, init) => (JSON.parse(init.body).sender.unionId ? ALLOW() : respond(200, { allowed: false, reason: 'no_union_id', colleagueId: null })) });
  await runtime.ingest(privateEvent({ openId: 'ou_late', unionId: '', source: 'history_catchup', messageId: 'om_history' }));
  await flush();
  assert.equal(replies.length, 0, 'history catch-up refusals never reply');
  await runtime.ingest(privateEvent({ openId: 'ou_late', unionId: 'on_late', messageId: 'om_live' }));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.sender.unionId, 'on_late');
  assert.deepEqual(accepted.map(item => item.messageId), ['om_live']);
});

test('a refused message stays refused when history catch-up observes it again', async () => {
  let allowed = false;
  const { runtime, calls, accepted, forwarded, replies, logs, advance } = harness({ reply: () => (allowed ? ALLOW() : DENY()) });
  await runtime.ingest(privateEvent({ messageId: 'om_refused' }));
  allowed = true;
  advance(60_000);
  await runtime.ingest(privateEvent({ messageId: 'om_refused', source: 'history_catchup' }));
  await runtime.ingest(privateEvent({ messageId: 'om_refused' }));
  await flush();
  assert.equal(calls.length, 1, 'a remembered refusal needs no request');
  assert.equal(accepted.length, 0);
  assert.equal(replies.length, 1);
  assert.deepEqual(admissionLogs(logs).slice(1).map(([, , status, { reason, cached }]) => [status, reason, cached]),
    [['deny', 'not_enabled', true], ['deny', 'not_enabled', true]]);
  await runtime.ingest(privateEvent({ messageId: 'om_new' }));
  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(accepted.map(item => item.messageId), ['om_new']);
  assert.equal(forwarded.length, 1);
});

test('private events without an identifiable human sender are not stored', async () => {
  const { runtime, calls, accepted, replies, logs } = harness();
  const recall = privateEvent({ type: 'message.recalled', actor: { type: 'unknown', openId: '', userId: '', unionId: '' } });
  assert.deepEqual(await runtime.ingest(recall), { admitted: false, decision: 'deny' });
  assert.deepEqual(await runtime.ingest(privateEvent({ isApp: true })), { admitted: false, decision: 'deny' });
  assert.deepEqual(await runtime.ingest(privateEvent({ actor: { type: 'user', openId: '', unionId: 'on_x', userId: '' } })), { admitted: false, decision: 'deny' });
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(accepted.length, 0);
  assert.equal(replies.length, 0);
  assert.deepEqual(admissionLogs(logs).map(([, , , { reason }]) => reason), ['sender_unidentified', 'sender_unidentified', 'open_id_missing']);
});

test('reply failure is logged once and never retried or queued', async () => {
  let attempts = 0;
  const failure = Object.assign(new Error('provider detail'), { code: 'feishu_api_rejected', outcome: 'failed', platformCode: 230002 });
  const { runtime, logs, accepted } = harness({ reply: DENY, replyMessage: async () => { attempts++; throw failure; } });
  await runtime.ingest(privateEvent());
  await runtime.ingest(privateEvent());
  await flush();
  assert.equal(attempts, 1);
  assert.equal(accepted.length, 0);
  assert.deepEqual(logs.filter(([level]) => level === 'warning'),
    [['warning', 'private_admission', 'reply_failed', { code: 'feishu_api_rejected', platformCode: 230002 }]]);
  assert.equal(JSON.stringify(logs).includes('provider detail'), false);
});

test('live ingest keeps the request inside the ingest deadline', async () => {
  const { runtime, calls, accepted, replies, logs, now } = harness({ raw: withAdmission({ ...ADMISSION, timeoutMs: 5000 }),
    reply: (_call, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })) });
  assert.deepEqual(await runtime.ingest(privateEvent({ messageId: 'om_late' }), { deadlineAt: now() + 200 }),
    { admitted: false, decision: 'unavailable' });
  await flush();
  assert.equal(calls.length, 0, 'no request starts without budget left');
  assert.equal(replies.length, 0, 'an out-of-budget refusal is not cached and so has no reply');
  const started = Date.now();
  assert.deepEqual(await runtime.ingest(privateEvent({ messageId: 'om_clamped' }), { deadlineAt: now() + 400 }),
    { admitted: false, decision: 'unavailable' });
  const elapsed = Date.now() - started;
  assert.equal(calls.length, 1);
  assert.ok(elapsed < 1000, `request ended after ${elapsed} ms although timeoutMs is 5000`);
  assert.deepEqual(admissionLogs(logs).map(([, , , { reason }]) => reason), ['deadline', 'timeout']);
  assert.equal(accepted.length, 0);
});

test('admission logs carry decision, reason, cached and a six-character open_id only', async () => {
  const lines = [];
  const log = createLogger({ write: line => lines.push(line) });
  const admission = createPrivateAdmission({ settings: validateConfig(base).routing.privateAdmission, connectionId: 'kosbling-auth', token: TOKEN, log,
    fetchImpl: async () => respond(200, { allowed: false, reason: 'not_registered', colleagueId: 'colleague-secret' }) });
  await admission.check({ openId: 'ou_abcdef123456', unionId: 'on_union_secret_value', chatId: 'oc_chat' });
  await admission.check({ openId: 'ou_abcdef123456', chatId: 'oc_chat' });
  const events = lines.map(line => JSON.parse(line));
  assert.deepEqual(events.map(({ operation, status, decision, reason, cached, openId, level }) => ({ operation, status, decision, reason, cached, openId, level })), [
    { operation: 'private_admission', status: 'deny', decision: 'deny', reason: 'not_registered', cached: false, openId: 'ou_abc', level: 'info' },
    { operation: 'private_admission', status: 'deny', decision: 'deny', reason: 'not_registered', cached: true, openId: 'ou_abc', level: 'info' },
  ]);
  const text = lines.join('');
  for (const secret of [TOKEN, 'on_union_secret_value', 'ou_abcdef', 'colleague-secret']) assert.equal(text.includes(secret), false, secret);
  const unknown = createLogger({ write: line => lines.push(line) });
  unknown('info', 'private_admission', 'x', { decision: 'maybe', cached: 'yes', openId: 'bad id!' });
  const last = JSON.parse(lines.at(-1));
  assert.equal('decision' in last || 'cached' in last || 'openId' in last, false);
});

test('private card actions follow the admission decision; other card rules are unchanged', async () => {
  let allowed = true;
  const config = validateConfig(base);
  const admission = createPrivateAdmission({ settings: config.routing.privateAdmission, connectionId: 'kosbling-auth', token: TOKEN,
    fetchImpl: async () => (allowed ? ALLOW() : DENY()) });
  const authorize = createCardAuthorize({ routing: config.routing, privateAdmission: admission });
  assert.equal(await authorize({ actor: { openId: 'ou_card' }, conversationId: 'oc_p2p', conversationType: 'p2p' }), true);
  assert.equal(await authorize({ actor: { openId: 'ou_listed' }, conversationId: 'oc_p2p', conversationType: 'p2p' }), true);
  assert.equal(await authorize({ actor: { openId: 'ou_card' }, conversationId: 'oc_group', conversationType: 'group' }), true);
  assert.equal(await authorize({ actor: { openId: 'ou_card' }, conversationId: 'oc_unlisted', conversationType: 'group' }), false);
  assert.equal(await authorize({ actor: {}, conversationId: 'oc_p2p', conversationType: 'p2p' }), false);
  allowed = false;
  assert.equal(await authorize({ actor: { openId: 'ou_denied' }, conversationId: 'oc_p2p', conversationType: 'p2p' }), false);
  const { privateAdmission, ...routing } = base.routing;
  const unconfigured = createCardAuthorize({ routing: validateConfig({ ...base, routing }).routing, privateAdmission: admission });
  assert.equal(await unconfigured({ actor: { openId: 'ou_card' }, conversationId: 'oc_p2p', conversationType: 'p2p' }), false);
  const allowAll = createCardAuthorize({ routing: validateConfig({ ...base, routing: { ...routing, allowAllPrivateUsers: true } }).routing });
  assert.equal(await allowAll({ actor: { openId: 'ou_card' }, conversationId: 'oc_p2p', conversationType: 'p2p' }), true);
});

test('without privateAdmission private chats never call the callback or log admission', async () => {
  const { privateAdmission, ...routing } = base.routing;
  const calls = []; const logs = []; const accepted = []; const forwarded = [];
  const admission = createPrivateAdmission({ settings: ADMISSION, connectionId: 'kosbling-auth', token: TOKEN,
    fetchImpl: async () => { calls.push(1); return DENY(); } });
  for (const allowAllPrivateUsers of [false, true]) {
    const runtime = createCommunicationRuntime({ config: validateConfig({ ...base, routing: { ...routing, allowAllPrivateUsers } }),
      store: { acceptInbound: async input => { accepted.push(input); return { duplicate: false }; } }, chat: {}, privateAdmission: admission,
      log: (...entry) => logs.push(entry), forward: { handleMessage: async input => { forwarded.push(input); return { accepted: true }; } } });
    await runtime.ingest(privateEvent({ openId: 'ou_open' }));
    await runtime.ingest(privateEvent({ type: 'message.recalled', actor: { type: 'unknown', openId: '', userId: '', unionId: '' } }));
  }
  await flush();
  assert.equal(calls.length, 0);
  assert.equal(accepted.length, 4, 'every private event is stored as before');
  assert.equal(forwarded.length, 1, 'only allow-all admits the unlisted sender');
  assert.deepEqual(logs, []);
});
