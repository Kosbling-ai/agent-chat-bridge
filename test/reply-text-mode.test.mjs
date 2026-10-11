import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../src/config.mjs';
import { resolveTextReplyPolicy } from '../src/core/reply-mode.mjs';
import { resolveSilentReplyPolicy } from '../src/core/silent-reply.mjs';
import { createForwardRuntime } from '../src/core/forward-runtime.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';
import { createExecutionFeedback } from '../src/channels/feishu/execution-feedback.mjs';
import { createFeishuReplies, markdownToFeishuPost } from '../src/channels/feishu/replies.mjs';

const bin = fileURLToPath(new URL('../bin/agent-chat-bridge.mjs', import.meta.url));
const base = { schemaVersion: 1,
  storage: Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `TEST_${key.toUpperCase()}`])),
  codex: { bin: './codex', cwd: './workspace', envNames: [] },
  feishu: { connectionId: 'test', appIdEnv: 'TEST_APP', appSecretEnv: 'TEST_SECRET', botOpenId: 'bot' },
  routing: { version: '1', privateUserIds: ['human'], groups: [{ conversationId: 'chat', trigger: 'mention', passiveContext: true }] }, hooks: [] };
const withGroup = fields => ({ ...base, routing: { ...base.routing, groups: [{ ...base.routing.groups[0], ...fields }] } });
const flush = () => new Promise(resolve => setTimeout(resolve, 20));

test('reply config is optional, defaults to card and normalizes text mode with its acknowledgement', () => {
  const plain = validateConfig(base).routing.groups[0];
  assert.equal(Object.hasOwn(plain, 'reply'), false, 'configurations without the key keep their normalized shape');
  assert.deepEqual(validateConfig(withGroup({ reply: {} })).routing.groups[0].reply, { mode: 'card' });
  assert.deepEqual(validateConfig(withGroup({ reply: { mode: 'card' } })).routing.groups[0].reply, { mode: 'card' });
  assert.deepEqual(validateConfig(withGroup({ reply: { mode: 'text' } })).routing.groups[0].reply, { mode: 'text', ack: 'none' });
  assert.deepEqual(validateConfig(withGroup({ reply: { mode: 'text', ack: 'none' } })).routing.groups[0].reply, { mode: 'text', ack: 'none' });
  assert.deepEqual(validateConfig(withGroup({ reply: { mode: 'text', ack: 'reaction' } })).routing.groups[0].reply,
    { mode: 'text', ack: 'reaction', ackEmoji: 'GLANCE' });
  assert.deepEqual(validateConfig(withGroup({ reply: { mode: 'text', ack: 'reaction', ackEmoji: 'OnIt' } })).routing.groups[0].reply,
    { mode: 'text', ack: 'reaction', ackEmoji: 'OnIt' });
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
    feishu: { ...base.feishu, processingReactionEmoji: 'OnIt' } }));
  assert.throws(() => validateConfig(withGroup({ capabilities: ['hook'], reply: { mode: 'text' } })), { code: 'group_context_requires_bridge' });
});

test('check-config accepts the new keys and reports a bad value by code', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-reply-mode-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'bridge.json');
  const run = () => spawnSync(process.execPath, [bin, 'check-config', '--config', path], { encoding: 'utf8', timeout: 20000 });
  await writeFile(path, JSON.stringify({ ...base, routing: { ...base.routing, silentReply: { tokens: ['NO_REPLY'] }, groups: [
    { conversationId: 'approval', trigger: 'mention', replyTriggers: true, passiveContext: true, reply: { mode: 'text' } },
    { conversationId: 'production', trigger: 'all', passiveContext: true, reply: { mode: 'text', ack: 'reaction' } },
  ] } }));
  const passed = run();
  assert.equal(passed.status, 0, passed.stdout);
  assert.match(passed.stdout, /"operation":"check_config","status":"succeeded"/);
  await writeFile(path, JSON.stringify(withGroup({ reply: { mode: 'thread' } })));
  const failed = run();
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout + failed.stderr, /invalid_group_reply_mode/);
});

