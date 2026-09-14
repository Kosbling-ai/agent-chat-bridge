import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionFeedback } from '../src/channels/feishu/execution-feedback.mjs';
import { createProcessingTyping } from '../src/channels/feishu/typing.mjs';

function jobFixture() {
  return {
    id: 'run-1',
    leaseOwner: 'worker',
    callerId: 'live',
    chatId: 'chat-1',
    chatType: 'group',
    messageId: 'source-message',
    sourceMessageId: 'source-message',
    senderOpenId: 'sender-1',
    deliveryMode: 'bridge',
    status: 'running',
    result: {
      execution: { threadId: 'thread-1', turnId: 'turn-1' },
      executionCard: { messageId: 'card-message', entries: [] },
    },
  };
}

test('live feedback awaits production Typing before starting the execution card', async () => {
  const job = jobFixture();
  const calls = [];
  let release;
  const feedback = createExecutionFeedback({
    jobs: {
      async patchFeedback({ key, value }) {
        job.result = { ...job.result, [key]: value };
      },
    },
    sessions: {},
    chat: {},
    typing: { async start() { calls.push('typing:start'); await new Promise(resolve => { release = resolve; }); return { reactionId:'reaction-1' }; } },
    cardClient: {},
    executor: {},
  });

  const started = feedback.start(job);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['typing:start']);
  release();
  const state = await started;
  assert.equal(state.typing.reactionId, 'reaction-1');
  state.card.stop();
});

test('normal completion removes the confirmed Typing reaction before audit and list recovery', async () => {
  const job = jobFixture();
  delete job.result.executionCard;
  const removed = [];
  const typing = createProcessingTyping({
    chat: {
      async addReaction() { return { reaction_id: 'known-reaction' }; },
      async removeReaction({ reactionId }) { removed.push(reactionId); },
      async listReactions() { throw new Error('synthetic list failure'); },
    },
    inbound: {
      async recordEvent() { throw new Error('synthetic audit failure'); },
      async loadOpenProcessingReactionIds() { return new Set(); },
    },
  });
  const feedback = createExecutionFeedback({
    jobs: { async patchFeedback() {} }, sessions: {}, chat: {}, typing, executor: {},
    cardClient: { im: { v1: { message: {
      async create() { return { code: 0, data: { message_id: 'card-message' } }; },
    } } } },
  });

  const state = await feedback.start(job);
  const result = { ...job.result, answer: 'done' };
  await feedback.prepare(job, result, state);
  assert.deepEqual(result.processingReaction, { reactionId: 'known-reaction' });
  await feedback.cleanup({ ...job, result });
  assert.deepEqual(removed, ['known-reaction']);
});

test('terminal snapshot persistence failure stops before any card delivery', async () => {
  const job = jobFixture();
  delete job.result.executionCard;
  let creates = 0;
  const feedback = createExecutionFeedback({
    jobs: { async patchFeedback() { throw Object.assign(new Error('lost'), { code: 'forward_lease_lost' }); } },
    sessions: {}, typing: { async start() { return null; } },
    cardClient: { im: { v1: { message: { async create() { creates += 1; } } } } },
  });
  const state = await feedback.start(job);
  await assert.rejects(feedback.prepare(job, { answer: 'done' }, state), { code: 'forward_lease_lost' });
  assert.equal(creates, 0);
});

test('busy waiting reuses one card and does not repeat Typing until admission succeeds', async () => {
  const job = jobFixture();
  job.result = { execution: { bindingOpenId: 'group:binding' } };
  const effects = [];
  let reaction = 0;
  const feedback = createExecutionFeedback({
    jobs: { async patchFeedback({ key, value }) { job.result = { ...job.result, [key]: structuredClone(value) }; } },
    sessions: {},
    chat: {},
    typing: {
      async start() { const id = `reaction-${++reaction}`; effects.push(`typing:add:${id}`); return { reactionId:id }; },
      async cleanup(_job, value) { effects.push(`typing:remove:${value?.reactionId || 'persisted'}`); },
    },
    cardClient: { im: { v1: { message: {
      async create() { effects.push('card:create'); return { code: 0, data: { message_id: 'card-message' } }; },
      async patch() { effects.push('card:patch'); return { code: 0 }; },
    } } } },
  });

  const first = await feedback.start(job);
  await first.card.chain;
  await feedback.wait(job, first);
  const second = feedback.restoreWaiting(job);
  await feedback.wait(job, second);
  assert.deepEqual(effects.filter(value => value.startsWith('typing:add')), ['typing:add:reaction-1']);

  const admitted = feedback.restoreWaiting(job);
  feedback.activate(job, admitted, { turnId: 'turn-1' });
  await new Promise(resolve => setImmediate(resolve));
  await admitted.card.chain;
  assert.equal(effects.filter(value => value === 'card:create').length, 1);
  assert.equal(effects.filter(value => value === 'card:patch').length, 0, 'an unsent waiting card is created only after confirmed admission');
  assert.deepEqual(effects.filter(value => value.startsWith('typing:add')), ['typing:add:reaction-1']);
  assert.deepEqual(effects.filter(value => value.startsWith('typing:remove')), ['typing:remove:reaction-1','typing:remove:persisted']);
});

