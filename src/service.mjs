import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as sdk from '@larksuiteoapi/node-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ConfigError } from './config.mjs';
import { createPoolFromEnvironment, storageConnectionReferences } from './storage/connection.mjs';
import { createMysqlStore } from './storage/store.mjs';
import { StoreError } from './storage/errors.mjs';
import { migrate } from './storage/migrations.mjs';
import { createCodexExecutor } from './agents/codex/executor.mjs';
import { createCodexSessionStore } from './storage/codex-sessions.mjs';
import { createForwardJobStore } from './storage/forward-jobs.mjs';
import { createInboundMessageStore } from './storage/inbound-messages.mjs';
import { createFeishuAdapter } from './channels/feishu/adapter.mjs';
import { createFeishuChatClient } from './channels/feishu/chat-client.mjs';
import { createFeishuMedia, resolveMediaInboxDir, sendOutboundAttachment } from './channels/feishu/media.mjs';
import { createOutboundMedia } from './channels/feishu/outbound-media.mjs';
import { createProcessingTyping } from './channels/feishu/typing.mjs';
import { createForwardRuntime } from './core/forward-runtime.mjs';
import { createCommunicationRuntime } from './core/communication-runtime.mjs';
import { createCardTextProvider } from './channels/feishu/card-text.mjs';
import { createExecutionFeedback } from './channels/feishu/execution-feedback.mjs';
import { createUserInputRuntime } from './channels/feishu/user-input-runtime.mjs';
import { createBusinessCardAction } from './channels/feishu/business-card-action.mjs';
import { createFeishuReplies } from './channels/feishu/replies.mjs';
import { createCatchup } from './core/catchup.mjs';
import { listCatchupConversations } from './core/conversations.mjs';
import { startServer } from './server.mjs';
import { createLogger, createErrorReporter, safeObserver } from './logger.mjs';
import { resolveSharedHome } from './agents/codex/idle-lifecycle.mjs';

