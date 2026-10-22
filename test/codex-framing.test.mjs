import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAppServerClient } from '../src/agents/codex/app-server-client.mjs';
import { createExecutorLogAdapter } from '../src/service.mjs';
import { createLogger } from '../src/logger.mjs';

function client(options = {}) {
  return new CodexAppServerClient({ config: { bin: 'unused', cwd: '/unused', sharedHome: '/unused', idleCloseMs: 0 },
    spawnSyncImpl: () => ({ status: 1 }), ...options });
}

test('fragmented image-sized RPC response is scanned linearly and delivered exactly once', () => {
  const c = client(); const child = {}; c.child = child;
  const responses = []; c.handleResponse = message => responses.push(message);
  const wire = JSON.stringify({ id: 7, result: { text: '中文图片', image: 'x'.repeat(2 * 1024 * 1024) } }) + '\n';
  const indexOf = String.prototype.indexOf; let scanned = 0;
  try {
    String.prototype.indexOf = function (search, from = 0) {
      if (search === '\n') scanned += Math.max(0, this.length - from);
      return indexOf.call(this, search, from);
    };
    for (let i = 0; i < wire.length; i += 4096) c.handleStdout(wire.slice(i, i + 4096), child);
  } finally { String.prototype.indexOf = indexOf; }
  assert.ok(scanned <= wire.length * 2, `rescanned ${scanned} characters for ${wire.length} characters`);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].result.text, '中文图片');
  assert.equal(responses[0].result.image.length, 2 * 1024 * 1024);
  assert.deepEqual(c.stdoutChunks, []);
});

test('mixed partial frames, blank lines, invalid JSON and notifications keep wire order', async () => {
  const events = []; const logs = [];
  const c = client({ eventSink: event => events.push(event), log: (_, event) => logs.push(event) });
  const child = {}; c.child = child; c.childGenerations.set(child, 1);
  const responses = []; const requests = [];
  c.handleResponse = message => responses.push(message);
  c.handleServerRequest = message => requests.push(message);
  c.handleStdout('  \n{"id":1,"result":"', child);
  c.handleStdout('中文"}\r\ninvalid\n{"id":2,"method":"question"}\n{"method":"done","params":{}}\n{"id":', child);
  c.handleStdout('3,"result":true}\n', child);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(responses, [{ id: 1, result: '中文' }, { id: 3, result: true }]);
  assert.deepEqual(requests, [{ id: 2, method: 'question' }]);
  assert.deepEqual(events.map(event => event.method), ['done']);
  assert.equal(logs.filter(event => event.operation === 'rpc_frame' && event.status === 'invalid').length, 1);
  assert.equal(c.lifecycle.active, 0);
});

test('disconnect discards a partial frame and late data cannot contaminate the next child', () => {
  const c = client(); const oldChild = {}; c.child = oldChild;
  c.handleStdout('{"id":1,"result":"private partial', oldChild);
  c.handleExit(new Error('disconnected'), oldChild);
  assert.deepEqual(c.stdoutChunks, []);
  const child = {}; c.child = child; const responses = []; c.handleResponse = m => responses.push(m);
  c.handleStdout('late old data\n', oldChild);
  c.handleStdout('{"id":2,"result":true}\n', child);
  assert.deepEqual(responses, [{ id: 2, result: true }]);
});

test('RPC timeout identifies the method without logging request data', async () => {
  const events = []; const c = client({ log: (_, event) => events.push(event) });
  c.child = { stdin: { writable: true, write() {} } }; c.close = () => Promise.resolve();
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(c.request('thread/resume', { secret: 'must-not-appear' }, { skipStart: true, timeoutMs: 10 }), { code: 'CODEX_RPC_TIMEOUT', outcome: 'unknown' });
    const event = events.find(event => event.operation === 'rpc_request');
    assert.equal(event.rpc_method, 'thread/resume'); assert.equal(event.durationMs, 10);
    assert.equal(JSON.stringify(events).includes('must-not-appear'), false);
  } finally { clearTimeout(keepAlive); }
});

test('memory guard diagnostics retain only bounded numbers and a fixed code', () => {
  const events = []; const log = createExecutorLogAdapter(createLogger({ write: value => events.push(JSON.parse(value)) }));
  log('warning', { operation: 'memory_guard', status: 'restart_pending', error_code: 'CODEX_MEMORY_LIMIT',
    rssBytes: 20, heapUsedBytes: 5, rssLimitBytes: 10, heapLimitBytes: 10, payload: 'private' });
  assert.equal(events[0].code, 'CODEX_MEMORY_LIMIT');
  assert.deepEqual([events[0].rss_bytes, events[0].heap_used_bytes, events[0].rss_limit_bytes, events[0].heap_limit_bytes], [20, 5, 10, 10]);
  assert.equal(JSON.stringify(events).includes('private'), false);
});
