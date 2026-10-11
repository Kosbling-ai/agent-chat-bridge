import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../src/config.mjs';
import { jobReplyPolicy, resolveReplyPolicy } from '../src/core/reply-mode.mjs';
import { resolveSilentReplyPolicy } from '../src/core/silent-reply.mjs';
import { createForwardRuntime } from '../src/core/forward-runtime.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';
import { createExecutionFeedback } from '../src/channels/feishu/execution-feedback.mjs';
import { createFeishuReplies, markdownToFeishuPost } from '../src/channels/feishu/replies.mjs';
import { createForwardJobStore } from '../src/storage/forward-jobs.mjs';

const bin = fileURLToPath(new URL('../bin/agent-chat-bridge.mjs', import.meta.url));
const ID_A = 'ou_0123456789abcdef';
const ID_B = 'ou_fedcba9876543210';
const base = { schemaVersion: 1,
  storage: Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `TEST_${key.toUpperCase()}`])),
  codex: { bin: './codex', cwd: './workspace', envNames: [] },
  feishu: { connectionId: 'test', appIdEnv: 'TEST_APP', appSecretEnv: 'TEST_SECRET', botOpenId: 'bot' },
  routing: { version: '1', privateUserIds: ['human'], silentReply: { tokens: ['NO_REPLY'] },
    groups: [{ conversationId: 'chat', trigger: 'mention', passiveContext: true }] }, hooks: [] };
const withGroup = fields => ({ ...base, routing: { ...base.routing, groups: [{ ...base.routing.groups[0], ...fields }] } });
const withoutTokens = raw => ({ ...raw, routing: { ...raw.routing, silentReply: undefined } });
const flush = () => new Promise(resolve => setTimeout(resolve, 20));
const TEXT = { mode: 'text', ack: 'none' };

test('reply config is optional, defaults to card and normalizes text mode with its acknowledgement', () => {
  const plain = validateConfig(base).routing.groups[0];
  assert.equal(Object.hasOwn(plain, 'reply'), false, 'configurations without the key keep their normalized shape');
  assert.deepEqual(validateConfig(withGroup({ reply: {} })).routing.groups[0].reply, { mode: 'card' });
  assert.deepEqual(validateConfig(withGroup({ reply: { mode: 'card' } })).routing.groups[0].reply, { mode: 'card' });
  assert.deepEqual(validateConfig(withGroup({ reply: { mode: 'text' } })).routing.groups[0].reply, TEXT);
  assert.deepEqual(validateConfig(withGroup({ reply: { mode: 'text', ack: 'none' } })).routing.groups[0].reply, TEXT);
  assert.deepEqual(validateConfig(withGroup({ reply: { mode: 'text', ack: 'reaction' } })).routing.groups[0].reply,
    { mode: 'text', ack: 'reaction', ackEmoji: 'OnIt' });
  assert.deepEqual(validateConfig(withGroup({ reply: { mode: 'text', ack: 'reaction', ackEmoji: 'GLANCE' } })).routing.groups[0].reply,
    { mode: 'text', ack: 'reaction', ackEmoji: 'GLANCE' });
});

test('reply config rejects malformed values and keys that cannot apply', () => {
  for (const reply of [null, [], 'text', { mode: 'text', extra: true }]) {
    assert.throws(() => validateConfig(withGroup({ reply })), { code: 'invalid_group_reply_fields' }, JSON.stringify(reply));
  }
  for (const mode of ['Text', 'post', null, 1]) assert.throws(() => validateConfig(withGroup({ reply: { mode } })), { code: 'invalid_group_reply_mode' });
  for (const ack of ['reactions', 'emoji', null, true]) assert.throws(() => validateConfig(withGroup({ reply: { mode: 'text', ack } })), { code: 'invalid_group_reply_ack' });
  for (const ackEmoji of ['', 'EYES!', '👀', 'x'.repeat(81), null, 1]) {
    assert.throws(() => validateConfig(withGroup({ reply: { mode: 'text', ack: 'reaction', ackEmoji } })), { code: 'invalid_group_reply_ack_emoji' });
  }
  assert.throws(() => validateConfig(withGroup({ reply: { ack: 'reaction' } })), { code: 'group_reply_ack_requires_text_mode' });
  assert.throws(() => validateConfig(withGroup({ reply: { mode: 'card', ack: 'none' } })), { code: 'group_reply_ack_requires_text_mode' });
  assert.throws(() => validateConfig(withGroup({ reply: { mode: 'card', ackEmoji: 'OnIt' } })), { code: 'group_reply_ack_requires_text_mode' });
  assert.throws(() => validateConfig(withGroup({ reply: { mode: 'text', ackEmoji: 'OnIt' } })), { code: 'group_reply_ack_emoji_requires_reaction' });
  assert.throws(() => validateConfig(withGroup({ reply: { mode: 'text', ack: 'reaction', ackEmoji: 'Typing' } })),
    { code: 'group_reply_ack_emoji_conflicts_with_processing_reaction' });
  assert.doesNotThrow(() => validateConfig({ ...withGroup({ reply: { mode: 'text', ack: 'reaction', ackEmoji: 'Typing' } }),
    feishu: { ...base.feishu, processingReactionEmoji: 'Get' } }));
  assert.throws(() => validateConfig(withGroup({ capabilities: ['hook'], reply: { mode: 'text' } })), { code: 'group_context_requires_bridge' });
});

