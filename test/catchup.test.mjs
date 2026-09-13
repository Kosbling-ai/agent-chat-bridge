import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatchup, historyMessageEvent } from '../src/core/catchup.mjs';

const clock = 1789250000000;
const conversation = { conversationId: 'chat', conversationType: 'p2p' };
const item = id => ({ message_id: id, chat_id: 'chat', msg_type: 'text', create_time: String(clock - 2000),
  body: { content: JSON.stringify({ text: id }) }, sender: { sender_type: 'user', id_type: 'open_id', id: 'human' } });
function fixture(overrides = {}) {
  const rows = new Map(), received = [], requests = [], logs = [];
  const store = {
    async getCursor({ key }) { return structuredClone(rows.get(key) ?? null); },
    async setCursor({ key, expectedVersion, value }) {
      assert.equal(rows.get(key)?.version ?? 0, expectedVersion);
      rows.set(key, { version: expectedVersion + 1, value: structuredClone(value) });
      return { version: expectedVersion + 1 };
    },
  };
  const options = { connectionId: 'fixture', store, listConversations: async () => [conversation],
    chat: { async listMessages(request) { requests.push(request); return { items: [], has_more: false }; } },
    onEvent: async event => { received.push(event); }, now: () => clock, wait: async () => {},
    log: (...args) => logs.push(args), ...overrides };
  return { options, rows, received, requests, logs, create: extra => createCatchup({ ...options, ...extra }) };
}

test('history conversion retains source, structured content and mentions without fabricating live edit', () => {
  const event = historyMessageEvent({ ...item('m'), updated: true, update_time: String(clock - 1000),
    mentions: [{ key: '@1', name: 'Bot', id: 'bot', id_type: 'open_id' }] }, conversation, { connectionId: 'fixture' });
  assert.equal(event.type, 'message.received'); assert.equal(event.source, 'history_catchup');
  assert.equal(event.message.updated, true); assert.equal(event.actor.openId, 'human');
  assert.equal(event.message.mentions[0].openId, 'bot');
  assert.throws(() => historyMessageEvent({ ...item('bad'), chat_id: 'foreign' }, conversation, { connectionId: 'fixture' }));
  assert.equal(historyMessageEvent({ ...item('recalled'), deleted: true }, conversation, { connectionId: 'fixture' }).type, 'message.recalled');
});

test('page continuation survives restart and does not skip more than 50 messages at the same timestamp', async () => {
  const requests = [], delivered = [];
  const f = fixture({ maxPagesPerConversation: 1, onEvent: async event => delivered.push(event.messageId),
    chat: { async listMessages(request) {
      requests.push(request);
      return request.pageToken ? { items: [item('last')], has_more: false }
        : { items: Array.from({ length: 50 }, (_, i) => item(`m${i}`)), has_more: true, page_token: 'next' };
    } } });
  const first = f.create();
  assert.equal((await first.runOnce()).incomplete, 1); await first.stop();
  const checkpoint = [...f.rows.values()][0].value;
  assert.equal(checkpoint.window.pageToken, 'next'); assert(checkpoint.throughMs < clock);
  const second = f.create({ now: () => clock + 999999 });
  await second.runOnce(); await second.stop();
  assert.equal(delivered.length, 51); assert.equal(requests[1].endTime, requests[0].endTime);
  assert.equal([...f.rows.values()][0].value.throughMs, clock);
});

test('failed durable receive keeps the same page and commit-loss replay uses stable event keys', async () => {
  let fail = true;
  const seen = [];
  const f = fixture({ chat: { async listMessages() { return { items: [item('a'), item('b')], has_more: false }; } },
    onEvent: async event => { seen.push(event.eventKey); if (event.messageId === 'b' && fail) throw new Error('synthetic'); } });
  const worker = f.create(); assert.equal((await worker.runOnce()).failed, 1);
  assert.equal([...f.rows.values()][0].value.window.pageToken, '');
  fail = false; await worker.runOnce(); await worker.stop();
  assert.equal(seen[0], seen[2]); assert.equal(seen[1], seen[3]);
  assert.equal([...f.rows.values()][0].value.window, null);
});

