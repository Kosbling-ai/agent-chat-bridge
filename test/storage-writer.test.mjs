import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWriter } from '../src/storage/writer.mjs';
import { validateConfig } from '../src/config.mjs';
import { startService } from '../src/service.mjs';
import { createLogger } from '../src/logger.mjs';
import { createPoolFromEnvironment, storageConnectionReferences } from '../src/storage/connection.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const migrationRows = await Promise.all(['001-initial.sql', '002-codex-sessions.sql', '003-forward-runtime.sql', '004-bot-connection.sql']
  .map(async (file, index) => ({ version: index + 1,
    checksum: createHash('sha256').update(await readFile(new URL(`../src/storage/migrations/${file}`, import.meta.url), 'utf8')).digest('hex') })));

function fakeConnection(probe) {
  let queries = 0;
  return {
    connection: new EventEmitter(),
    destroyed: false,
    destroy() { this.destroyed = true; },
    async query(sql) {
      queries += 1;
      if (sql.includes('DATABASE')) return [[{ name: 'fixture' }]];
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      return probe(sql, queries - 2);
    },
  };
}

async function writerFixture(probe, options = {}) {
  const lost = [];
  const logs = [];
  const connection = fakeConnection(probe);
  const writer = await acquireWriter({ getConnection: async () => connection }, error => lost.push(error), {
    connectionId: 'fixture', probeIntervalMs: 10_000, probeTimeoutMs: 15, probeMaxMisses: 2,
    log: (...entry) => logs.push(entry), ...options,
  });
  return { writer, connection, lost, logs };
}

for (const [event, reason] of [['error', 'connection_error'], ['end', 'connection_end']]) {
  test(`writer ${event} immediately loses the lock with ${reason}`, async () => {
    const fixture = await writerFixture(async () => [[{ held: 1 }]]);
    fixture.connection.connection.emit(event, event === 'error' ? new Error('synthetic') : undefined);
    assert.equal(fixture.lost.length, 1);
    assert.equal(fixture.lost[0].reason, reason);
    assert.throws(() => fixture.writer.assert(), { code: 'writer_lock_lost' });
    await fixture.writer.close();
  });
}

test('held=0 immediately loses the lock with lock_not_held', async () => {
  const fixture = await writerFixture(async () => [[{ held: 0 }]]);
  await assert.rejects(fixture.writer.verify(), { code: 'writer_lock_lost', reason: 'lock_not_held' });
  assert.equal(fixture.lost.length, 1);
  assert.equal(fixture.lost[0].reason, 'lock_not_held');
  await fixture.writer.close();
});

test('a probe query failure immediately loses the lock with probe_query_failed', async () => {
  const fixture = await writerFixture(async () => { throw new Error('synthetic query failure'); });
  await assert.rejects(fixture.writer.verify(), { code: 'writer_lock_lost', reason: 'probe_query_failed' });
  assert.equal(fixture.lost.length, 1);
  assert.equal(fixture.lost[0].reason, 'probe_query_failed');
  await fixture.writer.close();
});

test('one timed out probe can recover, resets misses, and emits a warning', async () => {
  let resolveProbe;
  const fixture = await writerFixture(() => new Promise(resolve => { resolveProbe = resolve; }));
  const verifying = fixture.writer.verify();
  await delay(22);
  assert.equal(fixture.lost.length, 0);
  resolveProbe([[{ held: 1 }]]);
  await verifying;
  fixture.writer.assert();
  const warning = fixture.logs.find(([, operation, status, fields]) => operation === 'store_writer_probe' && status === 'recovered' && fields.consecutiveMisses === 1);
  assert.ok(warning);
  assert.equal(warning[3].reason, 'probe_timeout');
  console.log(`PROBE_RECOVERY_LOG ${JSON.stringify({ level: warning[0], operation: warning[1], status: warning[2], ...warning[3] })}`);
  let resolveNextProbe;
  const nextProbe = fixture.writer.verify();
  resolveNextProbe = resolveProbe;
  await delay(22);
  const latestTimeout = fixture.logs.filter(([, operation, status]) => operation === 'store_writer_probe' && status === 'suspected').at(-1);
  assert.equal(latestTimeout[3].consecutiveMisses, 1);
  resolveNextProbe([[{ held: 1 }]]);
  await nextProbe;
  fixture.writer.assert();
  await fixture.writer.close();
});

