import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWriter } from '../src/storage/writer.mjs';
import { validateConfig } from '../src/config.mjs';
import { startService } from '../src/service.mjs';
import { createLogger } from '../src/logger.mjs';
import { createPoolFromEnvironment, storageConnectionReferences } from '../src/storage/connection.mjs';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const migrationRows = await Promise.all(['001-initial.sql', '002-codex-sessions.sql', '003-forward-runtime.sql', '004-bot-connection.sql']
  .map(async (file, index) => ({ version: index + 1,
    checksum: createHash('sha256').update(await readFile(new URL(`../src/storage/migrations/${file}`, import.meta.url), 'utf8')).digest('hex') })));

test('writer compatibility facade does not acquire a connection or advisory lock', async () => {
  let calls = 0;
  const writer = await acquireWriter({ getConnection: async () => { calls += 1; throw new Error('must not connect'); } });
  writer.assert(); await writer.verify(); await writer.close();
  assert.equal(calls, 0);
});

test('storage writer settings remain accepted as deprecated compatibility fields', () => {
  const directory = '/tmp/bridge-storage-compat';
  const config = validateConfig({ schemaVersion: 1, listen: { host: '127.0.0.1', port: 0 }, runtime: {},
    storage: { hostEnv: 'TEST_HOST', portEnv: 'TEST_PORT', userEnv: 'TEST_USER', passwordEnv: 'TEST_PASSWORD', databaseEnv: 'TEST_DATABASE', writer: {} },
    codex: { bin: process.execPath, cwd: directory, envNames: [] },
    feishu: { connectionId: 'fixture', appIdEnv: 'TEST_APP', appSecretEnv: 'TEST_SECRET', botOpenId: 'bot', catchup: false },
    routing: { version: '1', privateUserIds: ['human'], groups: [] } });
  assert.equal(config.storage.writer.probeIntervalMs, 500);
});

const rawConfig = directory => ({
  schemaVersion: 1,
  listen: { host: '127.0.0.1', port: 0 },
  runtime: { unhealthyExitMs: 30_000 },
  storage: {
    hostEnv: 'TEST_HOST', portEnv: 'TEST_PORT', userEnv: 'TEST_USER', passwordEnv: 'TEST_PASSWORD', databaseEnv: 'TEST_DATABASE',
    writer: { probeIntervalMs: 500, probeTimeoutMs: 5_000, probeMaxMisses: 2, lostShutdownMs: 20 },
  },
  codex: { bin: process.execPath, cwd: directory, envNames: [] },
  feishu: { connectionId: 'fixture', appIdEnv: 'TEST_APP', appSecretEnv: 'TEST_SECRET', botOpenId: 'bot', catchup: false },
  routing: { version: '1', privateUserIds: ['human'], groups: [] },
});

const env = { TEST_APP: 'fixture-app', TEST_SECRET: 'fixture-secret' };
const lostError = (reason = 'connection_end') => Object.assign(new Error('writer_lock_lost'), {
  code: 'writer_lock_lost', reason, durationMs: 12, consecutiveMisses: reason === 'probe_timeout' ? 2 : 0,
});

function serviceDependencies(events, options = {}) {
  let onWriterLost;
  let readiness;
  let workerHealthy = true;
  let codexHealthy = true;
  let outboundEnteredResolve, outboundRelease;
  let serverEnteredResolve, serverRelease;
  const outboundEntered = new Promise(resolve => { outboundEnteredResolve = resolve; });
  const serverEntered = new Promise(resolve => { serverEnteredResolve = resolve; });
  const worker = name => ({
    start() { events.push(`${name}-start`); },
    beginStop() { events.push(`${name}-begin-stop`); },
    async ingestCardAction() {},
    async stop() { events.push(`${name}-stop`); if (options.hangWorker === name) await new Promise(() => {}); },
    status: () => ({ running: workerHealthy }),
  });
  const forward = worker('forward');
  const communication = worker('communication');
  return {
    controls: {
      get onWriterLost() { return onWriterLost; }, get readiness() { return readiness; },
      setWorkerHealthy(value) { workerHealthy = value; }, setCodexHealthy(value) { codexHealthy = value; }, outboundEntered, serverEntered,
      releaseOutbound(value = { async close() { events.push('outbound-close'); } }) { outboundRelease?.(value); },
      releaseServer(value = { server: {}, async close() { events.push('server-close'); } }) { serverRelease?.(value); },
    },
    dependencies: {
      pool: () => ({ async end() { events.push('pool-close'); } }),
      store: async input => {
        onWriterLost = input.onWriterLost;
        if (options.loseDuringStartup) queueMicrotask(() => onWriterLost(lostError('connection_error')));
        return { async assertCurrent() {}, async close() { events.push('store-close'); } };
      },
      sessions: () => ({}), jobs: () => ({}), inbound: () => ({}),
      executor: () => ({ status: () => ({ closing: !codexHealthy, restartPending: codexHealthy ? null : 'pending', fault: null }), async close() { events.push('executor-close'); } }),
      feedback: () => ({ handleCardAction() {} }), userInput: () => ({ async close() {}, handleCardAction() {} }),
      replies: () => ({}), typing: () => ({}), communication: () => communication, forward: () => forward,
      media: async () => ({ async release() { events.push('media-release'); } }),
      outbound: async () => {
        if (!options.hangOutbound) return {};
        outboundEnteredResolve();
        return new Promise(resolve => { outboundRelease = resolve; });
      },
      sdk: { Client: class {}, WSClient: class {}, defaultHttpInstance: {} },
      chat: () => ({}),
      feishu: () => {
        let connected = false;
        return { async start() { connected = true; events.push('feishu-start'); }, async stop() { connected = false; events.push('feishu-stop'); }, status: () => ({ connected }) };
      },
      server: async input => {
        readiness = input.readiness;
        events.push('server-factory');
        if (!options.hangServer) return { server: {}, async close() { events.push('server-close'); } };
        serverEnteredResolve();
        return new Promise(resolve => { serverRelease = resolve; });
      },
    },
  };
}

