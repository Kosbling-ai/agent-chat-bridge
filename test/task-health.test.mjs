import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from '../src/logger.mjs';
import { startServer } from '../src/server.mjs';

async function fixture(t, jobs) {
  const lines = [];
  const log = createLogger({ write(line) { lines.push(JSON.parse(line)); } });
  const server = await startServer({
    config: { listen: { host: '127.0.0.1', port: 0 }, hooks: [] }, log, jobs,
  });
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.server.address().port}`, lines };
}

test('task health summary validates window and keeps successful polling quiet', async t => {
  const received = [];
  const { url, lines } = await fixture(t, {
    async taskHealthSummary(input) {
      received.push(input);
      return { window_minutes: input.windowMinutes, checked_at: input.checkedAt,
        failed: { total: 0, truncated: false, latest_finished_at: null,
          by_code: [], by_mode: { bridge: 0, caller: 0 } }, interrupted: { total: 0 } };
    },
  });
  for (const value of ['0', '4', '1441', '1.5', '-5', 'abc', '05', '']) {
    const response = await fetch(`${url}/health/tasks?window_minutes=${encodeURIComponent(value)}`);
    assert.equal(response.status, 400, value);
    assert.deepEqual(await response.json(), { error: 'invalid_window_minutes' });
  }
  assert.equal((await fetch(`${url}/health/tasks?window_minutes=5&window_minutes=6`)).status, 400);
  assert.equal((await fetch(`${url}/health/tasks?unknown=1`)).status, 400);
  const response = await fetch(`${url}/health/tasks`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).window_minutes, 120);
  assert.equal(received.length, 1);
  assert.equal(received[0].windowMinutes, 120);
  assert.equal(lines.filter(line => line.operation === 'http_task_health' && line.level === 'info').length, 0);
});

test('task health summary returns fixed 503 when storage is unreadable', async t => {
  const { url, lines } = await fixture(t, {
    async taskHealthSummary() { throw new Error('private database text'); },
  });
  const response = await fetch(`${url}/health/tasks?window_minutes=30`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'task_health_unavailable' });
  const entry = lines.find(line => line.operation === 'http_task_health');
  assert.equal(entry.level, 'error');
  assert.equal(entry.status_code, 503);
  assert.equal(JSON.stringify(lines).includes('private database text'), false);
});
