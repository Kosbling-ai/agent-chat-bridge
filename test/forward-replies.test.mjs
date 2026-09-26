import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFeishuReplies, markdownToFeishuPost } from '../src/channels/feishu/replies.mjs';
import { adaptLocalMarkdownImages } from '../src/channels/feishu/markdown-images.mjs';
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

test('local markdown images are paired only with collected attachments without leaking paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-image-replies-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const collected=join(root,'sent.png'),missing=join(root,'missing.png');await writeFile(collected,'image');
  const answer=`Before ![sent alt](sent.png) middle ![missing alt](<${missing.replace('missing.png','pics (final)/missing.png')}>) after ![remote](//example.invalid/a.png)`;
  const adapted=adaptLocalMarkdownImages(answer,[collected],{workspace:root});
  assert.equal(adapted,'Before sent alt middle 图片“missing alt”未能发送。 after ![remote](//example.invalid/a.png)');
  assert.doesNotMatch(adapted,new RegExp(root));
  const calls=[];const job={id:'run',leaseOwner:'worker',chatId:'chat',chatType:'p2p',messageId:'source',result:{answer,attachments:[collected]}};
  const replies=createFeishuReplies({chat:{async sendMessage(input){calls.push(input);return{message_id:'text'};}},jobs:{},connectionId:'fixture',workspace:root,
    async sendAttachment(){return{messageId:'image'};}});
  const delivered=await replies.deliver(job,job.result,{assertLease(){}});
  assert.equal(delivered.attachments[0].status,'sent');
  const encoded=JSON.stringify(calls[0].content);
  assert.match(encoded,/sent alt/);assert.match(encoded,/missing alt/);assert.match(encoded,/example.invalid/);assert.doesNotMatch(encoded,new RegExp(root));
});

test('local markdown image parsing consumes parenthesized and angle-bracket paths completely', () => {
  const first='/tmp/pics(final)/private.png',second='/tmp/pics (final)/private.png';
  assert.equal(adaptLocalMarkdownImages(`A ![one](${first}) Z`,[]),'A 图片“one”未能发送。 Z');
  assert.equal(adaptLocalMarkdownImages(`A ![two](<${second}>) Z`,[]),'A 图片“two”未能发送。 Z');
  assert.equal(adaptLocalMarkdownImages('A ![remote](//example.invalid/a.png) Z',[]),'A ![remote](//example.invalid/a.png) Z');
});

test('standard markdown titles and escapes use parsed image URLs while code remains literal', () => {
  const path='/tmp/pics(final)/private.png';
  assert.equal(adaptLocalMarkdownImages('A ![one](/tmp/pics\\(final\\)/private.png "caption") Z',[path]),'A one Z');
  assert.equal(adaptLocalMarkdownImages('A ![two](</tmp/missing.png> "caption") Z',[]),'A 图片“two”未能发送。 Z');
  const code='`![inline](/tmp/private.png)`\n```md\n![block](/tmp/private.png)\n```';
  assert.equal(adaptLocalMarkdownImages(code,[]),code);
});