function secret(env, key) {
  if (typeof env[key] !== 'string' || !env[key]) throw new ConfigError('required_environment_missing');
  return env[key];
}
export async function migrateService({ config, env = process.env, legacyConnectionId }) {
  if (!config.storage) throw new ConfigError('storage_unconfigured');
  const pool = createPoolFromEnvironment(storageConnectionReferences(config.storage), env);
  try { return await migrate(pool, { legacyConnectionId }); } finally { await pool.end(); }
}
export function createFeishuProxyAgent(value, options) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.hash) throw new Error('invalid');
    return new HttpsProxyAgent(url, options);
  } catch { throw new ConfigError('invalid_feishu_proxy'); }
}
export function boundedFeishuHttp(base, { proxyAgent, mediaDownloadTimeoutMs = 120000 } = {}) {
  const options = (value, url = value?.url) => ({ ...value,
    timeout: String(url || '').includes('/im/v1/messages/') && String(url || '').includes('/resources/') ? mediaDownloadTimeoutMs : 10000,
    maxContentLength: 32 * 1024 * 1024, maxBodyLength: 32 * 1024 * 1024, maxRedirects: 0,
    ...(proxyAgent ? { proxy: false, httpAgent: proxyAgent, httpsAgent: proxyAgent } : {}) });
  const http = { request: value => base.request(options(value)) };
  for (const method of ['get', 'delete', 'head', 'options']) http[method] = (url, value) => base[method](url, options(value, url));
  for (const method of ['post', 'put', 'patch']) http[method] = (url, data, value) => base[method](url, data, options(value, url));
  return http;
}
export async function startService({ config, configPath, env = process.env, log, signal, onRestartRequired = async () => {}, dependencies = {} }) {
  log = safeObserver(log);
  if (signal?.aborted) throw new ConfigError('startup_cancelled');
  if (!config.storage) return startServer({ config, log });
  const root = dirname(resolve(configPath));
  const cwd = resolve(root, config.codex.cwd);
  const bin = resolve(root, config.codex.bin);
  const cardTextProvider = createCardTextProvider({ file: config.feishu.cardTextFile ? resolve(cwd, config.feishu.cardTextFile) : undefined, root: cwd, log });
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
  const sharedHome = resolveSharedHome({
    configuredHome: config.codex.sharedHome,
    inheritedHome: env.CODEX_HOME ?? '',
    home: env.HOME,
  });
  const hookTokens = Object.fromEntries(config.hooks.map(hook => [hook.id, secret(env, hook.tokenEnv)]));
  const inboundTokens = Object.fromEntries(config.hooks.filter(hook => hook.inbound)
    .map(hook => [hook.id, secret(env, hook.inbound.tokenEnv)]));
  if (new Set(Object.values(inboundTokens)).size !== Object.keys(inboundTokens).length) {
    throw new ConfigError('duplicate_inbound_token');
  }
  const credentials = { appId: secret(env, config.feishu.appIdEnv), appSecret: secret(env, config.feishu.appSecretEnv) };
  const reporter = config.errorReporting ? createErrorReporter({ url: config.errorReporting.url, token: secret(env, config.errorReporting.tokenEnv), warn: log }) : undefined;
  if (reporter) log = createLogger(process.stdout, { reportError: reporter.report });
  const factories = { pool: createPoolFromEnvironment, store: createMysqlStore, executor: createCodexExecutor, sessions: createCodexSessionStore, jobs: createForwardJobStore, inbound: createInboundMessageStore, feedback: createExecutionFeedback, userInput: createUserInputRuntime, businessCardAction: createBusinessCardAction, replies: createFeishuReplies, typing: createProcessingTyping, communication: createCommunicationRuntime, forward: createForwardRuntime, feishu: createFeishuAdapter, chat: createFeishuChatClient, media: createFeishuMedia, outbound: createOutboundMedia, catchup: createCatchup, server: startServer, feishuProxyAgent: createFeishuProxyAgent, sdk, ...dependencies };
  const pool = factories.pool(storageConnectionReferences(config.storage), env);
  let store, executor, userInput, businessCardAction, feishu, communication, forward, catchup, http, media, outbound;
  const cardOperations = new Set();
  let acceptCardOperations = true;
  const runCardOperation = operation => {
    const pending = Promise.resolve().then(operation).finally(() => cardOperations.delete(pending));
    cardOperations.add(pending);
    pending.catch(() => {});
    return pending;
  };
  const handleCardOperation = operation => {
    if (!acceptCardOperations) return Promise.resolve({ toast: { type: 'error', content: '服务正在关闭，请稍后重试' } });
    return runCardOperation(operation);
  };
  let writerHealthy = true;
  let stopping = false;
  let closing;
  let fatalShutdown;
  let fatalShutdownDeadlineAt;
  let healthWatchdog;
  let healthChecking = false;
  let resolveWriterLost;
  const writerLost = new Promise(resolve => { resolveWriterLost = resolve; });
  let rejectCancelled;
  const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
  cancelled.catch(() => {});
  const abort = () => {
    stopping = true;
    rejectCancelled(new ConfigError('startup_cancelled'));
    safeObserver(() => feishu?.stop())();
    safeObserver(() => executor?.close())();
  };
  const checkCancelled = () => { if (signal?.aborted) throw new ConfigError('startup_cancelled'); };
  const stoppedError = () => writerHealthy
    ? new ConfigError('startup_cancelled')
    : Object.assign(new StoreError('writer_lock_lost'), { reason: 'writer_lost' });
  signal?.addEventListener('abort', abort, { once: true });
  const close = () => closing ??= (async () => {
    stopping = true;
    clearInterval(healthWatchdog);
    signal?.removeEventListener('abort', abort);
    acceptCardOperations = false;
    const failures = [];
    forward?.beginStop?.();
    // Invoke every ingress/claim stop synchronously before awaiting drains so a
    // slow listener cannot leave another worker accepting new work.
    const ingressClosing = [() => http?.close(), () => feishu?.stop(), () => catchup?.stop(), () => communication?.stop()]
      .map(operation => { try { return Promise.resolve(operation()); } catch (error) { return Promise.reject(error); } });
    const ingressResults = await Promise.allSettled(ingressClosing);
    if (ingressResults.some(result => result.status === 'rejected')) failures.push(true);
    try { await userInput?.close(); } catch { failures.push(true); }
    while (cardOperations.size) {
      const cardResults = await Promise.allSettled([...cardOperations]);
      if (cardResults.some(result => result.status === 'rejected')) failures.push(true);
    }
    const executorClosing = Promise.resolve().then(() => executor?.close());
    try { await forward?.stop(); } catch { failures.push(true); }
    try { await executorClosing; } catch { failures.push(true); }
    for (const operation of [() => media?.release?.(), () => outbound?.close?.()]) {
      try { await operation(); } catch { failures.push(true); }
    }
    for (const operation of [() => store ? store.close() : pool.end(), () => reporter?.close()]) {
      try { await operation(); } catch { failures.push(true); }
    }
    if (failures.length) throw new Error('service_shutdown_failed');
  })();
  const ensureWriterHealthy = () => {
    if (!writerHealthy) throw Object.assign(new StoreError('writer_lock_lost'), { reason: 'writer_lost' });
  };
  const cleanupLateComponent = async (component, operation) => {
    const remainingMs = fatalShutdownDeadlineAt === undefined
      ? config.storage.writer.lostShutdownMs
      : Math.max(0, fatalShutdownDeadlineAt - Date.now());
    let timer;
    let timedOut = false;
    const cleanup = Promise.resolve().then(operation).catch(() => {
      log('warning', 'late_component_cleanup', 'failed', { code: 'cleanup_failed', reason: component });
    });
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => { timedOut = true; resolve(); }, remainingMs);
    });
    await Promise.race([cleanup, timeout]);
    clearTimeout(timer);
    if (timedOut) log('warning', 'late_component_cleanup', 'timeout', { code: 'cleanup_timeout', reason: component, durationMs: remainingMs });
  };
  const requestFatalShutdown = ({ reason, code, operation, durationMs = 0, consecutiveMisses = 0, restartReason }) => {
    if (fatalShutdown) {
      log('warning', operation, 'duplicate', { code, reason, consecutiveMisses, durationMs });
      return fatalShutdown;
    }
    stopping = true;
    fatalShutdownDeadlineAt = Date.now() + config.storage.writer.lostShutdownMs;
    log('error', operation, 'failed', { code, reason, consecutiveMisses, durationMs });
    const shutdown = async () => {
      let forced = false;
      let deadline;
      const timeout = new Promise(resolve => {
        deadline = setTimeout(() => { forced = true; resolve(); }, config.storage.writer.lostShutdownMs);
        deadline.unref?.();
      });
      await Promise.race([
        close().catch(() => log('error', 'service_shutdown', 'failed', { code: 'shutdown_failed', reason })),
        timeout,
      ]);
      clearTimeout(deadline);
      if (forced) log('error', 'service_shutdown', 'forced', { code: 'shutdown_timeout', reason, durationMs: config.storage.writer.lostShutdownMs });
      await onRestartRequired(restartReason, 1);
    };
    fatalShutdown = store ? shutdown() : new Promise(resolve => setImmediate(resolve)).then(shutdown);
    fatalShutdown.catch(() => {});
    return fatalShutdown;
  };
  const onWriterLost = error => {
    writerHealthy = false;
    resolveWriterLost();
    const reason = error?.reason ?? 'lock_not_held';
    const durationMs = Number.isSafeInteger(error?.durationMs) ? error.durationMs : 0;
    const consecutiveMisses = Number.isSafeInteger(error?.consecutiveMisses) ? error.consecutiveMisses : 0;
    requestFatalShutdown({ reason, code: 'writer_lost', operation: 'store_writer', durationMs, consecutiveMisses,
      restartReason: `writer_lost:${reason}` });
  };
  try {
    store = await factories.store({ pool, connectionId: config.feishu.connectionId, onWriterLost,
      writerProbeIntervalMs: config.storage.writer.probeIntervalMs,
      writerProbeTimeoutMs: config.storage.writer.probeTimeoutMs,
      writerProbeMaxMisses: config.storage.writer.probeMaxMisses,
      log });
    ensureWriterHealthy();
    checkCancelled();
    // The default pool has already validated this reference. Dependency-injected
    // unit stores may omit database credentials and use this inert identifier.
    const schema=typeof env[config.storage.databaseEnv]==='string'&&env[config.storage.databaseEnv]?env[config.storage.databaseEnv]:'bridge_test';
    const sessions=pool?.query?factories.sessions({pool,schema,connectionId:config.feishu.connectionId}):{};
    const jobs=factories.jobs({pool,connectionId:config.feishu.connectionId});
    const inbound=factories.inbound({pool,connectionId:config.feishu.connectionId});
    const allowedGroupChatIds = new Set(config.routing.groups
      .filter(group => group.capabilities.includes('bridge')).map(group => group.conversationId));
    const executorLog = (level, event = {}) => log(level, event.operation || 'codex_executor', event.status || 'unknown', {
      code: event.error_code || event.code,
      rpcMethod: event.rpc_method,
      stage: event.stage,
    });
    const executorConfig = {
      bin,
      cwd,
      sharedHome,
      serviceName: config.feishu.displayName || 'Agent Chat Bridge',
      approvalPolicy: config.codex.approvalPolicy,
      approvalsReviewer: config.codex.approvalsReviewer,
      sandbox: config.codex.sandbox,
      model: config.codex.model,
      reasoningEffort: config.codex.reasoningEffort,
      networkAccess: config.codex.networkAccess,
      requestUserInput: config.codex.requestUserInput,
      threadNamePrefix: config.codex.threadNamePrefix,
      idleCloseMs: config.codex.idleCloseMs,
      closeGraceMs: config.codex.closeGraceMs,
      rpcTimeoutMs: config.codex.rpcTimeoutMs,
      turnTimeoutMs: config.codex.turnTimeoutMs,
      rolloverIdleMs: config.codex.rolloverIdleMs,
      rolloverCheckTimeoutMs: config.codex.rolloverCheckTimeoutMs,
      rolloverOnRulesUpdate: config.codex.rolloverOnRulesUpdate,
      rulesPaths: config.codex.rulesFiles,
      memoryCheckIntervalMs: config.codex.memoryCheckIntervalMs,
      memoryMaxRssBytes: config.codex.memoryMaxRssBytes,
      memoryMaxHeapUsedBytes: config.codex.memoryMaxHeapUsedBytes,
      maxOutputChars: config.feishu.maxOutputChars,
      outboxRelativeRoot: 'data/feishu-outbox',
      allowedGroupChatIds,
    };
    executor=factories.executor({config:executorConfig,sessionStore:sessions,childEnv,log:executorLog,
      onUserInput:event=>userInput?.open(event),onUserInputClosed:event=>userInput?.expire(event),onRestartRequired:async reason=>{
      log('warning','codex_executor','restart_required',{code:reason});
      await close();
      await onRestartRequired(reason);
    }});
    // Raw SDK logging can contain credentials or request content. Disable it.
    const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
    const proxyAgent = config.feishu.httpProxyEnv ? factories.feishuProxyAgent(secret(env, config.feishu.httpProxyEnv)) : undefined;
    const httpInstance = boundedFeishuHttp(factories.sdk.defaultHttpInstance, { proxyAgent,
      mediaDownloadTimeoutMs: config.feishu.mediaDownloadTimeoutMs });
    const client = new factories.sdk.Client({ ...credentials, logger, httpInstance });
    const chat = factories.chat({ client, maxMediaBytes: 28 * 1024 * 1024 });
    const createdMedia = await factories.media({ chat, inboxDir: resolveMediaInboxDir(config.feishu.mediaInboxDir, cwd),
      enabled: config.feishu.mediaEnabled, maxBytes: config.feishu.mediaMaxBytes,
      downloadTimeoutMs: config.feishu.mediaDownloadTimeoutMs, log });
    if (stopping) {
      await cleanupLateComponent('media', () => createdMedia?.release?.());
      throw stoppedError();
    }
    media = createdMedia;
    const createdOutbound = await factories.outbound({ chat, workspace: cwd,
      outboxDir: resolve(cwd, '.agent-chat-bridge/outbox'),
      bindingOutboxDir: resolve(cwd, 'data/feishu-outbox'),
      spoolDir: resolve(cwd, '.agent-chat-bridge/outbound-spool'),
      allowedGroupChatIds, maxTotalBytes: config.feishu.outputBudgetBytes, log });
    if (stopping) {
      await cleanupLateComponent('outbound', () => createdOutbound?.close?.());
      throw stoppedError();
    }
    outbound = createdOutbound;
    checkCancelled();
    const replies=factories.replies({chat,outbound,jobs,connectionId:config.feishu.connectionId,workspace:cwd,allowedGroupChatIds,
      sendAttachment: input => sendOutboundAttachment({ client, ...input }),
      replyAsPost:config.feishu.replyAsPost,maxOutputChars:config.feishu.maxOutputChars,log});
    const stopAuthorize=async({actor,conversationId,conversationType})=>{const group=config.routing.groups.find(item=>item.conversationId===conversationId);return Boolean(actor?.openId&&(config.routing.privateUserIds.includes(actor.openId)||(conversationType==='p2p'&&config.routing.allowAllPrivateUsers===true)||(group?.capabilities.includes('bridge')&&(group.userIds===undefined||group.userIds.includes(actor.openId)))));};
    userInput=factories.userInput({jobs,executor,cardClient:client,authorize:stopAuthorize,
      runAsync:runCardOperation,config:{displayName:config.feishu.displayName,cardTextProvider},log});
    const typing=factories.typing({chat,inbound,enabled:config.feishu.processingReaction,
      emoji:config.feishu.processingReactionEmoji,fallbackText:config.feishu.processingFallbackText,log});
    const feedback=factories.feedback({jobs,sessions,chat,typing,cardClient:client,authorize:stopAuthorize,executor,workspace:cwd,
      runAsync:runCardOperation,config:{executionCardIntervalMs:1000,displayName:config.feishu.displayName,cardTextProvider},log});
    forward=factories.forward({config:{
      steering:config.codex.steering,
      pollMs:config.codex.jobPollMs,
      retryDelayMs:config.codex.jobRetryMs,
      maxAttempts:config.codex.jobMaxAttempts,
      executeTimeoutMs:config.codex.turnTimeoutMs+10_000,
    },jobs,sessions,inbound,media,executor,feedback,replies,authorize:async()=>true,log});
    communication=factories.communication({config,store,inbound,forward,chat,outbound,hookTokens,log});
    businessCardAction=factories.businessCardAction({hooks:config.hooks,ingest:communication.ingestCardAction,
      runAsync:runCardOperation,log});
    feishu = factories.feishu({ sdk: factories.sdk, wsClient: new factories.sdk.WSClient({ ...credentials, logger, httpInstance, ...(proxyAgent ? { agent: proxyAgent } : {}) }), connectionId: config.feishu.connectionId, botOpenId: config.feishu.botOpenId, onEvent: communication.ingest,
      onCardAction: payload => handleCardOperation(async()=>{
        const business=businessCardAction.handleCardAction(payload);if(business)return business;
        const answered=await userInput.handleCardAction(payload); return answered??feedback.handleCardAction(payload);
      }), log });
    const readiness = async () => {
      let storeReady = writerHealthy;
      try { await store.assertCurrent(); } catch { storeReady = false; }
      const executorStatus=executor.status();
      const components = { store: storeReady, codex: !executorStatus.closing&&!executorStatus.restartPending&&!executorStatus.fault, feishu: feishu.status().connected, workers: forward.status().running&&communication.status().running };
      return { ready: !stopping && Object.values(components).every(Boolean), components };
    };
    const createdHttp = await factories.server({ config, log, readiness, eventRuntime: forward, inboundTokens });
    if (stopping) {
      await cleanupLateComponent('server', () => createdHttp?.close?.());
      throw stoppedError();
    }
    http = createdHttp;
    await Promise.race([feishu.start(), cancelled, writerLost]);
    ensureWriterHealthy();
    checkCancelled();
    if (stopping) throw stoppedError();
    if (config.feishu.catchup !== false) catchup = factories.catchup({ connectionId: config.feishu.connectionId, botOpenId: config.feishu.botOpenId, chat, store, onEvent: communication.ingest, listConversations: () => listCatchupConversations({ config, store }), log });
    forward.start();
    communication.start();
    catchup?.start();
    const unhealthySince = new Map();
    const checkHealth = async () => {
      if (stopping || healthChecking) return;
      healthChecking = true;
      try {
        const { components } = await readiness();
        const checkedAt = Date.now();
        for (const component of ['store', 'workers']) {
          const healthy = components[component];
          if (healthy) unhealthySince.delete(component);
          else if (!unhealthySince.has(component)) unhealthySince.set(component, checkedAt);
        }
        const failed = [...unhealthySince].find(([, since]) => checkedAt - since >= config.runtime.unhealthyExitMs);
        if (failed) requestFatalShutdown({ reason: failed[0], code: 'runtime_unhealthy', operation: 'service_health',
          durationMs: checkedAt - failed[1], restartReason: `unhealthy:${failed[0]}` });
      } finally { healthChecking = false; }
    };
    const healthIntervalMs = Math.min(config.runtime.unhealthyExitMs, config.storage.writer.probeIntervalMs);
    healthWatchdog = setInterval(() => { Promise.resolve(checkHealth()).catch(() => {}); }, healthIntervalMs);
    healthWatchdog.unref?.();
    await checkHealth();
    if (stopping) throw stoppedError();
    signal?.removeEventListener('abort', abort);
    return { server: http.server, close };
  } catch (error) {
    if (fatalShutdown) {
      await fatalShutdown.catch(() => {});
      throw error;
    }
    await close().catch(() => {});
    throw error;
  }
}