test('text policy applies only to bridge-delivered jobs in listed bridge groups set to text', () => {
  const routing = validateConfig({ ...base, routing: { ...base.routing, groups: [
    { conversationId: 'text', trigger: 'mention', passiveContext: true, reply: { mode: 'text' } },
    { conversationId: 'card', trigger: 'mention', passiveContext: true, reply: { mode: 'card' } },
    { conversationId: 'default', trigger: 'mention', passiveContext: true },
    { conversationId: 'hook', trigger: 'mention', passiveContext: true, capabilities: ['hook'] },
  ] } }).routing;
  const job = fields => ({ chatId: 'text', chatType: 'group', deliveryMode: 'bridge', ...fields });
  assert.deepEqual(resolveTextReplyPolicy(routing, job()), { mode: 'text', ack: 'none' });
  for (const fields of [{ chatId: 'card' }, { chatId: 'default' }, { chatId: 'hook' }, { chatId: 'unlisted' },
    { chatType: 'p2p' }, { deliveryMode: 'caller' }]) assert.equal(resolveTextReplyPolicy(routing, job(fields)), null, JSON.stringify(fields));
});

test('trigger all starts the Agent for every fresh human message but never for bots, itself or stale messages', async () => {
  const now = 1_800_000_000_000;
  const config = validateConfig(withGroup({ trigger: 'all', reply: { mode: 'text' } }));
  const forwarded = [];
  const runtime = createCommunicationRuntime({ config, now: () => now, store: { acceptInbound: async () => ({ duplicate: false }) },
    forward: { handleMessage: async input => { forwarded.push(input.message.messageId); return { execution: { terminal: 'completed' } }; } }, chat: {} });
  const event = (id, fields = {}) => ({ connectionId: 'test', source: 'live', eventKey: id, type: 'message.received', conversationId: 'chat',
    conversationType: 'group', messageId: id, occurredAt: now, actor: { type: 'user', openId: 'human', name: 'Human' },
    message: { kind: 'text', content: JSON.stringify({ text: `成本 ${id}` }), createTime: String(now), mentions: [] }, ...fields });
  await runtime.ingest(event('human'));
  await runtime.ingest(event('app', { isApp: true, actor: { type: 'app', appId: 'other-bot' } }));
  await runtime.ingest(event('self', { isSelf: true }));
  await runtime.ingest(event('stale', { occurredAt: now - 11 * 60 * 1000,
    message: { kind: 'text', content: '{"text":"old"}', createTime: String(now - 11 * 60 * 1000), mentions: [] } }));
  await new Promise(setImmediate);
  assert.deepEqual(forwarded, ['human']);
});

function feedbackFixture({ reply = { mode: 'text', ack: 'none' }, result = {}, chat: chatOverrides = {} } = {}) {
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
    jobs: { async patchFeedback(value) { effects.push(['patch', value.key]); } },
    sessions: { async loadBinding() { return null; }, async readPublicProgress() { return []; } },
    chat,
    typing: { async start() { effects.push(['typing:start']); return { reactionId: 'typing' }; }, async cleanup(_job, reaction) { effects.push(['typing:cleanup', reaction]); } },
    cardClient: { im: { v1: { message: {
      async create() { effects.push(['card:create']); return { code: 0, data: { message_id: 'card' } }; },
      async patch() { effects.push(['card:patch']); return { code: 0 }; },
    } } } },
    executor: {},
    config: { textReply: () => reply },
    log: (...entry) => logs.push(entry),
  });
  return { feedback, job, effects, logs };
}

