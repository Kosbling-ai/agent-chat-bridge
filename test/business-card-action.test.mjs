import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessCardAction } from '../src/channels/feishu/business-card-action.mjs';
import { createFeishuAdapter } from '../src/channels/feishu/adapter.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';
import { createLogger } from '../src/logger.mjs';

class Dispatcher { register(handlers) { this.handlers = handlers; return this; } }

const hook = { id: 'orders', url: 'https://business.invalid/hook', tokenEnv: 'HOOK_TOKEN', conversationIds: ['chat-1'] };
const payload = {
  event_id: 'event-1', create_time: '1700000000000', operator: { open_id: 'operator-1', name: 'Operator' },
  context: { open_chat_id: 'chat-1', open_message_id: 'message-1' },
  action: { value: { action: 'business', hook_id: 'orders', kind: 'approve', action_id: 'action-1', version: 2 } },
};

function harness({ holdAccept = false, registrationTimeoutMs = 2000 } = {}) {
  const rows = new Map(); const deliveries = []; const operations = []; const logs = []; let release;
  const gate = holdAccept ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  const store = {
    async acceptInbound(input) {
      await gate;
      const hash = JSON.stringify(input.semanticPayload);
      const existing = rows.get(input.eventKey);
      if (existing) {
        if (existing.hash !== hash) throw Object.assign(new Error('conflicting payload'), { code: 'inbound_conflict' });
        return { duplicate: true, hookJobIds: [existing.job.id] };
      }
      const job = { id: `hook-${rows.size + 1}`, kind: 'hook', hookId: input.hooks[0].hookId,
        payload: JSON.stringify(input.hooks[0].payload), attempts: 0, status: 'pending' };
      rows.set(input.eventKey, { hash, job });
      return { duplicate: false, hookJobIds: [job.id] };
    },
    async claimJobs() {
      const job = [...rows.values()].map(row => row.job).find(candidate => candidate.status === 'pending');
      if (!job) return [];
      job.status = 'running'; job.attempts += 1; job.leaseToken = 'lease';
      return [{ ...job }];
    },
    async claimOutbox() { return []; },
    async finishJobWithOutbox({ id }) { [...rows.values()].map(row => row.job).find(job => job.id === id).status = 'succeeded'; },
    async retryJob({ id }) { [...rows.values()].map(row => row.job).find(job => job.id === id).status = 'pending'; },
  };
  const config = { feishu: { connectionId: 'fixture' }, codex: {}, routing: { version: '1', privateUserIds: [], groups: [] }, hooks: [hook] };
  const communication = createCommunicationRuntime({ config, store, inbound: {}, forward: null, chat: {},
    hookTokens: { orders: 'synthetic' }, fetchImpl: async (_url, request) => {
      deliveries.push({ request, body: JSON.parse(request.body) });
      return new Response(null, { status: 204 });
    } });
  const action = createBusinessCardAction({ hooks: config.hooks, connectionId: config.feishu.connectionId,
    ingest: communication.ingestCardAction, registrationTimeoutMs,
    runAsync(operation) { const pending = Promise.resolve().then(operation); operations.push(pending); pending.catch(() => {}); },
    log: (...entry) => logs.push(entry) });
  return { action, communication, deliveries, operations, rows, logs, release };
}

async function eventually(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition_timeout');
}

function acceptedByBusinessReceiver(body, connectionId) {
  if (body?.event?.connectionId !== connectionId) return false;
  return body?.event?.schemaVersion === 1 && body.event.channel === 'feishu';
}

