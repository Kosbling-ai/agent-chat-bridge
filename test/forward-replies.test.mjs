import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOutboundMedia } from '../src/channels/feishu/outbound-media.mjs';
import { createFeishuReplies } from '../src/channels/feishu/replies.mjs';

test('card delivery still sends attachments and lease loss resumes after the confirmed item', async t => {
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
  const jobs = { async patchFeedback({ value }) { job.result = { ...job.result, delivery: structuredClone(value) }; } };
  const replies = createFeishuReplies({ chat, outbound, jobs, connectionId: 'fixture' });
  job.result = await replies.prepare(job, job.result);

  let fences = 0;
  await assert.rejects(replies.deliver(job, job.result, { skipText: true, assertLease() {
    fences += 1;
    if (fences === 4) throw Object.assign(new Error('lost'), { code: 'forward_lease_lost' });
  } }), { code: 'forward_lease_lost' });
  assert.equal(job.result.delivery.attachments[0].status, 'cleaned');
  assert.equal(job.result.delivery.attachments[1].status, 'upload_intent');

  await replies.deliver(job, job.result, { skipText: true, assertLease() {} });
  assert.deepEqual(calls, [
    'upload:first.txt', 'send:key:first.txt',
    'upload:second.txt', 'send:key:second.txt',
  ]);
  assert(job.result.delivery.attachments.every(item => item.status === 'cleaned'));
});