test('a text-mode group needs effective silent-reply tokens from the group or the routing defaults', () => {
  assert.throws(() => validateConfig(withoutTokens(withGroup({ reply: { mode: 'text' } }))), { code: 'group_text_reply_requires_silent_reply' });
  assert.throws(() => validateConfig(withGroup({ reply: { mode: 'text' }, silentReply: { tokens: [] } })), { code: 'group_text_reply_requires_silent_reply' });
  assert.doesNotThrow(() => validateConfig(withoutTokens(withGroup({ reply: { mode: 'text' }, silentReply: { tokens: ['SKIP'] } }))));
  assert.doesNotThrow(() => validateConfig(withGroup({ reply: { mode: 'text' } })), 'routing defaults count');
  assert.doesNotThrow(() => validateConfig(withoutTokens(withGroup({ reply: { mode: 'card' } }))), 'card mode does not need tokens');
});

test('check-config accepts the new keys and reports bad values by code', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-reply-mode-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'bridge.json');
  const run = () => spawnSync(process.execPath, [bin, 'check-config', '--config', path], { encoding: 'utf8', timeout: 20000 });
  await writeFile(path, JSON.stringify({ ...base, routing: { ...base.routing, groups: [
    { conversationId: 'mention-group', trigger: 'mention', replyTriggers: true, passiveContext: true, reply: { mode: 'text', ack: 'reaction' } },
    { conversationId: 'all-group', trigger: 'all', passiveContext: true, reply: { mode: 'text', ack: 'reaction' } },
  ] } }));
  const passed = run();
  assert.equal(passed.status, 0, passed.stdout);
  assert.match(passed.stdout, /"operation":"check_config","status":"succeeded"/);
  for (const [raw, code] of [[withGroup({ reply: { mode: 'thread' } }), 'invalid_group_reply_mode'],
    [withoutTokens(withGroup({ reply: { mode: 'text' } })), 'group_text_reply_requires_silent_reply']]) {
    await writeFile(path, JSON.stringify(raw));
    const failed = run();
    assert.notEqual(failed.status, 0);
    assert.match(failed.stdout + failed.stderr, new RegExp(code));
  }
});

test('reply policy resolves only for bridge-delivered jobs in listed bridge groups, and a recorded policy wins', () => {
  const routing = validateConfig({ ...base, routing: { ...base.routing, groups: [
    { conversationId: 'text', trigger: 'mention', passiveContext: true, reply: { mode: 'text' } },
    { conversationId: 'card', trigger: 'mention', passiveContext: true, reply: { mode: 'card' } },
    { conversationId: 'default', trigger: 'mention', passiveContext: true },
    { conversationId: 'hook', trigger: 'mention', passiveContext: true, capabilities: ['hook'] },
  ] } }).routing;
  const job = fields => ({ chatId: 'text', chatType: 'group', deliveryMode: 'bridge', ...fields });
  assert.deepEqual(resolveReplyPolicy(routing, job()), TEXT);
  assert.deepEqual(resolveReplyPolicy(routing, job({ chatId: 'card' })), { mode: 'card' });
  for (const fields of [{ chatId: 'default' }, { chatId: 'hook' }, { chatId: 'unlisted' }, { chatType: 'p2p' }, { deliveryMode: 'caller' }]) {
    assert.equal(resolveReplyPolicy(routing, job(fields)), null, JSON.stringify(fields));
  }
  const resolve = value => resolveReplyPolicy(routing, value);
  assert.deepEqual(jobReplyPolicy(job({ chatId: 'card', result: { replyMode: TEXT } }), undefined, resolve), TEXT, 'recorded on the job');
  assert.deepEqual(jobReplyPolicy(job(), { replyMode: { mode: 'card' } }, resolve), { mode: 'card' }, 'recorded on the result');
  assert.equal(jobReplyPolicy(job({ result: { executionCard: { messageId: 'card' } } }), undefined, resolve), null, 'an existing card keeps the card path');
  assert.equal(jobReplyPolicy(job({ deliveryMode: 'caller', result: { replyMode: TEXT } }), undefined, resolve), null);
});

