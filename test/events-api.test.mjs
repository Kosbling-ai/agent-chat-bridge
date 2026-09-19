import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from '../src/logger.mjs';
import { canonicalJsonHash, startServer, EVENTS_BODY_MAX_BYTES } from '../src/server.mjs';

const token = 'synthetic-event-token';
const hook = {
  id: 'custom-order',
  inbound: { tokenEnv: 'TEST_EVENT_TOKEN', scopePrefixes: ['custom-order:customer:'], defaultChatId: 'synthetic-chat' },
};
const event = {
  event_id: 'mail:one', producer_id: 'custom-order', scope: 'custom-order:customer:one', type: 'mail.inbound',
  correlation_id: 'inquiry-one', occurred_at: '2026-09-20T00:00:00Z',
  ref_ids: { message_id: 'mail-one', inquiry_id: 'inquiry-one' }, prompt: 'Read the referenced mail.',
};

async function fixture(t, { registerEvent, reportError } = {}) {
  const rows = new Map();
  const registrations = [];
  const logs = [];
  const runtime = {
    async registerEvent(input) {
      registrations.push(structuredClone(input));
      if (registerEvent) return registerEvent(input);
      const key = `${input.producerId}\0${input.eventId}`;
      const existing = rows.get(key);
      if (existing && existing.hash !== input.requestHash) throw Object.assign(new Error('conflict'), { code: 'job_conflict' });
      if (existing) return { ...existing.result, deduplicated: true };
      const result = { jobId: `00000000-0000-4000-8000-${String(rows.size + 1).padStart(12, '0')}`, bindingOpenId: 'system:synthetic', deduplicated: false };
      rows.set(key, { hash: input.requestHash, result, status: 'pending', updatedAt: 1234, type: input.type, scope: input.scope });
      return result;
    },
    async getEvent({ producerId, eventId }) {
      const row = rows.get(`${producerId}\0${eventId}`);
      return row ? {
        jobId: row.result.jobId, status: row.status, updatedAt: row.updatedAt, type: row.type, scope: row.scope,
      } : null;
    },
  };
  const log = createLogger({ write(value) { logs.push(JSON.parse(value)); } }, { reportError });
  const server = await startServer({
    config: { listen: { host: '127.0.0.1', port: 0 }, hooks: [hook] }, log, eventRuntime: runtime,
    inboundTokens: { 'custom-order': token },
  });
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.server.address().port}`, registrations, logs };
}

const post = (url, body, bearer = token) => fetch(`${url}/v1/events`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('events api rejects missing bearer', async t => {
  const { url } = await fixture(t);
  assert.equal((await post(url, event, '')).status, 401);
  assert.equal((await post(url, event, 'wrong-token')).status, 401);
});

test('events api rejects scope outside prefixes', async t => {
  const { url } = await fixture(t);
  assert.equal((await post(url, { ...event, scope: 'other:customer:one' })).status, 403);
  assert.equal((await post(url, { ...event, producer_id: 'other' })).status, 403);
});

test('events api dedups same event_id', async t => {
  const { url, registrations, logs } = await fixture(t);
  const first = await post(url, event);
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), {
    job_id: '00000000-0000-4000-8000-000000000001', binding_open_id: 'system:synthetic', deduplicated: false,
  });
  const duplicate = await post(url, { ...event, ref_ids: { inquiry_id: 'inquiry-one', message_id: 'mail-one' } });
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json()).deduplicated, true);
  assert.equal(registrations[0].requestHash, registrations[1].requestHash);
  assert.equal((await post(url, { ...event, prompt: 'Different prompt.' })).status, 409);
  const status = await fetch(`${url}/v1/events/mail%3Aone`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { job_id: '00000000-0000-4000-8000-000000000001', status: 'pending', updated_at: 1234 });
  const statusLog = logs.at(-1);
  assert.equal(statusLog.operation, 'events_api');
  assert.equal(statusLog.type, 'mail.inbound');
  assert.equal(statusLog.scope_prefix, 'custom-order:customer:');
  assert.equal(statusLog.status_code, 200);
});

test('events api validates bodies, limits payloads, and returns missing status', async t => {
  const { url, registrations } = await fixture(t);
  assert.equal((await post(url, '{')).status, 400);
  assert.equal((await post(url, { ...event, type: 'unknown' })).status, 400);
  const unknown = await post(url, { ...event, target_chat_id: 'not-accepted' });
  assert.equal(unknown.status, 400);
  assert.deepEqual(await unknown.json(), { error: 'unknown_field' });
  assert.equal((await post(url, { ...event, correlation_id: 'inquiry\ninjected' })).status, 400);
  assert.equal((await post(url, { ...event, ref_ids: { 'bad:key': 'value' } })).status, 400);
  assert.equal((await post(url, { ...event, ref_ids: { valid: 'line\nbreak' } })).status, 400);
  assert.equal((await post(url, { ...event, ref_ids: { valid: 'x'.repeat(257) } })).status, 400);
  assert.equal((await post(url, { ...event, prompt: 'x'.repeat(8001) })).status, 413);
  assert.equal((await post(url, 'x'.repeat(EVENTS_BODY_MAX_BYTES + 1))).status, 413);
  assert.equal((await fetch(`${url}/v1/events/missing`, { headers: { authorization: `Bearer ${token}` } })).status, 404);
  assert.equal(registrations.length, 0, 'invalid fields never reach forward registration');
});

test('events api canonical hash uses code-unit key order without unicode normalization', () => {
  const composed = { z: 'last', 'é': 'value' };
  const decomposed = { 'é': 'value', z: 'last' };
  const combined = { z: 'last', 'é': 'composed', 'é': 'decomposed' };
  assert.equal(canonicalJsonHash(composed), canonicalJsonHash({ 'é': 'value', z: 'last' }));
  assert.equal(canonicalJsonHash(decomposed), canonicalJsonHash({ z: 'last', 'é': 'value' }));
  assert.equal(canonicalJsonHash(combined), canonicalJsonHash({ 'é': 'decomposed', z: 'last', 'é': 'composed' }));
  assert.notEqual(canonicalJsonHash(composed), canonicalJsonHash(decomposed));
});

test('events api writes one terminal structured log', async t => {
  const success = await fixture(t);
  assert.equal((await post(success.url, event)).status, 202);
  const successLogs = success.logs.filter(entry => entry.operation === 'events_api');
  assert.equal(successLogs.length, 1);
  assert.deepEqual(successLogs[0], {
    timestamp: successLogs[0].timestamp, level: 'info', module: 'bridge', component: 'service', operation: 'events_api', status: 'completed',
    hook_id: 'custom-order', event_id: 'mail:one', type: 'mail.inbound', scope_prefix: 'custom-order:customer:', status_code: 202,
    job_id: '00000000-0000-4000-8000-000000000001', error_class: 'none',
  });
  let reports = 0;
  const failed = await fixture(t, {
    registerEvent: async () => { throw Object.assign(new Error('private failure'), { code: 'synthetic_internal' }); },
    reportError() { reports += 1; },
  });
  assert.equal((await post(failed.url, event)).status, 503);
  const failedLogs = failed.logs.filter(entry => entry.operation === 'events_api');
  assert.equal(failedLogs.length, 1);
  assert.equal(failed.logs.filter(entry => entry.level === 'error').length, 1);
  assert.equal(reports, 1);
  assert.equal(failedLogs[0].level, 'error');
  assert.equal(failedLogs[0].status_code, 503);
  assert.equal(failedLogs[0].error_class, 'service_unavailable');
});

test('readiness failure keeps existing error log and reporter path', async t => {
  const logs = [];
  let reports = 0;
  const log = createLogger({ write(value) { logs.push(JSON.parse(value)); } }, {
    reportError() { reports += 1; },
  });
  const server = await startServer({
    config: { listen: { host: '127.0.0.1', port: 0 }, hooks: [] },
    log,
    readiness: async () => { throw new Error('synthetic readiness failure'); },
  });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.server.address().port}`;
  assert.equal((await fetch(`${url}/health/ready`)).status, 503);
  const errors = logs.filter(entry => entry.level === 'error');
  assert.equal(errors.length, 1);
  assert.equal(reports, 1);
  assert.equal(errors[0].operation, 'http_health');
  assert.equal(errors[0].status, 'failed');
  assert.equal(errors[0].code, 'service_unavailable');
});