test('business card action forwards to hook', async () => {
  const fixture = harness(); fixture.communication.start();
  const wsClient = { async start() {}, close() {} };
  const adapter = createFeishuAdapter({ sdk: { EventDispatcher: Dispatcher }, wsClient, connectionId: 'fixture',
    onEvent: async () => {}, onCardAction: fixture.action.handleCardAction });
  const response = await adapter.dispatcher.handlers['card.action.trigger'](payload);
  assert.deepEqual(response, { toast: { type: 'info', content: '已收到，处理结果稍后更新在卡片上' } });
  await Promise.all(fixture.operations);
  await eventually(() => fixture.deliveries.length === 1);
  const delivered = fixture.deliveries[0];
  assert.equal(delivered.request.headers.authorization, 'Bearer synthetic');
  assert.deepEqual(delivered.body.event, {
    schemaVersion: 1, channel: 'feishu', type: 'card.action',
    connectionId: 'fixture', eventId: 'event-1', chatId: 'chat-1', messageId: 'message-1',
    operatorOpenId: 'operator-1', operatorName: 'Operator', value: payload.action.value,
    occurredAt: '2023-11-14T22:13:20.000Z',
  });
  assert.equal(acceptedByBusinessReceiver(delivered.body, 'fixture'), true);
  assert(fixture.rows.has('card_action:event-1'));
  assert.deepEqual(fixture.logs, [['info', 'receive', 'accepted', {
    component: 'card_action', hookId: 'orders', eventId: 'event-1', chatId: 'chat-1', messageId: 'message-1', kind: 'approve',
  }]]);
  await fixture.communication.stop();
});

test('business card action wrapper passes business receiver contract', async () => {
  const fixture = harness(); fixture.communication.start();
  await fixture.action.handleCardAction(payload);
  await Promise.all(fixture.operations);
  await eventually(() => fixture.deliveries.length === 1);
  const body = fixture.deliveries[0].body;
  assert.equal(acceptedByBusinessReceiver(body, 'fixture'), true);
  assert.equal(body.event.type, 'card.action');
  assert.equal(body.event.event, undefined);
  await fixture.communication.stop();
});

test('business card action normalizes second, millisecond, microsecond, nanosecond and ISO times', async () => {
  const events = [];
  const action = createBusinessCardAction({ hooks: [hook], connectionId: 'fixture',
    ingest: async ({ event }) => { events.push(event); } });
  const cases = [
    1700000000,
    '1700000000000',
    '1700000000000000',
    '1700000000000000000',
    '2023-11-14T22:13:20.000Z',
  ];
  for (const actionTime of cases) {
    await action.handleCardAction({ ...payload, action: { ...payload.action, action_time: actionTime } });
  }
  assert.deepEqual(events.map(event => event.occurredAt), cases.map(() => '2023-11-14T22:13:20.000Z'));
});

test('business card action rejects invalid times and hashes the original action time', async () => {
  const events = [];
  const action = createBusinessCardAction({ hooks: [hook], connectionId: 'fixture',
    ingest: async ({ event }) => { events.push(event); } });
  for (const actionTime of [Infinity, '100000000000000000000', 'invalid']) {
    await action.handleCardAction({ ...payload, event_id: '',
      action: { ...payload.action, action_time: actionTime } });
  }
  assert.deepEqual(events.map(event => event.occurredAt), [null, null, null]);
  await action.handleCardAction({ ...payload, event_id: '', action: { ...payload.action, action_time: '1700000000000' } });
  await action.handleCardAction({ ...payload, event_id: '', action: { ...payload.action, action_time: '1700000000000000' } });
  assert.equal(events[3].occurredAt, events[4].occurredAt);
  assert.notEqual(events[3].eventId, events[4].eventId);
});

test('business card action dedups replay', async () => {
  const fixture = harness(); fixture.communication.start();
  assert.equal((await fixture.action.handleCardAction(payload)).toast.type, 'info');
  assert.equal((await fixture.action.handleCardAction(structuredClone(payload))).toast.type, 'info');
  await Promise.all(fixture.operations);
  await eventually(() => fixture.deliveries.length === 1);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(fixture.deliveries.length, 1); assert.equal(fixture.rows.size, 1);
  assert.equal(fixture.logs.at(-1)[2], 'duplicate');
  await fixture.communication.stop();
});

test('business card action ignores unknown hook', async () => {
  const calls = []; const logs = [];
  const action = createBusinessCardAction({ hooks: [hook], connectionId: 'fixture',
    ingest: async input => calls.push(input), log: (...entry) => logs.push(entry) });
  const unknown = await action.handleCardAction({ ...payload, action: { ...payload.action, value: { ...payload.action.value, hook_id: 'missing' } } });
  const outside = await action.handleCardAction({ ...payload, context: { ...payload.context, open_chat_id: 'other-chat' } });
  assert.equal(unknown.toast.content, '此群未接入该业务');
  assert.equal(outside.toast.content, '此群未接入该业务');
  assert.equal(calls.length, 0); assert.equal(logs.length, 2);
});

