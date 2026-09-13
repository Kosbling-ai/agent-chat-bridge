import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
import { createRuntime } from '../src/core/runtime.mjs';
const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate) { for (let i = 0; i < 250; i++) { const value = await read(); if (predicate(value)) return value; await delay(20); } throw new Error('guard_timeout'); }
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
test('cleanup excludes native execution and respects persisted activity after restart', { skip: !process.env.BRIDGE_TEST_PASSWORD, timeout: 20000 }, async () => {
  const pool = createPoolFromEnvironment(refs); let store, runtime;
  const connectionId = 'guard-fixture', config = { feishu: { connectionId }, routing: { groups: [], privateUserIds: [] }, hooks: [] };
  const heldCleanup = gate(), cleanupEntered = gate();
  let seeding = false, cleanupPages = 0;
  const cleanups = [], activityChecks = [], starts = [], turns = new Map();
  const scope = conversationId => ({ connectionId, conversationId });
  async function enqueue(chat, key) { return store.enqueueJob({ ...scope(chat), kind: 'agent', idempotencyKey: key, payload: { text: key } }); }
  async function pendingCleanup(chat, key) {
    seeding = true;
    try {
    const job = await enqueue(chat, key);
    const claims = await store.claimJobs({ kind: 'agent', owner: 'fixture', leaseMs: 60000, limit: 10 });
    const claim = claims.find(row => row.id === job.id); assert(claim);
    const artifactScope = { ...scope(chat), runId: job.id }, ref = { ...artifactScope, artifactId: key };
    await store.finishJobWithOutbox({ id: job.id, leaseToken: claim.leaseToken, result: {}, outbox: ['upload', 'send'].map(kind => ({ kind: `artifact_${kind}`, idempotencyKey: `${key}-${kind}`, payload: { scope: artifactScope, ref } })) });
    for (const kind of ['upload', 'send']) {
      const [effect] = await store.claimOutbox({ owner: 'fixture', leaseMs: 60000, limit: 1 });
      assert.equal(effect.kind, `artifact_${kind}`);
      await store.settleOutbox({ id: effect.id, leaseToken: effect.leaseToken, status: 'sent', result: { file_key: key } });
    }
    } finally { seeding = false; }
  }
  async function complete(threadId) { const turn = turns.get(threadId); turn.status = 'completed'; turn.items = [{ type: 'agentMessage', text: 'done' }]; await runtime.notification({ method: 'turn/completed', params: { threadId, turn } }); }
  const codex = { status: () => ({ state: 'ready' }), startThread: async () => { const id = `thread-${starts.length}`; starts.push(id); return { thread: { id } }; }, startTurn: async ({ threadId }) => { const turn = { id: `turn-${threadId}`, status: 'inProgress', items: [] }; turns.set(threadId, turn); return { turn }; } };
  const outbound = { cleanup: async ({ scope: artifact }) => { cleanups.push(artifact.conversationId); if (artifact.conversationId === 'cleanup-first') { cleanupEntered.release(); await heldCleanup.promise; } } };
  try {
    await migrate(pool); store = await createMysqlStore({ pool });
    const claimJobs = store.claimJobs;
    store.claimJobs = async input => seeding && input.owner !== 'fixture' ? [] : claimJobs(input);
    // A native execution left unknown before process startup blocks cleanup.
    await pendingCleanup('persisted', 'old-artifact');
    const old = await enqueue('persisted', 'old-native');
    const [oldClaim] = await store.claimJobs({ kind: 'agent', owner: 'old', leaseMs: 60000, limit: 1 });
    const attempt = await store.beginAgentAttempt({ ...oldClaim, agentId: 'codex' });
    await store.bindAgentAttempt({ ...oldClaim, expectedGeneration: attempt.generation, nativeThreadId: 'old-thread', nativeTurnId: 'old-turn' });
    await store.holdAgentAttempt({ ...oldClaim, errorCode: 'fixture_unknown' });
    await pendingCleanup('guidance-only', 'guidance-artifact');
    await enqueue('guidance-only', 'guidance-parent');
    const [parentClaim] = await store.claimJobs({ kind: 'agent', owner: 'fixture', leaseMs: 60000, limit: 1 });
    const parentAttempt = await store.beginAgentAttempt({ ...parentClaim, agentId: 'codex' });
    await store.bindAgentAttempt({ ...parentClaim, expectedGeneration: parentAttempt.generation, nativeThreadId: 'guidance-thread', nativeTurnId: 'guidance-turn' });
    await enqueue('guidance-only', 'unknown-guidance');
    const [guidanceClaim] = await store.claimJobs({ kind: 'agent', owner: 'fixture', leaseMs: 60000, limit: 1 });
    assert.equal((await store.beginSteerAttempt({ ...guidanceClaim, agentId: 'codex' })).kind, 'new');
    await store.finishSteerAttempt({ ...guidanceClaim, outcome: 'unknown', errorCode: 'fixture_unknown' });
    await store.finishJobWithOutbox({ ...parentClaim, result: {}, outbox: [] });
    await pendingCleanup('cleanup-first', 'other-artifact');
    const listCleanup = store.listPendingCleanup;
    store.listPendingCleanup = async input => { const page = await listCleanup(input); cleanupPages++; return page; };
    const activity = store.getConversationActivity;
    store.getConversationActivity = async input => { activityChecks.push(input.conversationId); return activity(input); };
    runtime = createRuntime({ config, store, codex, outbound, chat: { sendMessage: async () => ({ message_id: 'sent' }) } }); runtime.start();
    await cleanupEntered.promise;
    const next = await enqueue('cleanup-first', 'next-native');
    await until(() => store.getJob({ id: next.id }), row => row.status === 'running');
    assert.equal(starts.length, 0, 'cleanup ownership prevents admission RPC after durable claim');
    heldCleanup.release();
    const native = await until(() => store.getAgentAttempt({ id: next.id }), row => row?.nativeTurnId);
    await until(async () => activityChecks.includes('persisted'), Boolean);
    await until(async () => activityChecks.includes('guidance-only'), Boolean);
    assert(!cleanups.includes('guidance-only'), 'unresolved guidance protects artifacts even after parent completion');
    assert(!cleanups.includes('persisted'), 'restart unknown native is still an owner');
    // A currently running native turn prevents entry into the cleanup file layer.
    await pendingCleanup('cleanup-first', 'during-native');
    const before = cleanups.length, beforePages = cleanupPages;
    await until(async () => cleanupPages, count => count > beforePages);
    assert.equal(cleanups.length, before);
    await complete(native.nativeThreadId);
    await until(() => store.getJob({ id: next.id }), row => row.status === 'succeeded');
    await until(async () => cleanups.length, count => count > before);
    assert.equal((await store.getJob({ id: old.id })).status, 'unknown');
    assert(runtime.status().running);
  } finally { heldCleanup.release(); await runtime?.stop(); if (store) await store.close(); else await pool.end(); }
});
