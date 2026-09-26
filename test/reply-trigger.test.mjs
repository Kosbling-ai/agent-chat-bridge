import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';
import { createRuntime } from '../src/core/runtime.mjs';
import { createReplyTrigger } from '../src/channels/feishu/reply-trigger.mjs';
import { createInboundMessageStore } from '../src/storage/inbound-messages.mjs';

const base = { schemaVersion: 1,
  storage: Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `TEST_${key.toUpperCase()}`])),
  codex: { bin: './codex', cwd: './workspace', envNames: [] },
  feishu: { connectionId: 'test', appIdEnv: 'TEST_APP', appSecretEnv: 'TEST_SECRET', botOpenId: 'bot' },
  routing: { version: '1', privateUserIds: [], groups: [{ conversationId: 'chat', trigger: 'mention', passiveContext: true }] }, hooks: [] };

const event = (id, parentId, rootId = '', source = 'live') => ({
  connectionId: 'test', source, eventKey: id, type: 'message.received', conversationId: 'chat',
  conversationType: 'group', messageId: id, occurredAt: Date.now(), actor: { type: 'user', openId: 'human', name: 'Human' },
  message: { kind: 'text', content: JSON.stringify({ text: `reply ${id}` }), parentId, rootId, mentions: [] },
});

const parent = (messageId, senderId, msgType = 'text') => ({ message_id: messageId, chat_id: 'chat', msg_type: msgType,
  sender: { id_type: 'open_id', id: senderId }, body: { content: msgType === 'interactive'
    ? JSON.stringify({ header: { title: { content: 'Business card' } }, body: { elements: [{ tag: 'button', text: { content: 'Approve' } }] } })
    : JSON.stringify({ text: 'Bot answer' }) } });

function fixture(replyTriggers = true, stored = new Set(), messages = {}) {
  const config = validateConfig({ ...base, routing: { ...base.routing, groups: [{ ...base.routing.groups[0], replyTriggers }] } });
  const forwarded = [], accepted = [], reads = [], lookups = [];
  const inbound = {
    async hasBotMessage(input) { lookups.push(input.messageId); return stored.has(input.messageId); },
    async loadRecentGroupContext() { return []; },
  };
  const chat = { async getMessage({ messageId }) { reads.push(messageId); return { items: messages[messageId] ? [messages[messageId]] : [] }; } };
  const runtime = createCommunicationRuntime({ config, inbound, chat,
    store: { async acceptInbound(input) { accepted.push(input); return { duplicate: false }; } },
    forward: { async handleMessage(input) { forwarded.push(input); return { execution: { terminal: 'completed' } }; } } });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { runtime, forwarded, accepted, reads, lookups, flush };
}

test('group reply trigger validates and defaults off', () => {
  assert.equal(validateConfig(base).routing.groups[0].replyTriggers, false);
  assert.equal(validateConfig({ ...base, routing: { ...base.routing, groups: [{ ...base.routing.groups[0], replyTriggers: true }] } }).routing.groups[0].replyTriggers, true);
  for (const replyTriggers of [null, 1, 'true']) {
    assert.throws(() => validateConfig({ ...base, routing: { ...base.routing, groups: [{ ...base.routing.groups[0], replyTriggers }] } }),
      { code: 'invalid_group_reply_triggers' });
  }
});

test('reply to stored bot text triggers normal forward path and reply context', async () => {
  const f = fixture(true, new Set(['bot-text']), { 'bot-text': parent('bot-text', 'bot') });
  await f.runtime.ingest(event('reply-text', 'bot-text'));
  await f.flush();
  assert.equal(f.forwarded.length, 1);
  assert.equal(f.forwarded[0].idempotencyKey, 'live:test:chat:reply-text');
  assert.match(f.forwarded[0].prompt, /【被回复消息】/);
  assert.match(f.forwarded[0].prompt, /> Bot answer/);
  assert.deepEqual(f.reads, ['bot-text'], 'stored ID skips ownership read; context reads parent once');
  assert.equal(f.accepted[0].passiveContext, false);
});

test('reply to bot card falls back to one Feishu read and reuses card for reply context', async () => {
  const f = fixture(true, new Set(), { card: parent('card', 'bot', 'interactive') });
  await f.runtime.ingest(event('reply-card', 'card', '', 'history_catchup'));
  await f.flush();
  assert.equal(f.forwarded.length, 1);
  assert.match(f.forwarded[0].prompt, /【被回复消息】[\s\S]*Business card[\s\S]*\[按钮\] Approve/);
  assert.deepEqual(f.reads, ['card']);
});

