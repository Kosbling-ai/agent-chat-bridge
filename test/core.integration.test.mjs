import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
import { createRuntime } from '../src/core/runtime.mjs';
import { createApi } from '../src/core/api.mjs';
import { startServer } from '../src/server.mjs';
import { createCatchup } from '../src/core/catchup.mjs';
import { listCatchupConversations } from '../src/core/conversations.mjs';

const enabled = Boolean(process.env.BRIDGE_TEST_PASSWORD);
const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));
async function eventually(read, predicate) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('condition_timeout');
}
test('real Store core: immediate completion, independent hook, API authorization and unknown recovery', { skip: !enabled, timeout: 30000 }, async () => {
  const pool = createPoolFromEnvironment(refs);
  await migrate(pool);
  let store = await createMysqlStore({ pool });
  const config = { listen: { host: '127.0.0.1', port: 0 }, feishu: { connectionId: 'fixture', botOpenId: 'bot' }, auth: { clients: [{ id: 'tester', conversationIds: ['chat', 'unknown', 'unsupported'], admin: true }] }, routing: { version: '1', privateUserIds: ['human'], groups: [] }, hooks: [{ id: 'hook', url: 'http://synthetic.invalid', conversationIds: ['chat'] }] };
  let runtime, server, mode = 'normal', turns = 0, threadStarts = 0, hooks = 0;
  let firstChunkGate, releaseChunk, failFirstChunk = false;
  const sent = [];
  const completed = new Map();
  const rejectReads = new Set(), readAttempts = new Map();
  const codex = {
    status: () => ({ state: 'ready' }),
    async startThread() { return { thread: { id: `thread-${++threadStarts}` } }; },
    async resumeThread({ threadId }) { return { thread: { id: threadId } }; },
    async startTurn({ threadId }) {
      turns++;
      if (mode === 'unknown') throw Object.assign(new Error('synthetic'), { outcome: 'unknown' });
      if (mode === 'rejected') throw Object.assign(new Error('synthetic admission rejected'), { outcome: 'rejected' });
      const turn = { id: `turn-${turns}`, status: mode === 'live' ? 'inProgress' : 'completed', items: [{ type: 'agentMessage', text: mode === 'multipart' ? 'A'.repeat(12000) + 'B'.repeat(12000) : 'Synthetic answer' }] };
      completed.set(threadId, turn);
      if (mode === 'live') return { turn: { id: turn.id, status: 'inProgress' } };
      if (mode === 'stream-fallback') {
        turn.items = [{ type: 'commandExecution', id: 'tool-only', status: 'completed' }];
        await runtime.notification({ method: 'item/agentMessage/delta', params: { threadId, turnId: turn.id, itemId: 'stream', delta: 'Partial streamed draft' } });
        await runtime.notification({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ output_text: 'Recovered streamed answer' }] } } });
        await runtime.notification({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'agentMessage', phase: 'commentary', text: 'must not replace final' } } });
        await runtime.notification({ method: 'item/completed', params: { threadId, turnId: turn.id, item: { type: 'message', role: 'user', content: ['USER_SECRET'] } } });
      }
      // The Store commits this notification before RPC admission is returned.
      if (mode === 'thin-terminal') rejectReads.add(threadId);
      await runtime.notification({ method: 'turn/completed', params: { threadId, turn: mode === 'thin-terminal' ? { id: turn.id, status: 'completed', items: [] } : turn } });
      return { turn: { id: turn.id, status: 'inProgress' } };
    },
    async readThread({ threadId }) {
      readAttempts.set(threadId, (readAttempts.get(threadId) ?? 0) + 1);
      if (rejectReads.has(threadId)) throw Object.assign(new Error('synthetic read rejected'), { code: 'codex_rpc_rejected', outcome: 'rejected' });
      return { thread: { turns: [completed.get(threadId)].filter(Boolean) } };
    },
  };
  const chat = { async sendMessage(input) { sent.push(input); if (input.content.body.elements[0].content.startsWith('AAA')) { if (failFirstChunk) throw Object.assign(new Error('synthetic rejection'), { outcome: 'failed' }); await firstChunkGate; } return { message_id: `sent-${sent.length}` }; }, async replyMessage(input) { sent.push(input); return { message_id: `sent-${sent.length}` }; }, async getMessage({ messageId }) { return { items: [{ message_id: messageId, chat_id: messageId === 'foreign' ? 'forbidden' : 'chat' }] }; } };
  const token = 'synthetic-bridge-token-for-tests-only';
  const event = { schemaVersion: 1, channel: 'feishu', connectionId: 'fixture', eventId: 'e1', eventKey: 'receive:e1', type: 'message.received', source: 'live', receivedAt: 1, occurredAt: 1, conversationId: 'chat', conversationType: 'p2p', messageId: 'm1', revision: '', actor: { type: 'user', openId: 'human' }, isApp: false, isSelf: false, message: { kind: 'text', parsedContent: { text: 'Synthetic question' }, content: '{"text":"Synthetic question"}', mentions: [] }, platform: { feishu: { eventType: 'receive' } } };
  try {
    runtime = createRuntime({ config, store, codex, chat, hookTokens: { hook: 'synthetic' }, fetchImpl: async () => { hooks++; return new Response(null, { status: 503 }); } });
    await assert.rejects(runtime.ingest({ ...event, source: 'history_catchup', eventKey: 'history-incomplete', actor: { type: 'user', userId: 'not-an-open-id' } }), { code: 'history_authorization_identity_missing' });
    const accepted = await runtime.ingest(event);
    assert(accepted.agentJobId, 'identity-incomplete history must not take canonical first receipt from live');
    assert.equal((await runtime.ingest({ ...event, receivedAt: 99 })).agentJobId, accepted.agentJobId);
    const caught = [];
    const catchup = createCatchup({ connectionId: 'fixture', botOpenId: 'bot', store,
      listConversations: () => listCatchupConversations({ config, store }), wait: async () => {},
      chat: { listMessages: async () => ({ items: [{ message_id: 'm1', chat_id: 'chat', create_time: String(Date.now()), msg_type: 'text', body: { content: '{"text":"Changed history observation"}' }, sender: { sender_type: 'user', id_type: 'open_id', id: 'human' } }], has_more: false }) },
      onEvent: async event => { caught.push(await runtime.ingest(event)); },
    });
    await catchup.runOnce();
    await catchup.stop();
    assert.equal(caught.length, 1);
    assert.equal(caught[0].agentJobId, accepted.agentJobId);
    assert.equal(caught[0].duplicateCanonical, true, 'history changes cannot fabricate a second Agent or edit hook');
    assert.deepEqual(caught[0].hookJobIds, accepted.hookJobIds);
    runtime.start();
    await eventually(() => store.getJob({ id: accepted.agentJobId }), row => row.status === 'succeeded');
    assert.equal(turns, 1); assert.equal(sent.length, 1);
    assert.equal((await store.getJob({ id: accepted.hookJobIds[0] })).status, 'pending');
    assert(hooks >= 1);
    assert.equal((await store.readRunEvents({ runId: accepted.agentJobId })).length, 1);
    const api = createApi({ config, store, chat, tokens: { tester: token } });
    server = await startServer({ config, api, log() {}, readiness: async () => ({ ready: true }) });
    const url = `http://127.0.0.1:${server.server.address().port}`;
    assert.equal((await fetch(`${url}/v1/runs/${accepted.agentJobId}`)).status, 401);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    assert.equal((await fetch(`${url}/v1/runs/${accepted.agentJobId}`, { headers })).status, 200);
    assert.equal((await fetch(`${url}/v1/messages/foreign`, { headers })).status, 404);
    assert.equal((await fetch(`${url}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ conversationId: 'forbidden', idempotencyKey: 'x', text: 'synthetic' }) })).status, 403);
    assert.equal((await fetch(`${url}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ conversationId: 'chat', idempotencyKey: 'x', text: 'synthetic', cwd: '/tmp' }) })).status, 400);
    assert.equal((await fetch(`${url}/v1/messages/%ZZ`, { headers })).status, 404);
    assert.equal((await fetch(`${url}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ conversationId: 'chat', idempotencyKey: 'x'.repeat(255), text: 'synthetic' }) })).status, 400);
    assert.equal((await fetch(`${url}/v1/deliveries`, { method: 'POST', headers, body: JSON.stringify({ conversationId: 'chat', idempotencyKey: 'reaction', kind: 'reaction', messageId: 'owned', emojiType: 'x'.repeat(513) }) })).status, 400);
    mode = 'unknown';
    const result = await (await fetch(`${url}/v1/runs`, { method: 'POST', headers, body: JSON.stringify({ conversationId: 'unknown', idempotencyKey: 'unknown', text: 'synthetic' }) })).json();
    await eventually(() => store.getJob({ id: result.id }), row => row.status === 'unknown');
    assert.equal((await fetch(`${url}/v1/sessions/reset`, { method: 'POST', headers, body: JSON.stringify({ conversationId: 'unknown', generation: 1 }) })).status, 409);
    const before = turns;
    await runtime.stop();
    const recovery = await store.enqueueJob({ kind: 'agent', connectionId: 'fixture', conversationId: 'recovered', idempotencyKey: 'recovered', payload: { text: 'already admitted' } });
    const [claim] = await store.claimJobs({ kind: 'agent', owner: 'crashed-worker', limit: 1, leaseMs: 100 });
    const attempt = await store.beginAgentAttempt({ id: claim.id, leaseToken: claim.leaseToken, agentId: 'codex' });
    completed.set('recovery-thread', { id: 'recovery-turn', status: 'completed', items: [{ type: 'commandExecution', id: 'tool-only', status: 'completed' }] });
    await store.bufferNativeEvent({ connectionId: 'fixture', eventKey: 'recovery-delta', nativeThreadId: 'recovery-thread', nativeTurnId: 'recovery-turn', payload: { method: 'item/agentMessage/delta', params: { threadId: 'recovery-thread', turnId: 'recovery-turn', itemId: 'recovery-message', delta: 'Partial recovery draft' } } });
    await store.bufferNativeEvent({ connectionId: 'fixture', eventKey: 'recovery-message-final', nativeThreadId: 'recovery-thread', nativeTurnId: 'recovery-turn', payload: { method: 'item/completed', params: { threadId: 'recovery-thread', turnId: 'recovery-turn', item: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ output_text: 'Recovered answer' }] } } } });
    await store.bufferNativeEvent({ connectionId: 'fixture', eventKey: 'recovery-message-user', nativeThreadId: 'recovery-thread', nativeTurnId: 'recovery-turn', payload: { method: 'item/completed', params: { threadId: 'recovery-thread', turnId: 'recovery-turn', item: { type: 'message', role: 'user', content: ['USER_SECRET'] } } } });
    await store.bindAgentAttempt({ id: claim.id, leaseToken: claim.leaseToken, expectedGeneration: attempt.generation, nativeThreadId: 'recovery-thread', nativeTurnId: 'recovery-turn' });
    await new Promise(resolve => setTimeout(resolve, 150));
    runtime = createRuntime({ config, store, codex, chat, hookTokens: { hook: 'synthetic' }, fetchImpl: async () => new Response(null, { status: 204 }) });
    runtime.start();
    await eventually(() => store.getJob({ id: recovery.id }), row => row.status === 'succeeded');
    assert(sent.some(effect => effect.content.body.elements[0].content === 'Recovered answer'), 'restarted completed turn uses persisted stream fallback');
    assert.equal(turns, before, 'unknown admission must not replay on worker restart');
    mode = 'normal';
    const unsupported = await runtime.ingest({ ...event, eventId: 'e2', eventKey: 'receive:e2', conversationId: 'unsupported', messageId: 'm2', message: { kind: 'image', parsedContent: { image_key: 'synthetic' }, mentions: [] } });
    await eventually(() => store.getJob({ id: unsupported.agentJobId }), row => row.status === 'succeeded');
    assert.equal(turns, before); assert.match(sent.at(-1).content.body.elements[0].content, /暂不支持.*尚未交给 Agent/);
    mode = 'live';
    const live = await store.enqueueJob({ kind: 'agent', connectionId: 'fixture', conversationId: 'live', idempotencyKey: 'live', payload: { text: 'synthetic' } });
    await eventually(async () => { const [[row]] = await pool.execute('SELECT native_turn_id FROM bridge_attempts WHERE job_id=?', [live.id]); return row; }, row => row?.native_turn_id);
    const beforeStop = turns;
    await runtime.stop();
    assert.equal((await store.getJob({ id: live.id })).status, 'pending');
    const binding = await store.getSession({ connectionId: 'fixture', conversationId: 'live', agentId: 'codex' });
    completed.get(binding.nativeThreadId).status = 'completed';
    rejectReads.add(binding.nativeThreadId);
    runtime = createRuntime({ config, store, codex, chat, hookTokens: { hook: 'synthetic' }, fetchImpl: async () => new Response(null, { status: 204 }) });
    runtime.start();
    await eventually(async () => readAttempts.get(binding.nativeThreadId), value => value > 0);
    await eventually(() => store.getJob({ id: live.id }), row => row.status === 'pending');
    assert.equal((await store.getSession({ connectionId: 'fixture', conversationId: 'live', agentId: 'codex' })).activeRunId, live.id);
    assert.equal(turns, beforeStop, 'a rejected recovery read must not repeat admission');
    rejectReads.delete(binding.nativeThreadId);
    await eventually(() => store.getJob({ id: live.id }), row => row.status === 'succeeded');
    assert.equal(turns, beforeStop, 'graceful restart must recover known turn without replay');
    mode = 'multipart';
    firstChunkGate = new Promise(resolve => { releaseChunk = resolve; });
    const count = sent.length;
    const multipart = await store.enqueueJob({ kind: 'agent', connectionId: 'fixture', conversationId: 'multipart', idempotencyKey: 'multipart', payload: { text: 'synthetic' } });
    await eventually(async () => sent.length, value => value === count + 1);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(sent.length, count + 1, 'second chunk cannot start before first platform confirmation');
    releaseChunk();
    await eventually(() => store.getJob({ id: multipart.id }), row => row.status === 'succeeded');
    assert(sent[count].content.body.elements[0].content.startsWith('AAA')); assert(sent[count + 1].content.body.elements[0].content.startsWith('BBB'));
    failFirstChunk = true;
    const failed = await store.enqueueJob({ kind: 'agent', connectionId: 'fixture', conversationId: 'delivery-failed', idempotencyKey: 'delivery-failed', payload: { text: 'synthetic' } });
    await eventually(() => store.getJob({ id: failed.id }), row => row.status === 'delivery_failed');
    const sentAfterFailure = sent.length, turnsAfterFailure = turns;
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(sent.length, sentAfterFailure, 'failed predecessor keeps later chunks blocked');
    assert.equal(turns, turnsAfterFailure, 'delivery failure cannot rerun completed model work');
    mode = 'thin-terminal';
    const thin = await store.enqueueJob({ kind: 'agent', connectionId: 'fixture', conversationId: 'thin-terminal', idempotencyKey: 'thin-terminal', payload: { text: 'synthetic' } });
    await eventually(() => store.getJob({ id: thin.id }), row => row.status === 'pending' && row.errorCode === 'agent_recovery_pending');
    const thinBinding = await store.getSession({ connectionId: 'fixture', conversationId: 'thin-terminal', agentId: 'codex' });
    assert.equal(thinBinding.activeRunId, thin.id);
    assert(readAttempts.get(thinBinding.nativeThreadId) > 0);
    const admittedTurns = turns;
    rejectReads.delete(thinBinding.nativeThreadId);
    await eventually(() => store.getJob({ id: thin.id }), row => row.status === 'succeeded');
    assert.equal(turns, admittedTurns, 'terminal supplement read rejection must retain successful model execution');
    mode = 'rejected';
    const denied = await store.enqueueJob({ kind: 'agent', connectionId: 'fixture', conversationId: 'denied', idempotencyKey: 'denied', payload: { text: 'synthetic' } });
    await eventually(() => store.getJob({ id: denied.id }), row => row.status === 'failed');
    assert.equal((await store.getSession({ connectionId: 'fixture', conversationId: 'denied', agentId: 'codex' })).activeRunId, null);
    mode = 'stream-fallback';
    const streamed = await store.enqueueJob({ kind: 'agent', connectionId: 'fixture', conversationId: 'streamed', idempotencyKey: 'streamed', payload: { text: 'synthetic' } });
    await eventually(() => store.getJob({ id: streamed.id }), row => row.status === 'succeeded');
    assert.equal(sent.at(-1).content.body.elements[0].content, 'Recovered streamed answer');
  } finally { releaseChunk?.(); await server?.close(); await runtime?.stop(); await store.close(); }
});
