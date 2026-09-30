import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';
import { resolveSilentReplyPolicy, matchSilentReply } from '../src/core/silent-reply.mjs';
import { createForwardRuntime } from '../src/core/forward-runtime.mjs';
import { createFeishuChatClient } from '../src/channels/feishu/chat-client.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';
import { normalizeFeishuEvent, RECALL } from '../src/channels/feishu/normalize.mjs';
import { historyMessageEvent } from '../src/core/catchup.mjs';

const base = { schemaVersion: 1,
  storage: Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `TEST_${key.toUpperCase()}`])),
  codex: { bin: './codex', cwd: './workspace', envNames: [] },
  feishu: { connectionId: 'test', appIdEnv: 'TEST_APP', appSecretEnv: 'TEST_SECRET', botOpenId: 'bot' },
  routing: { version: '1', privateUserIds: ['human'], groups: [{ conversationId: 'chat', trigger: 'mention', passiveContext: true }] }, hooks: [] };
const withRouting = silentReply => ({ ...base, routing: { ...base.routing, silentReply } });
const withGroup = fields => ({ ...base, routing: { ...base.routing, groups: [{ ...base.routing.groups[0], ...fields }] } });

test('silent reply config defaults to no tokens and delete, and validates both levels', () => {
  const config = validateConfig(base);
  assert.deepEqual(config.routing.silentReply, { tokens: [], card: 'delete' });
  assert.equal(config.routing.groups[0].silentReply, undefined);
  assert.deepEqual(validateConfig(withRouting({})).routing.silentReply, { tokens: [], card: 'delete' });
  assert.deepEqual(validateConfig(withRouting({ tokens: ['NO_REPLY', 'NO_REPLY', 'SKIP'], card: 'complete' })).routing.silentReply,
    { tokens: ['NO_REPLY', 'SKIP'], card: 'complete' });
  assert.deepEqual(validateConfig(withGroup({ silentReply: { tokens: ['NO_REPLY'] } })).routing.groups[0].silentReply, { tokens: ['NO_REPLY'] });
  assert.deepEqual(validateConfig(withGroup({ silentReply: { card: 'complete' } })).routing.groups[0].silentReply, { card: 'complete' });
  assert.deepEqual(validateConfig(withGroup({ silentReply: {} })).routing.groups[0].silentReply, {});
});

test('silent reply config rejects malformed values at either level', () => {
  for (const value of [null, [], 'NO_REPLY', { tokens: [], extra: true }]) {
    assert.throws(() => validateConfig(withRouting(value)), { code: 'invalid_silent_reply_fields' }, JSON.stringify(value));
    assert.throws(() => validateConfig(withGroup({ silentReply: value })), { code: 'invalid_silent_reply_fields' }, JSON.stringify(value));
  }
  for (const value of [{ tokens: 'NO_REPLY' }, { tokens: null }, { tokens: [''] }, { tokens: [' NO_REPLY'] }, { tokens: ['NO_REPLY\n'] },
    { tokens: ['A\u0000B'] }, { tokens: [1] }, { tokens: ['x'.repeat(201)] }, { tokens: Array.from({ length: 21 }, (_, i) => `T${i}`) },
    { card: 'hide' }, { card: null }, { card: 'Delete' }]) {
    assert.throws(() => validateConfig(withRouting(value)), { code: 'invalid_silent_reply' }, JSON.stringify(value));
    assert.throws(() => validateConfig(withGroup({ silentReply: value })), { code: 'invalid_silent_reply' }, JSON.stringify(value));
  }
  assert.throws(() => validateConfig(withGroup({ capabilities: ['hook'], silentReply: { tokens: ['NO_REPLY'] } })), { code: 'group_context_requires_bridge' });
});

test('silent reply policy applies only to bridge groups and group fields override defaults one by one', () => {
  const routing = validateConfig({ ...base, routing: { ...base.routing, silentReply: { tokens: ['NO_REPLY'] }, groups: [
    { conversationId: 'inherit', trigger: 'mention', passiveContext: true },
    { conversationId: 'override', trigger: 'mention', passiveContext: true, silentReply: { card: 'complete' } },
    { conversationId: 'off', trigger: 'mention', passiveContext: true, silentReply: { tokens: [] } },
    { conversationId: 'own', trigger: 'mention', passiveContext: true, silentReply: { tokens: ['SKIP'], card: 'complete' } },
    { conversationId: 'hook', trigger: 'mention', passiveContext: true, capabilities: ['hook'] },
  ] } }).routing;
  assert.deepEqual(resolveSilentReplyPolicy(routing, { chatId: 'inherit', chatType: 'group' }), { tokens: ['NO_REPLY'], card: 'delete' });
  assert.deepEqual(resolveSilentReplyPolicy(routing, { chatId: 'override', chatType: 'group' }), { tokens: ['NO_REPLY'], card: 'complete' });
  assert.equal(resolveSilentReplyPolicy(routing, { chatId: 'off', chatType: 'group' }), null);
  assert.deepEqual(resolveSilentReplyPolicy(routing, { chatId: 'own', chatType: 'group' }), { tokens: ['SKIP'], card: 'complete' });
  assert.equal(resolveSilentReplyPolicy(routing, { chatId: 'hook', chatType: 'group' }), null);
  assert.equal(resolveSilentReplyPolicy(routing, { chatId: 'unlisted', chatType: 'group' }), null);
  assert.equal(resolveSilentReplyPolicy(routing, { chatId: 'inherit', chatType: 'p2p' }), null);
  assert.equal(resolveSilentReplyPolicy(validateConfig(base).routing, { chatId: 'chat', chatType: 'group' }), null, 'unconfigured is off');
});

