import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as sdk from '@larksuiteoapi/node-sdk';
import { ConfigError } from './config.mjs';
import { createPoolFromEnvironment } from './storage/connection.mjs';
import { createMysqlStore } from './storage/store.mjs';
import { migrate } from './storage/migrations.mjs';
import { createCodexAdapter } from './agents/codex/adapter.mjs';
import { createFeishuAdapter } from './channels/feishu/adapter.mjs';
import { createFeishuChatClient } from './channels/feishu/chat-client.mjs';
import { createRuntime } from './core/runtime.mjs';
import { createApi } from './core/api.mjs';
import { startServer } from './server.mjs';
import { createLogger, createErrorReporter } from './logger.mjs';

function secret(env, key) {
  if (typeof env[key] !== 'string' || !env[key]) throw new ConfigError('required_environment_missing');
  return env[key];
}
export async function migrateService({ config, env = process.env }) {
  if (!config.storage) throw new ConfigError('storage_unconfigured');
  const pool = createPoolFromEnvironment(config.storage, env);
  try { return await migrate(pool); } finally { await pool.end(); }
}
export function boundedFeishuHttp(base) {
  const options = value => ({ ...value, timeout: 10000, maxContentLength: 24 * 1024 * 1024, maxBodyLength: 24 * 1024 * 1024, maxRedirects: 0 });
  const http = { request: value => base.request(options(value)) };
  for (const method of ['get', 'delete', 'head', 'options']) http[method] = (url, value) => base[method](url, options(value));
  for (const method of ['post', 'put', 'patch']) http[method] = (url, data, value) => base[method](url, data, options(value));
  return http;
}
export async function startService({ config, configPath, env = process.env, log }) {
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
  const childEnv = Object.fromEntries(config.codex.envNames.map(name => [name, secret(env, name)]));
  const tokens = Object.fromEntries(config.auth.clients.map(client => [client.id, secret(env, client.tokenEnv)]));
  const hookTokens = Object.fromEntries(config.hooks.map(hook => [hook.id, secret(env, hook.tokenEnv)]));
  const credentials = { appId: secret(env, config.feishu.appIdEnv), appSecret: secret(env, config.feishu.appSecretEnv) };
  const reporter = config.errorReporting ? createErrorReporter({ url: config.errorReporting.url, token: secret(env, config.errorReporting.tokenEnv), warn: log }) : undefined;
  if (reporter) log = createLogger(process.stdout, { reportError: reporter.report });
  const pool = createPoolFromEnvironment(config.storage, env);
  let store, codex, feishu, runtime, http;
  let writerHealthy = true;
  let closing;
  const close = () => closing ??= (async () => {
    const failures = [];
    for (const operation of [() => http?.close(), () => feishu?.stop(), () => runtime?.stop(), () => codex?.close(), () => store ? store.close() : pool.end(), () => reporter?.close()]) {
      try { await operation(); } catch { failures.push(true); }
    }
    if (failures.length) throw new Error('service_shutdown_failed');
  })();
  try {
    store = await createMysqlStore({ pool, onWriterLost: () => { writerHealthy = false; log('error', 'store_writer', 'failed', { code: 'writer_lost' }); } });
    codex = createCodexAdapter({ bin, cwd, env: childEnv, threadDefaults: { approvalPolicy: 'never', sandbox: 'workspace-write', ...(config.codex.model ? { model: config.codex.model } : {}) } }, {
      onNotification: message => runtime.notification(message), onFault: event => runtime.onFault(event), log,
    });
    // Raw SDK logging can contain credentials or request content. Disable it.
    const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
    const httpInstance = boundedFeishuHttp(sdk.defaultHttpInstance);
    const client = new sdk.Client({ ...credentials, logger, httpInstance });
    const chat = createFeishuChatClient({ client });
    runtime = createRuntime({ config, store, codex, chat, hookTokens, log });
    feishu = createFeishuAdapter({ sdk, wsClient: new sdk.WSClient({ ...credentials, logger, httpInstance }), connectionId: config.feishu.connectionId, botOpenId: config.feishu.botOpenId, onEvent: runtime.ingest, log });
    const api = createApi({ config, store, chat, tokens });
    await codex.start();
    await feishu.start();
    runtime.start();
    http = await startServer({ config, log, api, readiness: async () => {
      let storeReady = writerHealthy;
      try { await store.assertCurrent(); } catch { storeReady = false; }
      const components = { store: storeReady, codex: codex.status().state === 'ready', feishu: feishu.status().connected, workers: runtime.status().running };
      return { ready: Object.values(components).every(Boolean), components };
    } });
    return { server: http.server, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