test('the job store accepts the replyMode feedback key and still rejects unknown keys', async () => {
  const statements = [];
  const connection = { async query() {}, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {}, destroy() {},
    async execute(sql, values) { statements.push({ sql, values }); return [{ affectedRows: 1 }]; } };
  const store = createForwardJobStore({ pool: { async getConnection() { return connection; } }, connectionId: 'fixture' });
  await store.patchFeedback({ id: 'run', leaseOwner: 'owner', key: 'replyMode', value: TEXT });
  assert.match(statements[0].sql, /'\$\.replyMode'/);
  assert.equal(statements[0].values[0], JSON.stringify(TEXT));
  await assert.rejects(async () => store.patchFeedback({ id: 'run', leaseOwner: 'owner', key: 'unknownKey', value: {} }), { code: 'invalid_store_input' });
});

const groupEvent = (now, id, fields = {}) => ({ connectionId: 'test', source: 'live', eventKey: id, type: 'message.received', conversationId: 'chat',
  conversationType: 'group', messageId: id, occurredAt: now, actor: { type: 'user', openId: 'human', name: 'Human' },
  message: { kind: 'text', content: JSON.stringify({ text: `message ${id}` }), mentions: [] }, ...fields });

test('trigger all starts the Agent for every fresh human message but never for bots, itself or stale messages', async () => {
  const now = 1_800_000_000_000;
  const config = validateConfig(withGroup({ trigger: 'all', reply: { mode: 'text' } }));
  const forwarded = [];
  const runtime = createCommunicationRuntime({ config, now: () => now, store: { acceptInbound: async () => ({ duplicate: false }) },
    forward: { handleMessage: async input => { forwarded.push(input.message.messageId); return { execution: { terminal: 'completed' } }; } }, chat: {} });
  await runtime.ingest(groupEvent(now, 'human'));
  await runtime.ingest(groupEvent(now, 'app', { isApp: true, actor: { type: 'app', appId: 'other-bot' } }));
  await runtime.ingest(groupEvent(now, 'self', { isSelf: true }));
  await runtime.ingest(groupEvent(now - 11 * 60 * 1000, 'stale'));
  await new Promise(setImmediate);
  assert.deepEqual(forwarded, ['human']);
});

test('trigger all history catch-up skips messages older than ten minutes and ignores reply triggers and passive context', async () => {
  const now = 1_800_000_000_000;
  const config = validateConfig(withGroup({ trigger: 'all', replyTriggers: true, reply: { mode: 'text' } }));
  const forwarded = [];
  const accepted = [];
  const lookups = [];
  const runtime = createCommunicationRuntime({ config, now: () => now,
    store: { async acceptInbound(input) { accepted.push(input); return { duplicate: false }; } },
    inbound: { async hasBotMessage(input) { lookups.push(input); return true; }, async loadRecentGroupContext() { return []; } },
    chat: { async getMessage() { return { items: [] }; } },
    forward: { handleMessage: async input => { forwarded.push(input.message.messageId); return { execution: { terminal: 'completed' } }; } } });
  const reply = { kind: 'text', content: '{"text":"reply to the bot"}', mentions: [], parent_id: 'om_bot_message' };
  await runtime.ingest(groupEvent(now - 11 * 60 * 1000, 'old-history', { source: 'history_catchup', message: reply }));
  await runtime.ingest(groupEvent(now - 60 * 1000, 'fresh-history', { source: 'history_catchup', message: reply }));
  await new Promise(setImmediate); await flush();
  assert.deepEqual(forwarded, ['fresh-history']);
  assert.deepEqual(lookups, [], 'trigger all never asks whether the parent is a bot message');
  assert.deepEqual(accepted.map(input => [input.messageId, input.passiveContext, input.inboundMessage.groupContextCandidate]),
    [['old-history', false, false], ['fresh-history', false, false]]);
});