test('writer loss flips readiness and requests one non-zero process exit after shutdown', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-writer-loss-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  const fixture = serviceDependencies(events);
  const exits = [];
  let logOutput = '';
  const log = createLogger({ write(chunk) { logOutput += chunk; } });
  const service = await startService({ config: validateConfig(rawConfig(directory)), configPath: join(directory, 'bridge.json'), env,
    dependencies: fixture.dependencies, log, onRestartRequired: async (reason, code) => exits.push({ reason, code }) });
  assert.equal((await fixture.controls.readiness()).ready, true);
  fixture.controls.onWriterLost(lostError('probe_timeout'));
  fixture.controls.onWriterLost(lostError('connection_end'));
  assert.equal((await fixture.controls.readiness()).ready, false);
  await delay(5);
  assert.deepEqual(exits, [{ reason: 'writer_lost:probe_timeout', code: 1 }]);
  const lossLog = logOutput.trim().split('\n').map(line => JSON.parse(line))
    .find(event => event.operation === 'store_writer' && event.status === 'failed');
  assert.equal(lossLog.reason, 'probe_timeout');
  assert.equal(lossLog.consecutive_misses, 2);
  assert.equal(logOutput.trim().split('\n').map(line => JSON.parse(line)).filter(event => event.level === 'error' && event.operation === 'store_writer').length, 1);
  assert.equal(logOutput.trim().split('\n').map(line => JSON.parse(line)).filter(event => event.level === 'error').length, 1);
  console.log(`REAL_WRITER_LOSS_LOG ${JSON.stringify(lossLog)}`);
  console.log(`WRITER_EXIT_LOG ${JSON.stringify({ reason: exits[0].reason, exitCode: exits[0].code, ready: false })}`);
  assert.ok(events.includes('communication-stop'));
  assert.ok(events.includes('forward-begin-stop'));
  await service.close();
});

test('writer loss during startup never starts readiness and requests the same non-zero exit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-writer-startup-loss-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  const fixture = serviceDependencies(events, { loseDuringStartup: true });
  const exits = [];
  await assert.rejects(startService({ config: validateConfig(rawConfig(directory)), configPath: join(directory, 'bridge.json'), env,
    dependencies: fixture.dependencies, onRestartRequired: async (reason, code) => exits.push({ reason, code }) }), { code: 'writer_lock_lost' });
  assert.equal(events.includes('server-factory'), false);
  assert.equal(events.includes('store-close'), true);
  assert.deepEqual(exits, [{ reason: 'writer_lost:connection_error', code: 1 }]);
});

test('writer-loss cleanup deadline forces the non-zero exit request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-writer-forced-loss-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  const fixture = serviceDependencies(events, { hangWorker: 'forward' });
  const exits = [];
  await startService({ config: validateConfig(rawConfig(directory)), configPath: join(directory, 'bridge.json'), env,
    dependencies: fixture.dependencies, onRestartRequired: async (reason, code) => exits.push({ reason, code }) });
  fixture.controls.onWriterLost(lostError());
  await delay(30);
  assert.deepEqual(exits, [{ reason: 'writer_lost:connection_end', code: 1 }]);
});

test('watchdog ignores persistent Codex restart state but exits for unhealthy workers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-unhealthy-worker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  const fixture = serviceDependencies(events);
  const exits = [];
  const config = rawConfig(directory);
  config.runtime.unhealthyExitMs = 20;
  config.storage.writer.probeIntervalMs = 5;
  await startService({ config: validateConfig(config), configPath: join(directory, 'bridge.json'), env,
    dependencies: fixture.dependencies, onRestartRequired: async (reason, code) => exits.push({ reason, code }) });
  fixture.controls.setCodexHealthy(false);
  await delay(55);
  assert.deepEqual(exits, []);
  fixture.controls.setWorkerHealthy(false);
  await delay(55);
  assert.deepEqual(exits, [{ reason: 'unhealthy:workers', code: 1 }]);
  await delay(20);
  assert.equal(exits.length, 1);
});

