import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOutboundMedia } from '../src/channels/feishu/outbound-media.mjs';
import { createFeishuReplies, markdownToFeishuPost } from '../src/channels/feishu/replies.mjs';
import { createExecutionFeedback } from '../src/channels/feishu/execution-feedback.mjs';

test('card delivery sends attachments and never repeats an unknown upload after lease loss', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-forward-replies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const chat = {
    async uploadFile({ fileName }) { calls.push(`upload:${fileName}`); return { file_key: `key:${fileName}` }; },
    async uploadImage() { throw new Error('unexpected image'); },
    async sendMessage({ content }) { calls.push(`send:${content.file_key}`); return { message_id: `message:${content.file_key}` }; },
    async replyMessage() { throw new Error('card success must skip fallback text'); },
  };
  const outbound = await createOutboundMedia({
    workspace: root, outboxDir: join(root, 'outbox'), bindingOutboxDir: join(root, 'data/feishu-outbox'),
    spoolDir: join(root, 'spool'), allowedGroupChatIds: new Set(['chat']), chat,
  });
  const scope = { connectionId: 'fixture', conversationId: 'chat', runId: 'run', conversationType: 'group', bindingOpenId: 'group:binding', sinceMs: 1000 };
  const directory = await outbound.directory(scope);
  for (const name of ['first.txt', 'second.txt']) {
    await writeFile(join(directory, name), name);
    await utimes(join(directory, name), 1, 1);
  }
  const job = { id: 'run', leaseOwner: 'worker', chatId: 'chat', chatType: 'group', sourceMessageId: 'source', startedAt: 1000,
    result: { execution: { bindingOpenId: 'group:binding', startedAt: 1000 }, answer: 'done' } };
  const jobs = {
    async patchReplyResult({ result }) { job.result = structuredClone(result); },
    async patchFeedback({ value }) { job.result = { ...job.result, delivery: structuredClone(value) }; },
  };
  const replies = createFeishuReplies({ chat, outbound, jobs, connectionId: 'fixture' });
  job.result = await replies.prepare(job, job.result);

  let fences = 0;
  await assert.rejects(replies.deliver(job, job.result, { skipText: true, assertLease() {
    fences += 1;
    if (fences === 4) throw Object.assign(new Error('lost'), { code: 'forward_lease_lost' });
  } }), { code: 'forward_lease_lost' });
  assert.equal(job.result.delivery.attachments[0].status, 'cleaned');
  assert.equal(job.result.delivery.attachments[1].status, 'upload_intent');

  const resumed = await replies.deliver(job, job.result, { skipText: true, assertLease() {} });
  assert.deepEqual(calls, [
    'upload:first.txt', 'send:key:first.txt',
  ]);
  assert.equal(resumed.status, 'unknown');
  assert.equal(job.result.delivery.attachments[0].status, 'cleaned');
  assert.equal(job.result.delivery.attachments[1].status, 'unknown');
});

test('API run without a source message creates the original post in the conversation', async () => {
  const calls=[];
  const job={id:'api-run',leaseOwner:'worker',chatId:'chat',chatType:'group',sourceMessageId:null,result:{answer:'done',delivery:{artifactsPrepared:true,attachments:[]}}};
  const jobs={async patchFeedback({value}){job.result={...job.result,delivery:structuredClone(value)};}};
  const replies=createFeishuReplies({chat:{async sendMessage(input){calls.push(input);return{message_id:'created'};},async replyMessage(){throw new Error('must not reply');}},jobs,connectionId:'fixture'});
  const delivered=await replies.deliver(job,job.result,{assertLease(){}});
  assert.equal(delivered.status,'sent');
  assert.equal(calls[0].conversationId,'chat');
  assert.equal(calls[0].kind,'post');
});