test('failed image upload gets one stable path-free user notice', async t => {
  const root=await mkdtemp(join(tmpdir(),'bridge-image-failure-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const image=join(root,'failed.png');await writeFile(image,'image');const calls=[];
  const job={id:'run',leaseOwner:'worker',chatId:'chat',chatType:'p2p',messageId:'source',result:{execution:{threadId:'thread',turnId:'turn'},answer:`![preview](${image})`,attachments:[image]}};
  const replies=createFeishuReplies({chat:{async sendMessage(input){calls.push(input);return{message_id:'text'};}},jobs:{},connectionId:'fixture',async sendAttachment(){throw new Error('synthetic');}});
  const delivered=await replies.deliver(job,job.result,{assertLease(){}});
  assert.equal(delivered.messages,2);assert.equal(delivered.attachments[0].status,'failed');assert.equal(calls.length,2);
  assert.match(JSON.stringify(calls[1].content),/图片未能发送/);assert.doesNotMatch(JSON.stringify(calls[1].content),new RegExp(root));
  assert.equal(typeof calls[1].uuid,'string');assert.equal(calls[1].uuid.length,24);
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
  const calls = [], recorded = [];
  const job = { id:'run', leaseOwner:'worker', chatId:'chat', messageId:'source', sourceMessageId:'source',
    result:{ answer:`# Title\n[link](https://example.invalid)\n${'x'.repeat(3100)}` } };
  const replies = createFeishuReplies({ chat: {
    async sendMessage(input) { calls.push(input); return { message_id:`sent-${calls.length}` }; },
    async replyMessage() { throw new Error('production reply must use chat create'); },
  }, jobs:{}, inbound:{async recordReply(value){recorded.push(value);}}, botOpenId:'bot', connectionId:'fixture', maxOutputChars:3500 });
  const delivered = await replies.deliver(job, job.result, { assertLease() {} });
  assert.equal(delivered.status, 'sent');
  assert.equal(delivered.messages, 2);
  assert(calls.every(call => call.conversationId === 'chat' && call.kind === 'post'));
  assert.deepEqual(calls[0].content.zh_cn.content[0], [{ tag:'text', text:'Title' }]);
  assert.deepEqual(calls[0].content.zh_cn.content[1], [{ tag:'a', text:'link', href:'https://example.invalid' }]);
  assert.equal(new Set(calls.map(call => call.uuid)).size, 2);
  assert.deepEqual(recorded.map(value => [value.messageId,value.chatId,value.messageType,value.senderOpenId]),
    [['sent-1','chat','post','bot'],['sent-2','chat','post','bot']]);
});

test('confirmed execution card ID is recorded for reply ownership', async () => {
  const recorded = [];
  const job = { id:'run', leaseOwner:'worker', chatId:'chat', chatType:'group', messageId:'source',
    senderOpenId:'human', deliveryMode:'bridge', result:{} };
  const feedback = createExecutionFeedback({ jobs:{async patchFeedback({key,value}){job.result={...job.result,[key]:value};}},
    inbound:{async recordReply(value){recorded.push(value);}}, botOpenId:'bot',
    cardClient:{im:{v1:{message:{async create(){return{code:0,data:{message_id:'card-id'}};}}}}} });
  const state = await feedback.start(job);
  await state.card.update();
  state.card.stop();
  assert.deepEqual(recorded.map(value => [value.messageId,value.chatId,value.messageType,value.senderOpenId]),
    [['card-id','chat','interactive','bot']]);
});

test('text reply mode keeps the original 1900-character chunks', async () => {
  const calls = [];
  const job = { id:'run', leaseOwner:'worker', chatId:'chat', messageId:'source', result:{ answer:'x'.repeat(2000) } };
  const replies = createFeishuReplies({ chat:{ async sendMessage(input) { calls.push(input); return { message_id:'sent' }; } },
    jobs:{}, connectionId:'fixture', replyAsPost:false, maxOutputChars:3500 });
  assert.equal((await replies.deliver(job, job.result, { assertLease() {} })).messages, 2);
  assert.deepEqual(calls.map(call => [call.kind, call.content.text.length]), [['text',1900],['text',100]]);
});

test('post replies turn individual and multiple open_id mentions into at elements beside markdown links', () => {
  const post = markdownToFeishuPost('# Tasks\n**Owner** <at user_id="ou_alice1"></at> and <at open_id="ou_bob2"></at> [details](https://example.invalid) @{ou_c3}');
  assert.deepEqual(post.zh_cn.content, [
    [{ tag:'text', text:'Tasks' }],
    [{ tag:'text', text:'Owner ' }, { tag:'at', user_id:'ou_alice1' }, { tag:'text', text:' and ' },
      { tag:'at', user_id:'ou_bob2' }, { tag:'text', text:' ' }, { tag:'a', text:'details', href:'https://example.invalid' },
      { tag:'text', text:' ' }, { tag:'at', user_id:'ou_c3' }],
  ]);
});

test('invalid mentions and disabled mention-all stay literal; fenced code does not mention', () => {
  const literal = '<at user_id="ou_Bad"></at> @{ou_bad-id} <at open_id="all"></at> <at user_id="all"></at>';
  assert.deepEqual(markdownToFeishuPost(literal).zh_cn.content[0], [{ tag:'text', text:literal }]);
  assert.deepEqual(markdownToFeishuPost('```\n@{ou_valid1}\n```').zh_cn.content[1], [{ tag:'text', text:'@{ou_valid1}' }]);
  assert.deepEqual(markdownToFeishuPost('<at user_id="all"></at> @{all}', { allowMentionAll:true }).zh_cn.content[0],
    [{ tag:'at', user_id:'all' }, { tag:'text', text:' @{all}' }]);
});

test('text mode promotes valid mentions to post and gates mention-all by group', async () => {
  const calls = [];
  const reply = createFeishuReplies({ chat:{ async sendMessage(input) { calls.push(input); return { message_id:'sent' }; } },
    jobs:{}, connectionId:'fixture', replyAsPost:false, mentionAllGroupChatIds:new Set(['enabled']) });
  const send = async (chatId, chatType, answer) => reply.deliver({ id:'run', chatId, chatType, messageId:'source', result:{ answer } },
    { answer }, { assertLease() {} });
  await send('enabled', 'group', 'Hi @{ou_alice1} and <at open_id="ou_bob2"></at>');
  await send('disabled', 'group', '<at user_id="all"></at>');
  await send('enabled', 'group', '<at user_id="all"></at>');
  await send('enabled', 'p2p', '<at user_id="all"></at>');
  await send('enabled', 'group', '@{ou_Bad}');
  assert.deepEqual(calls.map(call => call.kind), ['post', 'text', 'post', 'text', 'text']);
  assert.deepEqual(calls[0].content.zh_cn.content[0].filter(element => element.tag === 'at'),
    [{ tag:'at', user_id:'ou_alice1' }, { tag:'at', user_id:'ou_bob2' }]);
  assert.deepEqual(calls[1].content, { text:'<at user_id="all"></at>' });
  assert.deepEqual(calls[2].content.zh_cn.content[0], [{ tag:'at', user_id:'all' }]);
  assert.deepEqual(calls[3].content, { text:'<at user_id="all"></at>' });
  assert.deepEqual(calls[4].content, { text:'@{ou_Bad}' });
});

test('reply chunks keep mention markers whole at text and post boundaries', async () => {
  for (const [replyAsPost, boundary] of [[false, 1900], [true, 3000]]) {
    const calls = [];
    const answer = `${'x'.repeat(boundary - 3)}@{ou_owner1} tail`;
    const reply = createFeishuReplies({ chat:{ async sendMessage(input) { calls.push(input); return { message_id:'sent' }; } },
      jobs:{}, connectionId:'fixture', replyAsPost, maxOutputChars:5000 });
    await reply.deliver({ id:'run', chatId:'group', chatType:'group', messageId:'source', result:{ answer } },
      { answer }, { assertLease() {} });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].kind, replyAsPost ? 'post' : 'text');
    assert.deepEqual(calls[1].content.zh_cn.content[0],
      [{ tag:'at', user_id:'ou_owner1' }, { tag:'text', text:' tail' }]);
  }
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
