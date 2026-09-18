import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionCard, renderExecutionCard, observeExecutionCard } from '../src/channels/feishu/execution-card.mjs';
const quiet = { info() {}, warn() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(saved, overrides = {}, options = {}) {
  const calls = []; const persisted = [];
  const message = {
    async create(payload) { calls.push({ method: 'create', payload }); return { code: 0, data: { message_id: 'om_card' } }; },
    async patch(payload) { calls.push({ method: 'patch', payload }); return { code: 0 }; },
    ...overrides,
  };
  const card = new ExecutionCard({ client: { im: { v1: { message } } }, chatId: 'chat', uuid: 'stable-create', saved, logger: options.logger || quiet, persist: async (value) => persisted.push(value) });
  return { card, calls, persisted };
}
const tool = (id, status = 'running') => ({ kind: 'tool', id, title: '读取信息', status, summary: '正在处理' });
function manualPollClock() {
  let callback; let time = 0; let cleared = false;
  return {
    now: () => time,
    setIntervalFn(fn) { callback = fn; return { unref() {} }; },
    clearIntervalFn() { cleared = true; },
    async run(at) { time = at; await callback(); await tick(); },
    get cleared() { return cleared; },
  };
}

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
  assert.deepEqual(final.body.elements[0], { tag: 'div', text: { tag: 'plain_text', content: '我先核对记录。', text_size: 'normal', text_color: 'grey' } });
  assert.deepEqual(final.body.elements[1].elements[0].elements[0], { tag: 'div', text: { tag: 'plain_text', content: '正在处理', text_size: 'normal', text_color: 'grey' } });
  const answer = final.body.elements.find((element) => element.content === '最终答案');
  assert.equal(answer.text_size, 'heading');
  const replay = fixture(persisted.at(-1));
  assert.equal(await replay.card.finish('最终答案'), true);
  assert.equal(replay.calls[0].method, 'patch');
  assert.equal(replay.calls[0].payload.path.message_id, 'om_card');
});

test('progress uses normal grey plain text while final Markdown stays intact and larger', () => {
  const commentary = '过程段落\n\n- 一项\n- 二项\n\n```js\nconst value = 1;\n```';
  const answer = '# 最终标题\n\n正文包含 **加粗**。\n\n1. 第一项\n2. 第二项\n\n```js\nconst answer = 42;\n```';
  const card = renderExecutionCard({ status: 'completed', entries: [{ kind: 'commentary', id: 'c', text: commentary }] }, answer);
  assert.deepEqual(card.body.elements[0], { tag: 'div', text: { tag: 'plain_text', content: commentary, text_size: 'normal', text_color: 'grey' } });
  assert.deepEqual(card.body.elements[1], { tag: 'markdown', content: answer, text_size: 'heading' });
  assert.deepEqual(card.body.elements[2], { tag: 'markdown', content: '**已完成**' });
});

test('temporary progress-unavailable state is visible only while running', () => {
  const running = renderExecutionCard({ status: 'running', progressUnavailable: true, entries: [] });
  assert.equal(running.body.elements[0].text.content, '进度暂不可用，任务仍在后台执行。');
  const completed = renderExecutionCard({ status: 'completed', progressUnavailable: true, entries: [] }, '# 最终答案');
  assert.doesNotMatch(JSON.stringify(completed), /进度暂不可用/);
  assert.ok(JSON.stringify(completed).includes('# 最终答案'));
});

test('slow SDK keeps only one request in flight and final waits for it once', async () => {
  let release; let creates = 0;
  const { card, calls } = fixture(null, { create: async () => { creates++; await new Promise((r) => { release = r; }); return { code: 0, data: { message_id: 'om_card' } }; } });
  card.push({ kind: 'started' });
  for (let i = 0; i < 500; i++) { card.push(tool(`t${i}`)); card.enqueue(); }
  await tick();
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
    return reads === 1 ? [{ id: 1, created_at: 101, progress_json: null }, { id: 2, event_key: 'tool:start', created_at: 101, progress_json: JSON.stringify(tool('t')) }] : [];
  } });
  await tick(); const snapshot = await observer.stop();
  assert.deepEqual(cursors[1], { at: 100, id: 0 });
  assert.equal(snapshot.entries[0].id, 't');
});

