import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createForwardJobStore } from '../src/storage/forward-jobs.mjs';
import { createCodexSessionStore } from '../src/storage/codex-sessions.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
import { createInboundMessageStore } from '../src/storage/inbound-messages.mjs';
import { createForwardRuntime } from '../src/core/forward-runtime.mjs';
import { createApi } from '../src/core/api.mjs';
import { createFeishuReplies } from '../src/channels/feishu/replies.mjs';
import { createExecutionFeedback } from '../src/channels/feishu/execution-feedback.mjs';
import { observeExecutionCard } from '../src/channels/feishu/execution-card.mjs';
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
    const store = createForwardJobStore({connectionId:'fixture', pool, now: () => now });
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
    const queuedInput = { ...input, idempotencyKey: 'queue-policy', messageId: 'system:queue-policy',
      initialResult: { policy: { queueIfBusy: true } }, queueIfBusySpecified: true, requestedQueueIfBusy: true };
    const queued = await store.upsert(queuedInput);
    assert.equal((await store.upsert(queuedInput)).id, queued.id);
    assert.equal((await store.upsert({ ...queuedInput, queueIfBusySpecified: false,
      initialResult: { policy: { queueIfBusy: false } } })).id, queued.id,
    'an omitted per-run option keeps the persisted policy');
    await assert.rejects(store.upsert({ ...queuedInput, requestedQueueIfBusy: false,
      initialResult: { policy: { queueIfBusy: false } } }), { code: 'job_conflict' });
    const legacyPolicy = await store.upsert({ ...input, idempotencyKey: 'legacy-queue-policy',
      messageId: 'system:legacy-queue-policy', initialResult: {} });
    assert.equal((await store.upsert({ ...input, idempotencyKey: 'legacy-queue-policy',
      messageId: 'system:legacy-queue-policy', initialResult: { policy: { queueIfBusy: false } },
      queueIfBusySpecified: true, requestedQueueIfBusy: false })).id, legacyPolicy.id);
    await pool.execute('DELETE FROM assistant_codex_forward_jobs WHERE public_run_id IN (?,?)', [queued.id, legacyPolicy.id]);

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
      value: { desired: false, reactionId: 'reaction', outcome: 'confirmed' },
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
      (connection_id,codex_session_id,feishu_open_id,chat_id,message_id,event_key,event_type,role,title,text,detail_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?,?,?,?,?)`, [
      'fixture','thread','group:binding','chat','system:daily:1','visible','public_progress','activity','Progress','',JSON.stringify({kind:'tool',id:'safe'}),1200,
      'fixture','thread','system:other','chat','system:daily:1','hidden','public_progress','activity','Other','',JSON.stringify({kind:'tool',id:'hidden'}),1200,
    ]);
    const events=await store.readEvents({id:first.id,after:'0',limit:10});
    assert.deepEqual(events.map(event=>event.title),['Progress']);
    assert.equal(events[0].sequence, events[0].id);
    assert.deepEqual(events[0].payload.progress, {kind:'tool',id:'safe'});

    const progressStore = createCodexSessionStore({
      connectionId: 'fixture',
      pool,
      schema: process.env.BRIDGE_TEST_DATABASE,
      now: () => now,
    });
    const delayed = await pool.getConnection();
    try {
      await delayed.beginTransaction();
      await delayed.execute(`INSERT INTO assistant_codex_events
        (connection_id,id,codex_session_id,feishu_open_id,chat_id,message_id,event_key,event_type,role,title,text,detail_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ['fixture',9000001,'late-thread','group:late','late-chat','late-message','tool:late','public_progress','activity','Late','',JSON.stringify({kind:'tool',id:'late',status:'completed'}),1300]);
      await pool.execute(`INSERT INTO assistant_codex_events
        (connection_id,id,codex_session_id,feishu_open_id,chat_id,message_id,event_key,event_type,role,title,text,detail_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ['fixture',9000002,'late-thread','group:late','late-chat','late-message','tool:visible','public_progress','activity','Visible','',JSON.stringify({kind:'tool',id:'visible',status:'running'}),1301]);
      const binding = { feishuOpenId: 'group:late', chatId: 'late-chat' };
      let cardState = { entries: [] };
      const card = {
        chain: Promise.resolve(),
        snapshot: () => structuredClone(cardState),
        push(event) {
          const index = cardState.entries.findIndex(item => item.id === event.id);
          if (index >= 0) cardState.entries[index] = event;
          else cardState.entries.push(event);
        },
        async persist(value) { cardState = structuredClone(value); },
        async log() {},
        stop() {},
      };
      const load = cursor => progressStore.readPublicProgress({
        binding, threadId: 'late-thread', messageId: 'late-message', cursor, limit: 100,
      }).then(rows => rows.map(row => ({ ...row, progress_json: row.detail_json })));
      const observer = observeExecutionCard({ card, since: 1200, load });
      for(let attempt=0;attempt<100&&!cardState.entries.length;attempt+=1)await new Promise(resolve=>setTimeout(resolve,5));
      assert.deepEqual(cardState.entries.map(entry => entry.id), ['visible']);
      await delayed.commit();
      const saved = await observer.stop();
      assert.deepEqual(saved.entries.map(entry => entry.id).sort(), ['late', 'visible']);
      await pool.execute(`UPDATE assistant_codex_events SET detail_json=?,created_at=?
        WHERE codex_session_id=? AND event_key=?`, [JSON.stringify({kind:'tool',id:'visible',status:'failed'}),1303,'late-thread','tool:visible']);
      const resumed = observeExecutionCard({ card, since: 1200, cursor: saved.observerCursor, load });
      const updated = await resumed.stop();
      assert.equal(updated.entries.find(entry => entry.id === 'visible').status, 'failed');
    } finally {
      delayed.release();
    }

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

    const deliveryRun = await store.upsert({
      ...input,
      idempotencyKey: 'delivery-sidecar',
      messageId: 'delivery-source',
      sourceMessageId: 'delivery-source',
      deliveryMode: 'bridge',
    });
    const deliveryClaim = (await store.claim({ owner: 'delivery-executor', leaseMs: 100, limit: 5 }))
      .find(job => job.id === deliveryRun.id);
    assert(deliveryClaim);
    const deliveryResult = {
      answer: 'delivered answer', rawAnswer: 'raw delivered answer',
      execution: { bindingOpenId: 'group:binding', threadId: 'delivery-thread', turnId: 'delivery-turn', startedAt: now },
    };
    await store.markReplyPending({
      id: deliveryRun.id, leaseOwner: 'delivery-executor', result: deliveryResult,
    });
    const replyClaim = (await store.claimReplyPending({ owner: 'delivery-worker', leaseMs: 100, limit: 5 }))
      .find(job => job.id === deliveryRun.id);
    assert(replyClaim);
    const deliveryCalls = [];
    const replies = createFeishuReplies({
      connectionId: 'fixture', jobs: store,
      chat: {
        async sendMessage() { deliveryCalls.push('reply'); return { message_id: 'reply-message' }; },
      },
      outbound: {
        async prepare() {
          return { artifacts: [{ ref: { artifactId: 'artifact-one' }, fileName: 'result.txt', size: 6, kind: 'file' }], failures: [], omitted: 0 };
        },
        async upload() { deliveryCalls.push('upload'); return { file_key: 'file-key' }; },
        async send() { deliveryCalls.push('attachment'); return { message_id: 'attachment-message' }; },
        async cleanup() { deliveryCalls.push('cleanup'); },
      },
    });
    const preparedDelivery = await replies.prepare(replyClaim, replyClaim.result);
    const delivered = await replies.deliver(replyClaim, preparedDelivery, { assertLease() {} });
    assert.equal(delivered.status, 'sent');
    assert.deepEqual(deliveryCalls, ['reply']);
    await store.patchFeedback({
      id: deliveryRun.id, leaseOwner: 'delivery-worker', key: 'typing',
      value: { desired: false, operation: 'remove', outcome: 'unknown' },
    });
    await store.markFinished({
      id: deliveryRun.id, leaseOwner: 'delivery-worker', status: 'completed',
      result: preparedDelivery, replySent: true,
    });
    const [cleanupClaim] = await store.claimFeedbackPending({ owner: 'feedback-worker', leaseMs: 100, limit: 1 });
    assert.equal(cleanupClaim.id, deliveryRun.id);
    const removedReactions = [];
    const feedback = createExecutionFeedback({
      jobs: store, sessions: {}, executor: {}, chat: {},
      typing: { async cleanup(job) { removedReactions.push('typing-reaction'); await store.patchFeedback({
        id:job.id,leaseOwner:job.leaseOwner,key:'typing',value:{desired:false,outcome:'confirmed'},
      }); } },
    });
    await feedback.cleanup(cleanupClaim, { assertLease() {} });
    await store.releaseFeedback({ id: deliveryRun.id, leaseOwner: 'feedback-worker' });
    assert.deepEqual(removedReactions, ['typing-reaction']);
    assert.equal((await store.getRun({ id: deliveryRun.id })).result.typing.outcome, 'confirmed');
    assert.deepEqual(await store.claimFeedbackPending({ owner: 'feedback-worker-2', leaseMs: 100, limit: 1 }), []);

    const safeUnknownAnswer = await store.upsert({ ...input, idempotencyKey: 'safe-unknown-answer', messageId: 'safe-unknown-answer' });
    const legacyUnknownReply = await store.upsert({ ...input, idempotencyKey: 'legacy-unknown-reply', messageId: 'legacy-unknown-reply' });
    for (const run of [safeUnknownAnswer, legacyUnknownReply]) {
      const claimed = await store.claimById({ id: run.id, owner: `prepare-${run.id}`, leaseMs: 100 });
      await store.markReplyPending({ id: run.id, leaseOwner: claimed.leaseOwner, result: run.id === safeUnknownAnswer.id
        ? { answer: 'unknown', rawAnswer: 'unknown' }
        : { answer: 'answer', delivery: { text: { items: [{ status: 'unknown' }] } } } });
    }
    const deliveryGuardClaims = await store.claimReplyPending({ owner: 'delivery-guard', leaseMs: 100, limit: 5 });
    assert.equal(deliveryGuardClaims.some(item => item.id === safeUnknownAnswer.id), true);
    assert.equal(deliveryGuardClaims.some(item => item.id === legacyUnknownReply.id), false);
    await store.markFinished({ id: safeUnknownAnswer.id, leaseOwner: 'delivery-guard', status: 'completed', result: safeUnknownAnswer.result });

    await pool.execute('DELETE FROM assistant_codex_forward_jobs');
    const startIntentRun = await store.upsert({
      ...input, idempotencyKey: 'start-intent-cleanup', messageId: 'start-intent-source',
      sourceMessageId: 'start-intent-source', deliveryMode: 'bridge',
    });
    const startIntentClaim = (await store.claim({ owner: 'crashed-owner', leaseMs: 100, limit: 1 }))[0];
    assert.equal(startIntentClaim.id, startIntentRun.id);
    await store.patchFeedback({
      id: startIntentRun.id, leaseOwner: 'crashed-owner', key: 'typing',
      value: { desired: true, reactionId: 'persisted-typing', outcome: 'confirmed' },
    });
    await store.patchExecution({
      id: startIntentRun.id, leaseOwner: 'crashed-owner',
      execution: { bindingOpenId: 'group:binding', threadId: 'uncertain-thread', startedAt: now, status: 'start_intent' },
    });
    now += 101;
    let startIntentExecutions = 0;
    const startIntentRemoved = [];
    const startIntentFeedback = createExecutionFeedback({
      jobs: store, sessions: {}, executor: {},
      chat: {
        async removeReaction(value) { startIntentRemoved.push(value.reactionId); },
        async listReactions() { throw new Error('known reaction id should be removed directly'); },
      },
    });
    const startIntentRuntime = createForwardRuntime({
      config: { owner: 'restart-worker', pollMs: 2, leaseMs: 10_000 }, jobs: store, sessions: {},
      executor: { async execute() { startIntentExecutions += 1; } },
      feedback: startIntentFeedback, replies: {}, authorize: async () => true,
    });
    startIntentRuntime.start();
    await new Promise(resolve => setTimeout(resolve, 20));
    await startIntentRuntime.stop();
    const heldStartIntent = await store.getRun({ id: startIntentRun.id });
    assert.equal(startIntentExecutions, 0);
    assert.deepEqual(startIntentRemoved, []);
    assert.equal(heldStartIntent.status, 'running');
    assert.equal(heldStartIntent.result.typing.desired, true);

    const leaseRun = await store.upsert({ ...input, idempotencyKey: 'lease-generation', messageId: 'lease-generation' });
    const oldLease = (await store.claim({ owner: 'same-process:first-claim', leaseMs: 100, limit: 1 }))[0];
    assert.equal(oldLease.id, leaseRun.id);
    now += 101;
    const newLease = (await store.claim({ owner: 'same-process:second-claim', leaseMs: 100, limit: 1 }))[0];
    assert.equal(newLease.id, leaseRun.id);
    assert.notEqual(newLease.leaseOwner, oldLease.leaseOwner);
    await assert.rejects(store.patchFeedback({
      id: leaseRun.id, leaseOwner: oldLease.leaseOwner, key: 'executionCard', value: { status: 'running' },
    }), { code: 'forward_lease_lost' });

    await pool.execute('DELETE FROM assistant_codex_forward_jobs');
    await pool.execute(`INSERT INTO assistant_codex_forward_jobs
      (connection_id,public_run_id,request_key_hash,request_hash,caller_id,execution_namespace,delivery_mode,message_id,chat_id,
       chat_type,message_type,sender_open_id,sender_name,conversation_scope,prompt,group_chat_context_json,
       context_entries_json,status,result_json,last_error,created_at,updated_at)
      WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n+1 FROM seq WHERE n<1000)
      SELECT 'fixture',UUID(),SHA2(CONCAT('history-',n),256),SHA2(CONCAT('history-request-',n),256),'history','','bridge',
       CONCAT('history-',n),'chat','group','text','system:history','','group','history','null','[]','completed',
       JSON_OBJECT('typing',JSON_OBJECT('desired',false,'outcome','confirmed')),'',?,? FROM seq`, [now, now]);
    const cleanupRun = await store.upsert({ ...input, idempotencyKey: 'indexed-cleanup', messageId: 'indexed-cleanup', deliveryMode: 'bridge' });
    const cleanupOwner = (await store.claim({ owner: 'cleanup-seed', leaseMs: 100, limit: 1 }))[0];
    assert.equal(cleanupOwner.id, cleanupRun.id);
    await store.patchFeedback({
      id: cleanupRun.id, leaseOwner: cleanupOwner.leaseOwner, key: 'typing',
      value: { desired: false, operation: 'remove', outcome: 'unknown', nextRetryAt: now },
    });
    await store.markRetry({ id: cleanupRun.id, leaseOwner: cleanupOwner.leaseOwner, held: true, errorCode: 'cleanup_fixture' });
    const [plan] = await pool.query(`EXPLAIN SELECT id FROM assistant_codex_forward_jobs
      FORCE INDEX (idx_forward_feedback_cleanup)
      WHERE connection_id='fixture' AND feedback_cleanup_pending=1 AND feedback_cleanup_at<=?
        AND status IN ('held','completed','failed','deferred')
        AND (lease_expires_at IS NULL OR lease_expires_at<=?)
      ORDER BY feedback_cleanup_at,id LIMIT 5`, [now, now]);
    assert.equal(plan[0].key, 'idx_forward_feedback_cleanup');
    const indexedClaims = await store.claimFeedbackPending({ owner: 'indexed-cleaner', leaseMs: 100, limit: 5 });
    assert.deepEqual(indexedClaims.map(job => job.id), [cleanupRun.id]);
    await store.releaseFeedback({ id: cleanupRun.id, leaseOwner: 'indexed-cleaner', nextAttemptAt: now + 1000 });

    const stopRun = await store.upsert({ ...input, idempotencyKey: 'stop-once', messageId: 'stop-source' });
    const stopClaim = (await store.claim({ owner: 'stop-worker', leaseMs: 100, limit: 5 }))
      .find(job => job.id === stopRun.id);
    assert(stopClaim);
    await store.patchExecution({
      id: stopRun.id, leaseOwner: 'stop-worker',
      execution: { bindingOpenId: 'group:binding', threadId: 'stop-thread', turnId: 'stop-turn', startedAt: now },
    });
    const stopInput = { id: stopRun.id, threadId: 'stop-thread', turnId: 'stop-turn', messageId: 'stop-source', actor: 'human' };
    const stopBegins = await Promise.all([store.beginStop(stopInput), store.beginStop(stopInput)]);
    assert.deepEqual(stopBegins.map(value => value.outcome).sort(), ['new', 'replay']);
    const pendingStop = stopBegins[0].stop;
    await store.finishStop({ id: stopRun.id, stop: { ...pendingStop, outcome: 'requested', confirmedAt: now } });
    const staleUnknown = await store.finishStop({ id: stopRun.id, stop: { ...pendingStop, outcome: 'unconfirmed', confirmedAt: now } });
    assert.equal(staleUnknown.replay, true);
    assert.equal(staleUnknown.stop.outcome, 'requested');

    const cardStopRun = await store.upsert({ ...input, idempotencyKey: 'card-stop', messageId: 'card-stop-source' });
    const cardStopClaim = await store.claimById({ id: cardStopRun.id, owner: 'card-stop-worker', leaseMs: 100 });
    await store.patchExecution({ id: cardStopRun.id, leaseOwner: cardStopClaim.leaseOwner,
      execution: { bindingOpenId: 'group:binding' } });
    await store.patchFeedback({ id: cardStopRun.id, leaseOwner: cardStopClaim.leaseOwner, key: 'executionCard',
      value: { messageId: 'card-stop-message', turnId: 'card-stop-turn', status: 'running' } });
    const cardStop = await store.beginStop({ id: cardStopRun.id, threadId: 'card-stop-thread', bindingThreadId: 'card-stop-thread',
      turnId: 'card-stop-turn', messageId: 'card-stop-source', actor: 'human' });
    assert.equal(cardStop.outcome,'new');
    assert.equal((await store.beginStop({ id: cardStopRun.id, threadId: 'wrong-thread', bindingThreadId: 'card-stop-thread',
      turnId: 'card-stop-turn', messageId: 'card-stop-source', actor: 'human' })).outcome,'stale');

    const communication = await createMysqlStore({connectionId:'fixture', pool, now: () => now });
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
    assert.equal(accepted.forwardRunId, undefined);
    assert.equal(replayed.forwardRunId, undefined);
    assert.deepEqual(replayed.hookJobIds, accepted.hookJobIds);
    const [[counts]] = await pool.query(`SELECT
      (SELECT COUNT(*) FROM assistant_codex_forward_jobs WHERE message_id='message-1') AS forward_count,
      (SELECT COUNT(*) FROM bridge_jobs WHERE event_id=? AND kind='hook') AS hook_count`, [accepted.eventId]);
    assert.equal(Number(counts.forward_count), 0);
    assert.equal(Number(counts.hook_count), 1);

    await communication.acceptInbound({
      connectionId: 'fixture', conversationId: 'chat', source: 'live', conversationType: 'group',
      eventKey: 'recall-1', eventType: 'message.recalled', messageId: 'message-1', recalledMessageId: 'message-1',
      payload: { source: 'live', conversationType: 'group' }, policyVersion: '1',
    });
    const inbound = createInboundMessageStore({connectionId:'fixture', pool, now: () => now });
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
    const [identities] = await pool.query("SELECT caller_id,sender_open_id,source_message_id FROM assistant_codex_forward_jobs WHERE caller_id IN ('live','api-caller') ORDER BY caller_id,sender_open_id");
    const apiIdentities = identities.filter(row => row.caller_id === 'api-caller').map(row => row.sender_open_id).sort();
    assert.deepEqual(apiIdentities, [deriveExecutionScope('api-caller', 'namespace-a'), deriveExecutionScope('api-caller', 'namespace-b')].sort());
    assert.equal(identities.some(row => row.caller_id === 'live'), false);
    assert(identities.filter(row => row.caller_id === 'api-caller').every(row => row.source_message_id === null));
    await communication.close();
  } finally {
    if (!pool.pool?._closed) await pool.end();
  }
});
