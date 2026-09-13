import test from 'node:test';
import assert from 'node:assert/strict';
import { observeNativeTurn, isTerminalTurn } from '../src/core/observe-turn.mjs';
const errorEvent = willRetry => ({ method: 'error', params: { threadId: 'thread', turnId: 'turn', willRetry, error: { message: 'SYNTHETIC_PROVIDER_DETAIL' } } });
async function observe(events, turn, rejection) {
  let polls = 0, reads = 0, sleeps = 0; const persisted = [];
  const result = await observeNativeTurn({ connectionId: 'fixture', job: { id: 'run', leaseToken: 'lease' }, attempt: { nativeThreadId: 'thread' }, turnId: 'turn', stopped: () => sleeps >= 3,
    sleep: async () => { sleeps++; }, store: { readNativeEvents: async () => { const event = events[polls++]; return event ? [{ sequence: polls, payload: event }] : []; }, appendRunEvent: async entry => persisted.push(entry), renewJob: async () => {} },
    codex: { status: () => ({ state: 'ready' }), readThread: async () => { reads++; if (rejection) throw rejection; return { thread: { turns: turn ? [turn] : [] } }; } } });
  return { result, polls, reads, sleeps, persisted };
}
test('non-retrying errors immediately reconcile known native turn and only accept explicit terminal status', async () => {
  for (const status of ['completed', 'failed', 'interrupted', 'inProgress', 'futureStatus', undefined]) {
    const actual = await observe([errorEvent(false)], status ? { id: 'turn', status } : null);
    assert.equal(actual.polls, 1); assert.equal(actual.reads, 1); assert.equal(actual.sleeps, 0);
    assert.equal(actual.persisted.length, 1);
    assert.equal(actual.result?.status ?? null, isTerminalTurn({ status }) ? status : null);
  }
});
test('retrying errors keep waiting; terminal notification remains authoritative and foreign turn is ignored', async () => {
  const turn = { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', text: 'answer' }] };
  const actual = await observe([{ ...errorEvent(false), params: { ...errorEvent(false).params, turnId: 'foreign' } }, errorEvent(true), { method: 'turn/completed', params: { threadId: 'thread', turn } }], turn);
  assert.equal(actual.polls, 3); assert.equal(actual.reads, 0); assert.equal(actual.result, turn); assert.equal(actual.persisted.length, 2);
  const retryOnly = await observe([errorEvent(true)], turn);
  assert.equal(retryOnly.reads, 0); assert.equal(retryOnly.result, null);
});
test('native read rejection stays a rejection for the existing attempt and never becomes a failed turn', async () => {
  const failure = Object.assign(new Error('synthetic read refusal'), { outcome: 'rejected' });
  await assert.rejects(observe([errorEvent(false)], null, failure), error => error === failure);
});
