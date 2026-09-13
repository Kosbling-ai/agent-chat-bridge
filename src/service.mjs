import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as sdk from '@larksuiteoapi/node-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ConfigError } from './config.mjs';
import { createPoolFromEnvironment } from './storage/connection.mjs';
import { createMysqlStore } from './storage/store.mjs';
import { migrate } from './storage/migrations.mjs';
import { createCodexAdapter } from './agents/codex/adapter.mjs';
import { createFeishuAdapter } from './channels/feishu/adapter.mjs';
import { createFeishuChatClient } from './channels/feishu/chat-client.mjs';
import { createFeishuMedia } from './channels/feishu/media.mjs';
import { createOutboundMedia } from './channels/feishu/outbound-media.mjs';
import { createRuntime } from './core/runtime.mjs';
import { createCatchup } from './core/catchup.mjs';
import { listCatchupConversations } from './core/conversations.mjs';
import { createApi } from './core/api.mjs';
import { startServer } from './server.mjs';
import { createLogger, createErrorReporter, safeObserver } from './logger.mjs';

function secret(env, key) {
  if (typeof env[key] !== 'string' || !env[key]) throw new ConfigError('required_environment_missing');
  return env[key];
}
export async function migrateService({ config, env = process.env }) {
  if (!config.storage) throw new ConfigError('storage_unconfigured');
  const pool = createPoolFromEnvironment(config.storage, env);
  try { return await migrate(pool); } finally { await pool.end(); }
}
export function createFeishuProxyAgent(value, options) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.hash) throw new Error('invalid');
    return new HttpsProxyAgent(url, options);
  } catch { throw new ConfigError('invalid_feishu_proxy'); }
}
export function boundedFeishuHttp(base, { proxyAgent } = {}) {
  const options = value => ({ ...value, timeout: 10000, maxContentLength: 32 * 1024 * 1024, maxBodyLength: 32 * 1024 * 1024, maxRedirects: 0,
    ...(proxyAgent ? { proxy: false, httpAgent: proxyAgent, httpsAgent: proxyAgent } : {}) });
  const http = { request: value => base.request(options(value)) };
  for (const method of ['get', 'delete', 'head', 'options']) http[method] = (url, value) => base[method](url, options(value));
  for (const method of ['post', 'put', 'patch']) http[method] = (url, data, value) => base[method](url, data, options(value));
  return http;
}
export async function startService({ config, configPath, env = process.env, log, signal, dependencies = {} }) {
  log = safeObserver(log);
  if (signal?.aborted) throw new ConfigError('startup_cancelled');
  if (!config.storage) return startServer({ config, log });
  const root = dirname(resolve(configPath));
  const cwd = resolve(root, config.codex.cwd);
  const bin = resolve(root, config.codex.bin);
  try {
    const [workspace, executable] = await Promise.all([stat(cwd), stat(bin)]);
    if (!workspace.isDirectory() || !executable.isFile() || (workspace.mode & 0o002) || (executable.mode & 0o002)
      || (process.getuid && workspace.uid !== process.getuid())) throw new Error('unsafe_workspace');
    await access(bin, constants.X_OK);
  } catch { throw new ConfigError('invalid_codex_workspace_or_executable'); }
  const proxyEnv = config.codex.proxyEnv ?? {};
  const childEnv = Object.fromEntries(config.codex.envNames.filter(name => !Object.hasOwn(proxyEnv, name)).map(name => [name, secret(env, name)]));
  // Custom source names avoid changing the SDK's ambient proxy environment.
  // Explicit proxy mappings override same-name envNames only in the child.
  for (const [name, source] of Object.entries(proxyEnv)) childEnv[name] = secret(env, source);
  const tokens = Object.fromEntries(config.auth.clients.map(client => [client.id, secret(env, client.tokenEnv)]));
  const hookTokens = Object.fromEntries(config.hooks.map(hook => [hook.id, secret(env, hook.tokenEnv)]));
  const credentials = { appId: secret(env, config.feishu.appIdEnv), appSecret: secret(env, config.feishu.appSecretEnv) };
  const reporter = config.errorReporting ? createErrorReporter({ url: config.errorReporting.url, token: secret(env, config.errorReporting.tokenEnv), warn: log }) : undefined;
  if (reporter) log = createLogger(process.stdout, { reportError: reporter.report });
  const factories = { pool: createPoolFromEnvironment, store: createMysqlStore, codex: createCodexAdapter, feishu: createFeishuAdapter, chat: createFeishuChatClient, media: createFeishuMedia, outbound: createOutboundMedia, catchup: createCatchup, feishuProxyAgent: createFeishuProxyAgent, sdk, ...dependencies };
  const pool = factories.pool(config.storage, env);
  let store, codex, feishu, runtime, catchup, http;
  let writerHealthy = true;
  let closing;
  let rejectCancelled;
  const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
  cancelled.catch(() => {});
  const abort = () => {
    rejectCancelled(new ConfigError('startup_cancelled'));
    safeObserver(() => feishu?.stop())();
    safeObserver(() => codex?.close())();
  };
  const checkCancelled = () => { if (signal?.aborted) throw new ConfigError('startup_cancelled'); };
  signal?.addEventListener('abort', abort, { once: true });
  const close = () => closing ??= (async () => {
    signal?.removeEventListener('abort', abort);
    const failures = [];
    for (const operation of [() => http?.close(), () => feishu?.stop(), () => catchup?.stop(), () => runtime?.stop(), () => codex?.close(), () => store ? store.close() : pool.end(), () => reporter?.close()]) {
      try { await operation(); } catch { failures.push(true); }
    }
    if (failures.length) throw new Error('service_shutdown_failed');
  })();
  try {
    store = await factories.store({ pool, onWriterLost: () => { writerHealthy = false; log('error', 'store_writer', 'failed', { code: 'writer_lost' }); } });
    checkCancelled();
    codex = factories.codex({ bin, cwd, env: childEnv, threadDefaults: { approvalPolicy: 'never', sandbox: 'workspace-write', ...(config.codex.model ? { model: config.codex.model } : {}) } }, {
      onNotification: message => runtime.notification(message), onFault: event => runtime.onFault(event), log,
    });
    // Raw SDK logging can contain credentials or request content. Disable it.
    const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
    const proxyAgent = config.feishu.httpProxyEnv ? factories.feishuProxyAgent(secret(env, config.feishu.httpProxyEnv)) : undefined;
    const httpInstance = boundedFeishuHttp(factories.sdk.defaultHttpInstance, { proxyAgent });
    const client = new factories.sdk.Client({ ...credentials, logger, httpInstance });
    const chat = factories.chat({ client, maxMediaBytes: 28 * 1024 * 1024 });
    const media = await factories.media({ chat, workspace: cwd, inboxDir: resolve(cwd, '.agent-chat-bridge/inbox'), maxTotalBytes: config.feishu.mediaBudgetBytes, log });
    const outbound = await factories.outbound({ chat, workspace: cwd, outboxDir: resolve(cwd, '.agent-chat-bridge/outbox'), spoolDir: resolve(cwd, '.agent-chat-bridge/outbound-spool'), maxTotalBytes: config.feishu.outputBudgetBytes, log });
    checkCancelled();
    runtime = createRuntime({ config, store, codex, chat, media, outbound, workspace: cwd, hookTokens, log });
    feishu = factories.feishu({ sdk: factories.sdk, wsClient: new factories.sdk.WSClient({ ...credentials, logger, httpInstance, ...(proxyAgent ? { agent: proxyAgent } : {}) }), connectionId: config.feishu.connectionId, botOpenId: config.feishu.botOpenId, onEvent: runtime.ingest, log });
    const api = createApi({ config, store, chat, tokens });
    await Promise.race([codex.start(), cancelled]);
    checkCancelled();
    await Promise.race([feishu.start(), cancelled]);
    checkCancelled();
    if (config.feishu.catchup !== false) catchup = factories.catchup({ connectionId: config.feishu.connectionId, botOpenId: config.feishu.botOpenId, chat, store, onEvent: runtime.ingest, listConversations: () => listCatchupConversations({ config, store }), log });
    runtime.start();
    catchup?.start();
    http = await startServer({ config, log, api, readiness: async () => {
      let storeReady = writerHealthy;
      try { await store.assertCurrent(); } catch { storeReady = false; }
      const components = { store: storeReady, codex: codex.status().state === 'ready', feishu: feishu.status().connected, workers: runtime.status().running };
      return { ready: Object.values(components).every(Boolean), components };
    } });
    checkCancelled();
    signal?.removeEventListener('abort', abort);
    return { server: http.server, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