test('text mode feedback creates no card and no Typing, and acknowledges only when configured', async () => {
  const { feedback, job, effects } = feedbackFixture();
  const state = await feedback.start(job);
  assert.equal(state.card, null);
  assert.equal(feedback.observe(job, state, { bindingOpenId: 'group:binding' }), null);
  const result = { ...job.result, answer: 'done' };
  await feedback.prepare(job, result, state);
  assert.equal(result.executionCard, undefined);
  assert.equal(await feedback.finish(job, result), false, 'the reply module sends the answer');
  assert.equal(await feedback.finishSilent(job, result, { tokens: ['NO_REPLY'], card: 'delete' }), 'none');
  await feedback.cleanup({ ...job, result });
  await flush();
  assert.deepEqual(effects, [], 'nothing reaches Feishu or the store');

  const acked = feedbackFixture({ reply: { mode: 'text', ack: 'reaction', ackEmoji: 'GLANCE' } });
  const ackState = await acked.feedback.start(acked.job);
  await acked.feedback.cleanup(acked.job, { reaction: ackState.typing });
  await flush();
  assert.deepEqual(acked.effects, [['reaction', { messageId: 'source', emojiType: 'GLANCE' }]], 'the acknowledgement is added once and left');

  const failing = feedbackFixture({ reply: { mode: 'text', ack: 'reaction', ackEmoji: 'GLANCE' },
    chat: { async addReaction() { throw Object.assign(new Error('rejected'), { code: 'feishu_api_rejected', platformCode: 231001 }); } } });
  const failedState = await failing.feedback.start(failing.job);
  assert.equal(failedState.card, null);
  assert.deepEqual(failing.logs, [['warning', 'reply_ack', 'failed', { code: 'feishu_api_rejected', runId: 'run', platformCode: 231001 }]]);
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

function replyFixture({ textReply = () => ({ mode: 'text', ack: 'none' }), answer = 'done', result: extra = {}, chat: overrides = {}, maxOutputChars } = {}) {
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
  const replies = createFeishuReplies({ chat, jobs: {}, connectionId: 'fixture', botOpenId: 'bot', textReply, mentionAllGroupChatIds: new Set(),
    inbound: { async recordReply(value) { recorded.push(value); } }, log: (...entry) => logs.push(entry), ...(maxOutputChars ? { maxOutputChars } : {}) });
  return { replies, job, calls, logs, recorded };
}

test('text mode replies to the triggering message with text for one plain line and post otherwise', async () => {
  const plain = replyFixture({ answer: '收到，已登记成本。' });
  const delivered = await plain.replies.deliver(plain.job, plain.job.result, { assertLease() {} });
  assert.equal(delivered.status, 'sent');
  assert.equal(plain.calls.length, 1);
  const [kind, input] = plain.calls[0];
  assert.equal(kind, 'reply');
  assert.deepEqual({ ...input, uuid: undefined }, { messageId: 'source', kind: 'text', content: { text: '收到，已登记成本。' }, replyInThread: false, uuid: undefined });
  assert.equal(input.uuid.length, 24);
  assert.deepEqual(plain.recorded, [{ messageId: 'reply-1', chatId: 'chat', chatType: 'group', messageType: 'text', senderOpenId: 'bot' }]);

  for (const answer of ['第一行\n第二行', '**已发送**', '见 [看板](https://example.invalid/x)']) {
    const fixture = replyFixture({ answer });
    await fixture.replies.deliver(fixture.job, fixture.job.result, { assertLease() {} });
    assert.equal(fixture.calls.length, 1, answer);
    assert.equal(fixture.calls[0][0], 'reply');
    assert.equal(fixture.calls[0][1].kind, 'post', answer);
    assert.deepEqual(fixture.calls[0][1].content, markdownToFeishuPost(answer, { mentionNames: true }));
  }
});

test('text mode mentions become post at nodes with open_id and name and never print the open_id', async () => {
  const answer = '<at user_id="ou_abc123">Lily</at> 请确认报价\n@{ou_def456} 已转制作';
  const { replies, job, calls } = replyFixture({ answer });
  await replies.deliver(job, job.result, { assertLease() {} });
  const post = calls[0][1].content;
  assert.equal(calls[0][1].kind, 'post');
  assert.deepEqual(post.zh_cn.content[0], [{ tag: 'at', user_id: 'ou_abc123', user_name: 'Lily' }, { tag: 'text', text: ' 请确认报价' }]);
  assert.deepEqual(post.zh_cn.content[1], [{ tag: 'at', user_id: 'ou_def456' }, { tag: 'text', text: ' 已转制作' }]);
  const texts = post.zh_cn.content.flat().filter(element => element.tag === 'text').map(element => element.text).join('');
  assert.doesNotMatch(texts, /ou_/);
  // The card-mode fallback conversion is unchanged: a named tag stays literal there.
  assert.deepEqual(markdownToFeishuPost('<at user_id="ou_abc123">Lily</at>').zh_cn.content[0], [{ tag: 'text', text: '<at user_id="ou_abc123">Lily</at>' }]);
});

test('text mode chunks long answers as replies to the same message and keeps a named mention intact', async () => {
  const mention = '<at user_id="ou_abc123">Lily</at>';
  const answer = `${'甲'.repeat(2990)}${mention}${'乙'.repeat(100)}`;
  const { replies, job, calls } = replyFixture({ answer, maxOutputChars: 5000 });
  await replies.deliver(job, job.result, { assertLease() {} });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([kind, input]) => kind === 'reply' && input.messageId === 'source' && input.replyInThread === false));
  assert.equal(new Set(calls.map(([, input]) => input.uuid)).size, 2);
  assert.deepEqual(calls[1][1].content.zh_cn.content[0][0], { tag: 'at', user_id: 'ou_abc123', user_name: 'Lily' });
});

