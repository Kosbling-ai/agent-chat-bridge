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
      async listReactions() { return { items: [] }; },
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

test('busy waiting reuses one card and does not repeat Typing until admission succeeds', async () => {
  const job = jobFixture();
  job.result = { execution: { bindingOpenId: 'group:binding' } };
  const effects = [];
  let reaction = 0;
  const feedback = createExecutionFeedback({
    jobs: { async patchFeedback({ key, value }) { job.result = { ...job.result, [key]: structuredClone(value) }; } },
    sessions: {},
    chat: {
      async addReaction() { const id = `reaction-${++reaction}`; effects.push(`typing:add:${id}`); return { reaction_id: id }; },
      async removeReaction({ reactionId }) { effects.push(`typing:remove:${reactionId}`); },
      async listReactions() { effects.push('typing:list'); return { items: [] }; },
    },
    cardClient: { im: { v1: { message: {
      async create() { effects.push('card:create'); return { code: 0, data: { message_id: 'card-message' } }; },
      async patch() { effects.push('card:patch'); return { code: 0 }; },
    } } } },
  });

  const first = await feedback.start(job);
  await first.card.chain;
  await feedback.wait(job, first);
  const afterFirstWait = [...effects];
  const second = feedback.restoreWaiting(job);
  await feedback.wait(job, second);
  assert.deepEqual(effects, afterFirstWait);

  const admitted = feedback.restoreWaiting(job);
  feedback.activate(job, admitted, { turnId: 'turn-1' });
  await new Promise(resolve => setImmediate(resolve));
  await admitted.card.chain;
  assert.equal(effects.filter(value => value === 'card:create').length, 1);
  assert.equal(effects.filter(value => value === 'card:patch').length, 2, 'one waiting patch and one confirmed-admission patch');
  assert.deepEqual(effects.filter(value => value.startsWith('typing:add')), ['typing:add:reaction-1', 'typing:add:reaction-2']);
  assert.deepEqual(effects.filter(value => value.startsWith('typing:remove')), ['typing:remove:reaction-1']);
});

test('lease loss while card intent persistence is blocked prevents the platform call', async () => {
  const job = jobFixture();
  job.sourceMessageId = null;
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
  await started;
  lost = true;
  releasePersist();
  await state.card.chain;
  assert.equal(creates, 0);
});

test('stop callback is fenced to the original sender/card/turn and replay does not interrupt twice', async () => {
  const job = jobFixture();
  let interrupts = 0;
  let authorized = true;
  const feedback = createExecutionFeedback({
    jobs: {
      async getRun() { return job; },
      async beginStop() {
        if (job.result.stop) return { outcome:'replay',stop:job.result.stop };
        const stop = { threadId:'thread-1',turnId:'turn-1',messageId:'source-message',actor:'sender-1',outcome:'pending' };
        job.result.stop = stop;
        return { outcome:'new',stop };
      },
      async finishStop({ stop }) { job.result.stop = stop; },
    },
    sessions: { async loadBinding() { return { threadId: 'thread-1' }; } },
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
  assert.equal((await feedback.handleCardAction(action)).toast.content, '已请求停止执行');
  assert.equal(interrupts, 1);

  job.result.stop = undefined;
  assert.equal((await feedback.handleCardAction({ ...action, action: { value: { ...action.action.value, expectedTurnId: 'stale-turn' } } })).toast.content, '该卡片已失效');
  assert.equal(interrupts, 1);

  authorized = false;
  assert.equal((await feedback.handleCardAction(action)).toast.type, 'error');
  assert.equal(interrupts, 1);
});

test('unknown typing add is reconciled from app reactions on an independent persisted snapshot', async () => {
  const durable = jobFixture();
  durable.result.typing = { desired: false, operation: 'remove', outcome: 'unknown' };
  const removed = [];
  const feedback = createExecutionFeedback({
    jobs: { async patchFeedback({ key, value }) { durable.result = { ...durable.result, [key]: structuredClone(value) }; } },
    sessions: {}, cardClient: {}, executor: {},
    chat: {
      async listReactions() { return { items: [
        { reaction_id:'ours',operator:{operator_type:'app'},reaction_type:{emoji_type:'Typing'} },
        { reaction_id:'human',operator:{operator_type:'user'},reaction_type:{emoji_type:'Typing'} },
        { reaction_id:'other',operator:{operator_type:'app'},reaction_type:{emoji_type:'OK'} },
      ] }; },
      async removeReaction({ reactionId }) { removed.push(reactionId); },
    },
  });
  await feedback.cleanup(structuredClone(durable));
  assert.deepEqual(removed, ['ours']);
  assert.equal(durable.result.typing.outcome, 'confirmed');
  assert.equal(durable.result.typing.desired, false);
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
