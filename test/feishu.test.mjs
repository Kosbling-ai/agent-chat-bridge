import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createFeishuAdapter, probeFeishuConnection } from '../src/channels/feishu/adapter.mjs';
import { normalizeFeishuEvent, feishuEventIdentity, RECEIVE, RECALL } from '../src/channels/feishu/normalize.mjs';
import { createFeishuChatClient } from '../src/channels/feishu/chat-client.mjs';

const event = { event_id: 'evt', create_time: '1700000000000', token: 'do-not-copy',
  sender: { sender_type: 'app', sender_id: { open_id: 'bot' } },
  message: { message_id: 'm', chat_id: 'chat', chat_type: 'group', message_type: 'text',
    content: '{"text":"hello"}', mentions: [{ key: '@_user_1', name: 'Bot', id: { open_id: 'bot' } }] } };
class Dispatcher { register(handlers) { this.handlers = handlers; return this; } }
function ingress(onEvent, options = {}) {
  const wsClient = { start: async () => {}, close() { this.closed = true; } };
  const adapter = createFeishuAdapter({ sdk: { EventDispatcher: Dispatcher }, wsClient,
    connectionId: 'test', botOpenId: 'bot', onEvent, ...options });
  return { adapter, wsClient, receive: adapter.dispatcher.handlers[RECEIVE] };
}
function fakeChat(handler = () => ({ code: 0, data: { message_id: 'sent' } }), options = {}) {
  const calls = [];
  const im = new Proxy({}, { get: (_, resource) => new Proxy({}, { get: (_, method) => async (request) => {
    calls.push({ resource, method, request }); return handler({ resource, method, request });
  } }) });
  return { calls, chat: createFeishuChatClient({ client: { im: { v1: im } }, ...options }) };
}
const send = { conversationId: 'chat', kind: 'text', content: { text: 'hello' }, uuid: 'stable-effect' };

test('normalization preserves identities, source content and app flags but strips secrets', () => {
  const flat = normalizeFeishuEvent(RECEIVE, event, { connectionId: 'test', botOpenId: 'bot', receivedAt: 1 });
  const envelope = normalizeFeishuEvent(RECEIVE, { header: event, event }, { connectionId: 'test', botOpenId: 'bot', receivedAt: 1 });
  assert.deepEqual(flat, envelope);
  assert.equal(flat.message.mentions[0].openId, 'bot');
  assert.equal(flat.isSelf, true); assert.equal(flat.isApp, true);
  assert.equal(JSON.stringify(flat).includes('do-not-copy'), false);
  assert.notEqual(normalizeFeishuEvent(RECALL, event, { connectionId: 'test' }).eventKey, flat.eventKey);
  assert.deepEqual(feishuEventIdentity(flat), feishuEventIdentity({ ...flat, receivedAt: 99, source: 'history', isSelf: false }));
  const noId = { ...event, event_id: '' };
  assert.equal(normalizeFeishuEvent(RECEIVE, noId, { connectionId: 'test' }).eventKey,
    normalizeFeishuEvent(RECEIVE, noId, { connectionId: 'test' }).eventKey);
});

test('connection readiness reads the live socket and fails closed without supported internals', async () => {
  let socket = null;
  const { adapter, wsClient } = ingress(() => {});
  wsClient.wsConfig = { getWSInstance: () => socket };
  await adapter.start();
  assert.equal(adapter.status().connected, false);
  socket = { readyState: 1 };
  assert.equal(adapter.status().connected, true);
  socket.readyState = 3;
  assert.equal(adapter.status().connected, false);
  socket.readyState = 1; adapter.stop();
  assert.equal(adapter.status().connected, false);
  assert.deepEqual(probeFeishuConnection({}), { connected: false, supported: false });
});

test('SDK 1.60.0 exposes the version-pinned socket probe without opening a network connection', async () => {
  const sdk = await import('@larksuiteoapi/node-sdk');
  const intervals = [];
  const originalSetInterval = globalThis.setInterval;
  let ws;
  // SDK owns an unreferenced-by-client DataCache timer; capture only construction.
  try {
    globalThis.setInterval = (...args) => { const timer = originalSetInterval(...args); intervals.push(timer); return timer; };
    ws = new sdk.WSClient({ appId: 'offline-test', appSecret: 'offline-test', loggerLevel: sdk.LoggerLevel.fatal,
      logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } });
  } finally { globalThis.setInterval = originalSetInterval; }
  try {
    assert.deepEqual(probeFeishuConnection(ws), { connected: false, supported: true });
    let closed = false;
    ws.wsConfig.setWSInstance({ readyState: 1, removeAllListeners() {}, terminate() { closed = true; } });
    assert.equal(probeFeishuConnection(ws).connected, true);
    ws.close({ force: true });
    assert.equal(closed, true);
    assert.equal(probeFeishuConnection(ws).connected, false);
  } finally { ws.close({ force: true }); intervals.forEach(clearInterval); }
});

