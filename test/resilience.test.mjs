import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeltaCoalescer } from '../src/agents/codex/executor.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';
import { createLogger } from '../src/logger.mjs';
import { StoreError } from '../src/storage/errors.mjs';
import { createExecutorLogAdapter } from '../src/service.mjs';

const config = {
  feishu: { connectionId: 'fixture', botOpenId: 'bot' },
  codex: {}, routing: { privateUserIds: [], groups: [] }, hooks: [],
};
const immediate = () => new Promise(resolve => setImmediate(resolve));

test('delta persistence coalesces 20 updates per item into at most two writes', async () => {
  const writes = [];
  let releaseFirst;
  const firstWrite = new Promise(resolve => { releaseFirst = resolve; });
  const persist = createDeltaCoalescer({
    write: async value => {
      writes.push(value);
      if (writes.length === 1) await firstWrite;
    },
  });
  let text = '';
  const pending = [];
  for (let index = 0; index < 20; index += 1) {
    text += String(index % 10);
    pending.push(persist('turn:item', text));
  }
  assert.equal(writes.length, 1);
  releaseFirst();
  await Promise.all(pending);
  assert.ok(writes.length <= 2);
  assert.equal(writes.at(-1), text);
});

test('delta coalescer microtask handoff retains the next latest value', async () => {
  const writes = [];
  const persist = createDeltaCoalescer({ write: async value => { writes.push(value); } });
  const first = persist('turn:item', 'a');
  let second;
  queueMicrotask(() => { second = persist('turn:item', 'ab'); });
  await first;
  await second;
  assert.equal(writes.at(-1), 'ab');
});

test('delta coalescer retries the latest pending value after a write failure', async () => {
  const writes = [];
  const errors = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const persist = createDeltaCoalescer({
    write: async value => {
      writes.push(value);
      if (writes.length === 1) { await firstGate; throw Object.assign(new Error('synthetic'), { code: 'ER_LOCK_WAIT_TIMEOUT' }); }
    },
    onError: error => errors.push(error.code),
  });
  const first = persist('turn:item', 'a');
  const second = persist('turn:item', 'ab');
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(writes, ['a', 'ab']);
  assert.deepEqual(errors, ['ER_LOCK_WAIT_TIMEOUT']);
});

test('delta coalescer survives a synchronous first writer failure', async () => {
  const writes = [];
  const persist = createDeltaCoalescer({
    write(value) {
      writes.push(value);
      if (writes.length === 1) throw new Error('synthetic synchronous failure');
    },
  });
  await persist('turn:item', 'a');
  await persist('turn:item', 'ab');
  await persist('turn:item', 'abc');
  assert.deepEqual(writes, ['a', 'ab', 'abc']);
});

test('delta coalescer keeps interleaved items independent', async () => {
  const writes = { first: [], second: [] };
  const releases = {};
  const gates = Object.fromEntries(['first', 'second'].map(key => [key, new Promise(resolve => { releases[key] = resolve; })]));
  const persist = createDeltaCoalescer({ write: async ({ key, text }) => {
    writes[key].push(text);
    if (writes[key].length === 1) await gates[key];
  } });
  const pending = [
    persist('turn:first', { key: 'first', text: 'a' }),
    persist('turn:second', { key: 'second', text: 'x' }),
    persist('turn:first', { key: 'first', text: 'ab' }),
    persist('turn:second', { key: 'second', text: 'xy' }),
  ];
  assert.deepEqual(writes, { first: ['a'], second: ['x'] });
  releases.first(); releases.second();
  await Promise.all(pending);
  assert.deepEqual(writes, { first: ['a', 'ab'], second: ['x', 'xy'] });
});

