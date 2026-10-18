import test from 'node:test';
import assert from 'node:assert/strict';
import { createForwardRuntime } from '../src/core/forward-runtime.mjs';

const flush = async () => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

function fixture({ renew, leaseMs = 40, heartbeatMs = 10, leaseExpiresAt } = {}) {
  const logs = [];
  const writes = [];
  let executeCalls = 0;
  let executionSignal;
  const job = {
    id: 'run-1', leaseOwner: 'lease-owner', status: 'running', attempts: 1,
    deliveryMode: 'caller', callerId: 'caller', executionNamespace: 'scope',
    chatId: 'chat', chatType: 'group', messageId: 'message', senderOpenId: 'human',
    senderUnionId: '', senderName: 'Human', prompt: 'work', contextEntries: [], result: {}, leaseExpiresAt,
  };
  const jobs = {
    async upsert() { return job; },
    async getRun() { return job; },
    async claimById() { return job; },
    async claimReplyById() { return null; },
    async renew(input) { return renew(input); },
    async markReplyPending() { writes.push('reply_pending'); },
    async markRetry() { writes.push('retry'); },
  };
  const executor = {
    async execute(_input, { signal }) {
      executeCalls += 1;
      executionSignal = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { code: 'CODEX_WAIT_ABORTED', outcome: 'unknown' }));
      }, { once: true }));
    },
  };
  const runtime = createForwardRuntime({
    config: { owner: 'owner', leaseMs, heartbeatMs }, jobs, sessions: {}, executor,
    authorize: async () => true, now: Date.now, log: (...entry) => logs.push(entry),
  });
  const run = () => runtime.handleMessage({
    callerId: 'caller', idempotencyKey: 'key', conversationId: 'chat',
    actor: { openId: 'human', name: 'Human' },
    message: { conversationId: 'chat', conversationType: 'group', messageId: 'message', type: 'text', text: 'work' },
  });
  return { runtime, run, logs, writes,
    get executeCalls() { return executeCalls; },
    get executionSignal() { return executionSignal; } };
}

test('transient renewal failures retry within the confirmed lease and log one recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let renewals = 0;
  let concurrent = 0;
  let maxConcurrent = 0;
  const f = fixture({ renew: async () => {
    renewals += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    try {
      if (renewals === 2) throw Object.assign(new Error('temporary'), { code: 'store_timeout' });
      return { renewed: true };
    } finally { concurrent -= 1; }
  } });
  const running = f.run();
  await flush();
  assert.equal(f.executeCalls, 1);
  t.mock.timers.tick(10);
  await flush();
  assert.equal(f.executionSignal.aborted, false);
  t.mock.timers.tick(5);
  await flush();
  assert.equal(renewals, 3);
  assert.equal(maxConcurrent, 1);
  assert.equal(f.executionSignal.aborted, false);
  assert.equal(f.logs.filter(([, operation, status]) => operation === 'forward_lease' && status === 'degraded').length, 1);
  assert.equal(f.logs.filter(([, operation, status]) => operation === 'forward_lease' && status === 'recovered').length, 1);
  f.runtime.beginStop();
  await running;
});

test('persistent transient renewal failure aborts at the last confirmed deadline without terminal writes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let renewals = 0;
  const f = fixture({ renew: async () => {
    renewals += 1;
    if (renewals > 1) throw Object.assign(new Error('temporary'), { code: 'store_unavailable' });
    return { renewed: true };
  } });
  const running = f.run();
  await flush();
  t.mock.timers.tick(39);
  await flush();
  assert.equal(f.executionSignal.aborted, false);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(f.executionSignal.aborted, true);
  await running;
  assert.deepEqual(f.writes, []);
  assert.equal(f.logs.filter(([, operation, status]) => operation === 'forward_lease' && status === 'degraded').length, 1);
  assert.equal(f.logs.some(([, operation, status]) => operation === 'forward_lease' && status === 'recovered'), false);
});

test('a stale lease aborts immediately and an initial renewal failure never starts execution', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let renewals = 0;
  const stale = fixture({ renew: async () => {
    renewals += 1;
    if (renewals > 1) throw Object.assign(new Error('stale'), { code: 'stale_lease' });
    return { renewed: true };
  } });
  const staleRun = stale.run();
  await flush();
  t.mock.timers.tick(10);
  await flush();
  assert.equal(stale.executionSignal.aborted, true);
  await staleRun;
  assert.deepEqual(stale.writes, []);

  const initial = fixture({ renew: async () => {
    throw Object.assign(new Error('temporary'), { code: 'store_timeout' });
  } });
  await assert.rejects(initial.run(), { code: 'store_timeout' });
  assert.equal(initial.executeCalls, 0);
});

test('a renewal that completes after the old deadline is rejected even when storage reports success', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let renewals = 0;
  let finishRenewal;
  const f = fixture({ renew: async () => {
    renewals += 1;
    if (renewals === 2) await new Promise(resolve => { finishRenewal = resolve; });
    return { renewed: true };
  } });
  const running = f.run();
  await flush();
  t.mock.timers.tick(10);
  await flush();
  assert.equal(typeof finishRenewal, 'function');
  t.mock.timers.setTime(41);
  finishRenewal();
  await flush();
  assert.equal(f.executionSignal.aborted, true);
  await running;
  assert.deepEqual(f.writes, []);
});

test('an initial renewal that returns after the claimed lease deadline never starts execution', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let finishRenewal;
  const f = fixture({ leaseExpiresAt: 20, renew: async () => {
    await new Promise(resolve => { finishRenewal = resolve; });
    return { renewed: true };
  } });
  const running = f.run();
  await flush();
  assert.equal(typeof finishRenewal, 'function');
  t.mock.timers.setTime(21);
  finishRenewal();
  await running;
  assert.equal(f.executeCalls, 0);
  assert.deepEqual(f.writes, []);
});

test('stopping aborts the operation and prevents any later heartbeat', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let renewals = 0;
  const f = fixture({ renew: async () => { renewals += 1; return { renewed: true }; } });
  const running = f.run();
  await flush();
  f.runtime.beginStop();
  await flush();
  assert.equal(f.executionSignal.aborted, true);
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(renewals, 1);
  await running;
});