test('ordinary replies use chat create, production markdown conversion and 3000-character chunks', async () => {
  const calls = [];
  const job = { id:'run', leaseOwner:'worker', chatId:'chat', messageId:'source', sourceMessageId:'source',
    result:{ answer:`# Title\n[link](https://example.invalid)\n${'x'.repeat(3100)}` } };
  const replies = createFeishuReplies({ chat: {
    async sendMessage(input) { calls.push(input); return { message_id:`sent-${calls.length}` }; },
    async replyMessage() { throw new Error('production reply must use chat create'); },
  }, jobs:{}, connectionId:'fixture', maxOutputChars:3500 });
  const delivered = await replies.deliver(job, job.result, { assertLease() {} });
  assert.equal(delivered.status, 'sent');
  assert.equal(delivered.messages, 2);
  assert(calls.every(call => call.conversationId === 'chat' && call.kind === 'post'));
  assert.deepEqual(calls[0].content.zh_cn.content[0], [{ tag:'text', text:'Title' }]);
  assert.deepEqual(calls[0].content.zh_cn.content[1], [{ tag:'a', text:'link', href:'https://example.invalid' }]);
  assert.equal(new Set(calls.map(call => call.uuid)).size, 2);
});

test('text reply mode keeps the original 1900-character chunks', async () => {
  const calls = [];
  const job = { id:'run', leaseOwner:'worker', chatId:'chat', messageId:'source', result:{ answer:'x'.repeat(2000) } };
  const replies = createFeishuReplies({ chat:{ async sendMessage(input) { calls.push(input); return { message_id:'sent' }; } },
    jobs:{}, connectionId:'fixture', replyAsPost:false, maxOutputChars:3500 });
  assert.equal((await replies.deliver(job, job.result, { assertLease() {} })).messages, 2);
  assert.deepEqual(calls.map(call => [call.kind, call.content.text.length]), [['text',1900],['text',100]]);
});

test('legacy unconfirmed ordinary reply is held without another create', async () => {
  let creates = 0;
  const job = { id:'run', leaseOwner:'worker', chatId:'chat', messageId:'source',
    result:{ answer:'done', delivery:{ text:{ items:[{ index:0, status:'unknown' }] } } } };
  const replies = createFeishuReplies({ chat:{ async sendMessage() { creates += 1; } }, jobs:{}, connectionId:'fixture' });
  const delivered = await replies.deliver(job, job.result, { assertLease() {} });
  assert.equal(delivered.status, 'unknown');
  assert.equal(creates, 0);
  assert.deepEqual(markdownToFeishuPost(''), { zh_cn:{ title:'', content:[[{ tag:'text', text:' ' }]] } });
});

test('final card rejection flows through the controller into the original post fallback', async () => {
  const effects = [];
  const job = { id:'run', leaseOwner:'worker', callerId:'live', chatId:'chat', chatType:'p2p', messageId:'source',
    sourceMessageId:null, senderOpenId:'human', deliveryMode:'bridge', result:{ answer:'final answer',
      execution:{ threadId:'thread', turnId:'turn', terminal:'completed' },
      executionCard:{ messageId:'card-message', status:'running', entries:[] } } };
  const jobs = { async patchFeedback({ key, value }) { job.result = { ...job.result, [key]:structuredClone(value) }; } };
  const feedback = createExecutionFeedback({ jobs, sessions:{}, chat:{}, executor:{},
    cardClient:{ im:{ v1:{ message:{ async patch() { effects.push('card:patch'); return { code:999 }; } } } } } });
  const replies = createFeishuReplies({ jobs, connectionId:'fixture', chat:{
    async sendMessage(input) { effects.push(`message:${input.kind}`); return { message_id:'post-message' }; },
  } });
  const cardDelivered = await feedback.finish(job, job.result);
  const delivered = await replies.deliver(job, job.result, { skipText:cardDelivered, assertLease() {} });
  assert.equal(cardDelivered, false);
  assert.equal(delivered.status, 'sent');
  assert.deepEqual(effects, ['card:patch', 'card:patch', 'message:post']);
});
