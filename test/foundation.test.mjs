import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../bin/agent-chat-bridge.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const base = { schemaVersion: 1, listen: { host: '127.0.0.1', port: 0 } };
const sentinel = 'synthetic-test-value-never-print-0123456789';

async function fixture(t, content = base) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-foundation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, typeof content === 'string' ? content : JSON.stringify(content));
  return { dir, path };
}

function run(t, args, { cwd = root, env = {} } = {}) {
  // Deliberately do not inherit the host environment or any real credentials.
  const child = spawn(process.execPath, [cli, ...args], {
    cwd, env: { ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const lines = [];
  let buffer = '';
  const waiters = [];
  child.stdout.on('data', (data) => {
    const text = String(data);
    stdout += text;
    buffer += text;
    while (buffer.includes('\n')) {
      const index = buffer.indexOf('\n');
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      try {
        const parsed = JSON.parse(line);
        lines.push(parsed);
        for (const waiter of [...waiters]) {
          if (waiter.predicate(parsed)) waiter.resolve(parsed);
        }
      } catch { /* --help is plain text. */ }
    }
  });
  child.stderr.on('data', (data) => { stderr += String(data); });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, lines }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await finished;
  });
  return {
    child, finished,
    waitFor(predicate) {
      const found = lines.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('child lifecycle timeout')), 5000);
        const waiter = { predicate, resolve(value) { clearTimeout(timer); resolve(value); } };
        waiters.push(waiter);
        finished.then(() => { clearTimeout(timer); reject(new Error('child exited before lifecycle event')); });
      });
    },
  };
}

test('help and strict arguments require an explicit configuration', async (t) => {
  const help = await run(t, ['--help']).finished;
  assert.equal(help.code, 0);
  assert.match(help.stdout, /foundation only/);
  const { dir } = await fixture(t);
  for (const args of [[], ['start'], ['start', '--config'], ['unknown'], ['--help', '--extra'], ['start', '--config', 'x', '--extra']]) {
    const result = await run(t, args, { cwd: dir }).finished;
    assert.equal(result.code, 1);
    assert.match(result.stdout, /invalid_arguments/);
  }
});

test('check-config validates shape without resolving or printing secrets', async (t) => {
  const { path } = await fixture(t, { ...base, auth: { tokenEnv: 'BRIDGE_TEST_TOKEN' } });
  for (const env of [{}, { BRIDGE_TEST_TOKEN: sentinel }]) {
    const result = await run(t, ['check-config', '--config', path], { env }).finished;
    assert.equal(result.code, 0);
    assert.equal(result.lines[0].status, 'succeeded');
    assert.equal(result.stdout.includes(sentinel), false);
    assert.equal(result.stdout.includes(path), false);
    assert.equal(result.stdout.includes('BRIDGE_TEST_TOKEN'), false);
    assert.equal(result.stderr, '');
  }
});

test('reject inline secrets, unknown fields, invalid types and malformed JSON without leaking input', async (t) => {
  for (const config of [
    { ...base, auth: { token: sentinel } },
    { ...base, feishu: { appSecret: sentinel } },
    { ...base, storage: { password: sentinel } },
    { ...base, [sentinel]: true },
    { ...base, auth: { tokenEnv: `bad-${sentinel}` } },
    { ...base, listen: { port: '18830' } },
    { ...base, listen: { port: 65536 } },
    { ...base, listen: { host: 'localhost' } },
    { ...base, listen: { allowRemote: 'true' } },
    { schemaVersion: 2 },
    { schemaVersion: 1, listen: [] },
    { schemaVersion: 1, listen: null },
    `{"schemaVersion":1,"token":"${sentinel}",broken`,
  ]) {
    const { path } = await fixture(t, config);
    const result = await run(t, ['check-config', '--config', path]).finished;
    assert.equal(result.code, 1);
    assert.equal(result.stdout.includes(sentinel), false);
    assert.equal(result.stderr.includes(sentinel), false);
  }
  const missing = await run(t, ['start', '--config', resolve(tmpdir(), sentinel, 'missing.json')]).finished;
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /config_unreadable/);
  assert.equal(missing.stdout.includes(sentinel), false);
});

test('non-loopback requires explicit opt-in; validation never opens remote sockets', async (t) => {
  for (const host of ['0.0.0.0', '::', '192.0.2.1']) {
    const { path } = await fixture(t, { ...base, listen: { host } });
    const rejected = await run(t, ['check-config', '--config', path]).finished;
    assert.equal(rejected.code, 1);
    assert.match(rejected.stdout, /remote_listen_not_allowed/);
    const permitted = await fixture(t, { ...base, listen: { host, allowRemote: true } });
    const accepted = await run(t, ['check-config', '--config', permitted.path]).finished;
    assert.equal(accepted.code, 0);
  }
});

test('real local process is live but never integration-ready, without any credentials', async (t) => {
  const { path, dir } = await fixture(t, { ...base, auth: { tokenEnv: 'NOT_SET' } });
  const app = run(t, ['start', '--config', path], { cwd: dir });
  const listening = await app.waitFor((line) => line.operation === 'listen' && line.status === 'succeeded');
  const url = `http://127.0.0.1:${listening.port}`;
  const live = await fetch(`${url}/health/live`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { live: true });
  const ready = await fetch(`${url}/health/ready`);
  assert.equal(ready.status, 503);
  assert.deepEqual(await ready.json(), { ready: false, reason: 'components_unconfigured', missing: ['feishu', 'codex', 'store'] });
  const unavailable = await fetch(`${url}/api/messages`, { headers: { authorization: `Bearer ${sentinel}` } });
  assert.equal(unavailable.status, 404);
  const post = await fetch(`${url}/health/live`, { method: 'POST', body: sentinel });
  assert.equal(post.status, 405);
  app.child.kill('SIGTERM');
  const result = await app.finished;
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout.includes(sentinel), false);
  assert.equal(result.stderr, '');
  assert.deepEqual(result.lines.map((line) => `${line.operation}:${line.status}`), [
    'listen:succeeded', 'shutdown:started', 'shutdown:succeeded',
  ]);
});

test('SIGINT shuts down with a bounded grace period even with an incomplete HTTP request', async (t) => {
  const { path } = await fixture(t);
  const app = run(t, ['start', '--config', path]);
  const { port } = await app.waitFor((line) => line.operation === 'listen');
  const socket = net.createConnection({ host: '127.0.0.1', port });
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write('GET /health/live HTTP/1.1\r\nHost: localhost\r\n');
  app.child.kill('SIGINT');
  await app.waitFor((line) => line.operation === 'shutdown' && line.status === 'started');
  app.child.kill('SIGTERM');
  const result = await app.finished;
  assert.equal(result.code, 0);
  assert.equal(result.lines.filter((line) => line.operation === 'shutdown' && line.status === 'started').length, 1);
  assert.ok(result.lines.at(-1).durationMs < 4000);
});

test('listen collision exits nonzero with a safe diagnostic', async (t) => {
  const blocker = net.createServer();
  blocker.listen(0, '127.0.0.1');
  await once(blocker, 'listening');
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const { path } = await fixture(t, { ...base, listen: { host: '127.0.0.1', port: blocker.address().port } });
  const result = await run(t, ['start', '--config', path]).finished;
  assert.equal(result.code, 1);
  assert.equal(result.lines[0].code, 'startup_failed');
  assert.equal(result.stdout.includes(path), false);
  assert.equal(result.stderr, '');
});