test('communication poll retries a transient store error and recovers', async () => {
  let claims = 0;
  let releaseIdle;
  let releaseRetry;
  const waits = [];
  const logs = [];
  const runtime = createCommunicationRuntime({ config, chat: {}, log: (...entry) => logs.push(entry),
    store: {
      async claimJobs() { claims += 1; if (claims === 1) throw new StoreError('store_unavailable'); return []; },
      async claimOutbox() { return []; },
    },
    wait: async milliseconds => {
      waits.push(milliseconds);
      if (milliseconds === 1000) await new Promise(resolve => { releaseRetry = resolve; });
      if (milliseconds === 100) await new Promise(resolve => { releaseIdle = resolve; });
    },
  });
  runtime.start();
  while (!releaseRetry) await immediate();
  assert.deepEqual(runtime.status(), { running: true, healthy: true, degraded: true, consecutiveFailures: 1 });
  releaseRetry();
  while (!releaseIdle) await immediate();
  assert.deepEqual(runtime.status(), { running: true, healthy: true, degraded: false, consecutiveFailures: 0 });
  assert.equal(waits[0], 1000);
  const warning = logs.find(([level, operation]) => level === 'warning' && operation === 'communication_worker');
  assert.equal(warning[3].willRetry, true);
  assert.equal(warning[3].stage, 'claim_jobs');
  releaseIdle();
  await runtime.stop();
});

test('communication poll marks non-transient store errors unhealthy immediately', async () => {
  const logs = [];
  const runtime = createCommunicationRuntime({ config, chat: {}, log: (...entry) => logs.push(entry),
    store: {
      async claimJobs() { throw new StoreError('invalid_store_input'); },
      async claimOutbox() { throw new Error('unexpected'); },
    }, wait: async () => {},
  });
  runtime.start();
  while (runtime.status().running) await immediate();
  assert.deepEqual(runtime.status(), { running: false, healthy: false, degraded: false, consecutiveFailures: 1 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'error');
  assert.equal(logs[0][3].willRetry, false);
  await runtime.stop();
});

test('communication poll remains degraded through a persistent transient failure with capped backoff', async () => {
  let clock = 0;
  const logs = [];
  const waits = [];
  let blocked = false;
  const runtime = createCommunicationRuntime({ config, chat: {}, now: () => clock, log: (...entry) => logs.push(entry),
    store: {
      async claimJobs() { throw new StoreError('store_timeout'); },
      async claimOutbox() { throw new Error('unexpected'); },
    },
    wait: async milliseconds => { waits.push(milliseconds); clock += milliseconds; if (waits.length === 8) { blocked = true; await new Promise(() => {}); } },
  });
  runtime.start();
  while (!blocked) await immediate();
  assert.deepEqual(runtime.status(), { running: true, healthy: true, degraded: true, consecutiveFailures: 8 });
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][3].willRetry, true);
  await runtime.stop();
});

test('communication poll logs persistent degradation periodically without stopping', async () => {
  let clock = 0;
  let claims = 0;
  const logs = [];
  let blocked = false;
  const runtime = createCommunicationRuntime({ config, chat: {}, now: () => clock, log: (...entry) => logs.push(entry),
    store: {
      async claimJobs() {
        claims += 1;
        throw new StoreError('store_timeout');
      },
      async claimOutbox() { return []; },
    },
    wait: async () => { clock += 30000; if (claims === 11) { blocked = true; await new Promise(() => {}); } },
  });
  runtime.start();
  while (!blocked) await immediate();
  assert.equal(runtime.status().healthy, true);
  assert.equal(runtime.status().degraded, true);
  assert.equal(logs.length, 2);
  assert.deepEqual(logs.map(entry => entry[3].consecutiveFailures), [1, 11]);
  await runtime.stop();
});

test('communication poll stop interrupts a retry backoff', async () => {
  let retrying = false;
  const runtime = createCommunicationRuntime({ config, chat: {},
    store: {
      async claimJobs() { throw new StoreError('store_unavailable'); },
      async claimOutbox() { return []; },
    },
    wait: async milliseconds => { if (milliseconds === 1000) retrying = true; await new Promise(() => {}); },
  });
  runtime.start();
  while (!retrying) await immediate();
  await Promise.race([
    runtime.stop(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('stop_timeout')), 100)),
  ]);
  assert.equal(runtime.status().running, false);
});

test('logger allowlists storage resilience fields', () => {
  const events = [];
  const log = createLogger({ write: value => events.push(JSON.parse(value)) });
  log('warning', 'communication_worker', 'failed', {
    stage: 'claim_jobs', errorClass: 'store_timeout', errno: 1205, sqlState: 'HY000', durationMs: 17,
    consecutiveFailures: 2, willRetry: true, sql: 'must not appear', payload: 'must not appear',
  });
  assert.deepEqual(events[0], {
    timestamp: events[0].timestamp, level: 'warning', module: 'bridge', component: 'service',
    operation: 'communication_worker', status: 'failed', consecutive_failures: 2, durationMs: 17,
    stage: 'claim_jobs', error_class: 'store_timeout', errno: 1205, sql_state: 'HY000', will_retry: true,
  });
});

