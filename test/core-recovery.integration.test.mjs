import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
import { createRuntime } from '../src/core/runtime.mjs';
import { createApi } from '../src/core/api.mjs';

const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));
async function eventually(read, predicate) {
  for (let i = 0; i < 150; i++) { const row = await read(); if (predicate(row)) return row; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('recovery_condition_timeout');
}
test('admin scoped recovery reads/adopts or verified-abandons unknown native work without replay', { skip: !process.env.BRIDGE_TEST_PASSWORD, timeout: 20000 }, async () => {
  const pool = createPoolFromEnvironment(refs); let store, runtime;
  const scopes = ['adopt', 'abandon', 'active', 'foreign-workspace', 'owner', 'cross-owner'];
  const config = { feishu: { connectionId: 'recovery-fixture', botOpenId: 'bot' }, routing: { version: '1', privateUserIds: [], groups: [] }, hooks: [], auth: { clients: [
    { id: 'admin', admin: true, conversationIds: scopes }, { id: 'user', admin: false, conversationIds: scopes }, { id: 'foreign-admin', admin: true, conversationIds: [] },
  ] } };
  const tokens = Object.fromEntries(config.auth.clients.map(client => [client.id, `synthetic-token-for-${client.id}-only`]));
  const threads = new Map(), sent = [], logs = [];
  let starts = 0;
  const codex = { status: () => ({ state: 'ready' }), readThread: async ({ threadId }) => ({ thread: threads.get(threadId) }), startThread: async () => { starts++; throw new Error('unexpected admission'); }, startTurn: async () => { starts++; throw new Error('unexpected turn'); } };
  const chat = { sendMessage: async input => { sent.push(input); return { message_id: 'sent' }; } };
  async function seed(conversationId, nativeThreadId, nativeTurnId) {
    const job = await store.enqueueJob({ kind: 'agent', connectionId: config.feishu.connectionId, conversationId, idempotencyKey: conversationId, payload: { source: 'api', text: 'already attempted' } });
    const [claim] = await store.claimJobs({ kind: 'agent', owner: 'crashed', leaseMs: 1000, limit: 1 });
    const attempt = await store.beginAgentAttempt({ id: claim.id, leaseToken: claim.leaseToken, agentId: 'codex' });
    if (nativeThreadId) await store.bindAgentAttempt({ id: claim.id, leaseToken: claim.leaseToken, expectedGeneration: attempt.generation, nativeThreadId, ...(nativeTurnId ? { nativeTurnId } : {}) });
    await store.holdAgentAttempt({ id: claim.id, leaseToken: claim.leaseToken, errorCode: 'synthetic_unknown' });
    return { id: job.id, generation: attempt.generation };
  }
  try {
    await migrate(pool); store = await createMysqlStore({connectionId:'recovery-fixture', pool });
    const jobs = {};
    for (const conversationId of scopes) jobs[conversationId] = await seed(conversationId, conversationId === 'active' ? 'active-thread' : conversationId === 'owner' ? 'owned-thread' : undefined, conversationId === 'active' ? 'active-turn' : conversationId === 'owner' ? 'owned-turn' : undefined);
    threads.set('adopt-thread', { id: 'adopt-thread', cwd: '/synthetic/workspace', turns: [{ id: 'adopt-turn', status: 'completed', items: [{ type: 'agentMessage', text: 'Recovered original execution' }] }] });
    threads.set('active-thread', { id: 'active-thread', cwd: '/synthetic/workspace', turns: [{ id: 'active-turn', status: 'inProgress' }] });
    threads.set('foreign-thread', { id: 'foreign-thread', cwd: '/other/workspace', turns: [{ id: 'foreign-turn', status: 'completed', items: [] }] });
    threads.set('owned-thread', { id: 'owned-thread', cwd: '/synthetic/workspace', turns: [{ id: 'owned-turn', status: 'completed', items: [] }] });
    const api = createApi({ config, store, chat, tokens });
    const call = (method, url, value, client = 'admin') => { const request = Readable.from(value ? [Buffer.from(JSON.stringify(value))] : []); Object.assign(request, { method, url, headers: { authorization: `Bearer ${tokens[client]}` } }); return api(request); };
    const request = (name, action, extra = {}) => ({ runId: jobs[name].id, generation: Number(jobs[name].generation), idempotencyKey: name, action, evidence: 'SYNTHETIC_AUDIT_EVIDENCE', ...extra });
    const adopt = request('adopt', 'adopt_turn', { nativeThreadId: 'adopt-thread', nativeTurnId: 'adopt-turn' });
    await assert.rejects(call('POST', '/v1/recoveries', adopt, 'user'), { status: 403 });
    await assert.rejects(call('POST', '/v1/recoveries', adopt, 'foreign-admin'), { status: 403 });
    await assert.rejects(call('POST', '/v1/recoveries', { ...adopt, action: 'force_retry' }), { status: 400 });
    const accepted = await call('POST', '/v1/recoveries', adopt);
    assert.equal(accepted.status, 202);
    assert.equal((await call('POST', '/v1/recoveries', adopt)).body.id, accepted.body.id);
    const abandon = await call('POST', '/v1/recoveries', request('abandon', 'abandon_verified'));
    const active = await call('POST', '/v1/recoveries', request('active', 'abandon_verified'));
    const foreign = await call('POST', '/v1/recoveries', request('foreign-workspace', 'adopt_turn', { nativeThreadId: 'foreign-thread', nativeTurnId: 'foreign-turn' }));
    const cross = await call('POST', '/v1/recoveries', request('cross-owner', 'adopt_turn', { nativeThreadId: 'owned-thread', nativeTurnId: 'owned-turn' }));
    runtime = createRuntime({ config, store, codex, chat, workspace: '/synthetic/workspace', log: (...entry) => logs.push(entry) }); runtime.start();
    await eventually(() => store.getJob({ id: jobs.adopt.id }), row => row.status === 'succeeded');
    assert.equal(starts, 0); assert.equal(sent.length, 1); assert.equal(sent[0].content.text, 'Recovered original execution');
    await eventually(() => store.getRecovery({ id: abandon.body.id }), row => row.status === 'applied');
    assert.equal((await store.getJob({ id: jobs.abandon.id })).status, 'cancelled');
    for (const [result, code] of [[active, 'recovery_turn_active'], [foreign, 'recovery_workspace_mismatch'], [cross, 'thread_scope_conflict']]) {
      const row = await eventually(() => store.getRecovery({ id: result.body.id }), row => row.status === 'rejected'); assert.equal(row.errorCode, code);
    }
    assert.equal((await store.getJob({ id: jobs.active.id })).status, 'unknown');
    assert.equal((await call('POST', '/v1/recoveries', adopt)).body.id, accepted.body.id, 'completed registration remains idempotent');
    assert(!JSON.stringify((await call('GET', `/v1/recoveries/${accepted.body.id}`)).body).includes('SYNTHETIC_AUDIT_EVIDENCE'));
    assert(!JSON.stringify(logs).includes('SYNTHETIC_AUDIT_EVIDENCE'));
    assert(runtime.status().running, 'expected recovery refusal does not fault the worker');
  } finally { await runtime?.stop(); if (store) await store.close(); else await pool.end(); }
});
