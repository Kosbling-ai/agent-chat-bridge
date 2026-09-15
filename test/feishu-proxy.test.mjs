import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import * as sdk from '@larksuiteoapi/node-sdk';
import { validateConfig } from '../src/config.mjs';
import { boundedFeishuHttp, createFeishuProxyAgent, startService } from '../src/service.mjs';

const run = promisify(execFile);
const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const eventually = async (predicate, milliseconds = 5000) => {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('fixture connection timeout');
};
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = server => new Promise(resolve => server.close(resolve));

async function certificate(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-feishu-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'cert.pem');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', cert]);
  return { key: await readFile(key), cert: await readFile(cert) };
}

test('real SDK REST and WSS reconnect traverse the dedicated CONNECT proxy', { timeout: 15000 }, async t => {
  const tls = await certificate(t);
  let httpsPort;
  let websocketConnections = 0;
  const target = https.createServer(tls, (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/open-apis/auth/v3/tenant_access_token/internal') {
      response.end(JSON.stringify({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 }));
    } else if (request.url === '/open-apis/im/v1/messages/message') {
      response.end(JSON.stringify({ code: 0, data: { items: [{ message_id: 'message' }] } }));
    } else if (request.url === '/callback/ws/endpoint') {
      response.end(JSON.stringify({ code: 0, data: { URL: `wss://127.0.0.1:${httpsPort}/events?device_id=device&service_id=1`,
        ClientConfig: { PingInterval: 60, ReconnectCount: 3, ReconnectInterval: 0.01, ReconnectNonce: 0 } } }));
    } else { response.statusCode = 404; response.end(JSON.stringify({ code: 404 })); }
  });
  const sockets = new Set();
  target.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const wss = new WebSocketServer({ server: target });
  wss.on('connection', socket => {
    websocketConnections++;
    if (websocketConnections === 1) setTimeout(() => socket.terminate(), 30);
  });
  httpsPort = await listen(target);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    wss.close();
    await close(target);
  });

  const connectTargets = [];
  const proxySockets = new Set();
  const proxy = net.createServer(client => {
    proxySockets.add(client); client.once('close', () => proxySockets.delete(client));
    client.on('error', () => {});
    let buffered = '';
    client.once('data', chunk => {
      buffered += chunk.toString('latin1');
      const [requestLine] = buffered.split('\r\n');
      const [, authority] = requestLine.split(' ');
      connectTargets.push(authority);
      const [host, port] = authority.split(':');
      assert.equal(host, '127.0.0.1');
      const upstream = net.connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(Buffer.from(buffered.slice(buffered.indexOf('\r\n\r\n') + 4), 'latin1'));
        client.pipe(upstream).pipe(client);
      });
      upstream.on('error', () => client.destroy());
      proxySockets.add(upstream); upstream.once('close', () => proxySockets.delete(upstream));
    });
  });
  const proxyPort = await listen(proxy);
  t.after(async () => { for (const socket of proxySockets) socket.destroy(); await close(proxy); });

  const agent = createFeishuProxyAgent(`http://127.0.0.1:${proxyPort}`);
  // Trust is scoped to this fixture agent. Do not mutate NODE_TLS_REJECT_UNAUTHORIZED
  // or the process-wide CA set.
  const connectWithFixtureCa = agent.connect.bind(agent);
  agent.connect = (request, options) => connectWithFixtureCa(request, { ...options, ca: tls.cert });
  const httpInstance = boundedFeishuHttp(sdk.defaultHttpInstance, { proxyAgent: agent });
  const tokenShape = await httpInstance.post(`https://127.0.0.1:${httpsPort}/open-apis/auth/v3/tenant_access_token/internal`, {});
  assert.equal(tokenShape.tenant_access_token, 'fixture-token');
  const client = new sdk.Client({ appId: 'fixture-app', appSecret: 'fixture-secret', disableTokenCache: true,
    httpInstance, logger, loggerLevel: sdk.LoggerLevel.fatal });
  const result = await client.request({ method: 'get', url: `https://127.0.0.1:${httpsPort}/open-apis/im/v1/messages/message` });
  assert.deepEqual(result, { code: 0, data: { items: [{ message_id: 'message' }] } }, 'SDK response interceptor shape is preserved');

  const intervals = [];
  const originalSetInterval = globalThis.setInterval;
  let ws;
  try {
    globalThis.setInterval = (...args) => { const timer = originalSetInterval(...args); intervals.push(timer); return timer; };
    ws = new sdk.WSClient({ appId: 'fixture-app', appSecret: 'fixture-secret', domain: `https://127.0.0.1:${httpsPort}`,
      httpInstance, agent, logger, loggerLevel: sdk.LoggerLevel.fatal });
  } finally { globalThis.setInterval = originalSetInterval; }
  t.after(() => { ws?.close({ force: true }); intervals.forEach(clearInterval); });
  ws.start({ eventDispatcher: new sdk.EventDispatcher({ logger, loggerLevel: sdk.LoggerLevel.fatal }).register({}) });
  await eventually(() => websocketConnections >= 2);
  ws.close({ force: true });
  intervals.forEach(clearInterval);
  assert.ok(connectTargets.length >= 5, 'token, REST, two config pulls and two WSS upgrades use CONNECT');
  assert.ok(connectTargets.every(value => value === `127.0.0.1:${httpsPort}`));
});