test('silent reply matching is exact, case-sensitive and trims surrounding whitespace only', () => {
  const policy = { tokens: ['NO_REPLY'], card: 'delete' };
  assert.equal(matchSilentReply('NO_REPLY', policy), 'NO_REPLY');
  assert.equal(matchSilentReply('  \n NO_REPLY \n', policy), 'NO_REPLY');
  for (const answer of ['no_reply', 'NO_REPLY.', 'NO_REPLY 好的', '好的 NO_REPLY', '`NO_REPLY`', 'NO_ REPLY', '', '   ', undefined, null]) {
    assert.equal(matchSilentReply(answer, policy), '', JSON.stringify(answer));
  }
  assert.equal(matchSilentReply('NO_REPLY', null), '');
  assert.equal(matchSilentReply('NO_REPLY', { tokens: [] }), '');
});

function deliveryHarness({ answer = 'NO_REPLY', chatType = 'group', silentReply, result: extra = {}, delivery = 'sent', job: jobFields = {}, silentCard } = {}) {
  const effects = [];
  const logs = [];
  let claimed = false;
  const job = { id: 'run', leaseOwner: 'owner', status: 'reply_pending', callerId: 'live', chatId: 'chat', chatType,
    messageId: 'message', sourceMessageId: 'message', deliveryMode: 'bridge', createdAt: 1,
    result: { answer, execution: { terminal: 'completed' }, ...extra }, ...jobFields };
  const jobs = {
    async claimReplyPending() { if (claimed) return []; claimed = true; return [job]; },
    async claim() { return []; }, async renew() {},
    async markRetry(value) { effects.push(['retry', value]); },
    async markFinished(value) { effects.push(['finished', value]); job.status = value.status; },
  };
  const feedback = {
    async finish() { effects.push(['card:finish']); return true; },
    async finishSilent(_job, _result, policy) { effects.push(['card:silent', policy.card]); return silentCard ?? (policy.card === 'complete' ? 'completed' : 'deleted'); },
    async cleanup() { effects.push(['typing:cleanup']); },
  };
  const replies = { async prepare(_job, value) { return value; },
    async deliver(_job, value, options) { effects.push(['deliver', { skipText: options.skipText, silentReply: value.silentReply }]); return { status: delivery }; } };
  const runtime = createForwardRuntime({ config: { owner: 'owner', pollMs: 1, leaseMs: 10_000, silentReply }, jobs, sessions: {}, executor: {},
    feedback, replies, inbound: { async recordReply(value) { effects.push(['recorded', value.text]); } }, log: (...entry) => logs.push(entry) });
  return { runtime, effects, logs, job };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 20));
const policy = card => () => ({ tokens: ['NO_REPLY'], card });

test('a sentinel group answer sends no text, closes the card by policy and finishes as silent', async () => {
  for (const card of ['delete', 'complete']) {
    const { runtime, effects, logs } = deliveryHarness({ answer: '\nNO_REPLY  ', silentReply: policy(card) });
    runtime.start(); await flush(); await runtime.stop();
    assert.deepEqual(effects.find(([name]) => name === 'card:silent'), ['card:silent', card]);
    assert.equal(effects.some(([name]) => name === 'card:finish'), false);
    const expected = card === 'delete' ? 'deleted' : 'completed';
    assert.deepEqual(effects.find(([name]) => name === 'deliver')[1], { skipText: true, silentReply: { status: 'silent', card: expected } });
    const finished = effects.find(([name]) => name === 'finished')[1];
    assert.equal(finished.status, 'completed');
    assert.equal(finished.replySent, false);
    assert.deepEqual(finished.result.silentReply, { status: 'silent', card: expected });
    assert.equal(effects.some(([name]) => name === 'recorded'), false, 'no bot reply is recorded in group context');
    assert.equal(effects.at(-1)[0], 'typing:cleanup');
    assert.equal(logs.some(([level, operation, status, fields]) => level === 'info' && operation === 'forward_reply'
      && status === 'silent' && fields.reason === `card_${expected}`), true);
  }
});