test('a failed turn in text mode sends one short text line', async () => {
  const long = `Codex 执行失败：\n${'细节 '.repeat(200)}`;
  for (const [answer, extra] of [['执行未完成，请稍后重试。', { failed: true }], [long, { failed: true }], ['执行已停止。', { turnStatus: 'interrupted' }]]) {
    const { replies, job, calls } = replyFixture({ answer, result: extra });
    await replies.deliver(job, job.result, { assertLease() {} });
    assert.equal(calls.length, 1);
    const [kind, input] = calls[0];
    assert.equal(kind, 'reply');
    assert.equal(input.kind, 'text');
    assert.doesNotMatch(input.content.text, /\n/);
    assert.ok(Array.from(input.content.text).length <= 200, input.content.text);
  }
});

test('a rejected reply is sent to the chat instead, while an unconfirmed reply is retried later', async () => {
  const rejected = Object.assign(new Error('feishu_api_rejected'), { code: 'feishu_api_rejected', outcome: 'failed', platformCode: 230011 });
  const fallback = replyFixture({ chat: { async replyMessage() { throw rejected; } } });
  const delivered = await fallback.replies.deliver(fallback.job, fallback.job.result, { assertLease() {} });
  assert.equal(delivered.status, 'sent');
  assert.equal(fallback.calls.length, 1);
  assert.equal(fallback.calls[0][0], 'create');
  assert.equal(fallback.calls[0][1].conversationId, 'chat');
  assert.deepEqual(fallback.logs.find(([, , status]) => status === 'reply_rejected'),
    ['warning', 'forward_reply', 'reply_rejected', { code: 'reply_target_rejected', runId: 'run', platformCode: 230011 }]);

  const unknown = Object.assign(new Error('feishu_transport_error'), { code: 'feishu_transport_error', outcome: 'unknown' });
  const pending = replyFixture({ chat: { async replyMessage() { throw unknown; } } });
  await assert.rejects(pending.replies.deliver(pending.job, pending.job.result, { assertLease() {} }), { code: 'feishu_transport_error' });
  assert.deepEqual(pending.calls, [], 'no duplicate create after an unconfirmed reply');
});

test('card mode and jobs with an existing card keep the original create path', async () => {
  for (const fixture of [replyFixture({ textReply: () => null, answer: 'done' }),
    replyFixture({ answer: 'done', result: { executionCard: { messageId: 'card', delivery: 'fallback' } } })]) {
    await fixture.replies.deliver(fixture.job, fixture.job.result, { assertLease() {} });
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0][0], 'create');
    assert.equal(fixture.calls[0][1].kind, 'post');
  }
});