test('observer overlap accepts a smaller late id and ignores an already seen id', async () => {
  const { card } = fixture();
  let reads = 0;
  const batches = [
    [{ id: '101', event_key: 'tool:visible', created_at: 101, progress_json: JSON.stringify(tool('visible')) }],
    [{ id: '100', event_key: 'tool:late', created_at: 102, progress_json: JSON.stringify(tool('late', 'completed')) }],
    [{ id: '101', event_key: 'tool:visible', created_at: 103, progress_json: JSON.stringify(tool('visible', 'failed')) }],
  ];
  const observer = observeExecutionCard({ card, since: 100, load: async () => batches[reads++] || [] });
  await tick();
  const saved = await observer.stop();
  assert.equal(saved.entries.find(entry => entry.id === 'late').status, 'completed');
  assert.equal(saved.entries.find(entry => entry.id === 'visible').status, 'running');
});

test('create without a message id chooses the original normal-message fallback', async () => {
  let creates = 0;
  const first = fixture(null, { create: async () => { creates += 1; return { code: 0, data: {} }; } });
  first.card.push({ kind: 'started' });
  await first.card.chain;
  assert.equal(first.card.snapshot().delivery, 'fallback');
  assert.equal(await first.card.finish('answer'), false);
  assert.equal(creates, 1);
});

test('final patch failure closes the original card and selects normal-message fallback', async () => {
  let patches = 0;
  const first = fixture({ messageId: 'om_card', entries: [] }, {
    patch: async () => { patches += 1; throw new Error('timeout'); },
  });
  assert.equal(await first.card.finish('complete answer'), false);
  assert.equal(first.card.snapshot().delivery, 'fallback');
  assert.equal(patches, 2);
});

test('observer retries transient reads with backoff and clears degraded state after recovery', async () => {
  const events = []; const logger = { info: line => events.push(JSON.parse(line)), warn: line => events.push(JSON.parse(line)) };
  const { card } = fixture({ messageId: 'om_card', entries: [] }, {}, { logger });
  const clock = manualPollClock(); let reads = 0;
  const observer = observeExecutionCard({ card, since: 100, intervalMs: 1000, now: clock.now,
    setIntervalFn: clock.setIntervalFn, clearIntervalFn: clock.clearIntervalFn,
    load: async () => {
      reads += 1;
      if (reads <= 3) throw Object.assign(new Error('temporary failure'), { code: 'ECONNRESET' });
      return [{ id: 1, created_at: 101, progress_json: { kind: 'commentary', id: 'recovered', text: '恢复后的进度' } }];
    } });
  await tick();
  assert.equal(reads, 1);
  await clock.run(999); assert.equal(reads, 1);
  await clock.run(1000); assert.equal(reads, 2);
  await clock.run(2999); assert.equal(reads, 2);
  await clock.run(3000); assert.equal(reads, 3);
  await card.chain;
  assert.equal(card.snapshot().progressUnavailable, true);
  assert.match(JSON.stringify(renderExecutionCard(card.snapshot())), /进度暂不可用/);
  await clock.run(6999); assert.equal(reads, 3);
  await clock.run(7000); assert.equal(reads, 4);
  await card.chain;
  assert.equal(card.snapshot().progressUnavailable, undefined);
  assert.equal(card.snapshot().entries[0].id, 'recovered');
  const retryLogs = events.filter(event => event.operation === 'read_progress' && event.status === 'retrying');
  assert.deepEqual(retryLogs.map(event => [event.stage, event.error_code, event.consecutive_failures, event.retry_delay_ms]), [
    ['load', 'ECONNRESET', 1, 1000], ['load', 'ECONNRESET', 2, 2000], ['load', 'ECONNRESET', 3, 4000],
  ]);
  assert.equal(events.find(event => event.operation === 'read_progress' && event.status === 'recovered').consecutive_failures, 3);
  await observer.stop();
  assert.equal(clock.cleared, true);
});

