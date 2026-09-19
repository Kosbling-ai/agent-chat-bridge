import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer, EVENTS_BODY_MAX_BYTES } from '../src/server.mjs';

const token = 'synthetic-event-token';
const hook = {
  id: 'custom-order',
  inbound: { tokenEnv: 'TEST_EVENT_TOKEN', scopePrefixes: ['custom-order:customer:'], defaultChatId: 'synthetic-chat' },
};
const event = {
  event_id: 'mail:one', producer_id: 'custom-order', scope: 'custom-order:customer:one', type: 'mail.inbound',
  correlation_id: 'inquiry-one', occurred_at: '2026-09-20T00:00:00Z', ref_ids: { message_id: 'mail-one' }, prompt: 'Read the referenced mail.',
};

async function fixture(t) {
  const rows = new Map();
  const runtime = {
    async registerEvent(input) {
      const key = `${input.producerId}:${input.eventId}`;
      const existing = rows.get(key);
      if (existing && existing.hash !== input.requestHash) throw Object.assign(new Error('conflict'), { code: 'job_conflict' });
      if (existing) return { ...existing.result, deduplicated: true };
      const result = { jobId: '00000000-0000-4000-8000-000000000001', bindingOpenId: 'system:synthetic', deduplicated: false };
      rows.set(key, { hash: input.requestHash, result, status: 'pending', updatedAt: 1234 });
      return result;
    },
    async getEvent({ producerId, eventId }) {
      const row = rows.get(`${producerId}:${eventId}`);
      return row ? { jobId: row.result.jobId, status: row.status, updatedAt: row.updatedAt } : null;
    },
  };
  const server = await startServer({
    config: { listen: { host: '127.0.0.1', port: 0 }, hooks: [hook] }, log() {}, eventRuntime: runtime,
    inboundTokens: { 'custom-order': token },
  });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.server.address().port}`;
}

const post = (url, body, bearer = token) => fetch(`${url}/v1/events`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('events api rejects missing bearer', async t => {
  const url = await fixture(t);
  assert.equal((await post(url, event, '')).status, 401);
  assert.equal((await post(url, event, 'wrong-token')).status, 401);
});

test('events api rejects scope outside prefixes', async t => {
  const url = await fixture(t);
  assert.equal((await post(url, { ...event, scope: 'other:customer:one' })).status, 403);
  assert.equal((await post(url, { ...event, producer_id: 'other' })).status, 403);
});

test('events api dedups same event_id', async t => {
  const url = await fixture(t);
  const first = await post(url, event);
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), {
    job_id: '00000000-0000-4000-8000-000000000001', binding_open_id: 'system:synthetic', deduplicated: false,
  });
  const duplicate = await post(url, { ...event, ref_ids: { message_id: 'mail-one' } });
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json()).deduplicated, true);
  assert.equal((await post(url, { ...event, prompt: 'Different prompt.' })).status, 409);
  const status = await fetch(`${url}/v1/events/mail%3Aone`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { job_id: '00000000-0000-4000-8000-000000000001', status: 'pending', updated_at: 1234 });
});

test('events api validates bodies, limits payloads, and returns missing status', async t => {
  const url = await fixture(t);
  assert.equal((await post(url, '{')).status, 400);
  assert.equal((await post(url, { ...event, type: 'unknown' })).status, 400);
  assert.equal((await post(url, { ...event, prompt: 'x'.repeat(8001) })).status, 413);
  assert.equal((await post(url, 'x'.repeat(EVENTS_BODY_MAX_BYTES + 1))).status, 413);
  assert.equal((await fetch(`${url}/v1/events/missing`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
});
