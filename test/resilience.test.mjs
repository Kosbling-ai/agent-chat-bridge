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

test('communication poll retry limit transitions a persistently failing worker to unhealthy', async () => {
  let clock = 0;
  const logs = [];
  const waits = [];
  const runtime = createCommunicationRuntime({ config, chat: {}, now: () => clock, log: (...entry) => logs.push(entry),
    store: {
      async claimJobs() { throw new StoreError('store_timeout'); },
      async claimOutbox() { throw new Error('unexpected'); },
    },
    wait: async milliseconds => { waits.push(milliseconds); clock += milliseconds; },
  });
  runtime.start();
  while (runtime.status().running) await immediate();
  assert.equal(runtime.status().consecutiveFailures, 6);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 10000]);
  assert.equal(logs.filter(([level]) => level === 'warning').length, 5);
  assert.equal(logs.filter(([level]) => level === 'error').length, 1);
  assert.equal(logs.at(-1)[3].willRetry, false);
  await runtime.stop();
});

test('communication poll deadline prevents a sixth claim after slow failures', async () => {
  let clock = 0;
  let claims = 0;
  const waits = [];
  const logs = [];
  const runtime = createCommunicationRuntime({ config, chat: {}, now: () => clock, log: (...entry) => logs.push(entry),
    store: {
      async claimJobs() {
        claims += 1;
        clock += 1800;
        if (claims <= 5) throw new StoreError('store_timeout');
        return [];
      },
      async claimOutbox() { return []; },
    },
    wait: async milliseconds => { waits.push(milliseconds); clock += milliseconds; },
  });
  runtime.start();
  while (runtime.status().running) await immediate();
  assert.equal(claims, 5);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 7800]);
  assert.equal(clock, 31800);
  assert.equal(logs.at(-1)[0], 'error');
  assert.equal(logs.at(-1)[3].reason, 'retry_deadline');
  assert.equal(logs.at(-1)[3].willRetry, false);
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