function feedbackFixture({ reply = TEXT, result = {}, chat: chatOverrides = {}, patchFeedback } = {}) {
  const effects = [];
  const job = { id: 'run', leaseOwner: 'worker', callerId: 'live', chatId: 'chat', chatType: 'group', messageId: 'source', sourceMessageId: 'source',
    senderOpenId: 'human', deliveryMode: 'bridge', status: 'running', createdAt: 1, result: { execution: { threadId: 'thread', turnId: 'turn' }, ...result } };
  const chat = {
    async addReaction(input) { effects.push(['reaction', input]); return { reaction_id: 'ack' }; },
    async deleteMessage(input) { effects.push(['delete', input]); },
    ...chatOverrides,
  };
  const logs = [];
  const feedback = createExecutionFeedback({
    jobs: { async patchFeedback(value) { effects.push(['patch', value.key, value.value]); if (patchFeedback) await patchFeedback(value); } },
    sessions: { async loadBinding() { return null; }, async readPublicProgress() { return []; } },
    chat,
    typing: { async start() { effects.push(['typing:start']); return { reactionId: 'typing' }; }, async cleanup(_job, reaction) { effects.push(['typing:cleanup', reaction]); } },
    cardClient: { im: { v1: { message: {
      async create() { effects.push(['card:create']); return { code: 0, data: { message_id: 'card' } }; },
      async patch() { effects.push(['card:patch']); return { code: 0 }; },
    } } } },
    executor: {},
    config: { replyPolicy: () => reply },
    log: (...entry) => logs.push(entry),
  });
  return { feedback, job, effects, logs };
}

test('text mode feedback records the mode, creates no card and no Typing, and acknowledges only when configured', async () => {
  const { feedback, job, effects } = feedbackFixture();
  const state = await feedback.start(job);
  assert.equal(state.card, null);
  assert.deepEqual(state.result.replyMode, TEXT);
  assert.equal(feedback.observe(job, state, { bindingOpenId: 'group:binding' }), null);
  const result = { ...job.result, answer: 'done' };
  await feedback.prepare(job, result, state);
  assert.equal(result.executionCard, undefined);
  assert.equal(await feedback.finish(job, result), false, 'the reply module sends the answer');
  assert.equal(await feedback.finishSilent(job, result, { tokens: ['NO_REPLY'], card: 'delete' }), 'none');
  await feedback.cleanup({ ...job, result });
  await flush();
  assert.deepEqual(effects, [['patch', 'replyMode', TEXT]], 'only the recorded mode reaches the store; nothing reaches Feishu');

  const acked = feedbackFixture({ reply: { mode: 'text', ack: 'reaction', ackEmoji: 'OnIt' } });
  const ackState = await acked.feedback.start(acked.job);
  await acked.feedback.cleanup(acked.job, { reaction: ackState.typing });
  await flush();
  assert.deepEqual(acked.effects.filter(([name]) => name !== 'patch'), [['reaction', { messageId: 'source', emojiType: 'OnIt' }]],
    'the acknowledgement is added once and left');

  const failing = feedbackFixture({ reply: { mode: 'text', ack: 'reaction', ackEmoji: 'OnIt' },
    chat: { async addReaction() { throw Object.assign(new Error('rejected'), { code: 'feishu_api_rejected', platformCode: 231001 }); } } });
  const failedState = await failing.feedback.start(failing.job);
  assert.equal(failedState.card, null);
  assert.deepEqual(failing.logs, [['warning', 'reply_ack', 'failed', { code: 'feishu_api_rejected', runId: 'run', platformCode: 231001 }]]);
});

test('the recorded mode survives retries and restarts: recovery in text mode builds no card even if the group is now card', async () => {
  const { feedback, job, effects } = feedbackFixture({ reply: { mode: 'card' }, result: { replyMode: TEXT } });
  const state = await feedback.restore({ ...job, recovered: true });
  assert.equal(state.card, null);
  assert.equal(feedback.restoreWaiting(job).card, null);
  await feedback.wait(job, state);
  await feedback.cleanup(job);
  assert.deepEqual(effects, [['typing:cleanup', undefined]], 'only the recovery Typing sweep runs; no card, no new record');

  const unrecorded = feedbackFixture();
  const restored = await unrecorded.feedback.restore(unrecorded.job);
  assert.equal(restored.card, null);
  assert.deepEqual(unrecorded.effects, [['typing:cleanup', undefined], ['patch', 'replyMode', TEXT]], 'a pre-upgrade job records its mode on recovery');

  const storeDown = feedbackFixture({ patchFeedback: async () => { throw Object.assign(new Error('down'), { code: 'store_unavailable' }); } });
  const continued = await storeDown.feedback.start(storeDown.job);
  assert.equal(continued.card, null, 'a failed record does not fail the turn');
  assert.deepEqual(storeDown.logs, [['warning', 'reply_mode', 'record_failed', { code: 'store_unavailable', runId: 'run' }]]);
});

