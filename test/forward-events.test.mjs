import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildBusinessEventPrompt, buildInitialPrompt } from '../src/agents/codex/prompt.mjs';
import { createForwardRuntime } from '../src/core/forward-runtime.mjs';

const input = {
  producerId: 'custom-order', eventId: 'mail:one', scope: 'custom-order:customer:one', type: 'mail.inbound',
  correlationId: 'inquiry-one', occurredAt: '2026-09-20T00:00:00Z', refIds: { message_id: 'mail-one' },
  prompt: 'Read the referenced mail.', chatId: 'synthetic-chat', requestHash: 'a'.repeat(64),
};

function eventJobs({ now = Date.now } = {}) {
  let job;
  let registeredInput;
  const retries = [];
  let recoverLoads = 0;
  return {
    get registeredInput() { return registeredInput; },
    get retries() { return retries; },
    get job() { return job; },
    get recoverLoads() { return recoverLoads; },
    async upsert(value) {
      registeredInput = structuredClone(value);
      job = { id: '00000000-0000-4000-8000-000000000001', status: 'pending', attempts: 0, leaseOwner: '',
        callerId: value.callerId, chatId: value.conversationId, chatType: value.chatType, messageId: value.messageId,
        sourceMessageId: value.sourceMessageId, senderOpenId: value.senderOpenId, senderName: value.senderName,
        executionNamespace: value.executionNamespace, deliveryMode: value.deliveryMode, prompt: value.prompt,
        contextEntries: value.contextEntries, groupChatContext: null, result: structuredClone(value.initialResult), updatedAt: 1 };
      return { ...job, duplicate: false };
    },
    async getRun() { return job && structuredClone(job); },
    async getByIdempotencyKey() { return job && structuredClone(job); },
    async claimById({ owner }) {
      if (job.status !== 'pending' || (job.nextAttemptAt != null && job.nextAttemptAt > now())) return null;
      Object.assign(job, { status: 'running', leaseOwner: owner, attempts: job.attempts + 1 });
      return structuredClone(job);
    },
    async claimReplyById({ owner }) {
      if (job.status !== 'reply_pending') return null;
      job.leaseOwner = owner;
      return structuredClone(job);
    },
    async claimReplyPending() { return []; },
    async loadRecoverable() {
      recoverLoads += 1;
      return job?.status === 'pending' && (job.nextAttemptAt == null || job.nextAttemptAt <= now()) ? [structuredClone(job)] : [];
    },
    async renew() {},
    async markReplyPending({ result }) { Object.assign(job, { status: 'reply_pending', result }); },
    async markFinished({ status, result }) { Object.assign(job, { status, result, leaseOwner: '', updatedAt: 2 }); },
    async markRetry(value) {
      retries.push(value);
      Object.assign(job, { status: 'pending', leaseOwner: '', nextAttemptAt: value.nextAttemptAt });
    },
  };
}