test('busy waiting follows the original single pause patch and then stays quiet', async () => {
  const job = jobFixture();
  job.sourceMessageId = null;
  job.result.executionCard = {
    messageId: 'card-message',
    status: 'running',
    entries: [],
    desiredRevision: 1,
    ackedRevision: 1,
    deliveryState: { operation: 'patch', status: 'confirmed', at: 1 },
  };
  let patches = 0;
  const feedback = createExecutionFeedback({
    jobs: {
      async patchFeedback({ key, value }) {
        job.result = { ...job.result, [key]: structuredClone(value) };
      },
    },
    sessions: {}, chat: {}, executor: {},
    cardClient: { im: { v1: { message: {
      async patch() {
        patches += 1;
        if (patches === 1) throw new Error('ambiguous transport failure');
        return { code: 0 };
      },
    } } } },
  });

  await feedback.wait(job, feedback.restoreWaiting(job));
  assert.equal(patches, 1);
  assert.equal(job.result.executionCard.status, 'retrying');
  await feedback.wait(job, feedback.restoreWaiting(job));
  assert.equal(patches, 1);
});

test('real progress card create precedes sidecar persistence and does not repeat after lease loss', async () => {
  const job = jobFixture();
  job.sourceMessageId = null;
  delete job.result.executionCard;
  let releasePersist;
  let persistenceStarted;
  let lost = false;
  let creates = 0;
  const started = new Promise(resolve => { persistenceStarted = resolve; });
  const feedback = createExecutionFeedback({
    jobs: {
      async patchFeedback({ key }) {
        assert.equal(key, 'executionCard');
        persistenceStarted();
        await new Promise(resolve => { releasePersist = resolve; });
      },
    },
    sessions: {}, chat: {}, executor: {},
    cardClient: { im: { v1: { message: { async create() { creates += 1; return { code: 0, data: { message_id: 'card' } }; } } } } },
  });
  const state = await feedback.start(job, {
    assertOwned() {
      if (lost) throw Object.assign(new Error('lease lost'), { code: 'forward_lease_lost' });
    },
  });
  state.card.push({ kind: 'started', turnId: 'turn-1' });
  await started;
  lost = true;
  releasePersist();
  await state.card.chain;
  state.card.stop();
  assert.equal(creates, 1);
});

test('legacy unconfirmed card state is held without another platform write', async () => {
  const job = jobFixture();
  job.sourceMessageId = null;
  job.result.executionCard = { status: 'completed', entries: [], delivery: 'unknown',
    deliveryState: { operation: 'create', status: 'unknown' } };
  let writes = 0;
  const feedback = createExecutionFeedback({ jobs: { async patchFeedback() {} }, sessions: {}, chat: {}, executor: {},
    cardClient: { im: { v1: { message: { async create() { writes += 1; }, async patch() { writes += 1; } } } } } });
  await assert.rejects(feedback.finish(job, job.result), { code: 'execution_card_delivery_unknown', outcome: 'unknown' });
  assert.equal(writes, 0);
});