test('handler waits for durable commit, and forwards deadline/signal without acknowledging early', async () => {
  let commit; let settled = false; let options;
  const { receive } = ingress((_, context) => { options = context; return new Promise((resolve) => { commit = resolve; }); });
  const pending = receive(event).then((value) => { settled = true; return value; });
  await new Promise(setImmediate);
  assert.equal(settled, false); assert.equal(options.signal.aborted, false);
  assert.ok(options.deadlineAt > Date.now());
  commit(); assert.equal(await pending, undefined);
});

test('durable failures throw sanitized errors; observer failure cannot change ACK', async () => {
  const { receive } = ingress(async () => { throw new Error('secret'); }, { log() { throw new Error('logger'); } });
  await assert.rejects(receive(event), (error) => error.code === 'feishu_ingress_failed' && !error.message.includes('secret'));
});

test('retryable ingress failures warn, and asynchronous terminal error reporting cannot escape', async () => {
  const logs = []; let reports = 0;
  const { receive, adapter } = ingress(async () => { throw new Error('temporary store issue'); }, {
    log: (...args) => logs.push(args), reportError: async () => { reports++; throw new Error('reporter secret'); },
  });
  await assert.rejects(receive(event));
  assert.equal(logs[0][0], 'warning'); assert.equal(reports, 0);
  adapter.status(); adapter.status(); // Unsupported probe is terminal and reported once.
  await new Promise(setImmediate);
  assert.equal(reports, 1);
  assert.ok(logs.some((entry) => entry[1] === 'feishu_error_reporting' && entry[3].code === 'feishu_reporting_failed'));
  assert.equal(JSON.stringify(logs).includes('secret'), false);
});

test('deadline aborts storage and throws even if persistence later resolves', async () => {
  let finish; let signal;
  const { receive } = ingress((_, context) => { signal = context.signal; return new Promise((resolve) => { finish = resolve; }); }, { deadlineMs: 10 });
  await assert.rejects(receive(event), { code: 'feishu_ingress_timeout' });
  assert.equal(signal.aborted, true); finish();
});

test('stop cancels active receive and future receives; lifecycle cannot start twice', async () => {
  const { adapter, wsClient, receive } = ingress(() => new Promise(() => {}));
  await adapter.start();
  await assert.rejects(adapter.start(), /already_started/);
  const pending = receive(event); adapter.stop();
  await assert.rejects(pending, { code: 'feishu_stopped' });
  await assert.rejects(receive(event), { code: 'feishu_stopped' });
  assert.equal(wsClient.closed, true); assert.equal(adapter.status().activeReceives, 0);
});

test('malformed events fail without invoking persistence; budget must be below platform 3 seconds', async () => {
  let called = false;
  await assert.rejects(ingress(() => { called = true; }).receive({}), /ingress_failed/);
  assert.equal(called, false);
  assert.throws(() => ingress(() => {}, { deadlineMs: 3000 }), /deadline/);
});

test('send/reply preserve stable UUID and SDK targets, no automatic retry', async () => {
  const { chat, calls } = fakeChat();
  await chat.sendMessage(send);
  await chat.replyMessage({ ...send, messageId: 'original', replyInThread: true });
  assert.equal(calls[0].request.data.uuid, 'stable-effect');
  assert.deepEqual(calls[0].request.params, { receive_id_type: 'chat_id' });
  assert.equal(calls[1].request.path.message_id, 'original');
  assert.equal(calls[1].request.data.reply_in_thread, true);
  assert.throws(() => chat.sendMessage({ ...send, uuid: undefined }));
  assert.throws(() => chat.sendMessage({ ...send, kind: 'audio' }));
});

test('write uncertainty survives timeout/network/platform error and never leaks payload', async () => {
  for (const handler of [() => { throw new Error('token secret'); }, () => new Promise(() => {}), () => ({ code: 999 })]) {
    const { chat, calls } = fakeChat(handler, { timeoutMs: 10 });
    await assert.rejects(chat.sendMessage(send), (error) => error.outcome === 'unknown' && !error.message.includes('secret'));
    assert.equal(calls.length, 1);
  }
});

test('history, members, resource and reaction requests stay scoped and paginated', async () => {
  const { chat, calls } = fakeChat();
  await chat.getMessage({ messageId: 'm' });
  await chat.listMessages({ conversationId: 'chat', pageSize: 20, pageToken: 'next' });
  await chat.listMembers({ conversationId: 'chat' });
  await chat.listReactions({ messageId: 'm' });
  await chat.addReaction({ messageId: 'm', emojiType: 'OK' });
  await chat.removeReaction({ messageId: 'm', reactionId: 'owned' });
  assert.equal(calls[1].request.params.page_size, 20);
  assert.equal(calls[2].resource, 'chatMembers');
  assert.equal(calls[5].request.path.reaction_id, 'owned');
  assert.throws(() => chat.listMessages({ conversationId: 'chat', pageSize: 101 }));
  assert.throws(() => chat.listMembers({ conversationId: 'chat', pageToken: 'x'.repeat(513) }));
});