test('unconfigured, non-sentinel, failed and deferred answers keep the ordinary delivery path', async () => {
  for (const [name, options] of [
    ['unconfigured', { silentReply: undefined }],
    ['disabled', { silentReply: () => null }],
    ['ordinary', { answer: '已登记。', silentReply: policy('delete') }],
    ['prefix', { answer: 'NO_REPLY 已登记', silentReply: policy('delete') }],
    ['case', { answer: 'no_reply', silentReply: policy('delete') }],
    ['failed', { silentReply: policy('delete'), result: { failed: true, turnStatus: 'failed', execution: { terminal: 'failed' } } }],
    ['deferred', { silentReply: policy('delete'), result: { deferred: true, execution: { terminal: 'deferred' } } }],
  ]) {
    const { runtime, effects } = deliveryHarness(options);
    runtime.start(); await flush(); await runtime.stop();
    assert.equal(effects.some(([effect]) => effect === 'card:silent'), false, name);
    assert.equal(effects.some(([effect]) => effect === 'card:finish'), true, name);
    const finished = effects.find(([effect]) => effect === 'finished')[1];
    assert.equal(finished.result.silentReply, undefined, name);
    assert.equal(finished.replySent, true, name);
  }
});

test('private chats are never silenced even when the resolver would match', async () => {
  const routing = validateConfig({ ...base, routing: { ...base.routing, silentReply: { tokens: ['NO_REPLY'] } } }).routing;
  const { runtime, effects } = deliveryHarness({ chatType: 'p2p', silentReply: job => resolveSilentReplyPolicy(routing, job) });
  runtime.start(); await flush(); await runtime.stop();
  assert.equal(effects.some(([effect]) => effect === 'card:silent'), false);
  assert.equal(effects.some(([effect]) => effect === 'card:finish'), true);
  assert.deepEqual(effects.find(([effect]) => effect === 'recorded'), ['recorded', 'NO_REPLY']);
});

test('silent delivery with unknown attachment state stays pending like ordinary delivery', async () => {
  const { runtime, effects } = deliveryHarness({ silentReply: policy('delete'), delivery: 'unknown' });
  runtime.start(); await flush(); await runtime.stop();
  assert.equal(effects.some(([name]) => name === 'finished'), false);
  assert.equal(effects.find(([name]) => name === 'retry')[1].replyPending, true);
});

test('forward runtime rejects a non-function silent reply resolver', () => {
  assert.throws(() => createForwardRuntime({ config: { silentReply: { tokens: ['NO_REPLY'] } }, jobs: {}, sessions: {}, executor: {} }),
    /invalid_forward_silent_reply/);
});

test('chat client recalls one message by id as a write', async () => {
  const calls = [];
  const chat = createFeishuChatClient({ client: { im: { v1: { message: {
    async delete(request) { calls.push(request); return calls.length === 1 ? { code: 0, data: {} } : { code: 230011 }; },
  } } } } });
  await chat.deleteMessage({ messageId: 'om_card' });
  assert.deepEqual(calls[0], { path: { message_id: 'om_card' } });
  await assert.rejects(chat.deleteMessage({ messageId: 'om_card' }), { code: 'feishu_api_rejected', outcome: 'failed', platformCode: 230011 });
  assert.throws(() => chat.deleteMessage({ messageId: '' }), { code: 'invalid_chat_argument' });
});

test('an unchanged silent card close retries within the reply attempt limit before finishing', async () => {
  const retry = deliveryHarness({ silentReply: policy('complete'), silentCard: 'unchanged', job: { replyAttempts: 1 } });
  retry.runtime.start(); await flush(); await retry.runtime.stop();
  const marked = retry.effects.find(([name]) => name === 'retry')[1];
  assert.equal(marked.replyPending, true);
  assert.equal(marked.errorCode, 'silent_card_unchanged');
  assert.equal(retry.effects.some(([name]) => ['deliver', 'finished'].includes(name)), false);
  assert.equal(retry.logs.some(([level, operation, status, fields]) => level === 'warning' && operation === 'forward_reply'
    && status === 'retrying' && fields.code === 'silent_card_unchanged'), true);

  const exhausted = deliveryHarness({ silentReply: policy('complete'), silentCard: 'unchanged', job: { replyAttempts: 3 } });
  exhausted.runtime.start(); await flush(); await exhausted.runtime.stop();
  assert.equal(exhausted.effects.some(([name]) => name === 'retry'), false);
  assert.deepEqual(exhausted.effects.find(([name]) => name === 'deliver')[1], { skipText: true, silentReply: { status: 'silent', card: 'unchanged' } });
  const finished = exhausted.effects.find(([name]) => name === 'finished')[1];
  assert.equal(finished.status, 'completed');
  assert.equal(exhausted.logs.some(([level, operation, status, fields]) => level === 'warning' && operation === 'forward_reply'
    && status === 'silent' && fields.reason === 'card_unchanged'), true);

  const none = deliveryHarness({ silentReply: policy('delete'), silentCard: 'none', job: { replyAttempts: 1 } });
  none.runtime.start(); await flush(); await none.runtime.stop();
  assert.equal(none.effects.some(([name]) => name === 'retry'), false, 'no card means nothing to retry');
  assert.equal(none.effects.find(([name]) => name === 'finished')[1].result.silentReply.card, 'none');
});