test('concurrent verify calls share one in-flight query', async () => {
  let resolveProbe;
  let probeQueries = 0;
  const fixture = await writerFixture(() => { probeQueries += 1; return new Promise(resolve => { resolveProbe = resolve; }); });
  const first = fixture.writer.verify();
  const second = fixture.writer.verify();
  const third = fixture.writer.verify();
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(probeQueries, 1);
  resolveProbe([[{ held: 1 }]]);
  await Promise.all([first, second, third]);
  await fixture.writer.close();
});

test('two consecutive timeout windows lose the writer once with probe_timeout', async () => {
  const fixture = await writerFixture(() => new Promise(() => {}));
  fixture.writer.verify().catch(() => {});
  await delay(38);
  assert.equal(fixture.lost.length, 1);
  assert.equal(fixture.lost[0].reason, 'probe_timeout');
  assert.equal(fixture.lost[0].consecutiveMisses, 2);
  assert.equal(fixture.connection.destroyed, true);
  const failure = fixture.logs.find(([, operation, status]) => operation === 'store_writer_probe' && status === 'failed');
  assert.ok(failure);
  assert.equal(failure[0], 'warning');
  console.log(`PROBE_TIMEOUT_LOG ${JSON.stringify({ level: failure[0], operation: failure[1], status: failure[2], ...failure[3] })}`);
  fixture.connection.connection.emit('end');
  assert.equal(fixture.lost.length, 1);
  await fixture.writer.close();
});

for (const lateOutcome of ['resolve', 'reject']) {
  test(`a late probe ${lateOutcome} after timeout loss cannot lose twice`, async () => {
    let settle;
    const fixture = await writerFixture(() => new Promise((resolve, reject) => { settle = lateOutcome === 'resolve' ? resolve : reject; }));
    const probing = fixture.writer.verify();
    probing.catch(() => {});
    await delay(38);
    assert.equal(fixture.lost.length, 1);
    settle(lateOutcome === 'resolve' ? [[{ held: 1 }]] : new Error('late rejection'));
    await assert.rejects(probing, { code: 'writer_lock_lost', reason: 'probe_timeout' });
    await delay(0);
    assert.equal(fixture.lost.length, 1);
    await fixture.writer.close();
  });
}