test('a job that already has an execution card keeps the card path after a switch to text mode', async () => {
  const { feedback, job, effects } = feedbackFixture({ result: { executionCard: { messageId: 'card', entries: [], status: 'running' } } });
  const state = await feedback.start(job);
  assert.ok(state.card, 'the existing card is finished, not abandoned');
  assert.deepEqual(effects, [['typing:start']]);
  state.card.stop();
  await feedback.cleanup(job, { reaction: { reactionId: 'typing' } });
  assert.deepEqual(effects.at(-1), ['typing:cleanup', { reactionId: 'typing' }]);
  const recorded = feedbackFixture();
  await recorded.feedback.cleanup({ ...recorded.job, result: { ...recorded.job.result, processingReaction: { reactionId: 'old' } } });
  assert.deepEqual(recorded.effects, [['typing:cleanup', { reactionId: 'old' }]], 'a recorded Typing reaction is still removed');
});

function replyFixture({ replyPolicy = () => TEXT, answer = 'done', result: extra = {}, chat: overrides = {}, maxOutputChars } = {}) {
  const calls = [];
  const logs = [];
  const recorded = [];
  const chat = {
    async replyMessage(input) { calls.push(['reply', input]); return { message_id: `reply-${calls.length}` }; },
    async sendMessage(input) { calls.push(['create', input]); return { message_id: `create-${calls.length}` }; },
    ...overrides,
  };
  const job = { id: 'run', leaseOwner: 'worker', chatId: 'chat', chatType: 'group', deliveryMode: 'bridge', messageId: 'source', sourceMessageId: 'source',
    result: { execution: { threadId: 'thread', turnId: 'turn', terminal: 'completed' }, answer, attachments: [], ...extra } };
  const replies = createFeishuReplies({ chat, jobs: {}, connectionId: 'fixture', botOpenId: 'bot', replyPolicy, mentionAllGroupChatIds: new Set(),
    inbound: { async recordReply(value) { recorded.push(value); } }, log: (...entry) => logs.push(entry), ...(maxOutputChars ? { maxOutputChars } : {}) });
  return { replies, job, calls, logs, recorded };
}
const textOf = content => JSON.stringify(content);

test('text mode replies to the triggering message with text for one plain line and post otherwise', async () => {
  const plain = replyFixture({ answer: 'All set. See https://example.invalid/page' });
  const delivered = await plain.replies.deliver(plain.job, plain.job.result, { assertLease() {} });
  assert.equal(delivered.status, 'sent');
  assert.equal(plain.calls.length, 1);
  const [kind, input] = plain.calls[0];
  assert.equal(kind, 'reply');
  assert.deepEqual({ ...input, uuid: undefined }, { messageId: 'source', kind: 'text', content: { text: 'All set. See https://example.invalid/page' },
    replyInThread: false, uuid: undefined }, 'a bare URL stays a text message');
  assert.equal(input.uuid.length, 24);
  assert.deepEqual(plain.recorded, [{ messageId: 'reply-1', chatId: 'chat', chatType: 'group', messageType: 'text', senderOpenId: 'bot' }]);

  for (const answer of ['line one\nline two', '**bold**', 'See [the page](https://example.invalid/x)']) {
    const fixture = replyFixture({ answer });
    await fixture.replies.deliver(fixture.job, fixture.job.result, { assertLease() {} });
    assert.equal(fixture.calls.length, 1, answer);
    assert.equal(fixture.calls[0][0], 'reply');
    assert.equal(fixture.calls[0][1].kind, 'post', answer);
    assert.deepEqual(fixture.calls[0][1].content, markdownToFeishuPost(answer, { textMode: true }));
  }
});