test('malformed or cross-chat page cannot advance cursor or partially emit its valid prefix', async () => {
  for (const result of [
    { items: [item('ok'), { ...item('bad'), chat_id: 'foreign' }], has_more: false },
    { items: [], has_more: true },
  ]) {
    const f = fixture({ chat: { async listMessages() { return result; } } });
    const worker = f.create(); assert.equal((await worker.runOnce()).failed, 1); await worker.stop();
    assert.equal(f.received.length, 0); assert.notEqual([...f.rows.values()][0].value.window, null);
  }
});

test('concurrent runs coalesce and shutdown interrupts stalled read without moving cursor', async () => {
  let release, requests = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ chat: { async listMessages() { requests++; return gate; } } });
  const worker = f.create(); const first = worker.runOnce(); assert.equal(worker.runOnce(), first);
  while (!requests) await new Promise(resolve => setImmediate(resolve));
  await worker.stop(); await first;
  release({ items: [item('late')], has_more: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.received.length, 0); assert.notEqual([...f.rows.values()][0].value.window, null);
});

test('a failed conversation does not block the next, and async logging failures remain contained', async () => {
  const f = fixture({ listConversations: async () => [conversation, { conversationId: 'other', conversationType: 'group' }],
    log: async () => { throw new Error('synthetic logger'); },
    chat: { async listMessages({ conversationId }) { if (conversationId === 'chat') throw new Error('private secret error'); return { items: [], has_more: false }; } } });
  const worker = f.create(); const result = await worker.runOnce(); await worker.stop();
  assert.equal(result.failed, 1); assert.equal(result.conversations, 2); assert.equal(result.pages, 1);
});

test('completed windows overlap and app echoes do not reach durable user ingestion', async () => {
  const requests = [];
  const f = fixture({ chat: { async listMessages(request) { requests.push(request); return { items: [{ ...item('bot'), sender: { sender_type: 'app' } }], has_more: false }; } } });
  const worker = f.create(); await worker.runOnce(); await worker.runOnce(); await worker.stop();
  assert.equal(f.received.length, 0); assert.equal(Number(requests[1].startTime) * 1000, clock - 300000);
});

test('lost checkpoint response is reconciled by loading the committed continuation on the next run', async () => {
  let fail = true;
  const requests = [];
  const f = fixture({ chat: { async listMessages(request) {
    requests.push(request);
    return request.pageToken ? { items: [], has_more: false } : { items: [item('first')], has_more: true, page_token: 'next' };
  } } });
  const setCursor = f.options.store.setCursor;
  f.options.store.setCursor = async input => {
    const result = await setCursor(input);
    if (input.value.window?.pageToken === 'next' && fail) { fail = false; throw new Error('response lost'); }
    return result;
  };
  const worker = f.create(); assert.equal((await worker.runOnce()).failed, 1);
  await worker.runOnce(); await worker.stop();
  assert.equal(requests[1].pageToken, 'next'); assert.equal(f.received.length, 1);
});

test('a stalled receive is bounded and cannot checkpoint the page after its timeout', async () => {
  let release;
  const f = fixture({ operationTimeoutMs: 20,
    chat: { async listMessages() { return { items: [item('first')], has_more: false }; } },
    onEvent: () => new Promise(resolve => { release = resolve; }) });
  const worker = f.create();
  // The synthetic promise has no I/O handle; keep Node alive for the timeout.
  const keepalive = setInterval(() => {}, 1000);
  try {
    assert.equal((await worker.runOnce()).failed, 1);
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.notEqual([...f.rows.values()][0].value.window, null);
  } finally { clearInterval(keepalive); await worker.stop(); }
});
