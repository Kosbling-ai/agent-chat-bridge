import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessCardAction } from '../src/channels/feishu/business-card-action.mjs';
import { createFeishuAdapter } from '../src/channels/feishu/adapter.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';

class Dispatcher { register(handlers) { this.handlers = handlers; return this; } }

const hook = { id: 'orders', url: 'https://business.invalid/hook', tokenEnv: 'HOOK_TOKEN', conversationIds: ['chat-1'] };
const payload = {
  event_id: 'event-1', operator: { open_id: 'operator-1', name: 'Operator' },
  context: { open_chat_id: 'chat-1', open_message_id: 'message-1' },
  action: { action_time: '1700000000000', value: { action: 'business', hook_id: 'orders', kind: 'approve', action_id: 'action-1', version: 2 } },
};

function harness({ holdAccept = false } = {}) {
  const rows = new Map(); const deliveries = []; const operations = []; const logs = []; let release;
  const gate = holdAccept ? new Promise(resolve => { release = resolve; }) : Promise.resolve();
  const store = {
    async acceptInbound(input) {
      await gate;
      if (rows.has(input.eventKey)) return { duplicate: true, hookJobIds: [rows.get(input.eventKey).id] };
      const job = { id: `hook-${rows.size + 1}`, kind: 'hook', hookId: input.hooks[0].hookId,
        payload: JSON.stringify(input.hooks[0].payload), attempts: 0, status: 'pending' };
      rows.set(input.eventKey, job);
      return { duplicate: false, hookJobIds: [job.id] };
    },
    async claimJobs() {
      const job = [...rows.values()].find(candidate => candidate.status === 'pending');
      if (!job) return [];
      job.status = 'running'; job.attempts += 1; job.leaseToken = 'lease';
      return [{ ...job }];
    },
    async claimOutbox() { return []; },
    async finishJobWithOutbox({ id }) { [...rows.values()].find(job => job.id === id).status = 'succeeded'; },
    async retryJob({ id }) { [...rows.values()].find(job => job.id === id).status = 'pending'; },
  };
  const config = { feishu: { connectionId: 'fixture' }, codex: {}, routing: { version: '1', privateUserIds: [], groups: [] }, hooks: [hook] };
  const communication = createCommunicationRuntime({ config, store, inbound: {}, forward: null, chat: {},
    hookTokens: { orders: 'synthetic' }, fetchImpl: async (_url, request) => {
      deliveries.push({ request, body: JSON.parse(request.body) });
      return new Response(null, { status: 204 });
    } });
  const action = createBusinessCardAction({ hooks: config.hooks, ingest: communication.ingestCardAction,
    runAsync(operation) { const pending = Promise.resolve().then(operation); operations.push(pending); pending.catch(() => {}); },
    log: (...entry) => logs.push(entry) });
  return { action, communication, deliveries, operations, rows, logs, release };
}

async function eventually(predicate) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition_timeout');
}

test('business card action forwards to hook', async () => {
  const fixture = harness({ holdAccept: true });
  fixture.communication.start();
  const wsClient = { async start() {}, close() {} };
  const adapter = createFeishuAdapter({ sdk: { EventDispatcher: Dispatcher }, wsClient, connectionId: 'fixture',
    onEvent: async () => {}, onCardAction: fixture.action.handleCardAction });
  const started = Date.now();
  const response = await adapter.dispatcher.handlers['card.action.trigger'](payload);
  assert.deepEqual(response, { toast: { type: 'info', content: '已收到，处理结果稍后更新在卡片上' } });
  assert(Date.now() - started < 2500);
  assert.equal(fixture.deliveries.length, 0);
  fixture.release();
  await Promise.all(fixture.operations);
  await eventually(() => fixture.deliveries.length === 1);
  const delivered = fixture.deliveries[0];
  assert.equal(delivered.request.headers.authorization, 'Bearer synthetic');
  assert.equal(delivered.body.event.kind, 'card_action');
  assert.deepEqual(delivered.body.event, {
    kind: 'card_action', event_id: 'event-1', operator_open_id: 'operator-1', operator_name: 'Operator',
    chat_id: 'chat-1', message_id: 'message-1', value: payload.action.value, occurred_at: '2023-11-14T22:13:20.000Z',
  });
  assert(fixture.rows.has('card_action:event-1'));
  assert.deepEqual(fixture.logs, [['info', 'card_action', 'accepted', {
    hookId: 'orders', chatId: 'chat-1', messageId: 'message-1', kind: 'approve',
  }]]);
  await fixture.communication.stop();
});

test('business card action dedups replay', async () => {
  const fixture = harness(); fixture.communication.start();
  assert.equal(fixture.action.handleCardAction(payload).toast.type, 'info');
  assert.equal(fixture.action.handleCardAction(structuredClone(payload)).toast.type, 'info');
  await Promise.all(fixture.operations);
  await eventually(() => fixture.deliveries.length === 1);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(fixture.deliveries.length, 1);
  assert.equal(fixture.rows.size, 1);
  await fixture.communication.stop();
});

test('business card action ignores unknown hook', async () => {
  const calls = []; const logs = [];
  const action = createBusinessCardAction({ hooks: [hook], ingest: async input => calls.push(input), log: (...entry) => logs.push(entry) });
  const unknown = action.handleCardAction({ ...payload, action: { ...payload.action, value: { ...payload.action.value, hook_id: 'missing' } } });
  const outside = action.handleCardAction({ ...payload, context: { ...payload.context, open_chat_id: 'other-chat' } });
  assert.equal(unknown.toast.content, '此群未接入该业务');
  assert.equal(outside.toast.content, '此群未接入该业务');
  assert.equal(calls.length, 0); assert.equal(logs.length, 2);
});

test('business card action leaves existing card actions for their original handlers', () => {
  const action = createBusinessCardAction({ hooks: [hook], ingest: async () => {} });
  assert.equal(action.handleCardAction({ action: { value: { action: 'submit_user_input' } } }), null);
  assert.equal(action.handleCardAction({ action: { value: { action: 'stop_execution' } } }), null);
});

test('business card action derives a stable event id when Feishu omits one', async () => {
  const accepted = [];
  const action = createBusinessCardAction({ hooks: [hook], ingest: async input => accepted.push(input),
    runAsync: operation => operation(), now: () => 1_800_000_000_000 });
  const withoutId = structuredClone(payload); delete withoutId.event_id;
  action.handleCardAction(withoutId); action.handleCardAction(structuredClone(withoutId));
  await eventually(() => accepted.length === 2);
  assert.match(accepted[0].eventId, /^[a-f0-9]{64}$/);
  assert.equal(accepted[0].eventId, accepted[1].eventId);
});