test('text mode turns every at spelling into an at element and never prints an open_id', async () => {
  const cases = [
    [`<at user_id="${ID_A}">Name A</at> hi`, [{ tag: 'at', user_id: ID_A, user_name: 'Name A' }, { tag: 'text', text: ' hi' }]],
    [`<at user_id="${ID_A}"></at> hi`, [{ tag: 'at', user_id: ID_A }, { tag: 'text', text: ' hi' }]],
    [`<at open_id='${ID_A}'>Name A</at>`, [{ tag: 'at', user_id: ID_A, user_name: 'Name A' }]],
    [`<at id=${ID_A}>Name A</at>`, [{ tag: 'at', user_id: ID_A, user_name: 'Name A' }]],
    [`<at user_id = "${ID_A}" >Name A</at>`, [{ tag: 'at', user_id: ID_A, user_name: 'Name A' }]],
    [`<at user_id="ou_Mixed_Case-123">Name A</at>`, [{ tag: 'at', user_id: 'ou_Mixed_Case-123', user_name: 'Name A' }]],
    [`@{${ID_B}} hi`, [{ tag: 'at', user_id: ID_B }, { tag: 'text', text: ' hi' }]],
    [`<at user_id="${ID_A}">${ID_B}</at>`, [{ tag: 'at', user_id: ID_A }]],
  ];
  for (const [answer, expected] of cases) {
    const { replies, job, calls } = replyFixture({ answer });
    await replies.deliver(job, job.result, { assertLease() {} });
    assert.equal(calls[0][1].kind, 'post', answer);
    assert.deepEqual(calls[0][1].content.zh_cn.content[0], expected, answer);
  }
  const code = replyFixture({ answer: '```\n<at user_id="' + ID_A + '">Name A</at>\n```' });
  await code.replies.deliver(code.job, code.job.result, { assertLease() {} });
  assert.deepEqual(code.calls[0][1].content.zh_cn.content[1], [{ tag: 'at', user_id: ID_A, user_name: 'Name A' }], 'tags inside code blocks too');

  for (const answer of [`<at user_id="${ID_A}">A<B</at> x`, `<at user_id="${ID_A}">first\nsecond</at>`, `bare ${ID_A} and id=${ID_B}.`,
    `[link ${ID_A}](https://example.invalid/a)`]) {
    const { replies, job, calls } = replyFixture({ answer });
    await replies.deliver(job, job.result, { assertLease() {} });
    const shown = calls[0][1].content.zh_cn.content.flat().filter(element => ['text', 'a'].includes(element.tag)).map(element => element.text).join('\n');
    assert.doesNotMatch(shown, /ou_[A-Za-z0-9_-]{8,}/, answer);
    assert.match(shown, /@成员/, answer);
  }
  const notAnId = replyFixture({ answer: 'you_are_welcome_here' });
  await notAnId.replies.deliver(notAnId.job, notAnId.job.result, { assertLease() {} });
  assert.deepEqual(notAnId.calls[0][1].content, { text: 'you_are_welcome_here' }, 'only a standalone ou_ token is masked');

  // The card-mode fallback conversion is unchanged.
  assert.deepEqual(markdownToFeishuPost(`<at user_id="${ID_A}">Name A</at>`).zh_cn.content[0], [{ tag: 'text', text: `<at user_id="${ID_A}">Name A</at>` }]);
  assert.deepEqual(markdownToFeishuPost(`bare ${ID_A}`).zh_cn.content[0], [{ tag: 'text', text: `bare ${ID_A}` }]);
});

test('text mode chunks long answers as replies to the same message and keeps a mention intact', async () => {
  const mention = `<at user_id="${ID_A}">Name A</at>`;
  const answer = `${'a'.repeat(2990)}${mention}${'b'.repeat(100)}`;
  const { replies, job, calls } = replyFixture({ answer, maxOutputChars: 5000 });
  await replies.deliver(job, job.result, { assertLease() {} });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([kind, input]) => kind === 'reply' && input.messageId === 'source' && input.replyInThread === false));
  assert.equal(new Set(calls.map(([, input]) => input.uuid)).size, 2);
  assert.deepEqual(calls[1][1].content.zh_cn.content[0][0], { tag: 'at', user_id: ID_A, user_name: 'Name A' });
});

test('a failed turn in text mode sends one short text line without open_ids', async () => {
  const long = `Run failed:\n${'detail '.repeat(200)}`;
  for (const [answer, extra] of [['执行未完成，请稍后重试。', { failed: true }], [long, { failed: true }], ['执行已停止。', { turnStatus: 'interrupted' }],
    [`failed for ${ID_A}`, { failed: true }]]) {
    const { replies, job, calls } = replyFixture({ answer, result: extra });
    await replies.deliver(job, job.result, { assertLease() {} });
    assert.equal(calls.length, 1);
    const [kind, input] = calls[0];
    assert.equal(kind, 'reply');
    assert.equal(input.kind, 'text');
    assert.doesNotMatch(input.content.text, /\n|ou_[A-Za-z0-9_-]{8,}/);
    assert.ok(Array.from(input.content.text).length <= 200, input.content.text);
  }
});

const rejection = (platformCode, outcome = 'failed', code = 'feishu_api_rejected') => Object.assign(new Error(code), { code, outcome, platformCode });