test('writer timer options reject values above the Node timer maximum', async () => {
  const pool = { getConnection() { throw new Error('must not connect'); } };
  for (const field of ['probeIntervalMs', 'probeTimeoutMs']) {
    await assert.rejects(acquireWriter(pool, undefined, { connectionId: 'fixture', [field]: 2_147_483_648 }), { code: 'invalid_store_input' });
  }
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

test('write path does not wait for a three-second in-flight writer probe', { timeout: 5_000 }, async () => {
  let probeStartedResolve;
  const probeStarted = new Promise(resolve => { probeStartedResolve = resolve; });
  let probeQueries = 0;
  let lost = 0;
  const basicConnection = overrides => ({
    connection: new EventEmitter(),
    destroyed: false,
    destroy() { this.destroyed = true; }, release() {},
    async query(sql) {
      if (sql.startsWith('SET SESSION')) return [[]];
      if (sql.includes('bridge_schema_migrations')) return [migrationRows];
      return [[]];
    },
    async execute() { return [{ affectedRows: 1 }]; },
    async beginTransaction() {}, async commit() {}, async rollback() {},
    ...overrides,
  });
  const schemaConnection = basicConnection({});
  const writerConnection = basicConnection({
    async query(sql) {
      if (sql.includes('DATABASE')) return [[{ name: 'fixture' }]];
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.includes('IS_USED_LOCK')) {
        probeQueries += 1;
        if (probeQueries === 1) {
          probeStartedResolve();
          await delay(3_000);
        }
        return [[{ held: 1 }]];
      }
      return [[]];
    },
  });
  const transactionConnection = basicConnection({});
  const connections = [schemaConnection, writerConnection, transactionConnection];
  const pool = {
    async getConnection() { return connections.shift() ?? transactionConnection; },
    async end() {},
  };
  const store = await createMysqlStore({ pool, connectionId: 'fixture', operationTimeoutMs: 1_800,
    writerProbeIntervalMs: 5, writerProbeTimeoutMs: 5_000, writerProbeMaxMisses: 2, onWriterLost: () => { lost += 1; } });
  await probeStarted;
  const startedAt = Date.now();
  assert.deepEqual(await store.setCursor({ connectionId: 'fixture', key: 'slow-probe', expectedVersion: 0, value: { ok: true } }), { version: 1 });
  assert.ok(Date.now() - startedAt < 1_800);
  await delay(3_050);
  assert.equal(lost, 0);
  assert.ok(probeQueries >= 1);
  await store.close();
});

test('writer loss while waiting for a transaction connection fences the late write', async () => {
  const events = [];
  let transactionRequestedResolve, releaseTransaction;
  const transactionRequested = new Promise(resolve => { transactionRequestedResolve = resolve; });
  const schemaConnection = {
    async query(sql) {
      if (sql.includes('bridge_schema_migrations')) return [migrationRows];
      return [[]];
    },
    release() {}, destroy() {},
  };
  const writerConnection = {
    connection: new EventEmitter(),
    async query(sql) {
      if (sql.includes('DATABASE')) return [[{ name: 'fixture' }]];
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      return [[{ held: 1 }]];
    },
    release() {}, destroy() {},
  };
  const transactionConnection = {
    destroyed: false,
    async query() { return [[]]; },
    async beginTransaction() { events.push('begin'); },
    async execute() { events.push('write'); return [{ affectedRows: 1 }]; },
    async commit() { events.push('commit'); },
    async rollback() { events.push('rollback'); },
    destroy() { this.destroyed = true; events.push('destroy'); },
    release() {},
  };
  let connectionCall = 0;
  const pool = {
    async getConnection() {
      connectionCall += 1;
      if (connectionCall === 1) return schemaConnection;
      if (connectionCall === 2) return writerConnection;
      transactionRequestedResolve();
      return new Promise(resolve => { releaseTransaction = resolve; });
    },
    async end() {},
  };
  const store = await createMysqlStore({ pool, connectionId: 'fixture', writerProbeIntervalMs: 10_000,
    onWriterLost: () => events.push('writer-lost') });
  const writing = store.setCursor({ connectionId: 'fixture', key: 'late-connection', expectedVersion: 0, value: { ok: true } });
  await transactionRequested;
  writerConnection.connection.emit('end');
  releaseTransaction(transactionConnection);
  await assert.rejects(writing, { code: 'writer_lock_lost' });
  assert.deepEqual(events, ['writer-lost', 'begin', 'destroy', 'rollback']);
  assert.equal(transactionConnection.destroyed, true);
  console.log(`LATE_CONNECTION_EVENTS ${JSON.stringify(events)}`);
  await store.close();
});

test('validated storage config creates a real pool from connection references without connecting', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-storage-pool-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = validateConfig(rawConfig(directory));
  const references = storageConnectionReferences(config.storage);
  assert.deepEqual(Object.keys(references), ['hostEnv', 'portEnv', 'userEnv', 'passwordEnv', 'databaseEnv']);
  const pool = createPoolFromEnvironment(references, {
    TEST_HOST: '127.0.0.1', TEST_PORT: '3306', TEST_USER: 'fixture', TEST_PASSWORD: 'fixture', TEST_DATABASE: 'bridge_test',
  });
  await pool.end();
});
