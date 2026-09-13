import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createForwardJobStore } from '../src/storage/forward-jobs.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
import { createInboundMessageStore } from '../src/storage/inbound-messages.mjs';
import { createForwardRuntime } from '../src/core/forward-runtime.mjs';
import { createApi } from '../src/core/api.mjs';
import { validateConfig } from '../src/config.mjs';
import { deriveExecutionScope } from '../src/agents/codex/thread-scope.mjs';
import { Readable } from 'node:stream';

const enabled = Boolean(process.env.BRIDGE_TEST_PASSWORD);
const refs = Object.fromEntries(
  ['host', 'port', 'user', 'password', 'database'].map((key) => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]),
);

test('isolated MySQL preserves forward idempotency, recovery state, and lease fences', {
  skip: !enabled,
  timeout: 40_000,
}, async () => {
  const pool = createPoolFromEnvironment(refs);
  try {
    await migrate(pool);
    let now = 1000;
    const store = createForwardJobStore({ pool, now: () => now });
    const input = {
      callerId: 'caller', idempotencyKey: 'daily:1', conversationId: 'chat',
      messageId: 'system:daily:1', chatType: 'group', senderOpenId: 'system:scope',
      prompt: 'prompt', executionNamespace: 'daily', deliveryMode: 'caller',
    };
    const first = await store.upsert(input);
    const duplicate = await store.upsert(input);
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.duplicate, true);
    await assert.rejects(store.upsert({ ...input, prompt: 'changed' }), { code: 'job_conflict' });

    const [claimed] = await store.claim({ owner: 'worker-a', leaseMs: 100, limit: 1 });
    assert.equal(claimed.id, first.id);
    await assert.rejects(
      store.patchExecution({ id: first.id, leaseOwner: 'worker-b', execution: { status: 'bound' } }),
      { code: 'forward_lease_lost' },
    );
    await store.patchExecution({
      id: first.id, leaseOwner: 'worker-a',
      execution: { bindingOpenId: 'group:binding', threadId: 'thread', turnId: 'turn', startedAt: 1000 },
    });
    await store.patchFeedback({
      id: first.id, leaseOwner: 'worker-a', key: 'typing',
      value: { desired: false, reactionId: 'reaction' },
    });
    await store.markReplyPending({
      id: first.id, leaseOwner: 'worker-a',
      result: { answer: 'answer', rawAnswer: 'raw' },
    });

    now = 1200;
    const [reply] = await store.claimReplyPending({ owner: 'worker-b', leaseMs: 100, limit: 1 });
    assert.equal(reply.id, first.id);
    assert.equal(reply.result.typing.reactionId, 'reaction');
    await store.markFinished({
      id: first.id, leaseOwner: 'worker-b', status: 'completed',
      result: reply.result, replySent: false,
    });
    const result = await store.getRun({ id: first.id });
    assert.equal(result.status, 'completed');
    assert.equal(result.result.rawAnswer, 'raw');
    assert.equal(result.result.typing.reactionId, 'reaction');
    await pool.execute(`INSERT INTO assistant_codex_events
      (codex_session_id,feishu_open_id,chat_id,message_id,event_key,event_type,role,title,text,detail_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?,?,?,?)`, [
      'thread','group:binding','chat','system:daily:1','visible','public_progress','activity','Progress','',JSON.stringify({kind:'tool',id:'safe'}),1200,
      'thread','system:other','chat','system:daily:1','hidden','public_progress','activity','Other','',JSON.stringify({kind:'tool',id:'hidden'}),1200,
    ]);
    const events=await store.readEvents({id:first.id,after:'0',limit:10});
    assert.deepEqual(events.map(event=>event.title),['Progress']);

    const expiring = await store.upsert({ ...input, idempotencyKey: 'expiring', messageId: 'system:expiring' });
    const [expiringClaim] = await store.claim({ owner: 'worker-expiring', leaseMs: 100, limit: 1 });
    assert.equal(expiringClaim.id, expiring.id);
    now += 101;
    await assert.rejects(store.patchExecution({ id: expiring.id, leaseOwner: 'worker-expiring', execution: { status: 'too-late' } }), { code: 'forward_lease_lost' });

    const busy = await store.upsert({ ...input, idempotencyKey: 'busy', messageId: 'system:busy' });
    const busyClaim = (await store.claim({ owner: 'worker-busy', leaseMs: 100, limit: 5 })).find(job => job.id === busy.id);
    assert.equal(busyClaim.id, busy.id);
    await store.markRetry({ id: busy.id, leaseOwner: 'worker-busy', preserveAttempt: true, errorCode: 'CODEX_THREAD_BUSY', nextAttemptAt: now + 1000 });
    assert.equal((await store.getRun({ id: busy.id })).attempts, 0);

    const deferred = await store.upsert({ ...input, idempotencyKey: 'runtime-deferred', messageId: 'runtime-deferred' });
    const ignored = await store.upsert({ ...input, idempotencyKey: 'runtime-ignored', messageId: 'runtime-ignored' });
    for (const run of [deferred, ignored]) {
      await pool.execute(`UPDATE assistant_codex_forward_jobs
        SET result_json=JSON_SET(result_json,'$.inputEvent',CAST(? AS JSON))
        WHERE public_run_id=?`, [JSON.stringify({ messageId: run.messageId, message: { kind: 'image' } }), run.id]);
    }
    const executed = [];
    const runtimeWorker = createForwardRuntime({
      config: { owner: 'runtime-worker', pollMs: 2, leaseMs: 10_000 },
      jobs: store,
      sessions: {},
      media: { async prepare(event) {
        if (event.messageId === 'runtime-ignored') return { status: 'ignored', reason: 'group_media_ignored', replyText: '' };
        return { status: 'ready', addendum: '（图片路径：safe/runtime.png）' };
      } },
      executor: { async execute(value) {
        executed.push(value.messageId);
        return { deferred: true, accepted: true, threadId: 'thread-runtime', turnId: 'turn-runtime' };
      } },
      replies: {},
      authorize: async () => true,
    });
    runtimeWorker.start();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [deferredRun, ignoredRun] = await Promise.all([store.getRun({ id: deferred.id }), store.getRun({ id: ignored.id })]);
      if (deferredRun.status === 'deferred' && ignoredRun.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await runtimeWorker.stop();
    const [deferredRun, ignoredRun] = await Promise.all([store.getRun({ id: deferred.id }), store.getRun({ id: ignored.id })]);
    assert.equal(deferredRun.status, 'deferred');
    assert.equal(deferredRun.result.execution.inputStatus, 'ready');
    assert.equal(ignoredRun.status, 'completed');
    assert.equal(ignoredRun.result.inputStatus, 'ignored');
    assert.deepEqual(executed, ['runtime-deferred']);

    const communication = await createMysqlStore({ pool, now: () => now });
    const receipt = {
      connectionId: 'fixture', conversationId: 'chat', source: 'live', conversationType: 'group',
      eventKey: 'event-1', eventType: 'message.received', messageId: 'message-1',
      payload: { source: 'live', conversationType: 'group' }, policyVersion: '1',
      occurredAt: 2000,
      inboundMessage: { messageType: 'text', senderOpenId: 'human', senderName: 'Human', text: 'hello', createdAt: 2000, groupContextCandidate: true },
      forwardJob: { prompt: 'Human：hello', senderOpenId: 'human', senderName: 'Human', inputEvent: { messageId: 'message-1', message: { kind: 'text' } } },
      hooks: [{ hookId: 'hook', payload: { messageId: 'message-1' } }],
    };
    const accepted = await communication.acceptInbound(receipt);
    const replayed = await communication.acceptInbound(receipt);
    assert.equal(accepted.forwardRunId, replayed.forwardRunId);
    assert.deepEqual(replayed.hookJobIds, accepted.hookJobIds);
    const [[counts]] = await pool.query(`SELECT
      (SELECT COUNT(*) FROM assistant_codex_forward_jobs WHERE message_id='message-1') AS forward_count,
      (SELECT COUNT(*) FROM bridge_jobs WHERE event_id=? AND kind='hook') AS hook_count`, [accepted.eventId]);
    assert.equal(Number(counts.forward_count), 1);
    assert.equal(Number(counts.hook_count), 1);
    const [[forwardInput]] = await pool.query('SELECT result_json FROM assistant_codex_forward_jobs WHERE message_id=?', ['message-1']);
    assert.equal(JSON.parse(forwardInput.result_json).inputEvent.messageId, 'message-1');

    await communication.acceptInbound({
      connectionId: 'fixture', conversationId: 'chat', source: 'live', conversationType: 'group',
      eventKey: 'recall-1', eventType: 'message.recalled', messageId: 'message-1', recalledMessageId: 'message-1',
      payload: { source: 'live', conversationType: 'group' }, policyVersion: '1',
    });
    const inbound = createInboundMessageStore({ pool, now: () => now });
    const context = await inbound.loadRecentGroupContext({ connectionId: 'fixture', chatId: 'chat', beforeMs: 2100 });
    assert.deepEqual(context, []);

    const apiConfig = validateConfig({
      schemaVersion: 1,
      storage: { hostEnv: 'DB_HOST', portEnv: 'DB_PORT', userEnv: 'DB_USER', passwordEnv: 'DB_PASSWORD', databaseEnv: 'DB_DATABASE' },
      codex: { bin: './codex', cwd: './workspace', envNames: [] },
      feishu: { connectionId: 'fixture', appIdEnv: 'APP_ID', appSecretEnv: 'APP_SECRET', botOpenId: 'bot' },
      routing: { version: '1', privateUserIds: [], groups: [{ conversationId: 'chat', trigger: 'mention', passiveContext: true }] },
      auth: { clients: [{ id: 'api-caller', tokenEnv: 'API_TOKEN', conversationIds: ['chat'], admin: false }] },
      hooks: [],
    });
    const runtime = createForwardRuntime({ jobs: store, sessions: {}, executor: {}, replies: {}, authorize: async () => true });
    const token = 'synthetic-token-at-least-24-characters';
    const api = createApi({ config: apiConfig, store: communication, forwardRuntime: runtime, chat: {}, tokens: { 'api-caller': token } });
    const post = (idempotencyKey, executionNamespace) => Object.assign(Readable.from([Buffer.from(JSON.stringify({ conversationId: 'chat', idempotencyKey, executionNamespace, deliveryMode: 'caller', text: 'scheduled' }))]), {
      method: 'POST', url: '/v1/runs', headers: { authorization: `Bearer ${token}` },
    });
    await api(post('scheduled-a', 'namespace-a'));
    await api(post('scheduled-b', 'namespace-b'));
    const [identities] = await pool.query("SELECT caller_id,sender_open_id FROM assistant_codex_forward_jobs WHERE caller_id IN ('live','api-caller') ORDER BY caller_id,sender_open_id");
    const apiIdentities = identities.filter(row => row.caller_id === 'api-caller').map(row => row.sender_open_id).sort();
    assert.deepEqual(apiIdentities, [deriveExecutionScope('api-caller', 'namespace-a'), deriveExecutionScope('api-caller', 'namespace-b')].sort());
    assert.equal(identities.some(row => row.caller_id === 'live' && row.sender_open_id === 'human'), true);
    await communication.close();
  } finally {
    if (!pool.pool?._closed) await pool.end();
  }
});
