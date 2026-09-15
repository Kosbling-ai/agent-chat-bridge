import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createCodexSessionStore } from '../src/storage/codex-sessions.mjs';
import { createForwardJobStore } from '../src/storage/forward-jobs.mjs';

const enabled = Boolean(process.env.BRIDGE_TEST_PASSWORD);
const refs = Object.fromEntries(['host','port','user','password','database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));

test('busy fork intent atomically switches only the expected scoped binding', { skip: !enabled, timeout: 40_000 }, async () => {
  const pool = createPoolFromEnvironment(refs);
  try {
    await migrate(pool);
    const sessions = createCodexSessionStore({ pool, connectionId: 'bot-a', schema: process.env.BRIDGE_TEST_DATABASE, now: () => 1000 });
    const jobs = createForwardJobStore({ pool, connectionId: 'bot-a', now: () => 2000 });
    const other = createForwardJobStore({ pool, connectionId: 'bot-b', now: () => 2000 });
    const binding = { feishuOpenId: 'human', chatId: 'chat', chatType: 'p2p', codexSessionId: 'source-thread', threadName: 'kept-name' };
    await sessions.saveCodexBinding(binding, { messageId: 'older-message' });
    await sessions.saveCodexRealtimeEvent(binding, { messageId: 'older-message', eventKey: 'history', eventType: 'agent_message', text: 'kept history', createdAt: 1100 });
    const created = await jobs.upsert({ callerId: 'live', idempotencyKey: randomUUID(), conversationId: 'chat', messageId: 'message',
      sourceMessageId: 'message', bindingOpenId: 'human', chatType: 'p2p', senderOpenId: 'human', prompt: 'busy' });
    const result = { failed: true, busyFork: { sourceThreadId: 'source-thread', bindingOpenId: 'human', chatId: 'chat' },
      executionCard: { messageId: 'card-message', status: 'failed', entries: [], forkSourceThreadId: 'source-thread' } };
    await pool.execute("UPDATE assistant_codex_forward_jobs SET status='failed',last_error='CODEX_THREAD_BUSY',result_json=? WHERE connection_id='bot-a' AND public_run_id=?", [JSON.stringify(result), created.id]);
    const input = { id: created.id, sourceThreadId: 'source-thread', bindingOpenId: 'human', chatId: 'chat', messageId: 'message',
      cardMessageId: 'card-message', actor: 'human', operationId: randomUUID() };
    const begun = await jobs.beginFork(input);
    assert.equal(begun.outcome, 'new');
    assert.equal((await jobs.beginFork({ ...input, operationId: randomUUID() })).outcome, 'replay');
    assert.equal((await other.beginFork(input)).outcome, 'not_found');
    const finished = await jobs.finishFork({ id: created.id, operationId: begun.fork.operationId, status: 'succeeded', targetThreadId: 'target-thread' });
    assert.equal(finished.outcome, 'succeeded');
    const [[saved]] = await pool.query("SELECT codex_session_id,thread_name,created_at FROM assistant_codex_sessions WHERE connection_id='bot-a'");
    assert.deepEqual({ thread: saved.codex_session_id, name: saved.thread_name, created: Number(saved.created_at) }, { thread: 'target-thread', name: 'kept-name', created: 1000 });
    const [[history]] = await pool.query("SELECT codex_session_id,text FROM assistant_codex_events WHERE connection_id='bot-a'");
    assert.deepEqual({ thread: history.codex_session_id, text: history.text }, { thread: 'source-thread', text: 'kept history' });
    assert.equal((await jobs.finishFork({ id: created.id, operationId: begun.fork.operationId, status: 'succeeded', targetThreadId: 'different' })).outcome, 'replay');
  } finally { await pool.end(); }
});

test('unknown fork outcome is durable and never creates a second intent', { skip: !enabled, timeout: 40_000 }, async () => {
  const pool = createPoolFromEnvironment(refs);
  try {
    await migrate(pool);
    const sessions = createCodexSessionStore({ pool, connectionId: 'bot-a', schema: process.env.BRIDGE_TEST_DATABASE, now: () => 2500 });
    await sessions.saveCodexBinding({ feishuOpenId: 'unknown-human', chatId: 'unknown-chat', chatType: 'p2p', codexSessionId: 'unknown-source' });
    const jobs = createForwardJobStore({ pool, connectionId: 'bot-a', now: () => 3000 });
    const created = await jobs.upsert({ callerId: 'live', idempotencyKey: randomUUID(), conversationId: 'unknown-chat', messageId: 'unknown-message',
      sourceMessageId: 'unknown-message', bindingOpenId: 'unknown-human', chatType: 'p2p', senderOpenId: 'unknown-human', prompt: 'busy' });
    const result = { failed: true, busyFork: { sourceThreadId: 'unknown-source', bindingOpenId: 'unknown-human', chatId: 'unknown-chat' },
      executionCard: { messageId: 'unknown-card', status: 'failed', entries: [], forkSourceThreadId: 'unknown-source' } };
    await pool.execute("UPDATE assistant_codex_forward_jobs SET status='failed',last_error='CODEX_THREAD_BUSY',result_json=? WHERE connection_id='bot-a' AND public_run_id=?", [JSON.stringify(result), created.id]);
    const input = { id: created.id, sourceThreadId: 'unknown-source', bindingOpenId: 'unknown-human', chatId: 'unknown-chat', messageId: 'unknown-message',
      cardMessageId: 'unknown-card', actor: 'unknown-human', operationId: randomUUID() };
    const begun = await jobs.beginFork(input);
    await jobs.finishFork({ id: created.id, operationId: begun.fork.operationId, status: 'unknown', errorCode: 'CODEX_FORK_UNCONFIRMED', targetThreadId: 'orphan-target' });
    const replay = await jobs.beginFork({ ...input, operationId: randomUUID() });
    assert.equal(replay.outcome, 'replay');
    assert.equal(replay.fork.status, 'unknown');
    assert.equal(replay.fork.targetThreadId, 'orphan-target');
    const binding = await sessions.loadBinding({ feishuOpenId: 'unknown-human', chatId: 'unknown-chat', chatType: 'p2p' });
    assert.equal(binding.codexSessionId, 'unknown-source');
  } finally { await pool.end(); }
});
