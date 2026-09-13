import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
import { createRuntime } from '../src/core/runtime.mjs';
const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));
async function until(read, predicate) { for (let i = 0; i < 200; i++) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('delivery_timeout'); }
test('lost outbox COMMIT responses never reverse confirmed platform facts or stop workers', { skip: !process.env.BRIDGE_TEST_PASSWORD, timeout: 15000 }, async () => {
  const pool = createPoolFromEnvironment(refs); let store, runtime;
  const config = { feishu: { connectionId: 'delivery-fixture', botOpenId: 'bot' }, routing: { version: '1', privateUserIds: [], groups: [] }, hooks: [] };
  const calls = [], settlements = [], logs = [];
  const chat = { sendMessage: async input => { calls.push('text'); if (input.content.text === 'reject') throw Object.assign(new Error('synthetic'), { outcome: 'failed' }); return { message_id: 'text' }; }, uploadImage: async () => { calls.push('upload'); return { image_key: 'uploaded' }; } };
  const outbound = { upload: async () => { calls.push('artifact_upload'); return { file_key: 'file' }; }, send: async input => { assert.equal(input.uploadResult.file_key, 'file'); calls.push('artifact_send'); return { message_id: 'file' }; }, cleanup: async () => { calls.push('cleanup'); } };
  try {
    await migrate(pool); store = await createMysqlStore({ pool });
    const scope = { connectionId: config.feishu.connectionId, conversationId: 'chat' };
    const text = await store.recordOutbox({ ...scope, idempotencyKey: 'text', kind: 'create', payload: { kind: 'text', content: { text: 'fixture' } } });
    const rejected = await store.recordOutbox({ ...scope, idempotencyKey: 'reject', kind: 'create', payload: { kind: 'text', content: { text: 'reject' } } });
    const upload = await store.recordOutbox({ ...scope, idempotencyKey: 'upload', kind: 'upload', payload: { mediaType: 'image', base64: 'YQ==' } });
    const job = await store.enqueueJob({ ...scope, kind: 'agent', idempotencyKey: 'job', payload: { text: 'synthetic completed native execution' } });
    const [claim] = await store.claimJobs({ kind: 'agent', owner: 'fixture', leaseMs: 60000, limit: 1 });
    const artifactScope = { ...scope, runId: job.id }, ref = { ...artifactScope, artifactId: 'synthetic-artifact' };
    await store.finishJobWithOutbox({ id: claim.id, leaseToken: claim.leaseToken, result: { status: 'completed' }, outbox: ['upload', 'send'].map(kind => ({ idempotencyKey: `artifact-${kind}`, kind: `artifact_${kind}`, payload: { scope: artifactScope, ref } })) });
    const settle = store.settleOutbox;
    store.settleOutbox = async input => { settlements.push({ id: input.id, status: input.status }); await settle(input); throw Object.assign(new Error('synthetic lost response'), { code: input.status === 'sent' ? 'commit_unknown' : 'stale_lease' }); };
    runtime = createRuntime({ config, store, chat, outbound, codex: { status: () => ({ state: 'ready' }) }, log: (...entry) => logs.push(entry) }); runtime.start();
    await until(() => store.getJob({ id: job.id }), row => row.status === 'succeeded');
    await until(async () => calls.includes('cleanup'), Boolean);
    assert.equal((await store.getOutbox({ id: text.id })).status, 'sent');
    assert.equal((await store.getOutbox({ id: upload.id })).status, 'sent');
    assert.equal((await store.getOutbox({ id: rejected.id })).status, 'failed');
    assert.equal(calls.filter(call => call === 'artifact_send').length, 1);
    assert.equal(calls.filter(call => call === 'upload').length, 1);
    assert.equal(new Set(settlements.map(entry => entry.id)).size, settlements.length, 'no contradictory second settlement');
    assert.equal(settlements.filter(entry => entry.status === 'unknown').length, 0, 'SQL error is not a platform unknown');
    assert(runtime.status().running);
    assert.equal(logs.filter(entry => entry[3]?.code === 'delivery_commit_confirmed').length, 4);
  } finally { await runtime?.stop(); if (store) await store.close(); else await pool.end(); }
});