test('service executor log adapter forwards only diagnostic allowlist fields', () => {
  const events = [];
  const adapter = createExecutorLogAdapter(createLogger({ write: value => events.push(JSON.parse(value)) }));
  adapter('warning', {
    operation: 'persist_delta', status: 'failed', errorClass: 'store_contention', errno: 1205,
    sqlState: 'HY000', durationMs: 23, stage: 'write', consecutiveFailures: 2, willRetry: true,
    payload: 'must not appear', message: 'must not appear',
  });
  assert.deepEqual(events[0], {
    timestamp: events[0].timestamp, level: 'warning', module: 'bridge', component: 'service',
    operation: 'persist_delta', status: 'failed', consecutive_failures: 2, durationMs: 23,
    stage: 'write', error_class: 'store_contention', errno: 1205, sql_state: 'HY000', will_retry: true,
  });
});

test('uncertain claim commit recovers without stopping the communication worker', async () => {
  let claims = 0, releaseRetry, releaseIdle;
  const logs = [];
  const runtime = createCommunicationRuntime({ config, chat: {}, log: (...entry) => logs.push(entry),
    store: {
      async claimJobs() { if (++claims === 1) throw new StoreError('commit_unknown', {reason:'commit_timeout'}); return []; },
      async claimOutbox() { return []; },
    },
    wait: async ms => { if (ms === 1000) await new Promise(r => { releaseRetry = r; }); else await new Promise(r => { releaseIdle = r; }); },
  });
  runtime.start();
  while (!releaseRetry) await immediate();
  assert.equal(runtime.status().running, true);
  assert.equal(logs[0][3].reason, 'commit_timeout');
  assert.equal(logs[0][3].willRetry, true);
  releaseRetry();
  while (!releaseIdle) await immediate();
  assert.equal(runtime.status().healthy, true);
  assert.equal(runtime.status().consecutiveFailures, 0);
  await runtime.stop(); releaseIdle();
});

test('degraded status clears only after both claim paths succeed', async () => {
  let outboxClaims = 0, releaseRetry, releaseOutbox, releaseIdle;
  const logs = [];
  const runtime = createCommunicationRuntime({ config, chat: {}, log: (...entry) => logs.push(entry),
    store: {
      async claimJobs() { return []; },
      async claimOutbox() {
        outboxClaims += 1;
        if (outboxClaims === 1) throw new StoreError('store_contention');
        if (outboxClaims === 2) await new Promise(resolve => { releaseOutbox = resolve; });
        return [];
      },
    },
    wait: async ms => {
      if (ms === 1000) await new Promise(resolve => { releaseRetry = resolve; });
      else await new Promise(resolve => { releaseIdle = resolve; });
    },
  });
  runtime.start();
  while (!releaseRetry) await immediate();
  releaseRetry();
  while (!releaseOutbox) await immediate();
  assert.equal(runtime.status().degraded, true);
  assert.equal(runtime.status().consecutiveFailures, 1);
  releaseOutbox();
  while (!releaseIdle) await immediate();
  assert.equal(runtime.status().degraded, false);
  assert.equal(runtime.status().consecutiveFailures, 0);
  assert.equal(logs.filter(([, operation, status]) => operation === 'communication_worker' && status === 'recovered').length, 1);
  await runtime.stop(); releaseIdle();
});

test('persistently uncertain claims remain recoverable beyond the old retry budget', async () => {
  let clock = 0;
  let blocked = false;
  const runtime = createCommunicationRuntime({ config, chat: {}, now: () => clock,
    store: { async claimJobs() { throw new StoreError('commit_unknown'); } },
    wait: async ms => { clock += ms; if (clock >= 91000) { blocked = true; await new Promise(() => {}); } },
  });
  runtime.start();
  while (!blocked) await immediate();
  assert.equal(runtime.status().healthy, true);
  assert.equal(runtime.status().degraded, true);
  assert.ok(runtime.status().consecutiveFailures > 6);
  await runtime.stop();
});

