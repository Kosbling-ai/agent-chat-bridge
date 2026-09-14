import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFeishuReplies, markdownToFeishuPost } from '../src/channels/feishu/replies.mjs';
import { createExecutionFeedback } from '../src/channels/feishu/execution-feedback.mjs';

test('bridge attachments use executor paths, delete successes and retain failures without blocking text', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-forward-replies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const chat = { async sendMessage(){calls.push('text');return{message_id:'text'};} };
  const first=join(root,'first.txt'),second=join(root,'second.txt');await writeFile(first,'first');await writeFile(second,'second');
  const job = { id: 'run', leaseOwner: 'worker', chatId: 'chat', chatType: 'group', messageId: 'source', sourceMessageId: 'source', startedAt: 1000,
    result: { execution: { bindingOpenId: 'group:binding', threadId: 'thread', turnId: 'turn', startedAt: 1000 }, answer: 'done', attachments:[first,second] } };
  const replies = createFeishuReplies({ chat, jobs:{}, connectionId:'fixture', allowedGroupChatIds:new Set(['chat']),
    async sendAttachment({filePath,uuid}){calls.push(`attachment:${filePath}:${uuid}`);if(filePath===second)throw new Error('synthetic');return{messageId:'sent'};} });
  const delivered=await replies.deliver(job,job.result,{assertLease(){}});
  assert.equal(delivered.status,'sent');assert.deepEqual(delivered.attachments.map(item=>item.status),['sent','failed']);
  await assert.rejects(stat(first),{code:'ENOENT'});assert.equal((await stat(second)).isFile(),true);
  const sha1 = value => createHash('sha1').update(value).digest('hex').slice(0,24);
  const prefix = sha1('codex-reply:source:turn:thread');
  assert.deepEqual(calls,['text',`attachment:${first}:${sha1(`${prefix}:file:0`)}`,`attachment:${second}:${sha1(`${prefix}:file:1`)}`]);
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

test('legacy unconfirmed attachments are held before old artifact objects are filtered', async () => {
  for (const legacyStatus of ['upload_intent', 'send_intent', 'unknown']) {
    let writes = 0;
    const job = {
      id: 'run', leaseOwner: 'worker', chatId: 'chat', messageId: 'source',
      result: {
        attachments: [{ ref: { artifactId: 'artifact' }, fileName: 'old.txt' }],
        delivery: { attachments: [{ artifactId: 'artifact', status: legacyStatus }] },
      },
    };
    const replies = createFeishuReplies({
      chat: { async sendMessage() { writes += 1; } }, jobs: {}, connectionId: 'fixture',
      async sendAttachment() { writes += 1; },
    });
    const delivered = await replies.deliver(job, job.result, { skipText: true, assertLease() {} });
    assert.equal(delivered.status, 'unknown');
    assert.deepEqual(delivered.attachments.map(item => item.status), ['unknown']);
    assert.equal(writes, 0);
  }
});

test('a failed existing text delivery remains failed when attachments are best effort', async () => {
  const job = {
    id: 'run', leaseOwner: 'worker', chatId: 'chat', messageId: 'source',
    result: { delivery: { text: { items: [{ index: 0, status: 'failed' }] } } },
  };
  const replies = createFeishuReplies({ chat: {}, jobs: {}, connectionId: 'fixture' });
  const delivered = await replies.deliver(job, job.result, { assertLease() {} });
  assert.equal(delivered.status, 'failed');
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
