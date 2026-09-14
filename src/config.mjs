import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';

export class ConfigError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function object(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new ConfigError(code);
  }
}

export function isLoopback(host) {
  return host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127');
}

export function validateConfig(raw) {
  object(raw, ['schemaVersion', 'listen', 'auth', 'storage', 'codex', 'feishu', 'routing', 'hooks', 'errorReporting'], 'invalid_config_fields');
  if (raw.schemaVersion !== 1) throw new ConfigError('unsupported_config_version');
  const listen = raw.listen === undefined ? {} : raw.listen;
  object(listen, ['host', 'port', 'allowRemote'], 'invalid_listen_fields');
  const { host = '127.0.0.1', port = 18830, allowRemote = false } = listen;
  if (typeof host !== 'string' || !isIP(host)) throw new ConfigError('invalid_listen_host');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError('invalid_listen_port');
  if (typeof allowRemote !== 'boolean') throw new ConfigError('invalid_remote_flag');
  if (!isLoopback(host) && !allowRemote) throw new ConfigError('remote_listen_not_allowed');

  let tokenEnv;
  if (raw.auth !== undefined) {
    object(raw.auth, ['tokenEnv', 'clients'], 'invalid_auth_fields');
    tokenEnv = raw.auth.tokenEnv;
    if (tokenEnv !== undefined && (typeof tokenEnv !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(tokenEnv))) {
      throw new ConfigError('invalid_token_env_reference');
    }
  }
  const runtime = validateRuntime(raw);
  return Object.freeze({
    schemaVersion: 1,
    listen: Object.freeze({ host, port, allowRemote }),
    auth: raw.auth ? Object.freeze({ ...(tokenEnv ? { tokenEnv } : {}), ...(runtime.auth ?? {}) }) : undefined,
    ...runtime.components,
  });
}