test('uploads accept bounded bytes only, never arbitrary filesystem paths', async () => {
  const { chat, calls } = fakeChat(() => ({ image_key: 'image', file_key: 'file' }), { maxMediaBytes: 4 });
  await chat.uploadImage({ bytes: Buffer.from('abc') });
  await chat.uploadFile({ bytes: Buffer.from('abc'), fileName: 'a.txt' });
  assert.equal(calls[1].request.data.file_type, 'stream');
  assert.throws(() => chat.uploadImage({ bytes: '/etc/passwd' }));
  assert.throws(() => chat.uploadImage({ bytes: Buffer.alloc(5) }));
  assert.throws(() => chat.uploadFile({ bytes: Buffer.alloc(1), fileName: '../secret' }));
});

test('downloads stream within byte cap and fail oversize without buffering whole media', async () => {
  const { chat, calls } = fakeChat(() => ({ getReadableStream: () => Readable.from([Buffer.from('abc'), Buffer.from('de')]), headers: {} }), { maxMediaBytes: 4 });
  const { stream } = await chat.downloadResource({ messageId: 'm', fileKey: 'key', type: 'image' });
  await assert.rejects(async () => { for await (const _ of stream) {} }, { code: 'media_too_large' });
  assert.deepEqual(calls[0].request.path, { message_id: 'm', file_key: 'key' });
  await assert.rejects(chat.downloadResource({ messageId: 'm', fileKey: 'key', type: 'url' }));
});

test('hung download has a wall clock limit', async () => {
  const source = new Readable({ read() {} });
  const { chat } = fakeChat(() => ({ getReadableStream: () => source, headers: {} }), { timeoutMs: 10 });
  const { stream } = await chat.downloadResource({ messageId: 'm', fileKey: 'key', type: 'file' });
  await assert.rejects(async () => { for await (const _ of stream) {} }, { code: 'media_timeout' });
  assert.equal(source.destroyed, true);
});

test('installed SDK and axios build chat HTTP requests without any network transport', async () => {
  const sdk = await import('@larksuiteoapi/node-sdk');
  const { default: axios } = await import('axios');
  assert.equal(axios.VERSION, '1.18.0');
  const requests = [];
  const http = axios.create({ timeout: 1000, adapter: async (config) => {
    requests.push(config);
    const data = config.url.includes('/auth/') ? { code: 0, tenant_access_token: 'offline-token', expire: 7200 }
      : config.responseType === 'stream' ? Readable.from([Buffer.from('ok')])
        : { code: 0, data: { message_id: 'offline-message', image_key: 'image', file_key: 'file', items: [] } };
    return { status: 200, statusText: 'OK', headers: {}, config, data };
  } });
  http.interceptors.response.use((response) => response.config.$return_headers ? { data: response.data, headers: response.headers } : response.data);
  const client = new sdk.Client({ appId: 'offline-http-app', appSecret: 'offline-value', httpInstance: http,
    logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} }, loggerLevel: sdk.LoggerLevel.fatal });
  const chat = createFeishuChatClient({ client });
  await chat.sendMessage(send);
  await chat.replyMessage({ ...send, messageId: 'm' });
  await chat.getMessage({ messageId: 'm' });
  await chat.listMessages({ conversationId: 'chat' });
  await chat.listMembers({ conversationId: 'chat' });
  await chat.addReaction({ messageId: 'm', emojiType: 'OK' });
  await chat.listReactions({ messageId: 'm' });
  await chat.removeReaction({ messageId: 'm', reactionId: 'r' });
  await chat.uploadImage({ bytes: Buffer.from('image') });
  await chat.uploadFile({ bytes: Buffer.from('file'), fileName: 'test.txt' });
  const resource = await chat.downloadResource({ messageId: 'm', fileKey: 'f', type: 'file' });
  let content = '';
  for await (const chunk of resource.stream) content += chunk.toString();
  assert.equal(content, 'ok');
  assert.equal(requests.filter((request) => request.url.includes('/im/')).length, 11);
  const create = requests.find((request) => request.url.endsWith('/im/v1/messages'));
  assert.equal(JSON.parse(create.data).uuid, 'stable-effect');
  assert.ok(requests.some((request) => request.url.endsWith('/chats/chat/members')));
  assert.ok(requests.some((request) => request.url.endsWith('/messages/m/resources/f')));
});