test('reply to another person does not trigger, even when the parent is fetched', async () => {
  const f = fixture(true, new Set(), { human: parent('human', 'someone-else') });
  await f.runtime.ingest(event('reply-human', 'human'));
  await f.flush();
  assert.equal(f.forwarded.length, 0);
  assert.equal(f.accepted[0].passiveContext, true);
});

test('disabled option does not inspect or trigger a reply', async () => {
  const f = fixture(false, new Set(['bot-text']), { 'bot-text': parent('bot-text', 'bot') });
  await f.runtime.ingest(event('reply-off', 'bot-text'));
  await f.flush();
  assert.equal(f.forwarded.length, 0);
  assert.deepEqual(f.lookups, []);
  assert.deepEqual(f.reads, []);
});

test('trigger all still accepts an ordinary human message without a reply lookup', async () => {
  const config = validateConfig({ ...base, routing: { ...base.routing,
    groups: [{ ...base.routing.groups[0], trigger: 'all', replyTriggers: true }] } });
  const forwarded = [];
  const runtime = createCommunicationRuntime({ config, store: { async acceptInbound() { return { duplicate: false }; } },
    inbound: { async hasBotMessage() { throw new Error('unexpected lookup'); }, async loadRecentGroupContext() { return []; } },
    chat: { async getMessage() { throw new Error('unexpected read'); } },
    forward: { async handleMessage(input) { forwarded.push(input); return { execution: { terminal: 'completed' } }; } } });
  await runtime.ingest(event('all', 'human'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(forwarded.length, 1);
});

test('legacy core runtime uses the same bot-reply eligibility before registering its agent job', async () => {
  const config = validateConfig({ ...base, routing: { ...base.routing,
    groups: [{ ...base.routing.groups[0], replyTriggers: true }] } });
  const accepted = [];
  const runtime = createRuntime({ config, store: { async acceptInbound(input) { accepted.push(input); return {}; } },
    codex: {}, chat: { async getMessage() { return { items: [parent('bot-text', 'bot')] }; } } });
  await runtime.ingest(event('legacy-reply', 'bot-text'));
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].agentJob.payload.messageId, 'legacy-reply');
  assert.equal(accepted[0].passiveContext, false);
});

test('root pointing at the bot triggers when immediate parent is someone else; cached reads are reused', async () => {
  const f = fixture(true, new Set(['bot-root']), { human: parent('human', 'someone-else') });
  await f.runtime.ingest(event('reply-root-1', 'human', 'bot-root'));
  await f.runtime.ingest(event('reply-root-2', 'human', 'bot-root'));
  await f.flush();
  assert.equal(f.forwarded.length, 2);
  assert.deepEqual(f.reads, ['human'], 'ownership and context reuse the cached parent');
  assert.match(f.forwarded[0].prompt, /【被回复消息】/);
});

test('Feishu sender must match this bot in the same chat', async () => {
  const lookup = createReplyTrigger({ botOpenId: 'bot', chat: { async getMessage() { return { items: [{ ...parent('p', 'bot'), chat_id: 'another-chat' }] }; } } });
  assert.equal((await lookup(event('wrong-chat', 'p'))).triggered, false);
});

test('stored bot message lookup scopes connection, chat and bot open ID', async () => {
  const queries = [];
  const connection = { async query() {}, async execute(sql, values) {
    queries.push({ sql, values });
    return [values.join(':') === 'test:bot-card:chat:bot' ? [{ found: 1 }] : []];
  }, release() {}, destroy() {} };
  const inbound = createInboundMessageStore({ pool: { async getConnection() { return connection; } }, connectionId: 'test' });
  assert.equal(await inbound.hasBotMessage({ messageId: 'bot-card', chatId: 'chat', botOpenId: 'bot' }), true);
  assert.equal(await inbound.hasBotMessage({ messageId: 'bot-card', chatId: 'other', botOpenId: 'bot' }), false);
  assert.match(queries[0].sql, /WHERE connection_id=\? AND message_id=\? AND chat_id=\? AND sender_open_id=\?/);
  assert.deepEqual(queries[0].values, ['test', 'bot-card', 'chat', 'bot']);
});
