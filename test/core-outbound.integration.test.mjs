import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
import { createRuntime } from '../src/core/runtime.mjs';
import { createOutboundMedia } from '../src/channels/feishu/outbound-media.mjs';
const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));
async function eventually(read, predicate) { for (let i = 0; i < 250; i++) { const row = await read(); if (predicate(row)) return row; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('outbound_condition_timeout'); }
test('Agent files use durable upload/send dependencies and restart cleanup without model replay', { skip: !process.env.BRIDGE_TEST_PASSWORD, timeout: 25000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'bridge-core-output-'));
  const pool = createPoolFromEnvironment(refs); let store, runtime, output;
  let modelCalls = 0, uploadCalls = 0, cleanupCalls = 0, unknownUpload = false, cleanupBlocked = true, gateRelease;
  const gate = new Promise(resolve => { gateRelease = resolve; });
  const sends = [], paths = new Map();
  const config = { feishu: { connectionId: 'output-fixture', botOpenId: 'bot' }, routing: { version: '1', privateUserIds: ['human'], groups: [] }, hooks: [] };
  const chat = {
    replyMessage: async () => ({ message_id: 'text-reply' }),
    async uploadFile({ bytes, fileType }) { uploadCalls++; assert.equal(fileType, 'pdf'); assert.equal(bytes.length, 3 * 1024 * 1024); if (unknownUpload) throw Object.assign(new Error('synthetic upload outcome'), { outcome: 'unknown' }); await gate; return { file_key: 'uploaded-file-key' }; },
    uploadImage: async () => { throw new Error('unexpected image'); },
    async sendMessage(input) { sends.push(input); return { message_id: 'file-message' }; },
  };
  const codex = { status: () => ({ state: 'ready' }), startThread: async () => ({ thread: { id: `output-thread-${modelCalls}` } }), async startTurn({ threadId, clientUserMessageId, input }) {
    modelCalls++;
    const conversationId = unknownUpload ? 'held-chat' : 'output-chat';
    const directory = await output.directory({ connectionId: config.feishu.connectionId, conversationId, runId: clientUserMessageId });
    assert(input[0].text.includes(directory), 'new private prompt provides the actual output directory');
    const path = join(directory, 'answer.pdf'); paths.set(conversationId, path); await writeFile(path, Buffer.alloc(3 * 1024 * 1024, 65), { mode: 0o600 });
    const turn = { id: `output-turn-${modelCalls}`, status: 'completed', items: [{ type: 'agentMessage', text: 'Generated file' }] };
    await runtime.notification({ method: 'turn/completed', params: { threadId, turn } }); return { turn };
  } };
  const event = conversationId => ({ schemaVersion: 1, channel: 'feishu', connectionId: config.feishu.connectionId, source: 'live', type: 'message.received', eventKey: conversationId, eventId: conversationId, messageId: conversationId, conversationId, conversationType: 'p2p', actor: { type: 'user', openId: 'human' }, message: { kind: 'text', content: '{"text":"make a file"}', parsedContent: { text: 'make a file' }, mentions: [] } });
  async function effect(jobId, kind) { const [[row]] = await pool.execute('SELECT id,status,cleanup_pending FROM bridge_outbox WHERE job_id=? AND kind=?', [jobId, kind]); return row; }
  try {
    await migrate(pool); store = await createMysqlStore({connectionId:'output-fixture', pool });
    const module = await createOutboundMedia({ workspace, outboxDir: join(workspace, 'outbox'), spoolDir: join(workspace, 'spool'), chat });
    output = { ...module, async cleanup(input) { cleanupCalls++; if (cleanupBlocked) throw new Error('synthetic cleanup unavailable'); return module.cleanup(input); } };
    runtime = createRuntime({ config, store, codex, chat, outbound: output });
    const job = await runtime.ingest(event('output-chat')); runtime.start();
    await eventually(() => effect(job.agentJobId, 'artifact_upload'), row => row?.status === 'running');
    assert.equal(sends.length, 0, 'send waits for persisted upload confirmation');
    gateRelease();
    await eventually(() => store.getJob({ id: job.agentJobId }), row => row.status === 'succeeded');
    await eventually(async () => cleanupCalls, count => count > 0);
    assert.equal(uploadCalls, 1); assert.equal(sends.length, 1); assert.equal(sends[0].content.file_key, 'uploaded-file-key');
    const sendRow = await effect(job.agentJobId, 'artifact_send'); assert(sendRow.cleanup_pending);
    assert(await stat(paths.get('output-chat')));
    await runtime.stop(); cleanupBlocked = false;
    runtime = createRuntime({ config, store, codex, chat, outbound: output }); runtime.start();
    await eventually(() => effect(job.agentJobId, 'artifact_send'), row => !row.cleanup_pending);
    await assert.rejects(stat(paths.get('output-chat')), { code: 'ENOENT' });
    assert.equal(sends.length, 1); assert.equal(uploadCalls, 1); assert.equal(modelCalls, 1, 'cleanup restart cannot resend/reexecute');
    unknownUpload = true;
    const held = await runtime.ingest(event('held-chat'));
    await eventually(() => effect(held.agentJobId, 'artifact_upload'), row => row?.status === 'unknown');
    await runtime.stop();
    runtime = createRuntime({ config, store, codex, chat, outbound: output }); runtime.start();
    await eventually(async () => (await store.getOutbox({ id: (await effect(held.agentJobId, 'artifact_send')).id })), row => row.blocked === true);
    assert.equal(sends.length, 1); assert.equal(uploadCalls, 2); assert.equal(modelCalls, 2);
    assert.equal((await store.getJob({ id: held.agentJobId })).status, 'reply_pending');
    assert(await stat(paths.get('held-chat')));
  } finally { gateRelease(); await runtime?.stop(); if (store) await store.close(); else await pool.end(); await rm(workspace, { recursive: true, force: true }); }
});