function recallHarness({ owned = true, lookup } = {}) {
  const config = validateConfig({ ...base, hooks: [{ id: 'h', url: 'https://example.invalid/h', tokenEnv: 'TEST_HOOK', conversationIds: ['chat'] }] });
  const accepted = [], lookups = [], logs = [];
  const runtime = createCommunicationRuntime({ config, log: (...entry) => logs.push(entry),
    store: { async acceptInbound(input) { accepted.push(input); return { duplicate: false }; } },
    inbound: { async hasBotMessage(input) { lookups.push(input); if (lookup) return lookup(input); return owned; },
      async loadRecentGroupContext() { return []; } },
    forward: { async handleMessage() { throw new Error('recall must not forward'); } } });
  return { runtime, accepted, lookups, logs };
}
const liveRecall = messageId => normalizeFeishuEvent(RECALL, { message: { message_id: messageId, chat_id: 'chat', chat_type: 'group',
  recall_time: String(Date.now()) } }, { connectionId: 'test', botOpenId: 'bot' });
const historyRecall = messageId => historyMessageEvent({ message_id: messageId, deleted: true, create_time: String(Date.now()), msg_type: 'interactive',
  sender: { sender_type: 'app', id: 'cli_app', id_type: 'app_id' }, body: { content: '{}' } },
  { conversationId: 'chat', conversationType: 'group' }, { connectionId: 'test', botOpenId: 'bot' });

test('recalls of recorded bot messages stay out of hooks and group context for live and history events', async () => {
  for (const event of [liveRecall('card'), historyRecall('card')]) {
    assert.equal(event.isApp || event.isSelf, false, 'Feishu recall events carry no bot operator');
    const { runtime, accepted, lookups } = recallHarness({ owned: true });
    await runtime.ingest(event);
    assert.deepEqual(lookups, [{ messageId: 'card', chatId: 'chat', botOpenId: 'bot' }]);
    assert.equal(accepted.length, 1, 'the recall is still accepted for tombstones and deduplication');
    assert.deepEqual(accepted[0].hooks, []);
    assert.equal(accepted[0].passiveContext, false);
    assert.equal(accepted[0].recalledMessageId, 'card');
  }
});

test('recalls of other messages and failed ownership lookups keep hook delivery', async () => {
  const other = recallHarness({ owned: false });
  await other.runtime.ingest(liveRecall('human-message'));
  assert.equal(other.accepted[0].hooks.length, 1);
  const failed = recallHarness({ lookup: () => { throw new Error('store down'); } });
  await failed.runtime.ingest(historyRecall('card'));
  assert.equal(failed.accepted[0].hooks.length, 1);
  assert.equal(failed.logs.some(([level, operation, status, fields]) => level === 'warning' && operation === 'recall_filter'
    && status === 'failed' && fields.code === 'outbound_message_lookup_failed'), true);
});

test('received messages never trigger the outbound recall lookup', async () => {
  const { runtime, accepted, lookups } = recallHarness();
  await runtime.ingest({ connectionId: 'test', source: 'live', eventKey: 'm1', type: 'message.received', conversationId: 'chat',
    conversationType: 'group', messageId: 'm1', occurredAt: Date.now(), actor: { type: 'user', openId: 'human', name: 'Human' },
    message: { kind: 'text', content: JSON.stringify({ text: 'hello' }), mentions: [] } });
  assert.equal(lookups.length, 0);
  assert.equal(accepted[0].hooks.length, 1);
});

test('silent reply token length counts Unicode code points like card text', () => {
  const emoji = '\u{1F910}';
  assert.deepEqual(validateConfig(withRouting({ tokens: [emoji.repeat(200)] })).routing.silentReply.tokens, [emoji.repeat(200)]);
  assert.throws(() => validateConfig(withRouting({ tokens: [emoji.repeat(201)] })), { code: 'invalid_silent_reply' });
});

test('the delivery guard never silences a non-group job even with a matching resolver', async () => {
  const { runtime, effects } = deliveryHarness({ chatType: 'p2p', silentReply: policy('delete') });
  runtime.start(); await flush(); await runtime.stop();
  assert.equal(effects.some(([effect]) => effect === 'card:silent'), false);
  assert.equal(effects.some(([effect]) => effect === 'card:finish'), true);
});
