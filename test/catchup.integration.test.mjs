import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
import { createCatchup } from '../src/core/catchup.mjs';
import { feishuEventIdentity } from '../src/channels/feishu/normalize.mjs';

const enabled = Boolean(process.env.BRIDGE_TEST_PASSWORD);
const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));
test('real Store catchup resumes fixed pagination window and replays a committed page without duplicate jobs', { skip: !enabled, timeout: 30000 }, async () => {
  let pool = createPoolFromEnvironment(refs);
  await migrate(pool);
  let store = await createMysqlStore({connectionId:'catchup-fixture', pool });
  let worker, fail = true;
  const clock = 1789250000000, calls = [], ids = new Set();
  const item = id => ({ message_id: id, chat_id: 'chat', msg_type: 'text', create_time: String(clock - 1000),
    body: { content: JSON.stringify({ text: id }) }, sender: { sender_type: 'user', id_type: 'open_id', id: 'human' } });
  const chat = { async listMessages(request) { calls.push(request); return request.pageToken
    ? { items: [item('second')], has_more: false }
    : { items: [item('first')], has_more: true, page_token: 'page2' }; } };
  const make = () => createCatchup({ connectionId: 'catchup-fixture', chat, store,
    listConversations: async () => [{ conversationId: 'chat', conversationType: 'p2p' }],
    now: () => clock, wait: async () => {}, maxPagesPerConversation: 1,
    onEvent: async event => {
      const result = await store.acceptInbound({ connectionId: event.connectionId, conversationId: event.conversationId,
        eventKey: event.eventKey, eventType: event.type, messageId: event.messageId, revision: event.revision,
        payload: event, semanticPayload: feishuEventIdentity(event), policyVersion: 'test',
        agentJob: { payload: { text: event.message.parsedContent.text } } });
      ids.add(result.agentJobId);
      if (fail) throw new Error('synthetic commit response lost');
    } });
  try {
    worker = make(); assert.equal((await worker.runOnce()).failed, 1); await worker.stop();
    await store.close(); pool = createPoolFromEnvironment(refs); store = await createMysqlStore({connectionId:'catchup-fixture', pool });
    fail = false; worker = make(); assert.equal((await worker.runOnce()).incomplete, 1); await worker.stop();
    assert.equal(ids.size, 1);
    await store.close(); pool = createPoolFromEnvironment(refs); store = await createMysqlStore({connectionId:'catchup-fixture', pool });
    worker = make(); assert.equal((await worker.runOnce()).failed, 0); await worker.stop();
    assert.equal(ids.size, 2); assert.equal(calls[2].pageToken, 'page2');
    assert.equal(calls[0].startTime, calls[2].startTime); assert.equal(calls[0].endTime, calls[2].endTime);
    const jobs = await store.claimJobs({ kind: 'agent', owner: 'review', leaseMs: 1000, limit: 10 });
    assert.equal(jobs.length, 2);
  } finally { await worker?.stop(); await store.close(); }
});