test('event job uses caller delivery and steer busy policy', async t => {
  const jobs = eventJobs();
  const executions = [];
  const runtime = createForwardRuntime({ config: { owner: 'event-test', pollMs: 60_000, steering: true }, jobs, sessions: {},
    executor: { async execute(value) { executions.push(value); return { answer: 'done', threadId: 'thread', turnId: 'turn' }; } }, replies: {} });
  runtime.start();
  t.after(() => runtime.stop());
  const registered = await runtime.registerEvent(input);
  for (let count = 0; count < 100 && !executions.length; count += 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(registered.deduplicated, false);
  assert.equal(jobs.registeredInput.callerId, 'custom-order');
  assert.equal(jobs.registeredInput.executionNamespace, 'custom-order:customer:one');
  assert.equal(jobs.registeredInput.deliveryMode, 'caller');
  assert.equal(jobs.registeredInput.idempotencyKey, 'event\0custom-order\0mail:one');
  assert.equal(jobs.registeredInput.messageId,
    `event:${createHash('sha256').update('custom-order\0mail:one').digest('hex')}`);
  assert.equal(jobs.registeredInput.messageId.length, 70);
  assert.equal(jobs.registeredInput.senderOpenId, 'system:custom-order');
  assert.equal(executions[0].busyPolicy, 'steer');
  assert.equal(executions[0].bindingOpenId, registered.bindingOpenId);
});

test('event job prompt carries business event block', async () => {
  const jobs = eventJobs();
  const runtime = createForwardRuntime({ jobs, sessions: {}, executor: {}, replies: {} });
  const registered = await runtime.registerEvent(input);
  assert.match(jobs.registeredInput.prompt, /^【业务事件】/m);
  assert.match(jobs.registeredInput.prompt, /type：mail\.inbound/);
  assert.match(jobs.registeredInput.prompt, /event_id：mail:one/);
  assert.match(jobs.registeredInput.prompt, /ref_ids\.message_id：mail-one/);
  assert.match(jobs.registeredInput.prompt, /Read the referenced mail\.$/);
  const initial = buildInitialPrompt({ binding: { feishuOpenId: registered.bindingOpenId, chatId: 'synthetic-chat', chatType: 'group' },
    prompt: jobs.registeredInput.prompt });
  assert.match(initial, /^【独立系统任务】/);
  assert.match(initial, /【业务事件】/);
  assert.equal(buildBusinessEventPrompt(input).split('\n').length, 8,
    'validated single-line correlation_id cannot add prompt metadata lines');
});

test('event job leaves an unconfirmed steer recoverable and re-executes it', async () => {
  let clock = 1_000;
  const jobs = eventJobs({ now: () => clock });
  let executions = 0;
  const runtime = createForwardRuntime({ config: { owner: 'event-retry', pollMs: 60_000, retryDelayMs: 10_000, steering: true },
    jobs, sessions: {}, executor: { async execute() {
      executions += 1;
      if (executions === 1) throw Object.assign(new Error('steer delivery unconfirmed'), { code: 'CODEX_STEER_UNCONFIRMED' });
      return { answer: 'done', threadId: 'thread', turnId: 'turn' };
    } }, replies: {}, now: () => clock });
  await runtime.registerEvent(input);
  await runtime.recover();
  assert.equal(jobs.retries.length, 1);
  assert.equal(jobs.retries[0].nextAttemptAt, 11_000);
  assert.equal(jobs.job.status, 'pending');
  clock = 11_000;
  await runtime.recover();
  assert.equal(jobs.recoverLoads, 2);
  assert.equal(executions, 2);
  assert.equal(jobs.job.status, 'completed');
});

test('event keys isolate delimiters, case, and maximum identifiers', async () => {
  const rows = new Map();
  let sequence = 0;
  const jobs = {
    async upsert(value) {
      const key = `${value.callerId}\0${value.idempotencyKey}`;
      const existing = rows.get(key);
      if (existing) return { ...existing, duplicate: true };
      const row = { id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`, callerId: value.callerId,
        executionNamespace: value.executionNamespace, messageId: value.messageId, status: 'pending', updatedAt: sequence };
      rows.set(key, row);
      return { ...row, duplicate: false };
    },
    async getByIdempotencyKey({ callerId, idempotencyKey }) { return rows.get(`${callerId}\0${idempotencyKey}`) || null; },
  };
  const runtime = createForwardRuntime({ jobs, sessions: {}, executor: {}, replies: {} });
  const variants = [
    { ...input, producerId: 'a:b', eventId: 'c' },
    { ...input, producerId: 'a', eventId: 'b:c' },
    { ...input, eventId: 'Mail' },
    { ...input, eventId: 'mail' },
    { ...input, producerId: 'h'.repeat(128), eventId: 'e'.repeat(128) },
  ];
  const registered = [];
  for (const value of variants) registered.push(await runtime.registerEvent(value));
  assert.equal(new Set(registered.map(value => value.jobId)).size, variants.length);
  assert.notEqual(registered[0].jobId, registered[1].jobId);
  assert.notEqual(registered[2].jobId, registered[3].jobId);
  assert.notEqual([...rows.values()][0].messageId, [...rows.values()][1].messageId);
  assert.notEqual([...rows.values()][2].messageId, [...rows.values()][3].messageId);
  for (const row of rows.values()) assert.equal(row.messageId.length, 70);
  assert.equal((await runtime.getEvent({ producerId: variants[4].producerId, eventId: variants[4].eventId })).jobId,
    registered[4].jobId);
});
