import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createForwardJobStore } from '../src/storage/forward-jobs.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';

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
      execution: { threadId: 'thread', turnId: 'turn', startedAt: 1000 },
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

    const communication = await createMysqlStore({ pool, now: () => now });
    const receipt = {
      connectionId: 'fixture', conversationId: 'chat', source: 'live', conversationType: 'group',
      eventKey: 'event-1', eventType: 'message.received', messageId: 'message-1',
      payload: { source: 'live', conversationType: 'group' }, policyVersion: '1',
      inboundMessage: { messageType: 'text', senderOpenId: 'human', senderName: 'Human', text: 'hello' },
      forwardJob: { prompt: 'Human：hello', senderOpenId: 'human', senderName: 'Human' },
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
    await communication.close();
  } finally {
    if (!pool.pool?._closed) await pool.end();
  }
});
