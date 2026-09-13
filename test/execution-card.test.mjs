import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionCard, renderExecutionCard, observeExecutionCard } from '../src/channels/feishu/execution-card.mjs';
const quiet = { info() {}, warn() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(saved, overrides = {}) {
  const calls = []; const persisted = [];
  const message = {
    async create(payload) { calls.push({ method: 'create', payload }); return { code: 0, data: { message_id: 'om_card' } }; },
    async patch(payload) { calls.push({ method: 'patch', payload }); return { code: 0 }; },
    ...overrides,
  };
  const card = new ExecutionCard({ client: { im: { v1: { message } } }, chatId: 'chat', uuid: 'stable-create', saved, logger: quiet, persist: async (value) => persisted.push(value) });
  return { card, calls, persisted };
}
const tool = (id, status = 'running') => ({ kind: 'tool', id, title: '读取信息', status, summary: '正在处理' });

test('one message has commentary, nested tools and final answer; replay patches same id', async () => {
  const { card, calls, persisted } = fixture();
  card.push({ kind: 'started' }); await card.chain;
  card.push({ kind: 'commentary', id: 'c', text: '我先核对记录。' });
  card.push(tool('t')); card.push(tool('t', 'completed'));
  assert.equal(await card.finish('最终答案'), true);
  assert.equal(calls.filter((x) => x.method === 'create').length, 1);
  const final = JSON.parse(calls.at(-1).payload.data.content);
  assert.equal(final.config.update_multi, true);
  assert.equal(final.config.summary.content, 'agent-chat-bridge · 已完成');
  assert.equal(final.header.title.content, 'agent-chat-bridge');
  assert.ok(JSON.stringify(final).includes('最终答案'));
  assert.equal(final.body.elements[1].tag, 'collapsible_panel');
  assert.equal(final.body.elements[1].elements[0].tag, 'collapsible_panel');
  const replay = fixture(persisted.at(-1));
  assert.equal(await replay.card.finish('最终答案'), true);
  assert.equal(replay.calls[0].method, 'patch');
  assert.equal(replay.calls[0].payload.path.message_id, 'om_card');
});

test('slow SDK keeps only one request in flight and final waits for it once', async () => {
  let release; let creates = 0;
  const { card, calls } = fixture(null, { create: async () => { creates++; await new Promise((r) => { release = r; }); return { code: 0, data: { message_id: 'om_card' } }; } });
  card.push({ kind: 'started' });
  for (let i = 0; i < 500; i++) { card.push(tool(`t${i}`)); card.enqueue(); }
  assert.equal(creates, 1);
  const final = card.finish('done'); release(); await final;
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'patch');
  assert.ok(card.snapshot().entries.length <= 24);
});

test('permission failure chooses durable fallback and does not loop creates', async () => {
  let creates = 0;
  const { card, persisted } = fixture(null, { create: async () => { creates++; return { code: 99991672 }; } });
  card.push({ kind: 'started' }); await card.chain;
  for (let i = 0; i < 20; i++) { card.push(tool(`t${i}`)); card.enqueue(); }
  assert.equal(await card.finish('normal answer'), false);
  assert.equal(creates, 1);
  assert.equal(persisted.at(-1).delivery, 'fallback');
});

test('oversized final falls back without claiming truncated delivery', async () => {
  const { card, calls, persisted } = fixture({ messageId: 'om_card', entries: [] });
  assert.equal(await card.finish('长'.repeat(12000)), false);
  assert.equal(persisted.at(-1).delivery, 'fallback');
  assert.ok(calls.every((x) => Buffer.byteLength(x.payload.data.content) < 30000));
  const replay = fixture(persisted.at(-1));
  assert.equal(await replay.card.finish('长'.repeat(12000)), false);
});

test('failure and interrupt close running tools, late progress cannot overwrite final', async () => {
  for (const status of ['failed', 'interrupted', 'deferred']) {
    const { card, calls } = fixture({ messageId: 'om_card', entries: [tool('t')] });
    await card.finish('终态', status);
    const count = calls.length; card.push(tool('late')); await card.enqueue();
    assert.equal(calls.length, count);
    assert.equal(card.snapshot().status, status);
    assert.notEqual(card.snapshot().entries[0].status, 'running');
  }
});

test('rendered history has bounded UTF8 bytes with nested tool groups', () => {
  const state = { status: 'running', entries: Array.from({ length: 100 }, (_, i) => i % 2 ? tool(`t${i}`) : { kind: 'commentary', id: `c${i}`, text: '长'.repeat(2000) }) };
  assert.ok(Buffer.byteLength(JSON.stringify(renderExecutionCard(state))) < 30000);
});

test('observer advances cursor through unrelated rows without exposing them', async () => {
  const { card } = fixture(); const cursors = []; let reads = 0;
  const observer = observeExecutionCard({ card, since: 100, load: async (cursor) => {
    cursors.push({ ...cursor }); reads++;
    return reads === 1 ? [{ id: 1, created_at: 101, progress_json: null }, { id: 2, created_at: 101, progress_json: JSON.stringify(tool('t')) }] : [];
  } });
  await tick(); const snapshot = await observer.stop();
  assert.deepEqual(cursors[1], { at: 100, id: 0 });
  assert.equal(snapshot.entries[0].id, 't');
});

test('observer read failure cannot reject final delivery', async () => {
  const { card } = fixture(); let reads = 0;
  const observer = observeExecutionCard({ card, since: 100, load: async () => { reads++; throw new Error('database unavailable'); } });
  await observer.stop();
  assert.equal(reads, 1);
  assert.equal(await card.finish('完整最终答复'), true);
});

test('audit and metadata failure never downgrade confirmed final delivery', async () => {
  let patches = 0;
  const card = new ExecutionCard({ client: { im: { v1: { message: { async patch() { patches++; return { code: 0 }; } } } } }, saved: { messageId: 'om_card', entries: [] }, logger: quiet,
    persist: async () => { throw new Error('db unavailable'); }, audit: async () => { throw new Error('audit unavailable'); } });
  assert.equal(await card.finish('完整答案'), true);
  assert.equal(patches, 1);
  assert.notEqual(card.snapshot().delivery, 'fallback');
});

test('fallback cannot send normal result until its choice is persisted', async () => {
  const card = new ExecutionCard({ client: { im: { v1: { message: { async patch() { return { code: 400 }; } } } } }, saved: { messageId: 'om_card', entries: [] }, logger: quiet,
    persist: async () => { throw new Error('db unavailable'); } });
  await assert.rejects(card.finish('完整答案'), /db unavailable/);
});

test('late started event in read overlap cannot regress a finished tool', async () => {
  const { card } = fixture(); let reads = 0;
  const observer = observeExecutionCard({ card, since: 100, load: async () => ++reads === 1
    ? [{ id: 2, created_at: 200, progress_json: tool('t', 'completed') }]
    : [{ id: 3, created_at: 150, progress_json: tool('t', 'running') }, { id: 2, created_at: 200, progress_json: tool('t', 'completed') }] });
  await tick(); const state = await observer.stop();
  assert.equal(state.entries.length, 1); assert.equal(state.entries[0].status, 'completed');
});


test('stop button belongs to the original live turn and disappears at completion', () => {
 const state = { status:'running', jobId:'17', turnId:'original-turn', entries:[] };
 const card = renderExecutionCard(state);
 const button = card.body.elements.find(x=>x.tag==='button');
 assert.equal(button.behaviors[0].value.expectedTurnId, 'original-turn');
 assert.equal(renderExecutionCard({...state,status:'interrupted'}).body.elements.some(x=>x.tag==='button'),false);
});
