import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
import { createRuntime } from '../src/core/runtime.mjs';
import { createApi } from '../src/core/api.mjs';
const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));
async function until(read, predicate) { for (let i = 0; i < 150; i++) { const row = await read(); if (predicate(row)) return row; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('guidance_recovery_timeout'); }
test('scoped audited guidance abandonment cancels only its job with zero native calls', { skip: !process.env.BRIDGE_TEST_PASSWORD, timeout: 12000 }, async () => {
  const pool = createPoolFromEnvironment(refs); let store, runtime;
  const scope = { connectionId: 'guidance-recovery', conversationId: 'chat', agentId: 'codex' };
  const config = { feishu: { connectionId: scope.connectionId }, routing: { groups: [], privateUserIds: [] }, hooks: [], auth: { clients: [{ id: 'admin', admin: true, conversationIds: ['chat'] }, { id: 'user', admin: false, conversationIds: ['chat'] }, { id: 'foreign', admin: true, conversationIds: [] }] } };
  const tokens = Object.fromEntries(config.auth.clients.map(client => [client.id, `synthetic-${client.id}-token-only`]));
  const logs = [];
  try {
    await migrate(pool); store = await createMysqlStore({ pool });
    const parent = await store.enqueueJob({ ...scope, kind: 'agent', idempotencyKey: 'parent', payload: { text: 'parent' } });
    const [claim] = await store.claimJobs({ kind: 'agent', owner: 'fixture', leaseMs: 300000, limit: 1 });
    const attempt = await store.beginAgentAttempt({ ...claim, agentId: 'codex' });
    await store.bindAgentAttempt({ ...claim, expectedGeneration: attempt.generation, nativeThreadId: 'thread', nativeTurnId: 'turn' });
    const guidance = await store.enqueueJob({ ...scope, kind: 'agent', idempotencyKey: 'guidance', payload: { text: 'guidance' } });
    const [g] = await store.claimJobs({ kind: 'agent', owner: 'fixture', leaseMs: 60000, limit: 1 });
    assert.equal((await store.beginSteerAttempt({ ...g, agentId: 'codex' })).kind, 'new');
    await store.finishSteerAttempt({ ...g, outcome: 'unknown', errorCode: 'fixture_unknown' });
    const before = await store.getSession(scope);
    const api = createApi({ config, store, chat: {}, tokens });
    const call = (value, client = 'admin') => { const request = Readable.from([Buffer.from(JSON.stringify(value))]); Object.assign(request, { method: 'POST', url: '/v1/recoveries', headers: { authorization: `Bearer ${tokens[client]}` } }); return api(request); };
    const input = { runId: guidance.id, generation: Number(attempt.generation), action: 'abandon_guidance_verified', idempotencyKey: 'verified', evidence: 'SYNTHETIC_GUIDANCE_EVIDENCE' };
    await assert.rejects(call(input, 'user'), { status: 403 });
    await assert.rejects(call(input, 'foreign'), { status: 403 });
    await assert.rejects(call({ ...input, nativeThreadId: 'thread' }), { status: 400 });
    const accepted = await call(input); assert.equal(accepted.status, 202);
    assert.equal((await call(input)).body.id, accepted.body.id);
    runtime = createRuntime({ config, store, chat: {}, codex: { status: () => ({ state: 'ready' }) }, workspace: '/synthetic/workspace', log: (...entry) => logs.push(entry) }); runtime.start();
    await until(() => store.getRecovery({ id: accepted.body.id }), row => row.status === 'applied');
    assert.equal((await store.getJob({ id: guidance.id })).status, 'cancelled');
    assert.equal((await store.getSteerAttempt({ id: guidance.id })).status, 'unknown', 'provider fact is not rewritten');
    assert.equal((await store.getJob({ id: parent.id })).status, 'running');
    assert.deepEqual(await store.getSession(scope), before);
    assert.equal((await store.getConversationActivity(scope)).unresolvedGuidance, false);
    assert.equal((await call(input)).body.id, accepted.body.id, 'applied action remains idempotent');
    assert(!JSON.stringify(logs).includes(input.evidence));
    assert(runtime.status().running);
  } finally { await runtime?.stop(); if (store) await store.close(); else await pool.end(); }
});
