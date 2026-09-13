import test from 'node:test';
import assert from 'node:assert/strict';
import { admitThread } from '../src/core/thread-admission.mjs';
const job = { id: 'job', leaseToken: 'lease' };
test('archived replacement requires exact rejected resume and fresh durable reset permission', async () => {
  let resetCalls = 0, starts = 0, duplicate = false;
  const store = { resetRejectedThreadAdmission: async () => { resetCalls++; return { generation: 2, nativeThreadId: null, recoveryRequired: duplicate }; } };
  const codex = { resumeThread: async () => { throw Object.assign(new Error('synthetic'), { outcome: 'rejected', reason: { kind: 'thread_archived', threadId: 'old' } }); }, startThread: async () => { starts++; return { thread: { id: 'new' } }; } };
  const attempt = { generation: 1, nativeThreadId: 'old' };
  const result = await admitThread({ store, codex, job, attempt });
  assert.equal(result.thread.thread.id, 'new'); assert.equal(attempt.generation, 2); assert.equal(starts, 1);
  duplicate = true;
  assert.equal((await admitThread({ store, codex, job, attempt: { generation: 1, nativeThreadId: 'old' } })).recoveryRequired, true);
  assert.equal(starts, 1); assert.equal(resetCalls, 2);
});
test('unknown resume or unmatched archived identity never authorizes replacement', async () => {
  for (const error of [Object.assign(new Error('synthetic'), { outcome: 'unknown' }), Object.assign(new Error('synthetic'), { outcome: 'rejected', reason: { kind: 'thread_archived', threadId: 'other' } })]) {
    let calls = 0;
    await assert.rejects(admitThread({ store: { resetRejectedThreadAdmission: async () => { calls++; } }, codex: { resumeThread: async () => { throw error; }, startThread: async () => { calls++; } }, job, attempt: { generation: 1, nativeThreadId: 'old' } }));
    assert.equal(calls, 0);
  }
});
