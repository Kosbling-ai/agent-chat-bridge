import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../src/core/runtime.mjs';
import { createFeishuChatClient } from '../src/channels/feishu/chat-client.mjs';
import { splitReplyCards, renderReplyCard, REPLY_CARD_MAX_BYTES } from '../src/channels/feishu/reply-card.mjs';

async function run({ answer = '**Done**', messageId = 'incoming', status = 'completed', unsupported = false } = {}) {
  let claimed = false, persisted, terminal, delivered = false;
  const calls = [], settlements = [];
  const turn = { id: 'turn', status, items: [{ type: 'agentMessage', phase: 'final_answer', text: answer }] };
  const store = {
    async claimJobs({ kind }) { if (kind !== 'agent' || claimed) return []; claimed = true; return [{ id: 'job', leaseToken: 'lease', conversationId: 'chat', payload: { text: 'input', messageId, unsupported } }]; },
    async readNativeEvents() { return []; },
    async getSteerAttempt() { return null; },
    async beginAgentAttempt() { return { recoveryRequired: true, nativeThreadId: 'thread', nativeTurnId: 'turn', generation: 1 }; },
    async finishJobWithOutbox(input) { persisted = JSON.parse(JSON.stringify(input)); },
    async retryJob(input) { terminal = input; },
    async claimOutbox() {
      if (!persisted || delivered) return [];
      delivered = true;
      // JSON roundtrip represents the durable boundary, not a real MySQL test.
      return persisted.outbox.map((effect, index) => ({ ...effect, id: `effect-${index}`, conversationId: 'chat', platformUuid: `uuid-${index}`, leaseToken: 'effect-lease', payload: JSON.stringify(effect.payload) }));
    },
    async settleOutbox(input) { settlements.push(input); },
  };
  const client = { im: { v1: { message: Object.fromEntries(['create','reply'].map(method => [method, async request => { calls.push({ method, request }); return { code: 0, data: { message_id: 'sent' } }; }])) } } };
  const runtime = createRuntime({ config: { feishu: { connectionId: 'test' }, codex: { steering: false }, routing: { groups: [] }, hooks: [] }, store,
    codex: { status: () => ({ state: 'ready' }), readThread: async () => ({ thread: { turns: [turn] } }) }, chat: createFeishuChatClient({ client }) });
  runtime.start();
  try {
    const until = Date.now() + 2000;
    while (!terminal && (!persisted || settlements.length !== persisted.outbox.length)) {
      if (Date.now() > until) throw new Error('fixture_timeout');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { await runtime.stop(); }
  return { persisted, calls, settlements, terminal };
}

test('final Codex answer persists interactive outbox and adapter replies with card JSON', async () => {
  const result = await run();
  assert.equal(result.persisted.outbox[0].payload.kind, 'interactive');
  assert.equal(result.calls[0].method, 'reply');
  assert.equal(result.calls[0].request.path.message_id, 'incoming');
  assert.equal(result.calls[0].request.data.uuid, 'uuid-0');
  assert.equal(result.calls[0].request.data.msg_type, 'interactive');
  const card = JSON.parse(result.calls[0].request.data.content);
  assert.equal(card.schema, '2.0');
  assert.equal(card.body.elements[0].content, '**Done**');
  assert.equal(card.header.template, 'green');
  assert.equal(result.settlements[0].status, 'sent');
});
test('API-origin final creates a card and empty final is still visible', async () => {
  const result = await run({ messageId: null, answer: '' });
  assert.equal(result.calls[0].method, 'create');
  assert.equal(result.calls[0].request.data.receive_id, 'chat');
  assert(JSON.parse(result.calls[0].request.data.content).body.elements[0].content);
});
test('long escaped Unicode answer retains all content and bounded ordered outbox entries', async () => {
  const answer = '中文😀"\\\n'.repeat(6000);
  const result = await run({ answer });
  assert(result.persisted.outbox.length > 1);
  assert.equal(result.persisted.outbox.map(e => e.payload.content.body.elements[0].content).join(''), answer.trim());
  for (const [index,effect] of result.persisted.outbox.entries()) {
    assert.equal(effect.idempotencyKey, `run:job:final-card:${index}`);
    assert(Buffer.byteLength(JSON.stringify(effect.payload.content)) <= REPLY_CARD_MAX_BYTES);
    assert(!effect.payload.content.body.elements[0].content.includes('\ufffd'));
  }
});
test('existing unsupported-input notification is a card; confirmed native failure remains failed without success outbox', async () => {
  const rejected = await run({ unsupported: true });
  assert.equal(rejected.persisted.result.status, 'input_unsupported');
  assert.equal(rejected.persisted.outbox[0].payload.content.header.template, 'blue');
  const failed = await run({ status: 'failed' });
  assert.equal(failed.terminal.terminal, true);
  assert.equal(failed.terminal.errorCode, 'agent_turn_failed');
  assert.equal(failed.persisted, undefined);
});
test('renderer validates status and does not produce nonfunctional stop buttons', () => {
  assert.throws(() => renderReplyCard('x','running'));
  assert.throws(() => splitReplyCards(null));
  assert.equal(renderReplyCard('failed','failed').header.template,'red');
  assert(!JSON.stringify(renderReplyCard('final')).includes('callback'));
});
test('installed Feishu SDK serializes interactive create/reply via offline HTTP transport', async () => {
  const sdk = await import('@larksuiteoapi/node-sdk');
  const { default: axios } = await import('axios');
  const requests = [];
  const http = axios.create({ adapter: async config => {
    requests.push(config);
    return { status: 200, statusText: 'OK', headers: {}, config, data: config.url.includes('/auth/')
      ? { code: 0, tenant_access_token: 'offline-token', expire: 7200 }
      : { code: 0, data: { message_id: 'offline-message' } } };
  } });
  http.interceptors.response.use(response => response.data);
  const originalSetInterval = globalThis.setInterval;
  let client;
  try {
    // SDK cache timer is not exposed for close; it must not keep this offline
    // fixture alive. Restore the global immediately after construction.
    globalThis.setInterval = (...args) => { const timer = originalSetInterval(...args); timer.unref(); return timer; };
    client = new sdk.Client({ appId: 'offline-card', appSecret: 'offline-value', httpInstance: http,
      logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } });
  } finally { globalThis.setInterval = originalSetInterval; }
  const chat = createFeishuChatClient({ client });
  const card = renderReplyCard('**Markdown**\n中文 "quoted" \\');
  await chat.sendMessage({ conversationId: 'chat', kind: 'interactive', content: card, uuid: 'create-uuid' });
  await chat.replyMessage({ messageId: 'message', kind: 'interactive', content: card, uuid: 'reply-uuid' });
  const sent = requests.filter(request => !request.url.includes('/auth/'));
  assert.equal(sent.length, 2);
  for (const request of sent) {
    const body = JSON.parse(request.data);
    assert.equal(body.msg_type, 'interactive');
    assert.deepEqual(JSON.parse(body.content), card);
  }
  assert(sent[0].url.endsWith('/im/v1/messages'));
  assert(sent[1].url.endsWith('/im/v1/messages/message/reply'));
  assert.equal(JSON.parse(sent[1].data).uuid, 'reply-uuid');
});