test('stop callback is fenced to the original sender/card/turn and replay does not interrupt twice', async () => {
  const job = jobFixture();
  job.result.execution = { bindingOpenId: 'group:binding' };
  job.result.executionCard.turnId = 'turn-1';
  let interrupts = 0;
  let stoppedIdentity;
  let authorized = true;
  const feedback = createExecutionFeedback({
    jobs: {
      async getRun() { return job; },
      async beginStop(input) {
        stoppedIdentity = { threadId:input.threadId,turnId:input.turnId };
        if (job.result.stop) return { outcome:'replay',stop:job.result.stop };
        const stop = { threadId:'thread-1',turnId:'turn-1',messageId:'source-message',actor:'sender-1',outcome:'pending' };
        job.result.stop = stop;
        return { outcome:'new',stop };
      },
      async finishStop({ stop }) { job.result.stop = stop; },
    },
    sessions: { async loadBinding() { return { codexSessionId: 'thread-1' }; } },
    chat: {},
    cardClient: {},
    executor: { async interrupt() { interrupts += 1; return { status: 'requested' }; }, async inspect() { return { status:'inProgress' }; } },
    authorize: async () => authorized,
  });
  const action = {
    action: { value: { action: 'stop_execution', jobId: job.id, expectedTurnId: 'turn-1' } },
    operator: { open_id: 'sender-1' },
    context: { open_chat_id: 'chat-1', open_message_id: 'card-message' },
  };

  assert.equal((await feedback.handleCardAction(action)).toast.content, '已请求停止执行');
  assert.deepEqual(stoppedIdentity,{threadId:'thread-1',turnId:'turn-1'});
  assert.equal((await feedback.handleCardAction(action)).toast.content, '已请求停止执行');
  assert.equal(interrupts, 1);

  job.result.stop = undefined;
  assert.equal((await feedback.handleCardAction({ ...action, action: { value: { ...action.action.value, expectedTurnId: 'stale-turn' } } })).toast.content, '该卡片已失效');
  assert.equal(interrupts, 1);

  authorized = false;
  assert.equal((await feedback.handleCardAction(action)).toast.type, 'error');
  assert.equal(interrupts, 1);
});

test('recovery delegates persisted and app reaction cleanup without replaying add', async () => {
  const durable = jobFixture();
  durable.result.typing = { desired: false, operation: 'remove', outcome: 'unknown' };
  const calls = [];
  const feedback = createExecutionFeedback({
    jobs: { async patchFeedback({ key, value }) { durable.result = { ...durable.result, [key]: structuredClone(value) }; } },
    sessions: {}, cardClient: {}, executor: {}, chat: {},
    typing: { async start() { calls.push('add'); }, async cleanup() { calls.push('cleanup'); } },
  });
  await feedback.restore(structuredClone(durable));
  assert.deepEqual(calls, ['cleanup']);
});

test('concurrent stop callbacks register once and replay only inspects the exact turn', async () => {
  const job = jobFixture();
  let saved;
  let interrupts = 0;
  let inspections = 0;
  let release;
  const jobs = {
    async getRun() { return structuredClone(job); },
    async beginStop() {
      if (saved) return { outcome:'replay',stop:structuredClone(saved) };
      saved = { threadId:'thread-1',turnId:'turn-1',messageId:'source-message',actor:'sender-1',outcome:'pending' };
      return { outcome:'new',stop:structuredClone(saved) };
    },
    async finishStop({ stop }) { saved = structuredClone(stop); },
  };
  const feedback = createExecutionFeedback({ jobs, sessions:{async loadBinding(){return{codexSessionId:'thread-1'};}}, chat:{}, cardClient:{}, authorize:async()=>true,
    executor:{async interrupt(){interrupts+=1;await new Promise(resolve=>{release=resolve;});return{status:'requested'};},async inspect(){inspections+=1;return{status:'inProgress'};}} });
  const action={action:{value:{action:'stop_execution',jobId:'run-1',expectedTurnId:'turn-1'}},operator:{open_id:'sender-1'},context:{open_chat_id:'chat-1',open_message_id:'card-message'}};
  const first=feedback.handleCardAction(action);
  while(!release)await new Promise(resolve=>setImmediate(resolve));
  const second=await feedback.handleCardAction(action);
  release();await first;
  assert.equal(second.toast.type,'error');
  assert.equal(interrupts,1);assert.equal(inspections,1);
});

test('terminal cards derive completed failed and interrupted from persisted result facts', async () => {
  for (const [result, expected] of [
    [{ answer:'ok', execution:{terminal:'completed'} }, '已完成'],
    [{ answer:'failed', failed:true, turnStatus:'failed', execution:{terminal:'failed'} }, '执行失败'],
    [{ answer:'stopped', failed:true, turnStatus:'interrupted', execution:{terminal:'interrupted'} }, '已中断'],
  ]) {
    const job=jobFixture();job.sourceMessageId=null;job.result={...job.result,...result};
    let content;
    const feedback=createExecutionFeedback({jobs:{async patchFeedback(){}},sessions:{},chat:{},executor:{},cardClient:{im:{v1:{message:{async patch(input){content=JSON.parse(input.data.content);return{code:0};}}}}}});
    assert.equal(await feedback.finish(job,job.result),true);
    assert(JSON.stringify(content).includes(expected));
  }
});