test('proxy wrapper enforces agent options and default mode adds none', async () => {
  const sentinel = {};
  let proxied;
  await boundedFeishuHttp({ request: async options => { proxied = options; return {}; } }, { proxyAgent: sentinel })
    .request({ proxy: true, httpAgent: 'caller', httpsAgent: 'caller', timeout: 1 });
  assert.equal(proxied.proxy, false);
  assert.equal(proxied.httpAgent, sentinel);
  assert.equal(proxied.httpsAgent, sentinel);
  assert.equal(proxied.timeout, 10000);
  let direct;
  await boundedFeishuHttp({ request: async options => { direct = options; return {}; } }).request({});
  assert.equal(Object.hasOwn(direct, 'proxy'), false);
  assert.equal(Object.hasOwn(direct, 'httpAgent'), false);
  assert.throws(() => createFeishuProxyAgent('socks://user:secret@example.invalid'), error => error.code === 'invalid_feishu_proxy' && !error.message.includes('secret'));
});

test('config references one proxy env and service injects the same agent into SDK HTTP and WSS', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-feishu-service-proxy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const raw = {
    schemaVersion: 1,
    storage: Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `TEST_${key.toUpperCase()}`])),
    codex: { bin: process.execPath, cwd: directory, envNames: ['PATH'] },
    feishu: { connectionId: 'proxy', appIdEnv: 'TEST_APP', appSecretEnv: 'TEST_SECRET', botOpenId: 'bot', catchup: false,
      httpProxyEnv: 'BRIDGE_FEISHU_PROXY_URL' },
    routing: { version: '1', privateUserIds: [], groups: [] },
    auth: { clients: [{ id: 'test', tokenEnv: 'TEST_TOKEN', conversationIds: [], admin: false }] },
  };
  assert.equal(validateConfig(raw).feishu.httpProxyEnv, 'BRIDGE_FEISHU_PROXY_URL');
  for (const value of ['http://inline.invalid', 'lowercase', 3]) {
    assert.throws(() => validateConfig({ ...raw, feishu: { ...raw.feishu, httpProxyEnv: value } }));
  }
  const config = validateConfig(raw);
  const env = { PATH: process.env.PATH, TEST_HOST: '127.0.0.1', TEST_PORT: '1', TEST_USER: 'fixture', TEST_PASSWORD: 'fixture',
    TEST_DATABASE: 'fixture', TEST_APP: 'fixture', TEST_SECRET: 'fixture', TEST_TOKEN: 'fixture-token-with-at-least-32-bytes',
    BRIDGE_FEISHU_PROXY_URL: 'http://proxy-user:proxy-secret@127.0.0.1:12345' };
  const sentinelAgent = {};
  let clientOptions; let wsOptions; let stopStart;
  const entered = new Promise(resolve => { stopStart = resolve; });
  const controller = new AbortController();
  const starting = startService({ config, configPath: join(directory, 'config.json'), env, signal: controller.signal, dependencies: {
    pool: () => ({ end: async () => {} }),
    store: async () => ({ close: async () => {}, assertCurrent: async () => {} }),
    codex: () => ({ start: async () => {}, close: async () => {}, status: () => ({ state: 'ready' }) }),
    feishuProxyAgent(value) { assert.equal(value, env.BRIDGE_FEISHU_PROXY_URL); return sentinelAgent; },
    sdk: {
      defaultHttpInstance: {},
      Client: class { constructor(options) { clientOptions = options; } },
      WSClient: class { constructor(options) { wsOptions = options; } },
    },
    chat: () => ({}), media: async () => ({}), outbound: async () => ({}),
    feishu: () => ({ start: () => { stopStart(); return new Promise(() => {}); }, stop() {}, status: () => ({ connected: false }) }),
  } });
  await entered;
  assert.equal(clientOptions.httpInstance.request instanceof Function, true);
  assert.equal(wsOptions.httpInstance, clientOptions.httpInstance);
  assert.equal(wsOptions.agent, sentinelAgent);
  assert.equal(JSON.stringify({ clientOptions, wsOptions }).includes('proxy-secret'), false);
  controller.abort();
  await assert.rejects(starting, { code: 'startup_cancelled' });
});
