import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
import { createRuntime } from '../src/core/runtime.mjs';
import { createFeishuMedia } from '../src/channels/feishu/media.mjs';

const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
test('durable media ingress downloads only authorized jobs before native admission and retains resources', { skip: !process.env.BRIDGE_TEST_PASSWORD, timeout: 15000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'bridge-core-media-'));
  const pool = createPoolFromEnvironment(refs);
  let store, runtime, downloads = 0, failDownload = false;
  const inputs = [], replies = [];
  const config = { feishu: { connectionId: 'media-fixture', botOpenId: 'bot' }, routing: { version: '1', privateUserIds: ['human'], groups: [{ conversationId: 'group', trigger: 'all', passiveContext: true }] }, hooks: [] };
  const chat = { async downloadResource() { downloads++; if (failDownload) throw new Error('synthetic'); return { contentType: 'image/png', stream: Readable.from(['synthetic-image']) }; }, async replyMessage(input) { replies.push(input); return { message_id: `sent-${replies.length}` }; } };
  const codex = { status: () => ({ state: 'ready' }), startThread: async () => ({ thread: { id: `thread-${inputs.length}` } }), resumeThread: async ({ threadId }) => ({ thread: { id: threadId } }), async startTurn({ threadId, input }) {
    inputs.push(input[0].text);
    const turn = { id: `turn-${inputs.length}`, status: 'completed', items: [{ type: 'agentMessage', text: 'answer' }] };
    await runtime.notification({ method: 'turn/completed', params: { threadId, turn } });
    return { turn };
  } };
  async function done(id) {
    for (let i = 0; i < 100; i++) { const row = await store.getJob({ id }); if (row.status === 'succeeded') return row; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error('media_run_timeout');
  }
  let sequence = 0;
  const event = (kind, content, conversationType = 'p2p') => ({ schemaVersion: 1, channel: 'feishu', connectionId: 'media-fixture', source: 'live', type: 'message.received', eventKey: `media-${++sequence}`, eventId: `media-${sequence}`, messageId: `message-${sequence}`, conversationId: conversationType === 'group' ? 'group' : `private-${sequence}`, conversationType, actor: { type: 'user', openId: 'human' }, message: { kind, content: JSON.stringify(content), parsedContent: content, mentions: [] } });
  try {
    await migrate(pool); store = await createMysqlStore({ pool });
    const media = await createFeishuMedia({ workspace, inboxDir: join(workspace, 'inbox'), chat });
    runtime = createRuntime({ config, store, codex, chat, media });
    const source = event('image', { image_key: 'image' });
    assert(!(await runtime.ingest({ ...source, actor: { type: 'user', openId: 'forbidden' } })).agentJobId);
    assert.equal(downloads, 0);
    const accepted = await runtime.ingest(event('image', { image_key: 'image' }));
    assert.equal(downloads, 0, 'ACK transaction never downloads');
    runtime.start(); await done(accepted.agentJobId);
    assert.equal(downloads, 1);
    const prepared = await media.prepare(parse((await store.getJob({ id: accepted.agentJobId })).payload).event, { runId: accepted.agentJobId });
    assert(inputs[0].includes(prepared.localPaths[0]));
    assert.equal(await readFile(prepared.localPaths[0], 'utf8'), 'synthetic-image');
    assert.equal(downloads, 1, 'finished run retained its reusable manifest');
    const group = await runtime.ingest(event('post', { content: [[{ tag: 'text', text: 'group caption' }, { tag: 'img', image_key: 'ignored' }]] }, 'group'));
    await done(group.agentJobId); assert.equal(downloads, 1); assert(inputs[1].includes('group caption'));
    failDownload = true;
    const failed = await runtime.ingest(event('image', { image_key: 'bad' }));
    const failedResult = await done(failed.agentJobId);
    assert.equal(parse(failedResult.result).status, 'input_failed'); assert.equal(await store.getAgentAttempt({ id: failed.agentJobId }), null);
    assert.equal(inputs.length, 2); assert(replies.some(reply => reply.content.text.includes('图片下载失败')));
    await runtime.stop();
    const recovery = await store.enqueueJob({ kind: 'agent', connectionId: config.feishu.connectionId, conversationId: 'recover-media', idempotencyKey: 'recover-media', payload: { source: 'chat', messageId: 'recover-message', unsupported: true, event: { ...event('image', { image_key: 'unavailable-after-restart' }), conversationId: 'recover-media', messageId: 'recover-message' } } });
    const [claim] = await store.claimJobs({ kind: 'agent', owner: 'crashed-media-worker', limit: 1, leaseMs: 100 });
    const attempt = await store.beginAgentAttempt({ id: claim.id, leaseToken: claim.leaseToken, agentId: 'codex' });
    await store.bindAgentAttempt({ id: claim.id, leaseToken: claim.leaseToken, expectedGeneration: attempt.generation, nativeThreadId: 'known-media-thread', nativeTurnId: 'known-media-turn' });
    const downloadsBeforeRecovery = downloads;
    codex.readThread = async () => ({ thread: { turns: [{ id: 'known-media-turn', status: 'completed', items: [{ type: 'agentMessage', text: 'recovered image answer' }] }] } });
    await new Promise(resolve => setTimeout(resolve, 150));
    runtime = createRuntime({ config, store, codex, chat, media }); runtime.start();
    await done(recovery.id);
    assert.equal(downloads, downloadsBeforeRecovery, 'known admission recovery cannot redownload unavailable input');
    assert.equal(inputs.length, 2, 'known media recovery does not repeat native admission');
  } finally { await runtime?.stop(); if (store) await store.close(); else await pool.end(); await rm(workspace, { recursive: true, force: true }); }
});
