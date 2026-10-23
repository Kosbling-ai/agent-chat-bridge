import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from '../src/server.mjs';

test('conversation prompts require independent bearer and configured chat; exact retries dedupe and changed content conflicts', async t => {
  const rows = new Map(); const seen = [];
  const server = await startServer({ config: { listen: { host: '127.0.0.1', port: 0 }, hooks: [], conversationInput: { tokenEnv: 'TOKEN', chatIds: ['first'] } }, conversationInputToken: 'secret',
    eventRuntime: { async registerConversationPrompt(input) {
      seen.push(input); const prior = rows.get(input.requestId);
      if (prior && prior !== input.requestHash) throw Object.assign(new Error('conflict'), { code: 'job_conflict' });
      rows.set(input.requestId, input.requestHash); return { jobId: 'job', bindingOpenId: 'group:identity', deduplicated: Boolean(prior) };
    } } });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.server.address().port}/v1/conversations/prompts`;
  const body = { request_id: 'tick-1', chat_id: 'first', prompt: 'inspect' };
  const post = (value = body, token = 'secret') => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(value) });
  assert.equal((await post(body, 'wrong')).status, 401);
  assert.equal((await post({ ...body, chat_id: 'other' })).status, 403);
  assert.equal((await post({ ...body, actor: 'pretend-human' })).status, 400);
  const first = await post(); assert.equal(first.status, 202); assert.equal((await first.json()).deduplicated, false);
  assert.equal((await (await post()).json()).deduplicated, true);
  assert.equal((await post({ ...body, prompt: 'different' })).status, 409);
  assert.equal(seen.length, 3);
});
