import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
import { createCodexSessionStore } from '../src/storage/codex-sessions.mjs';
import { createForwardJobStore } from '../src/storage/forward-jobs.mjs';
import { createInboundMessageStore } from '../src/storage/inbound-messages.mjs';

const enabled = Boolean(process.env.BRIDGE_TEST_PASSWORD);
const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));

test('two bots share one MySQL schema without sharing bindings, jobs, context, delivery or API reads', { skip: !enabled, timeout: 40000 }, async () => {
  const pool = createPoolFromEnvironment(refs);
  let writerA, writerB;
  try {
    await migrate(pool);
    const schema = process.env.BRIDGE_TEST_DATABASE;
    for (const factory of [createMysqlStore, createForwardJobStore, createInboundMessageStore]) {
      await assert.rejects(async () => factory({ pool, connectionId: '' }), { code: 'invalid_store_input' });
    }
    assert.throws(() => createCodexSessionStore({ pool, schema, connectionId: '' }), { code: 'invalid_store_input' });
    let time = Date.now();
    writerA = await createMysqlStore({ pool, connectionId: 'bot-a', now: () => time });
    const otherPool = createPoolFromEnvironment(refs);
    writerB = await createMysqlStore({ pool: otherPool, connectionId: 'BOT-A', now: () => time });
    const thirdPool = createPoolFromEnvironment(refs);
    try { await assert.rejects(createMysqlStore({ pool: thirdPool, connectionId: 'bot-a' }), { code: 'writer_busy' }); }
    finally { await thirdPool.end(); }

    const sessionsA = createCodexSessionStore({ pool, schema, connectionId: 'bot-a' });
    const sessionsB = createCodexSessionStore({ pool, schema, connectionId: 'BOT-A' });
    const identity = { feishuOpenId: 'same-actor', chatId: 'same-chat', chatType: 'group' };
    await sessionsA.saveCodexBinding({ ...identity, codexSessionId: 'thread-a' });
    await sessionsB.saveCodexBinding({ ...identity, codexSessionId: 'thread-b' });
    assert.equal((await sessionsA.loadBinding(identity)).codexSessionId, 'thread-a');
    assert.equal((await sessionsB.loadBinding(identity)).codexSessionId, 'thread-b');
    await sessionsA.saveCodexRealtimeEvent({ ...identity, codexSessionId: 'thread-a' }, { eventKey: 'same-key', messageId: 'same-message', eventType: 'public_progress', title: 'A' });
    await sessionsB.saveCodexRealtimeEvent({ ...identity, codexSessionId: 'thread-b' }, { eventKey: 'same-key', messageId: 'same-message', eventType: 'public_progress', title: 'B' });
    assert.equal((await sessionsA.readPublicProgress({ binding: identity, threadId: 'thread-a', messageId: 'same-message' }))[0].title, 'A');
    assert.equal((await sessionsB.readPublicProgress({ binding: identity, threadId: 'thread-b', messageId: 'same-message' }))[0].title, 'B');

    const jobsA = createForwardJobStore({ pool, connectionId: 'bot-a', now: () => time });
    const jobsB = createForwardJobStore({ pool, connectionId: 'BOT-A', now: () => time });
    const request = { callerId: 'same-caller', idempotencyKey: 'same-request', conversationId: 'same-chat', messageId: 'same-message', prompt: 'same prompt' };
    const runA = await jobsA.upsert(request), runB = await jobsB.upsert(request);
    assert.notEqual(runA.id, runB.id);
    assert.equal((await jobsA.upsert(request)).duplicate, true);
    assert.equal((await jobsB.getByMessageId({ messageId: 'same-message' })).id, runB.id);
    assert.equal(await jobsA.getRun({ id: runB.id }), null);
    assert.deepEqual(await jobsA.readEvents({ id: runB.id }), []);
    assert.equal(await jobsA.claimById({ id: runB.id, owner: 'owner', leaseMs: 1000 }), null);
    assert.equal((await jobsA.claim({ owner: 'owner-a', leaseMs: 1000 }))[0].id, runA.id);
    await assert.rejects(jobsA.renew({ id: runB.id, leaseOwner: 'owner-a', leaseMs: 1000 }), { code: 'forward_lease_lost' });
    assert.deepEqual(await jobsA.beginStop({ id: runB.id, threadId: 't', turnId: 'u', messageId: 'same-message', actor: 'actor' }), { outcome: 'not_found' });
    assert.equal((await jobsB.getRun({ id: runB.id })).status, 'pending');
    assert.deepEqual((await jobsB.claim({ owner: 'owner-b', leaseMs: 1000 })).map(item => item.id), [runB.id]);
    time += 1001;
    assert.equal((await jobsA.claim({ owner: 'owner-a-again', leaseMs: 1000 }))[0].id, runA.id);
    assert.equal((await jobsB.getRun({ id: runB.id })).leaseOwner, 'owner-b');
    assert.equal((await jobsB.claim({ owner: 'owner-b-again', leaseMs: 1000 }))[0].id, runB.id);
    await jobsA.markReplyPending({ id: runA.id, leaseOwner: 'owner-a-again', result: {} });
    await jobsB.markReplyPending({ id: runB.id, leaseOwner: 'owner-b-again', result: {} });
    assert.equal((await jobsA.claimReplyPending({ owner: 'reply-a', leaseMs: 1000 }))[0].id, runA.id);
    assert.equal((await jobsB.getRun({ id: runB.id })).leaseOwner, 'owner-b-again');
    assert.equal((await jobsB.claimReplyPending({ owner: 'reply-b', leaseMs: 1000 }))[0].id, runB.id);
    for (const [jobs, run, owner] of [[jobsA,runA,'reply-a'],[jobsB,runB,'reply-b']]) {
      await jobs.patchFeedback({ id: run.id, leaseOwner: owner, key: 'typing', value: { desired: false, outcome: 'unknown', nextRetryAt: time } });
      await jobs.markRetry({ id: run.id, leaseOwner: owner, held: true, errorCode: 'typing_unknown' });
    }
    assert.equal((await jobsA.claimFeedbackPending({ owner: 'cleanup-a', leaseMs: 1000 }))[0].public_run_id, runA.id);
    assert.equal((await jobsB.getRun({ id: runB.id })).leaseOwner, '');
    assert.equal((await jobsB.claimFeedbackPending({ owner: 'cleanup-b', leaseMs: 1000 }))[0].public_run_id, runB.id);

    const inboundA = createInboundMessageStore({ pool, connectionId: 'bot-a' });
    const inboundB = createInboundMessageStore({ pool, connectionId: 'BOT-A' });
    const message = { messageId: 'context-message', chatId: 'same-chat', senderOpenId: 'same-actor', text: 'context', groupContextCandidate: true, createdAt: 1000 };
    await inboundA.persist(message); await inboundB.persist(message);
    const context = { chatId: 'same-chat', beforeMs: 2000, windowMs: 2000 };
    const entryA = (await inboundA.loadRecentGroupContext(context))[0];
    assert.equal((await inboundB.loadRecentGroupContext(context)).length, 1);
    await inboundA.markForwarded({ entries: [entryA], threadId: 'thread-a', turnId: 'turn-a' });
    assert.deepEqual(await inboundA.loadRecentGroupContext(context), []);
    assert.equal((await inboundB.loadRecentGroupContext(context)).length, 1);
    await inboundA.recordReply({ messageId: 'reply', chatId: 'same-chat', text: 'A' });
    await inboundB.recordReply({ messageId: 'reply', chatId: 'same-chat', text: 'B' });
    await inboundA.recordEvent({ messageId: 'reply', chatId: 'same-chat', event: 'processing_reaction_added', detail: 'reaction_id=a' });
    await inboundB.recordEvent({ messageId: 'reply', chatId: 'same-chat', event: 'processing_reaction_added', detail: 'reaction_id=b' });
    assert.deepEqual([...await inboundA.loadOpenProcessingReactionIds({ messageId: 'reply' })], ['a']);
    assert.deepEqual([...await inboundB.loadOpenProcessingReactionIds({ messageId: 'reply' })], ['b']);

    const effectA = await writerA.recordOutbox({ connectionId: 'bot-a', conversationId: 'same-chat', kind: 'create', idempotencyKey: 'same-effect', payload: { text: 'A' } });
    const effectB = await writerB.recordOutbox({ connectionId: 'BOT-A', conversationId: 'same-chat', kind: 'create', idempotencyKey: 'same-effect', payload: { text: 'B' } });
    assert.notEqual(effectA.id, effectB.id);
    await assert.rejects(writerA.recordOutbox({ connectionId: 'bot-a', conversationId: 'same-chat', kind: 'reply', idempotencyKey: 'cross-predecessor', predecessorId: effectB.id, payload: { text: 'not ours' } }), { code: 'invalid_outbox_predecessor' });
    assert.equal(await writerA.getOutbox({ id: effectB.id }), null);
    assert.equal((await writerA.claimOutbox({ owner: 'a', leaseMs: 1000 }))[0].id, effectA.id);
    let [claimedB] = await writerB.claimOutbox({ owner: 'b', leaseMs: 1000 });
    assert.equal(claimedB.id, effectB.id);
    time += 1001;
    assert.equal((await writerA.claimOutbox({ owner: 'a-again', leaseMs: 1000 }))[0].id, effectA.id);
    assert.equal((await writerB.getOutbox({ id: effectB.id })).status, 'running');
    [claimedB] = await writerB.claimOutbox({ owner: 'b-again', leaseMs: 1000 });
    await assert.rejects(writerA.settleOutbox({ id: effectB.id, leaseToken: 'wrong', status: 'sent' }), { code: 'stale_lease' });
    assert.throws(() => writerA.getOutbox({ id: effectA.id, connectionId: 'BOT-A' }), { code: 'invalid_store_input' });
    const legacyWrongLink = await writerA.recordOutbox({ connectionId: 'bot-a', conversationId: 'same-chat', kind: 'create', idempotencyKey: 'legacy-wrong-link', payload: { text: 'A pending' } });
    await writerB.settleOutbox({ id: effectB.id, leaseToken: claimedB.leaseToken, status: 'sent', result: { file_key: 'b-private' } });
    await pool.execute('UPDATE bridge_outbox SET predecessor_id=? WHERE id=? AND connection_id=?', [effectB.id,legacyWrongLink.id,'bot-a']);
    const blocked = await writerA.getOutbox({ id: legacyWrongLink.id });
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.predecessorResult, null);
    assert.deepEqual(await writerA.claimOutbox({ owner: 'legacy-check', leaseMs: 1000 }), []);
    const hookInput = { conversationId: 'same-chat', kind: 'hook', hookId: 'same-hook', idempotencyKey: 'same-hook-key', payload: { text: 'same' } };
    const hookA = await writerA.enqueueJob({ ...hookInput, connectionId: 'bot-a' });
    const hookB = await writerB.enqueueJob({ ...hookInput, connectionId: 'BOT-A' });
    assert.notEqual(hookA.id, hookB.id);
    assert.equal((await writerA.claimJobs({ kind: 'hook', owner: 'hook-a', leaseMs: 1000 }))[0].id, hookA.id);
    assert.equal((await writerB.getJob({ id: hookB.id })).status, 'pending');
    assert.equal((await writerB.claimJobs({ kind: 'hook', owner: 'hook-b', leaseMs: 1000 }))[0].id, hookB.id);
    assert.equal(await writerA.getJob({ id: hookB.id }), null);
    for (const [sql, index] of [
      ["SELECT id FROM assistant_codex_forward_jobs WHERE connection_id='bot-a' AND status='pending' AND next_attempt_at<=1000 ORDER BY created_at,id LIMIT 5", 'idx_forward_status_next'],
      ["SELECT id FROM assistant_inbound_messages WHERE connection_id='bot-a' AND chat_id='same-chat' AND group_context_candidate=1 AND codex_context_forwarded_at IS NULL ORDER BY message_created_at DESC,id DESC LIMIT 5", 'idx_inbound_context'],
      ["SELECT id FROM bridge_jobs WHERE connection_id='bot-a' AND kind='hook' AND status='pending' ORDER BY created_at,id LIMIT 5", 'jobs_claim'],
    ]) {
      const [[plan]] = await pool.query(`EXPLAIN ${sql}`);
      assert.match(String(plan.possible_keys), new RegExp(index));
    }

  } finally {
    if (writerA) await writerA.close(); else await pool.end();
    if (writerB) await writerB.close();
  }
});