test('only a recalled trigger falls back to a chat message; other rejections are raised with their real code', async () => {
  const fallback = replyFixture({ chat: { async replyMessage() { throw rejection(230011); } } });
  const delivered = await fallback.replies.deliver(fallback.job, fallback.job.result, { assertLease() {} });
  assert.equal(delivered.status, 'sent');
  assert.deepEqual(fallback.calls.map(([kind, input]) => [kind, input.conversationId]), [['create', 'chat']]);
  assert.deepEqual(fallback.logs.filter(([, operation, status]) => operation === 'forward_reply' && status !== 'succeeded'),
    [['warning', 'forward_reply', 'reply_rejected', { code: 'reply_target_gone', runId: 'run', platformCode: 230011 }]]);

  for (const platformCode of [230001, 230002, 230050, 230111]) {
    const other = replyFixture({ chat: { async replyMessage() { throw rejection(platformCode); } } });
    await assert.rejects(other.replies.deliver(other.job, other.job.result, { assertLease() {} }), { code: 'feishu_api_rejected', platformCode });
    assert.deepEqual(other.calls, [], `no create fallback for ${platformCode}`);
    assert.deepEqual(other.logs, [['warning', 'forward_reply', 'reply_failed', { code: 'feishu_api_rejected', stage: 'reply', runId: 'run', platformCode }]]);
  }

  const unknown = replyFixture({ chat: { async replyMessage() { throw rejection(undefined, 'unknown', 'feishu_transport_error'); } } });
  await assert.rejects(unknown.replies.deliver(unknown.job, unknown.job.result, { assertLease() {} }), { code: 'feishu_transport_error' });
  assert.deepEqual(unknown.calls, [], 'no duplicate create after an unconfirmed reply');
  assert.deepEqual(unknown.logs, [], 'the forward runtime records the pending delivery');
});

test('a recalled trigger whose chat fallback also fails is logged once and retried later', async () => {
  const { replies, job, calls, logs } = replyFixture({ chat: {
    async replyMessage() { throw rejection(230011); },
    async sendMessage(input) { calls.push(['create', input]); throw rejection(230002); } } });
  await assert.rejects(replies.deliver(job, job.result, { assertLease() {} }), { code: 'feishu_api_rejected', platformCode: 230002 });
  assert.deepEqual(calls.map(([kind]) => kind), ['create']);
  assert.deepEqual(logs, [['warning', 'forward_reply', 'reply_failed', { code: 'feishu_api_rejected', stage: 'create', runId: 'run', platformCode: 230002, replyPlatformCode: 230011 }]]);
});

test('card mode, a recorded card mode and jobs with an existing card keep the original create path', async () => {
  for (const fixture of [replyFixture({ replyPolicy: () => null }), replyFixture({ result: { replyMode: { mode: 'card' } } }),
    replyFixture({ result: { executionCard: { messageId: 'card', delivery: 'fallback' } } })]) {
    await fixture.replies.deliver(fixture.job, fixture.job.result, { assertLease() {} });
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0][0], 'create');
    assert.equal(fixture.calls[0][1].kind, 'post');
  }
});

const FEEDBACK_KEYS = ['executionCard', 'typing', 'stop', 'delivery', 'replyMode'];
const withoutLocal = ({ executionCard, typing, stop, userInput, ...rest }) => rest;
function memoryJobs() {
  let job = { id: 'run', callerId: 'live', chatId: 'chat', chatType: 'group', messageId: 'source', sourceMessageId: 'source', senderOpenId: 'human',
    senderName: 'Human', deliveryMode: 'bridge', prompt: 'work', attempts: 0, status: 'pending', result: {}, createdAt: 1, leaseOwner: '' };
  const claim = async ({ owner }) => job.status === 'pending' ? (job = { ...job, status: 'running', leaseOwner: owner, attempts: job.attempts + 1 }) : null;
  const finish = async ({ status, result, replySent }) => { job = { ...job, status, replySent, result: { ...job.result, ...withoutLocal(structuredClone(result)) } }; };
  return { get job() { return job; }, upsert: async () => ({ ...job, duplicate: false }), getByMessageId: async () => null, getRun: async () => job,
    claimById: claim, claim: async input => { const value = await claim(input); return value ? [value] : []; },
    claimReplyById: async ({ owner }) => job.status === 'reply_pending' ? (job = { ...job, leaseOwner: owner }) : null,
    claimReplyPending: async () => [], renew: async () => ({ renewed: true }),
    patchFeedback: async ({ key, value }) => {
      if (!FEEDBACK_KEYS.includes(key)) throw Object.assign(new Error('invalid'), { code: 'invalid_store_input' });
      job = { ...job, result: { ...job.result, [key]: structuredClone(value) } };
    },
    markReplyPending: async ({ result }) => { job = { ...job, status: 'reply_pending', result: { ...job.result, ...withoutLocal(structuredClone(result)) } }; },
    markFinished: finish, markFinishedWithoutReply: finish,
    markRetry: async input => { job = { ...job, status: 'pending', last_error: input.errorCode, nextAttemptAt: input.nextAttemptAt, leaseOwner: '' }; } };
}