function memoryJobs(initial) {
  let job = { id: 'run', callerId: 'live', chatId: 'chat', chatType: 'group', messageId: 'source', sourceMessageId: 'source', senderOpenId: 'human',
    senderName: 'Human', deliveryMode: 'bridge', prompt: 'work', attempts: 0, status: 'pending', result: {}, createdAt: 1, leaseOwner: '', ...initial };
  const claim = async ({ owner }) => job.status === 'pending' ? (job = { ...job, status: 'running', leaseOwner: owner, attempts: job.attempts + 1 }) : null;
  const finish = async ({ status, result, replySent }) => { job = { ...job, status, result, replySent }; };
  return { get job() { return job; }, upsert: async () => ({ ...job, duplicate: false }), getByMessageId: async () => null, getRun: async () => job,
    claimById: claim, claim: async input => { const value = await claim(input); return value ? [value] : []; },
    claimReplyById: async ({ owner }) => job.status === 'reply_pending' ? (job = { ...job, leaseOwner: owner }) : null,
    claimReplyPending: async () => [], renew: async () => ({ renewed: true }),
    patchFeedback: async ({ key, value }) => { job = { ...job, result: { ...job.result, [key]: structuredClone(value) } }; },
    markReplyPending: async ({ result }) => { job = { ...job, status: 'reply_pending', result: structuredClone(result) }; },
    markFinished: finish, markFinishedWithoutReply: finish,
    markRetry: async input => { job = { ...job, status: 'pending', last_error: input.errorCode, nextAttemptAt: input.nextAttemptAt, leaseOwner: '' }; } };
}

async function runTextTurn(answer, reply = { mode: 'text', ack: 'none' }) {
  const routing = validateConfig({ ...base, routing: { ...base.routing, groups: [{ conversationId: 'chat', trigger: 'all', passiveContext: true,
    silentReply: { tokens: ['NO_REPLY'] }, reply }] } }).routing;
  const textReply = job => resolveTextReplyPolicy(routing, job);
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
    async create() { platform.push(['card:create']); return { code: 0, data: { message_id: 'card' } }; },
    async patch() { platform.push(['card:patch']); return { code: 0 }; },
  } } } };
  const jobs = memoryJobs();
  const typing = { async start() { platform.push(['typing:start']); return { reactionId: 'typing' }; }, async cleanup() { platform.push(['typing:cleanup']); } };
  const feedback = createExecutionFeedback({ jobs, sessions: { async loadBinding() { return null; }, async readPublicProgress() { return []; } },
    chat, typing, cardClient, executor: {}, config: { textReply } });
  const replies = createFeishuReplies({ chat, jobs, connectionId: 'fixture', textReply });
  const executor = { async execute() { return { answer, threadId: 'thread', turnId: 'turn' }; } };
  const runtime = createForwardRuntime({ config: { owner: 'owner', pollMs: 600_000, leaseMs: 10_000,
    silentReply: job => resolveSilentReplyPolicy(routing, job) }, jobs, sessions: {}, executor, feedback, replies });
  await runtime.handleMessage({ source: 'live', callerId: 'live', idempotencyKey: 'live:test:chat:source',
    message: { messageId: 'source', conversationId: 'chat', conversationType: 'group', type: 'text' },
    actor: { openId: 'human', name: 'Human' }, prompt: 'work', deliveryMode: 'bridge' });
  await runtime.stop();
  return { platform, job: jobs.job };
}

test('a text-mode turn replies once without any card, and NO_REPLY leaves no trace', async () => {
  const answered = await runTextTurn('已登记：成本 USD 12。');
  assert.deepEqual(answered.platform, [['reply', 'text']]);
  assert.equal(answered.job.status, 'completed');
  assert.equal(answered.job.replySent, true);

  const silent = await runTextTurn('NO_REPLY');
  assert.deepEqual(silent.platform, [], 'no card, reaction, message or recall');
  assert.equal(silent.job.status, 'completed');
  assert.deepEqual(silent.job.result.silentReply, { status: 'silent', card: 'none' });

  const acked = await runTextTurn('NO_REPLY', { mode: 'text', ack: 'reaction' });
  assert.deepEqual(acked.platform, [['reaction', 'GLANCE']], 'only the configured acknowledgement remains');
});
