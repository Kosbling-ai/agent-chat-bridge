import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionFeedback } from '../src/channels/feishu/execution-feedback.mjs';

function jobFixture() {
  return {
    id: 'run-1',
    leaseOwner: 'worker',
    callerId: 'live',
    chatId: 'chat-1',
    chatType: 'group',
    messageId: 'source-message',
    senderOpenId: 'sender-1',
    deliveryMode: 'bridge',
    status: 'running',
    result: {
      execution: { threadId: 'thread-1', turnId: 'turn-1' },
      executionCard: { messageId: 'card-message', entries: [] },
    },
  };
}

test('terminal typing intent removes an add reaction that confirms late', async () => {
  const job = jobFixture();
  const calls = [];
  let confirmAdd;
  const feedback = createExecutionFeedback({
    jobs: {
      async patchFeedback({ key, value }) {
        job.result = { ...job.result, [key]: value };
      },
    },
    sessions: {},
    chat: {
      async addReaction() {
        calls.push('add');
        return new Promise(resolve => { confirmAdd = resolve; });
      },
      async removeReaction({ reactionId }) {
        calls.push(`remove:${reactionId}`);
        return {};
      },
    },
    cardClient: {},
    executor: {},
  });

  const state = await feedback.start(job);
  while (!confirmAdd) await new Promise(resolve => setImmediate(resolve));
  const prepared = feedback.prepare(job, {}, state);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(job.result.typing.desired, false);
  confirmAdd({ reaction_id: 'reaction-1' });
  await prepared;

  assert.deepEqual(calls, ['add', 'remove:reaction-1']);
  assert.equal(job.result.typing.outcome, 'confirmed');
  assert.equal(job.result.typing.desired, false);
});

test('stop callback is fenced to the original sender/card/turn and replay does not interrupt twice', async () => {
  const job = jobFixture();
  let interrupts = 0;
  let authorized = true;
  const feedback = createExecutionFeedback({
    jobs: {
      async getRun() { return job; },
      async patchFeedback({ key, value }) { job.result = { ...job.result, [key]: value }; },
    },
    sessions: { async loadBinding() { return { threadId: 'thread-1' }; } },
    chat: {},
    cardClient: {},
    executor: { async interrupt() { interrupts += 1; return { status: 'requested' }; } },
    authorize: async () => authorized,
  });
  const action = {
    action: { value: { action: 'stop_execution', jobId: job.id, expectedTurnId: 'turn-1' } },
    operator: { open_id: 'sender-1' },
    context: { open_chat_id: 'chat-1', open_message_id: 'card-message' },
  };

  assert.equal((await feedback.handleCardAction(action)).toast.content, '已请求停止执行');
  assert.equal((await feedback.handleCardAction(action)).toast.content, '已请求停止执行');
  assert.equal(interrupts, 1);

  job.result.stop = undefined;
  assert.equal((await feedback.handleCardAction({ ...action, action: { value: { ...action.action.value, expectedTurnId: 'stale-turn' } } })).toast.content, '该卡片已失效');
  assert.equal(interrupts, 1);

  authorized = false;
  assert.equal((await feedback.handleCardAction(action)).toast.type, 'error');
  assert.equal(interrupts, 1);
});