test('transient hook completion failure degrades without replaying the hook or stopping the worker', async () => {
  let jobClaims = 0, hookRequests = 0, completions = 0, releaseIdle;
  const logs = [];
  const runtime = createCommunicationRuntime({
    config: { ...config, hooks: [{id:'hook',url:'https://example.invalid'}] }, chat: {}, hookTokens: {hook:'synthetic'}, log: (...entry) => logs.push(entry),
    store: {
      async claimJobs() { return ++jobClaims === 1 ? [{id:'job',hookId:'hook',payload:{},leaseToken:'lease',attempts:1}] : []; },
      async claimOutbox() { return []; },
      async finishJobWithOutbox() { completions += 1; throw new StoreError('store_timeout'); },
    },
    fetchImpl: async () => { hookRequests += 1; return {status:204}; },
    wait: async () => { await new Promise(resolve => { releaseIdle = resolve; }); },
  });
  runtime.start();
  while (!releaseIdle || !runtime.status().degraded) await immediate();
  assert.deepEqual({hookRequests, completions}, {hookRequests:1, completions:1});
  assert.equal(runtime.status().healthy, true);
  assert.equal(logs.find(([, operation]) => operation === 'communication_worker')[3].stage, 'active_hook');
  releaseIdle();
  while (runtime.status().degraded) await immediate();
  assert.equal(hookRequests, 1);
  await runtime.stop();
});

test('transient outbox settlement failure does not record a second outcome or replay the platform effect', async () => {
  let outboxClaims = 0, sends = 0, settlements = 0, releaseIdle;
  const logs = [];
  const runtime = createCommunicationRuntime({ config, log: (...entry) => logs.push(entry),
    chat: { async replyMessage() { sends += 1; return {messageId:'sent'}; } },
    store: {
      async claimJobs() { return []; },
      async claimOutbox() { return ++outboxClaims === 1 ? [{id:'outbox',kind:'reply',payload:{},platformUuid:'uuid',leaseToken:'lease'}] : []; },
      async settleOutbox() { settlements += 1; throw new StoreError('commit_unknown'); },
      async getOutbox() { return {status:'leased'}; },
    },
    wait: async () => { await new Promise(resolve => { releaseIdle = resolve; }); },
  });
  runtime.start();
  while (!releaseIdle || !runtime.status().degraded) await immediate();
  assert.deepEqual({sends, settlements}, {sends:1, settlements:1});
  assert.equal(runtime.status().healthy, true);
  assert.equal(logs.find(([, operation]) => operation === 'communication_worker')[3].stage, 'active_outbox');
  releaseIdle();
  while (runtime.status().degraded) await immediate();
  assert.deepEqual({sends, settlements}, {sends:1, settlements:1});
  await runtime.stop();
});

test('idle communication polling backs off to one second and shutdown wakes it', async () => {
  const waits = []; let releaseIdle;
  const runtime = createCommunicationRuntime({ config, chat: {},
    store: { async claimJobs() { return []; }, async claimOutbox() { return []; } },
    wait: async ms => { waits.push(ms); if (waits.length === 6) await new Promise(r => { releaseIdle = r; }); },
  });
  runtime.start();
  while (!releaseIdle) await immediate();
  assert.deepEqual(waits, [100, 200, 400, 800, 1000, 1000]);
  await runtime.stop(); releaseIdle();
});

test('a long-running operation does not keep empty claim polling at the fast cadence', async () => {
  const waits = []; let claims = 0, releaseHook, releaseIdle;
  const runtime = createCommunicationRuntime({ config: { ...config, hooks: [{id:'hook',url:'https://example.invalid'}] },
    chat: {}, hookTokens: {hook:'synthetic'},
    store: { async claimJobs() { return ++claims === 1 ? [{id:'one',hookId:'hook',payload:{},leaseToken:'lease'}] : []; },
      async claimOutbox() { return []; }, async finishJobWithOutbox() {} },
    fetchImpl: async () => { await new Promise(r => { releaseHook = r; }); return {status:204}; },
    wait: async ms => { waits.push(ms); if (waits.length === 7) await new Promise(r => { releaseIdle = r; }); },
  });
  runtime.start();
  while (!releaseIdle) await immediate();
  assert.deepEqual(waits, [100,100,200,400,800,1000,1000]);
  releaseHook();
  await runtime.stop(); releaseIdle();
});