test('business card action leaves existing card actions for their original handlers', () => {
  const action = createBusinessCardAction({ hooks: [hook], connectionId: 'fixture', ingest: async () => {} });
  assert.equal(action.handleCardAction({ action: { value: { action: 'submit_user_input' } } }), null);
  assert.equal(action.handleCardAction({ action: { value: { action: 'stop_execution' } } }), null);
});

test('business card action dedups replay without a valid timestamp', async () => {
  const fixture = harness();
  const withoutTime = structuredClone(payload); delete withoutTime.event_id; delete withoutTime.create_time;
  const first = await fixture.action.handleCardAction(withoutTime);
  const second = await fixture.action.handleCardAction(structuredClone(withoutTime));
  await Promise.all(fixture.operations);
  assert.equal(first.toast.type, 'info'); assert.equal(second.toast.type, 'info');
  assert.equal(fixture.rows.size, 1); assert.equal(fixture.logs.at(-1)[2], 'duplicate');
  const [{ job }] = [...fixture.rows.values()];
  assert.equal(JSON.parse(job.payload).occurredAt, null);
});

test('business card action returns before slow registration and retains job', async () => {
  const fixture = harness({ holdAccept: true }); fixture.communication.start();
  const started = Date.now();
  const response = await fixture.action.handleCardAction(payload);
  const duration = Date.now() - started;
  assert.equal(response.toast.content, '已收到，处理结果稍后更新在卡片上');
  assert(duration >= 1900 && duration < 2500, `unexpected registration wait: ${duration}`);
  assert.equal(fixture.rows.size, 0);
  fixture.release();
  await Promise.all(fixture.operations);
  await eventually(() => fixture.deliveries.length === 1);
  assert.equal(fixture.rows.size, 1);
  await fixture.communication.stop();
});

test('business card action reports failed registration once', async () => {
  const events = []; const reports = []; const operations = [];
  const log = createLogger({ write: line => events.push(JSON.parse(line)) }, { reportError: event => reports.push(event) });
  const action = createBusinessCardAction({ hooks: [hook], connectionId: 'fixture',
    ingest: async () => { throw Object.assign(new Error('private detail'), { code: 'store_unavailable' }); },
    runAsync(operation) { const pending = Promise.resolve().then(operation); operations.push(pending); pending.catch(() => {}); }, log });
  const response = await action.handleCardAction(payload);
  await Promise.all(operations);
  assert.equal(response.toast.content, '已收到，系统记录延迟，请稍后确认卡片状态');
  assert.equal(events.length, 1); assert.equal(reports.length, 1);
  assert.deepEqual({ ...events[0], timestamp: undefined }, {
    timestamp: undefined, level: 'error', module: 'bridge', component: 'card_action', operation: 'receive', status: 'failed',
    hook_id: 'orders', event_id: 'event-1', chat_id: 'chat-1', message_id: 'message-1', kind: 'approve',
    error_code: 'store_unavailable',
  });
  assert.deepEqual(reports[0], events[0]);
});

test('business card action reports registration failure after toast', async () => {
  const events = []; const reports = []; const operations = []; let rejectRegistration;
  const registration = new Promise((_, reject) => { rejectRegistration = reject; });
  const log = createLogger({ write: line => events.push(JSON.parse(line)) }, { reportError: event => reports.push(event) });
  const action = createBusinessCardAction({ hooks: [hook], connectionId: 'fixture', registrationTimeoutMs: 10,
    ingest: () => registration,
    runAsync(operation) { const pending = Promise.resolve().then(operation); operations.push(pending); pending.catch(() => {}); }, log });
  const response = await action.handleCardAction(payload);
  assert.equal(response.toast.content, '已收到，处理结果稍后更新在卡片上');
  assert.equal(events.length, 0); assert.equal(reports.length, 0);
  rejectRegistration(Object.assign(new Error('private detail'), { code: 'store_unavailable' }));
  await Promise.all(operations);
  assert.equal(events.length, 1); assert.equal(events[0].level, 'error');
  assert.equal(events[0].error_code, 'store_unavailable');
  assert.equal(reports.length, 1); assert.deepEqual(reports[0], events[0]);
});
