import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeltaCoalescer } from '../src/agents/codex/executor.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';
import { createLogger } from '../src/logger.mjs';
import { StoreError } from '../src/storage/errors.mjs';

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

test('logger allowlists storage resilience fields with snake-case output', () => {
  const events = [];
  const log = createLogger({ write: value => events.push(JSON.parse(value)) });
  log('warning', 'communication_worker', 'failed', {
    stage: 'claim_jobs', errorClass: 'store_timeout', errno: 1205, sqlState: 'HY000', durationMsSnake: 17,
    consecutiveFailures: 2, willRetry: true, sql: 'must not appear', payload: 'must not appear',
  });
  assert.deepEqual(events[0], {
    timestamp: events[0].timestamp, level: 'warning', module: 'bridge', component: 'service',
    operation: 'communication_worker', status: 'failed', consecutive_failures: 2, duration_ms: 17,
    stage: 'claim_jobs', error_class: 'store_timeout', errno: 1205, sql_state: 'HY000', will_retry: true,
  });
});