test('persistent observer failures cap backoff at eight intervals without stopping forever', async () => {
  const events = []; const logger = { info: line => events.push(JSON.parse(line)), warn: line => events.push(JSON.parse(line)) };
  const { card } = fixture({ messageId: 'om_card', entries: [] }, {}, { logger });
  const clock = manualPollClock(); let reads = 0;
  const observer = observeExecutionCard({ card, since: 100, intervalMs: 1000, now: clock.now,
    setIntervalFn: clock.setIntervalFn, clearIntervalFn: clock.clearIntervalFn,
    load: async () => { reads += 1; throw Object.assign(new Error('hidden details'), { code: 'POOL_BUSY' }); } });
  await tick();
  for (const at of [1000, 3000, 7000, 15000]) await clock.run(at);
  assert.equal(reads, 5);
  const retryLogs = events.filter(event => event.operation === 'read_progress' && event.status === 'retrying');
  assert.deepEqual(retryLogs.map(event => event.retry_delay_ms), [1000, 2000, 4000, 8000, 8000]);
  assert.ok(retryLogs.every(event => event.stage === 'load' && event.error_code === 'POOL_BUSY' && !JSON.stringify(event).includes('hidden details')));
  await clock.run(22999); assert.equal(reads, 5);
  await clock.run(23000); assert.equal(reads, 6);
  observer.cancel();
  await clock.run(99999); assert.equal(reads, 6);
  assert.equal(clock.cleared, true);
});

test('lease loss and runtime shutdown terminate observation without retry', async () => {
  for (const code of ['forward_lease_lost', 'forward_runtime_stopping']) {
    const events = []; const logger = { info: line => events.push(JSON.parse(line)), warn: line => events.push(JSON.parse(line)) };
    const { card } = fixture({ messageId: 'om_card', entries: [] }, {}, { logger });
    const clock = manualPollClock(); let reads = 0;
    const observer = observeExecutionCard({ card, since: 100, now: clock.now,
      setIntervalFn: clock.setIntervalFn, clearIntervalFn: clock.clearIntervalFn,
      load: async () => { reads += 1; throw Object.assign(new Error('private detail'), { code }); } });
    await tick(); await clock.run(100000); await observer.stop();
    assert.equal(reads, 1);
    assert.equal(clock.cleared, true);
    assert.ok(events.some(event => event.operation === 'read_progress' && event.status === 'stopped' && event.stage === 'load' && event.error_code === code));
    assert.doesNotMatch(JSON.stringify(events), /private detail/);
  }
});

test('lease loss raised while applying an event terminates instead of being skipped', async () => {
  const logs = []; const clock = manualPollClock(); let reads = 0;
  const card = {
    chain: Promise.resolve(),
    push() { throw Object.assign(new Error('private lease detail'), { code: 'forward_lease_lost' }); },
    log(status, _level, extra) { logs.push({ status, ...extra }); return Promise.resolve(); },
    stop() {}, snapshot() { return {}; },
  };
  const observer = observeExecutionCard({ card, since: 100, now: clock.now,
    setIntervalFn: clock.setIntervalFn, clearIntervalFn: clock.clearIntervalFn,
    load: async () => { reads += 1; return [{ id: 1, created_at: 101, progress_json: { kind: 'commentary', id: 'c', text: 'hidden' } }]; } });
  await tick(); await clock.run(100000); await observer.stop();
  assert.equal(reads, 1);
  assert.equal(clock.cleared, true);
  assert.deepEqual(logs.map(event => [event.status, event.stage, event.error_code]), [['stopped', 'event', 'forward_lease_lost']]);
  assert.doesNotMatch(JSON.stringify(logs), /private lease detail|hidden/);
});