test('writer loss while outbound initializes closes the late component and starts no ingress', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-writer-outbound-loss-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  const fixture = serviceDependencies(events, { hangOutbound: true });
  const exits = [];
  const starting = startService({ config: validateConfig(rawConfig(directory)), configPath: join(directory, 'bridge.json'), env,
    dependencies: fixture.dependencies, onRestartRequired: async (reason, code) => exits.push({ reason, code }) });
  await fixture.controls.outboundEntered;
  fixture.controls.onWriterLost(lostError('connection_end'));
  fixture.controls.releaseOutbound();
  await assert.rejects(starting, { code: 'writer_lock_lost' });
  assert.ok(events.includes('outbound-close'));
  assert.equal(events.some(event => event.endsWith('-start')), false);
  assert.equal(events.includes('server-factory'), false);
  assert.deepEqual(exits, [{ reason: 'writer_lost:connection_end', code: 1 }]);
});

test('a late outbound close that never returns cannot delay the writer-loss exit window', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-writer-late-close-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  const logs = [];
  const fixture = serviceDependencies(events, { hangOutbound: true });
  const exits = [];
  const starting = startService({ config: validateConfig(rawConfig(directory)), configPath: join(directory, 'bridge.json'), env,
    dependencies: fixture.dependencies, log: (...entry) => logs.push(entry),
    onRestartRequired: async (reason, code) => exits.push({ reason, code }) });
  await fixture.controls.outboundEntered;
  const lostAt = Date.now();
  fixture.controls.onWriterLost(lostError('connection_end'));
  fixture.controls.releaseOutbound({ async close() { events.push('outbound-close-start'); await new Promise(() => {}); } });
  await assert.rejects(starting, { code: 'writer_lock_lost' });
  assert.ok(Date.now() - lostAt < 80);
  assert.deepEqual(exits, [{ reason: 'writer_lost:connection_end', code: 1 }]);
  assert.ok(events.includes('outbound-close-start'));
  assert.ok(logs.some(([, operation, status, fields]) => operation === 'late_component_cleanup'
    && status === 'timeout' && fields.reason === 'outbound'));
});

test('writer loss while server initializes closes the late server and starts no ingress', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-writer-server-loss-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  const fixture = serviceDependencies(events, { hangServer: true });
  const exits = [];
  const starting = startService({ config: validateConfig(rawConfig(directory)), configPath: join(directory, 'bridge.json'), env,
    dependencies: fixture.dependencies, onRestartRequired: async (reason, code) => exits.push({ reason, code }) });
  await fixture.controls.serverEntered;
  fixture.controls.onWriterLost(lostError('connection_end'));
  fixture.controls.releaseServer();
  await assert.rejects(starting, { code: 'writer_lock_lost' });
  assert.ok(events.includes('server-close'));
  assert.equal(events.some(event => event.endsWith('-start')), false);
  assert.deepEqual(exits, [{ reason: 'writer_lost:connection_end', code: 1 }]);
});

test('writer probe configuration defaults and validation are explicit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-writer-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = rawConfig(directory);
  delete base.storage.writer;
  delete base.runtime;
  const validated = validateConfig(base);
  assert.deepEqual(validated.storage.writer, { probeIntervalMs: 500, probeTimeoutMs: 5_000, probeMaxMisses: 2, lostShutdownMs: 10_000 });
  assert.equal(validated.runtime.unhealthyExitMs, 30_000);
  for (const [field, code] of [
    ['probeIntervalMs', 'invalid_storage_writer_probe_interval'],
    ['probeTimeoutMs', 'invalid_storage_writer_probe_timeout'],
    ['probeMaxMisses', 'invalid_storage_writer_probe_max_misses'],
    ['lostShutdownMs', 'invalid_storage_writer_lost_shutdown'],
  ]) {
    assert.throws(() => validateConfig({ ...base, storage: { ...base.storage, writer: { [field]: 0 } } }), { code });
  }
  for (const field of ['probeIntervalMs', 'probeTimeoutMs', 'lostShutdownMs']) {
    assert.doesNotThrow(() => validateConfig({ ...base, storage: { ...base.storage, writer: { [field]: 2_147_483_647 } } }));
    assert.throws(() => validateConfig({ ...base, storage: { ...base.storage, writer: { [field]: 2_147_483_648 } } }));
  }
  assert.doesNotThrow(() => validateConfig({ ...base, runtime: { unhealthyExitMs: 2_147_483_647 } }));
  assert.throws(() => validateConfig({ ...base, runtime: { unhealthyExitMs: 2_147_483_648 } }), { code: 'invalid_runtime_unhealthy_exit' });
});