async function runTurn(executorResult, group = { reply: TEXT }) {
  const routing = validateConfig({ ...base, routing: { ...base.routing, groups: [{ conversationId: 'chat', trigger: 'all', passiveContext: true,
    silentReply: { tokens: ['NO_REPLY'] }, ...group }] } }).routing;
  const replyPolicy = job => resolveReplyPolicy(routing, job);
  const platform = [];
  const chat = {
    async replyMessage(input) { platform.push(['reply', input.kind]); return { message_id: 'reply' }; },
    async sendMessage(input) { platform.push(['create', input.kind]); return { message_id: 'create' }; },
    async addReaction(input) { platform.push(['reaction', input.emojiType]); return { reaction_id: 'ack' }; },
    async removeReaction() { platform.push(['reaction:remove']); },
    async listReactions() { platform.push(['reaction:list']); return { items: [] }; },
    async deleteMessage() { platform.push(['delete']); },
  };
  const cardClient = { im: { v1: { message: {
    async create(request) { platform.push(['card:create', request.data.msg_type]); return { code: 0, data: { message_id: 'card' } }; },
    async patch() { platform.push(['card:patch']); return { code: 0 }; },
  } } } };
  const jobs = memoryJobs();
  const typing = { async start() { platform.push(['typing:start']); return { reactionId: 'typing' }; }, async cleanup() { platform.push(['typing:cleanup']); } };
  const feedback = createExecutionFeedback({ jobs, sessions: { async loadBinding() { return null; }, async readPublicProgress() { return []; } },
    chat, typing, cardClient, executor: {}, config: { replyPolicy } });
  const replies = createFeishuReplies({ chat, jobs, connectionId: 'fixture', replyPolicy });
  let executions = 0;
  const executor = { async execute() { executions += 1; return { threadId: 'thread', turnId: 'turn', ...executorResult }; } };
  const runtime = createForwardRuntime({ config: { owner: 'owner', pollMs: 600_000, leaseMs: 10_000,
    silentReply: job => resolveSilentReplyPolicy(routing, job) }, jobs, sessions: {}, executor, feedback, replies });
  await runtime.handleMessage({ source: 'live', callerId: 'live', idempotencyKey: 'live:test:chat:source',
    message: { messageId: 'source', conversationId: 'chat', conversationType: 'group', type: 'text' },
    actor: { openId: 'human', name: 'Human' }, prompt: 'work', deliveryMode: 'bridge' });
  await runtime.stop();
  return { platform, job: jobs.job, executions };
}

test('a text-mode turn replies once without any card, and NO_REPLY sends nothing', async () => {
  const answered = await runTurn({ answer: 'Done.' });
  assert.deepEqual(answered.platform, [['reply', 'text']]);
  assert.equal(answered.job.status, 'completed');
  assert.equal(answered.job.replySent, true);
  assert.deepEqual(answered.job.result.replyMode, TEXT, 'the mode recorded at turn start stays on the job');

  const silent = await runTurn({ answer: 'NO_REPLY' });
  assert.deepEqual(silent.platform, [], 'no card, reaction, message or recall');
  assert.equal(silent.job.status, 'completed');
  assert.deepEqual(silent.job.result.silentReply, { status: 'silent', card: 'none' });

  const acked = await runTurn({ answer: 'NO_REPLY' }, { reply: { mode: 'text', ack: 'reaction' } });
  assert.deepEqual(acked.platform, [['reaction', 'OnIt']], 'only the configured acknowledgement remains');
});

test('a steered text-mode message sends nothing itself; the running turn answers once', async () => {
  const steered = await runTurn({ deferred: true, accepted: true, answer: '' });
  assert.deepEqual(steered.platform, []);
  assert.equal(steered.job.status, 'deferred');
  assert.equal(steered.executions, 1);
});

test('a group without the reply key keeps the execution card path end to end', async () => {
  const carded = await runTurn({ answer: 'Done.' }, {});
  assert.deepEqual(carded.platform, [['typing:start'], ['card:create', 'interactive'], ['typing:cleanup']]);
  assert.equal(carded.job.result.replyMode, undefined, 'nothing is recorded for a group without the key');
  assert.equal(carded.job.status, 'completed');
});