function string(value, code = 'invalid_runtime_config') {
  if (typeof value !== 'string' || !value || value.length > 2048) throw new ConfigError(code);
  return value;
}
function reference(value) {
  if (typeof value !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(value)) throw new ConfigError('invalid_environment_reference');
  return value;
}
// Codex receives only explicitly selected names. Lowercase proxy variables are
// conventional environment names; secret-reference fields retain uppercase-only
// validation and this does not enable ambient environment inheritance.
function codexEnvironmentName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) throw new ConfigError('invalid_environment_reference');
  return value;
}
function strings(value) {
  if (!Array.isArray(value) || value.length > 1000) throw new ConfigError('invalid_scope');
  return [...new Set(value.map(v => string(v)))];
}
function identifier(value, max) {
  const result = string(value);
  if (result.length > max) throw new ConfigError('invalid_identifier_length');
  return result;
}
function validateRuntime(raw) {
  const enabled = ['storage', 'codex', 'feishu', 'routing'].some(key => raw[key] !== undefined);
  if (!enabled) {
    if (raw.hooks !== undefined || raw.auth?.clients !== undefined || raw.errorReporting !== undefined) throw new ConfigError('runtime_components_required');
    return { components: {} };
  }
  for (const key of ['storage', 'codex', 'feishu', 'routing']) if (!raw[key]) throw new ConfigError('runtime_components_required');
  object(raw.storage, ['hostEnv', 'portEnv', 'userEnv', 'passwordEnv', 'databaseEnv'], 'invalid_storage_fields');
  const storage = Object.fromEntries(['hostEnv', 'portEnv', 'userEnv', 'passwordEnv', 'databaseEnv'].map(key => [key, reference(raw.storage[key])]));
  object(raw.codex, ['bin', 'cwd', 'sharedHome', 'envNames', 'model', 'idleCloseMs', 'rolloverIdleMs', 'rolloverOnRulesUpdate', 'rulesFiles', 'steering', 'proxyEnv', 'jobRetryMs', 'jobMaxAttempts'], 'invalid_codex_fields');
  const codex = { bin: string(raw.codex.bin), cwd: string(raw.codex.cwd), envNames: strings(raw.codex.envNames ?? []).map(codexEnvironmentName) };
  if (raw.codex.sharedHome !== undefined) codex.sharedHome = string(raw.codex.sharedHome);
  if (raw.codex.proxyEnv !== undefined) {
    object(raw.codex.proxyEnv, ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'], 'invalid_codex_proxy_fields');
    codex.proxyEnv = Object.fromEntries(Object.entries(raw.codex.proxyEnv).map(([name, source]) => [name, reference(source)]));
  }
  if (raw.codex.model !== undefined) codex.model = string(raw.codex.model);
  codex.steering = raw.codex.steering ?? true;
  if (typeof codex.steering !== 'boolean') throw new ConfigError('invalid_steering_flag');
  codex.jobRetryMs = raw.codex.jobRetryMs ?? 60_000;
  if (!Number.isSafeInteger(codex.jobRetryMs) || codex.jobRetryMs < 10_000 || codex.jobRetryMs > 1_800_000) throw new ConfigError('invalid_codex_job_retry');
  codex.jobMaxAttempts = raw.codex.jobMaxAttempts ?? 3;
  if (!Number.isInteger(codex.jobMaxAttempts) || codex.jobMaxAttempts < 1 || codex.jobMaxAttempts > 10) throw new ConfigError('invalid_codex_job_attempts');
  codex.idleCloseMs = raw.codex.idleCloseMs ?? 60_000;
  if (!Number.isSafeInteger(codex.idleCloseMs) || codex.idleCloseMs < 0 || codex.idleCloseMs > 24 * 60 * 60 * 1000) throw new ConfigError('invalid_codex_idle_close');
  codex.rolloverIdleMs = raw.codex.rolloverIdleMs ?? 2 * 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(codex.rolloverIdleMs) || codex.rolloverIdleMs < 0 || codex.rolloverIdleMs > 365 * 24 * 60 * 60 * 1000) throw new ConfigError('invalid_idle_rollover');
  codex.rolloverOnRulesUpdate = raw.codex.rolloverOnRulesUpdate ?? true;
  if (typeof codex.rolloverOnRulesUpdate !== 'boolean') throw new ConfigError('invalid_rules_rollover');
  codex.rulesFiles = strings(raw.codex.rulesFiles ?? ['AGENTS.md']);
  if (codex.rulesFiles.length > 20 || codex.rulesFiles.some(path => path.startsWith('/') || path.split(/[\\/]/).includes('..'))) throw new ConfigError('invalid_rules_files');
  object(raw.feishu, ['connectionId', 'appIdEnv', 'appSecretEnv', 'botOpenId', 'displayName', 'catchup', 'mediaBudgetBytes', 'outputBudgetBytes', 'httpProxyEnv', 'replyAsPost', 'maxOutputChars', 'processingReaction', 'processingReactionEmoji', 'processingFallbackText', 'mediaEnabled', 'mediaInboxDir', 'mediaMaxBytes', 'mediaUnsupportedReply'], 'invalid_feishu_fields');
  if (raw.feishu.catchup !== undefined && typeof raw.feishu.catchup !== 'boolean') throw new ConfigError('invalid_catchup_flag');
  const feishu = { connectionId: identifier(raw.feishu.connectionId, 128), appIdEnv: reference(raw.feishu.appIdEnv), appSecretEnv: reference(raw.feishu.appSecretEnv), botOpenId: identifier(raw.feishu.botOpenId, 512) };
  feishu.displayName = raw.feishu.displayName === undefined ? 'agent-chat-bridge' : identifier(raw.feishu.displayName, 80);
  feishu.replyAsPost = raw.feishu.replyAsPost ?? true;
  if (typeof feishu.replyAsPost !== 'boolean') throw new ConfigError('invalid_feishu_reply_mode');
  feishu.maxOutputChars = raw.feishu.maxOutputChars ?? 3500;
  if (!Number.isSafeInteger(feishu.maxOutputChars) || feishu.maxOutputChars < 1 || feishu.maxOutputChars > 1_000_000) throw new ConfigError('invalid_feishu_output_chars');
  if (raw.feishu.httpProxyEnv !== undefined) feishu.httpProxyEnv = reference(raw.feishu.httpProxyEnv);
  feishu.processingReaction = raw.feishu.processingReaction ?? true;
  if (typeof feishu.processingReaction !== 'boolean') throw new ConfigError('invalid_processing_reaction');
  feishu.processingReactionEmoji = raw.feishu.processingReactionEmoji === undefined ? 'Typing' : identifier(raw.feishu.processingReactionEmoji, 80);
  feishu.processingFallbackText = raw.feishu.processingFallbackText === undefined ? '收到，正在查询。' : String(raw.feishu.processingFallbackText);
  if (typeof raw.feishu.processingFallbackText !== 'undefined' && (typeof raw.feishu.processingFallbackText !== 'string' || raw.feishu.processingFallbackText.length > 1000)) throw new ConfigError('invalid_processing_fallback');
  feishu.mediaEnabled = raw.feishu.mediaEnabled ?? true;
  if (typeof feishu.mediaEnabled !== 'boolean') throw new ConfigError('invalid_media_enabled');
  if (raw.feishu.mediaInboxDir !== undefined) feishu.mediaInboxDir = string(raw.feishu.mediaInboxDir);
  feishu.mediaMaxBytes = raw.feishu.mediaMaxBytes ?? 20 * 1024 * 1024;
  if (!Number.isSafeInteger(feishu.mediaMaxBytes) || feishu.mediaMaxBytes < 0 || feishu.mediaMaxBytes > 1024 * 1024 * 1024) throw new ConfigError('invalid_media_max_bytes');
  feishu.mediaUnsupportedReply = raw.feishu.mediaUnsupportedReply === undefined ? '暂不支持处理「{{type}}」类型的附件，请改用文字、图片或飞书云文档链接。' : string(raw.feishu.mediaUnsupportedReply);
  feishu.catchup = raw.feishu.catchup ?? true;
  if (raw.feishu.mediaBudgetBytes !== undefined && (!Number.isSafeInteger(raw.feishu.mediaBudgetBytes) || raw.feishu.mediaBudgetBytes < 20 * 1024 * 1024 || raw.feishu.mediaBudgetBytes > 1024 * 1024 * 1024)) throw new ConfigError('invalid_media_budget');
  feishu.mediaBudgetBytes = raw.feishu.mediaBudgetBytes ?? 128 * 1024 * 1024;
  if (raw.feishu.outputBudgetBytes !== undefined && (!Number.isSafeInteger(raw.feishu.outputBudgetBytes) || raw.feishu.outputBudgetBytes < 28 * 1024 * 1024 || raw.feishu.outputBudgetBytes > 1024 * 1024 * 1024)) throw new ConfigError('invalid_output_budget');
  feishu.outputBudgetBytes = raw.feishu.outputBudgetBytes ?? 512 * 1024 * 1024;
  object(raw.routing, ['version', 'privateUserIds', 'groups'], 'invalid_routing_fields');
  if (!Array.isArray(raw.routing.groups) || raw.routing.groups.length > 1000) throw new ConfigError('invalid_group_scope');
  const groups = raw.routing.groups.map(group => {
    object(group, ['conversationId', 'userIds', 'trigger', 'passiveContext', 'name', 'description', 'capabilities'], 'invalid_group_fields');
    if (!['mention', 'all'].includes(group.trigger) || typeof group.passiveContext !== 'boolean') throw new ConfigError('invalid_group_policy');
    const capabilities=group.capabilities===undefined?['bridge','hook']:strings(group.capabilities);
    if(capabilities.some(value=>!['bridge','hook'].includes(value)))throw new ConfigError('invalid_group_capabilities');
    return { conversationId: identifier(group.conversationId, 255), ...(group.userIds === undefined ? {} : { userIds: strings(group.userIds) }), trigger: group.trigger, passiveContext: group.passiveContext, capabilities,
      ...(group.name === undefined ? {} : { name: string(group.name) }), ...(group.description === undefined ? {} : { description: string(group.description) }) };
  });
  if (new Set(groups.map(g => g.conversationId)).size !== groups.length) throw new ConfigError('duplicate_group');
  const routing = { version: string(raw.routing.version), privateUserIds: strings(raw.routing.privateUserIds), groups };
  if (!Array.isArray(raw.auth?.clients) || !raw.auth.clients.length || raw.auth.clients.length > 100 || raw.auth.tokenEnv !== undefined) throw new ConfigError('runtime_auth_clients_required');
  const clients = raw.auth.clients.map(client => {
    object(client, ['id', 'tokenEnv', 'conversationIds', 'admin'], 'invalid_client_fields');
    if (typeof client.admin !== 'boolean') throw new ConfigError('invalid_client_admin');
    return { id: identifier(client.id, 128), tokenEnv: reference(client.tokenEnv), conversationIds: strings(client.conversationIds).map(id => identifier(id, 255)), admin: client.admin };
  });
  if (new Set(clients.map(c => c.id)).size !== clients.length) throw new ConfigError('duplicate_client');
  if (!Array.isArray(raw.hooks ?? []) || (raw.hooks ?? []).length > 100) throw new ConfigError('invalid_hooks');
  const hooks = (raw.hooks ?? []).map(hook => {
    object(hook, ['id', 'url', 'tokenEnv', 'conversationIds', 'catchupGroupIds'], 'invalid_hook_fields');
    let url; try { url = new URL(hook.url); } catch { throw new ConfigError('invalid_hook_url'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new ConfigError('invalid_hook_url');
    const conversationIds = strings(hook.conversationIds).map(id => identifier(id, 255));
    const catchupGroupIds = strings(hook.catchupGroupIds ?? []).map(id => identifier(id, 255));
    if (catchupGroupIds.some(id => !conversationIds.includes(id))) throw new ConfigError('invalid_hook_catchup_scope');
    return { id: identifier(hook.id, 128), url: url.href, tokenEnv: reference(hook.tokenEnv), conversationIds, catchupGroupIds };
  });
  if (new Set(hooks.map(h => h.id)).size !== hooks.length) throw new ConfigError('duplicate_hook');
  let errorReporting;
  if (raw.errorReporting !== undefined) {
    object(raw.errorReporting, ['url', 'tokenEnv'], 'invalid_error_reporting');
    let url; try { url = new URL(raw.errorReporting.url); } catch { throw new ConfigError('invalid_error_reporting'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new ConfigError('invalid_error_reporting');
    errorReporting = { url: url.href, tokenEnv: reference(raw.errorReporting.tokenEnv) };
  }
  return { auth: { clients }, components: { storage, codex, feishu, routing, hooks, ...(errorReporting ? { errorReporting } : {}) } };
}

export async function loadConfig(path) {
  let text;
  try {
    text = await readFile(resolve(path), 'utf8');
  } catch {
    throw new ConfigError('config_unreadable');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    // JSON parser errors can contain user-supplied secrets. Never expose them.
    throw new ConfigError('invalid_config_json');
  }
  return validateConfig(raw);
}