test('one corrupt progress event is skipped without replaying or hiding later events', async () => {
  const pushed = []; const logs = [];
  const card = {
    chain: Promise.resolve(),
    push(event) { if (event.id === 'throws') throw Object.assign(new Error('private event'), { code: 'BAD_EVENT' }); pushed.push(event.id); },
    log(status, _level, extra) { logs.push({ status, ...extra }); return Promise.resolve(); },
    stop() {}, snapshot() { return { pushed }; },
  };
  let reads = 0;
  const observer = observeExecutionCard({ card, since: 100, load: async () => reads++ ? [] : [
    { id: 1, created_at: 101, progress_json: '{broken' },
    { id: 2, created_at: 102, progress_json: { kind: 'commentary', id: 'throws', text: 'do not expose' } },
    { id: 3, created_at: 103, progress_json: { kind: 'commentary', id: 'visible', text: 'ok' } },
  ] });
  await tick(); await observer.stop();
  assert.deepEqual(pushed, ['visible']);
  assert.deepEqual(logs.filter(event => event.stage === 'event').map(event => [event.status, event.error_code]), [['skipped', 'BAD_EVENT']]);
  assert.doesNotMatch(JSON.stringify(logs), /private event|do not expose/);
});

test('observer read failure cannot reject final delivery', async () => {
  const { card } = fixture(); let reads = 0;
  const observer = observeExecutionCard({ card, since: 100, load: async () => { reads++; throw new Error('database unavailable'); } });
  await observer.stop();
  assert.equal(reads, 1);
  assert.equal(await card.finish('完整最终答复'), true);
});

test('observer cancel releases its timer without a final poll', async () => {
  const { card } = fixture();
  let reads = 0;
  let cleared = false;
  let scheduled;
  const observer = observeExecutionCard({ card, since: 100, load: async () => { reads += 1; return []; },
    setIntervalFn(callback) { scheduled = callback; return { unref() {} }; },
    clearIntervalFn() { cleared = true; } });
  await tick();
  observer.cancel();
  await scheduled();
  assert.equal(cleared, true);
  assert.equal(reads, 1);
});

test('observer cancel suppresses a pending load result and later card side effects', async () => {
  const { card } = fixture({ messageId: 'om_card', entries: [] });
  let release; let scheduled;
  const observer = observeExecutionCard({ card, since: 100,
    load: async () => new Promise(resolve => { release = resolve; }),
    setIntervalFn(callback) { scheduled = callback; return { unref() {} }; }, clearIntervalFn() {} });
  await tick();
  observer.cancel();
  release([{ id: 1, created_at: 101, progress_json: { kind: 'commentary', id: 'late', text: 'late' } }]);
  await tick(); await scheduled(); await tick();
  assert.equal(card.snapshot().entries.length, 0);
  assert.equal(card.snapshot().progressUnavailable, undefined);
});

test('observer stop waits for an in-flight load without another poll or card patch', async () => {
  const { card, calls } = fixture({ messageId: 'om_card', entries: [] });
  let release; let reads = 0;
  const observer = observeExecutionCard({ card, since: 100,
    load: async () => { reads += 1; return new Promise(resolve => { release = resolve; }); } });
  await tick();
  const stopping = observer.stop();
  release([{ id: 1, created_at: 101, progress_json: { kind: 'commentary', id: 'late', text: 'late' } }]);
  await stopping;
  assert.equal(reads, 1);
  assert.equal(calls.length, 0);
  assert.equal(card.snapshot().entries.length, 0);
});

test('metadata failure after a confirmed patch remains observational', async () => {
  let patches = 0;
  const card = new ExecutionCard({ client: { im: { v1: { message: { async patch() { patches++; return { code: 0 }; } } } } }, saved: { messageId: 'om_card', entries: [] }, logger: quiet,
    persist: async () => { throw new Error('db unavailable'); }, audit: async () => { throw new Error('audit unavailable'); } });
  assert.equal(await card.finish('完整答案'), true);
  assert.equal(patches, 1);
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
