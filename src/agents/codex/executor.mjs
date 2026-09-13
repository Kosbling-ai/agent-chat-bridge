import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CodexAppServerClient } from './app-server-client.mjs';
import { buildInitialPrompt } from './prompt.mjs';
import { collectOutboxAttachments } from './outbound-files.mjs';
import { codexThreadCreatedAtMs, shouldRolloverForRules } from './codex-rules-rollover.mjs';
import { exactTurnSnapshot, inProgressTurnIds, isNoActiveTurnError, steerTurnWithMismatchRecovery, TurnRecoverySupersededError } from './codex-turn-recovery.mjs';
import { createPublicProgressProjector } from '../../shared/public-progress.mjs';

const textInput = (text) => ({ type: 'text', text, text_elements: [] });
const trim = (value) => String(value || '').trim();
const limitText = (value, max) => String(value || '').slice(0, max || undefined);
const stableKey = (value) => createHash('sha1').update(String(value || '')).digest('hex').slice(0, 24);
const bindingKey = ({ feishuOpenId, chatId }) => `${feishuOpenId || 'unknown'}:${chatId || 'unknown'}`;

function coded(message, code, { retryable = false, outcome } = {}) {
  const error = new Error(message); error.code = code; error.retryable = retryable;
  if (outcome) error.outcome = outcome;
  return error;
}

function parseDetail(row) {
  try { return JSON.parse(row?.detail_json || '{}'); } catch { return {}; }
}

function finalAnswer(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const final = [...items].reverse().find((item) => item?.type === 'agentMessage' && item.phase === 'final_answer' && trim(item.text));
  if (final) return trim(final.text);
  const message = [...items].reverse().find((item) => item?.type === 'message' && item.role === 'assistant' && item.phase === 'final_answer');
  if (message) return trim(codexMessageText(message));
  return trim([...items].reverse().find((item) => item?.type === 'agentMessage' && trim(item.text))?.text);
}

function codexMessageText(item = {}) {
  if (typeof item.text === 'string') return item.text;
  const content = Array.isArray(item.content) ? item.content : [];
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    return part.text || part.input_text || part.output_text || '';
  }).filter(Boolean).join('\n');
}

export function projectCodexItem(item) {
  switch (item?.type) {
    case 'message': {
      const text = codexMessageText(item);
      if (!text.trim()) return null;
      const role = item.role === 'user' ? 'user' : 'assistant';
      return { eventType: role === 'user' ? 'user_message' : 'agent_message', role, title: role === 'user' ? '用户' : (item.phase === 'final_answer' ? 'Codex 回复' : 'Codex'), text, detail: { phase: item.phase || '' } };
    }
    case 'function_call':
      return { eventType: 'tool_call', role: 'activity', title: `工具调用 · ${item.name || 'function'}`, text: '', detail: { callId: item.call_id || item.callId || '', name: item.name || '' } };
    case 'function_call_output':
      return { eventType: 'tool_output', role: 'activity', title: `工具结果${item.call_id ? ` · ${item.call_id}` : ''}`, text: '', detail: { callId: item.call_id || item.callId || '' } };
    case 'agentMessage':
      return { eventType: 'agent_message', role: 'assistant', title: item.phase === 'final_answer' ? 'Codex 回复' : 'Codex', text: item.text || '', detail: { phase: item.phase || '' } };
    case 'plan':
      return { eventType: 'plan', role: 'activity', title: '计划更新', text: item.text || '' };
    case 'reasoning': {
      const text = [...(item.summary || []), ...(item.content || [])].join('\n');
      return text.trim() ? { eventType: 'reasoning', role: 'activity', title: '推理摘要', text } : null;
    }
    case 'commandExecution':
      return { eventType: 'command_execution', role: 'activity', title: `运行命令${item.exitCode == null ? '' : ` · exit ${item.exitCode}`}`, text: '', detail: { status: item.status || '', exitCode: item.exitCode ?? null } };
    case 'fileChange':
      return { eventType: 'file_change', role: 'activity', title: '文件变更', text: (item.changes || []).map((change) => [change.kind || change.type || 'change', change.path || change.file || change.oldPath || change.newPath || ''].filter(Boolean).join(' ')).join('\n') };
    case 'mcpToolCall':
      return { eventType: 'tool_call', role: 'activity', title: `MCP 工具 · ${[item.server, item.tool].filter(Boolean).join('.')}`, text: '' };
    case 'dynamicToolCall':
      return { eventType: 'tool_call', role: 'activity', title: `工具调用 · ${[item.namespace, item.tool].filter(Boolean).join('.')}`, text: '' };
    case 'webSearch':
      return { eventType: 'web_search', role: 'activity', title: '网页搜索', text: item.query || '' };
    case 'contextCompaction':
      return { eventType: 'context_compaction', role: 'activity', title: '上下文压缩', text: 'Codex 已压缩上下文以继续会话。' };
    default:
      return null;
  }
}

function formatDurationShort(durationMs) {
  const value = Number(durationMs || 0);
  if (!Number.isFinite(value) || value <= 0) return '0ms';
  const dayMs = 24 * 60 * 60 * 1000;
  const hourMs = 60 * 60 * 1000;
  if (value % dayMs === 0) return `${Math.round(value / dayMs)} 天`;
  if (value % hourMs === 0) return `${Math.round(value / hourMs)} 小时`;
  return `${Math.round(value / 1000)} 秒`;
}

export function createCodexExecutor({ config, sessionStore, childEnv = {}, log = () => {}, spawnImpl, now = Date.now, onRestartRequired = async () => {} } = {}) {
  if (!config || !sessionStore) throw new Error('config and sessionStore are required');
  const locks = new Map();
  const activeByBinding = new Map();
  const activeByTurn = new Map();
  const earlyNotifications = new Map();
  const pendingStartThreads = new Set();
  const pendingKnownTurns = new Set();
  const loadedThreads = new Set();
  let memoryTimer;
  let closing = false;
  let restartPending = '';
  let restartNotified = false;

  const client = new CodexAppServerClient({
    config, childEnv, spawnImpl, log, now,
    eventSink: (event) => handleNotification(event),
    onDisconnect: (error) => handleDisconnect(error),
  });

  async function withKeyLock(key, operation) {
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((done) => { release = done; });
    const chained = previous.then(() => current, () => current);
    locks.set(key, chained);
    await previous.catch(() => {});
    try { return await operation(); }
    finally { release(); if (locks.get(key) === chained) locks.delete(key); }
  }

  function identity(input) {
    const feishuOpenId = trim(input.bindingOpenId);
    const chatId = trim(input.chatId);
    const chatType = trim(input.chatType) || 'p2p';
    if (!feishuOpenId || !chatId) throw coded('missing binding/chat identity', 'CODEX_INVALID_INPUT');
    return { feishuOpenId, chatId, chatType };
  }

  function threadDefaults(extra = {}) {
    return {
      cwd: config.cwd,
      approvalPolicy: config.approvalPolicy || 'auto',
      approvalsReviewer: config.approvalsReviewer || 'auto',
      sandbox: config.sandbox || 'workspace-write',
      ...(config.model ? { model: config.model } : {}),
      ...extra,
    };
  }

  async function startThread(actor) {
    const response = await client.request('thread/start', threadDefaults({
      serviceName: config.serviceName || 'Agent Chat Bridge',
      threadSource: 'user',
      ...(config.reasoningEffort ? { config: { model_reasoning_effort: config.reasoningEffort } } : {}),
    }));
    const threadId = trim(response?.thread?.id);
    if (!threadId) throw coded('Codex did not return a thread id', 'CODEX_THREAD_START_UNCONFIRMED', { outcome: 'unknown' });
    loadedThreads.add(threadId);
    return { threadId, threadName: buildThreadName(actor) };
  }

  function buildThreadName(actor) {
    const source = actor.feishuOpenId.startsWith('system:') ? actor.feishuOpenId : actor.chatType === 'p2p' ? actor.feishuOpenId : actor.chatId;
    const suffix = source.replace(/[^A-Za-z0-9_-]/g, '').slice(-12) || 'unknown';
    return `${config.threadNamePrefix || 'bridge'}-${actor.chatType === 'p2p' ? 'p2p' : 'group'}-${suffix}`;
  }

  async function ensureBinding(actor, messageId) {
    const existing = await sessionStore.loadBinding(actor);
    if (existing?.codexSessionId) return existing;
    const started = await startThread(actor);
    const binding = { ...actor, codexSessionId: started.threadId, threadName: started.threadName, created: true };
    await sessionStore.saveCodexBinding(binding, { messageId, lastError: '' });
    return binding;
  }

  async function ensureThreadReady(binding) {
    if (loadedThreads.has(binding.codexSessionId)) return;
    const response = await client.request('thread/resume', threadDefaults({ threadId: binding.codexSessionId,
      ...(config.reasoningEffort ? { config: { model_reasoning_effort: config.reasoningEffort } } : {}) }));
    const activeIds = inProgressTurnIds(response?.thread);
    if (activeIds.length) throw coded(`Codex thread contains an unbound active turn: ${activeIds.join(',')}`, 'CODEX_THREAD_HELD', { retryable: true, outcome: 'unknown' });
    loadedThreads.add(binding.codexSessionId);
  }

  async function maybeRollover(binding, messageId) {
    if (binding.created) return binding;
    if (config.rolloverOnRulesUpdate !== false && config.rulesPaths?.length) {
      const rulesMtimeMs = Math.max(0, ...config.rulesPaths.map((path) => { try { return statSync(resolve(config.cwd, path)).mtimeMs || 0; } catch { return 0; } }));
      if (rulesMtimeMs) {
        let detail;
        try {
          const response = await client.request('thread/read', { threadId: binding.codexSessionId, includeTurns: false }, { timeoutMs: config.rolloverCheckTimeoutMs });
          const thread = response?.thread || {};
          const threadCreatedAtMs = codexThreadCreatedAtMs(thread.createdAt || thread.created_at);
          detail = threadCreatedAtMs
            ? { shouldRollover: shouldRolloverForRules({ rulesMtimeMs, threadCreatedAtMs }), rulesMtimeMs, threadCreatedAtMs, threadPath: String(thread.path || '') }
            : { shouldRollover: false, rulesMtimeMs, skipped: 'native Codex thread createdAt is unavailable' };
        } catch { log('warning', { module: 'agent-chat-bridge', component: 'codex-executor', operation: 'rules_check', status: 'failed' }); }
        if (detail?.shouldRollover) return rollover(binding, messageId, 'rules_updated', {
          outText: 'Agent 规则文件已更新，后续飞书消息承接到新 Codex 会话。',
          inText: '因 Agent 规则文件已更新，本会话开始承接后续飞书消息。',
          detail,
        });
      }
    }
    const thresholdMs = Number(config.rolloverIdleMs || 0);
    const lastMessageAtMs = Number(binding.lastMessageAt || 0);
    if (!Number.isFinite(thresholdMs) || thresholdMs <= 0 || !Number.isFinite(lastMessageAtMs) || lastMessageAtMs <= 0) return binding;
    const nowMs = now();
    const idleMs = Math.max(0, nowMs - lastMessageAtMs);
    if (idleMs < thresholdMs) return binding;
    return rollover(binding, messageId, 'session_idle', {
      outText: `飞书会话已超过 ${formatDurationShort(thresholdMs)} 无新消息，后续飞书消息承接到新 Codex 会话。`,
      inText: `因原会话已超过 ${formatDurationShort(thresholdMs)} 无新消息，本会话开始承接后续飞书消息。`,
      detail: { shouldRollover: true, thresholdMs, lastMessageAtMs, nowMs, idleMs },
    });
  }

  async function rollover(binding, messageId, reason, { outText, inText, detail = {} } = {}) {
    const previous = binding.codexSessionId;
    const started = await startThread(binding);
    const next = { ...binding, codexSessionId: started.threadId, threadName: started.threadName || binding.threadName || '', created: true, rolledOver: true, rolloverFromCodexSessionId: previous };
    const rolloverDetail = { oldCodexSessionId: previous, newCodexSessionId: started.threadId, reason, messageId, ...detail };
    await sessionStore.saveCodexRealtimeEvent(binding, { messageId, eventKey: `rollover-out:${previous}:${started.threadId}`, eventType: 'session_rollover', role: 'activity', title: '会话承接', text: outText, createdAt: now(), detail: rolloverDetail });
    await sessionStore.saveCodexBinding(next, { messageId, lastError: '' });
    await sessionStore.saveCodexRealtimeEvent(next, { messageId, eventKey: `rollover-in:${previous}:${started.threadId}`, eventType: 'session_rollover', role: 'activity', title: '会话承接', text: inText, createdAt: now(), detail: rolloverDetail });
    log('info', { module: 'agent-chat-bridge', component: 'codex-executor', operation: 'session_rollover', status: 'succeeded', oldThreadId: previous, newThreadId: started.threadId, reason });
    return next;
  }

  async function persistUser(binding, input, eventKeyPrefix, prompt, detail = {}) {
    await sessionStore.saveCodexRealtimeEvent(binding, {
      messageId: input.messageId, eventKey: `${eventKeyPrefix}:${input.messageId || stableKey(prompt)}`,
      eventType: 'user_message', role: 'user', title: '用户', text: prompt, createdAt: now(),
      detail: { senderOpenId: input.senderOpenId || '', senderName: input.senderName || '', chatType: binding.chatType || '', ...detail },
    });
  }

  function duplicateResult(binding, event, turnId = '') {
    const key = String(event?.event_key || '');
    if (key.startsWith('assistant-final:') && event.event_type === 'agent_message' && event.role === 'assistant' && trim(event.text)) {
      return { deferred: false, duplicate: true, reason: 'duplicate_final_answer', threadId: binding.codexSessionId, turnId, answer: limitText(trim(event.text), config.maxOutputChars || 3500) };
    }
    if (key.startsWith('error:')) {
      const detail = parseDetail(event);
      return { failed: true, turnStatus: detail.turnStatus === 'interrupted' ? 'interrupted' : 'failed', deferred: false, duplicate: true, reason: 'duplicate_error', threadId: binding.codexSessionId, turnId, answer: limitText(`Codex 会话失败：${trim(event.text) || '未知错误'}`, config.maxOutputChars || 3500) };
    }
    return { deferred: true, accepted: key.startsWith('user-steer-confirmed:'), duplicate: true, reason: 'duplicate_message', threadId: binding.codexSessionId, turnId };
  }

  async function reconcileSteer(binding, messageId, prompt) {
    if (!messageId) return null;
    const rows = await sessionStore.loadSteerEvents(binding, messageId);
    const attempt = rows.find((row) => row.event_key === `user-steer-attempt:${messageId}`);
    if (!attempt) return null;
    const detail = parseDetail(attempt);
    const receipt = (prefix) => rows.some((row) => row.event_key === `${prefix}:${messageId}` && parseDetail(row).attemptId === detail.attemptId);
    if (receipt('user-steer-rejected')) return null;
    const accepted = () => ({ deferred: true, accepted: true, threadId: binding.codexSessionId, turnId: detail.turnId, rootMessageId: detail.rootMessageId });
    if (receipt('user-steer-confirmed')) return accepted();
    const response = await client.request('thread/read', { threadId: binding.codexSessionId, includeTurns: true });
    const turn = (response?.thread?.turns || []).find((entry) => entry.id === detail.turnId);
    const baseline = new Set(detail.baselineIds || []);
    const matches = (turn?.items || []).filter((item) => item.type === 'userMessage' && !baseline.has(item.id)
      && (item.content || []).filter((part) => part.type === 'text').map((part) => part.text || '').join('') === prompt);
    if (matches.length !== 1) throw coded('steer delivery unconfirmed', 'CODEX_STEER_UNCONFIRMED', { outcome: 'unknown' });
    await persistUser(binding, { messageId }, 'user-steer-confirmed', prompt, { attemptId: detail.attemptId });
    return accepted();
  }

  async function steer(active, input) {
    if (input.messageId && input.messageId === active.messageId) return waitForTurn(active, input.messageId, { takeover: true });
    if (active.pendingSteerId && active.pendingSteerId !== input.messageId) throw coded('previous steer delivery unconfirmed', 'CODEX_STEER_UNCONFIRMED', { outcome: 'unknown' });
    const duplicate = await sessionStore.findAcceptedMessageEvent(active.binding, input.messageId, { includeInFlight: true });
    if (duplicate) return duplicateResult(active.binding, duplicate, active.turnId);
    const reconciled = await reconcileSteer(active.binding, input.messageId, input.prompt);
    if (reconciled) { active.pendingSteerId = null; return reconciled; }
    const attemptId = randomUUID();
    const before = await client.request('thread/read', { threadId: active.threadId, includeTurns: true });
    const baselineIds = (before?.thread?.turns || []).find((turn) => turn.id === active.turnId)?.items?.filter((item) => item.type === 'userMessage').map((item) => item.id) || [];
    await persistUser(active.binding, input, 'user-steer-attempt', input.prompt, { attemptId, turnId: active.turnId, rootMessageId: active.messageId, baselineIds });
    active.pendingSteerId = input.messageId;
    try {
      await steerTurnWithMismatchRecovery({ request: (...args) => client.request(...args), threadId: active.threadId, expectedTurnId: active.turnId, input: [textInput(input.prompt)], shouldContinue: () => !active.settled });
    } catch (error) {
      if (isNoActiveTurnError(error) || error instanceof TurnRecoverySupersededError) {
        active.pendingSteerId = null;
        await persistUser(active.binding, input, 'user-steer-rejected', input.prompt, { attemptId });
        const latest = await client.request('thread/read', { threadId: active.threadId, includeTurns: true });
        const ended = (latest?.thread?.turns || []).find((turn) => turn.id === active.turnId);
        if (!ended || ended.status === 'inProgress') throw coded('steer rejection could not be reconciled', 'CODEX_STEER_UNCONFIRMED', { outcome: 'unknown' });
        if (!active.settled) {
          if (ended.status === 'completed') active.resolve({ turn: ended });
          else active.reject(coded(ended.error?.message || `Codex turn ${ended.status}`, ended.status === 'interrupted' ? 'CODEX_TURN_INTERRUPTED' : 'CODEX_TURN_FAILED'));
        }
        await active.completed.catch(() => {});
        while (activeByBinding.get(bindingKey(active.binding)) === active) await new Promise((resolvePromise) => setImmediate(resolvePromise));
        return { restart: true, input };
      }
      throw coded('steer delivery unconfirmed', 'CODEX_STEER_UNCONFIRMED', { outcome: 'unknown' });
    }
    await persistUser(active.binding, input, 'user-steer-confirmed', input.prompt, { attemptId });
    active.pendingSteerId = null;
    return { deferred: true, accepted: true, rootMessageId: active.messageId, threadId: active.threadId, turnId: active.turnId };
  }

  function createTurnState(binding, input, turnId, startedAt) {
    let resolveCompletion; let rejectCompletion;
    let timeoutTimer;
    const state = {
      binding, threadId: binding.codexSessionId, turnId, messageId: input.messageId,
      startedAt, outboxScanFromMs: startedAt, itemText: new Map(), publicProgress: createPublicProgressProjector(),
      lastAgentMessage: '', pendingSteerId: null, settled: false, stopRequested: false,
      finalized: null,
      completed: new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; }),
      resolve(value) { if (state.settled) return; state.settled = true; clearTimeout(timeoutTimer); resolveCompletion(value); },
      reject(error) { if (state.settled) return; state.settled = true; clearTimeout(timeoutTimer); rejectCompletion(error); },
    };
    if (Number(config.turnTimeoutMs) > 0) {
      timeoutTimer = setTimeout(() => {
        state.reject(coded(`Codex turn timed out after ${config.turnTimeoutMs}ms`, 'CODEX_TURN_TIMEOUT'));
        const release = client.lifecycle.hold();
        client.request('turn/interrupt', { threadId: state.threadId, turnId: state.turnId })
          .catch(() => log('warning', { module: 'agent-chat-bridge', component: 'codex-executor', operation: 'timeout_interrupt', status: 'unconfirmed', threadId: state.threadId, turnId: state.turnId }))
          .finally(release);
      }, Number(config.turnTimeoutMs));
      timeoutTimer.unref?.();
    }
    return state;
  }

  async function registerState(state) {
    state.finalized = finalizeTurn(state);
    activeByBinding.set(bindingKey(state.binding), state);
    activeByTurn.set(state.turnId, state);
    const releaseActivity = client.lifecycle.hold();
    state.finalized.finally(() => {
      releaseActivity();
      activeByTurn.delete(state.turnId);
      if (activeByBinding.get(bindingKey(state.binding)) === state) activeByBinding.delete(bindingKey(state.binding));
      maybeNotifyRestart();
    }).catch(() => {});
    const early = earlyNotifications.get(state.turnId) || [];
    earlyNotifications.delete(state.turnId);
    for (const event of early) await handleNotification(event);
  }

  function handleDisconnect(error) {
    loadedThreads.clear();
    for (const state of activeByTurn.values()) {
      const lost = coded('Codex app-server connection was lost; native turn status is unknown', 'CODEX_OBSERVATION_LOST', { retryable: true, outcome: 'unknown' });
      Object.assign(lost, { cause: error, threadId: state.threadId, turnId: state.turnId, startedAt: state.startedAt });
      state.reject(lost);
    }
  }

  function finalizeTurn(state) {
    return state.completed.then(async ({ turn }) => {
      const answer = finalAnswer(turn) || state.lastAgentMessage;
      if (answer) await sessionStore.saveCodexRealtimeEvent(state.binding, { messageId: state.messageId, eventKey: `assistant-final:${state.messageId || stableKey(answer)}`, eventType: 'agent_message', role: 'assistant', title: 'Codex 回复', text: answer, createdAt: now(), detail: { phase: 'final_answer', turnId: state.turnId } });
      await sessionStore.touchCodexBinding(state.binding, { messageId: state.messageId, lastError: '' });
      return {
        deferred: false,
        threadId: state.threadId,
        turnId: state.turnId,
        answer: limitText(answer, config.maxOutputChars || 3500),
        attachments: collectOutboxAttachments(state.binding, state.outboxScanFromMs, { workspace: config.cwd, outboxRelativeRoot: config.outboxRelativeRoot, allowedGroupChatIds: config.allowedGroupChatIds, log }),
      };
    }, async (error) => {
      const observationUnknown = error?.outcome === 'unknown';
      await sessionStore.saveCodexRealtimeEvent(state.binding, {
        messageId: state.messageId,
        eventKey: `${observationUnknown ? 'observation-error' : 'error'}:${state.messageId || state.turnId}`,
        eventType: 'error', role: 'activity',
        title: observationUnknown ? 'Codex 状态待核对' : 'Codex 会话失败',
        text: error.message, createdAt: now(),
        detail: { turnId: state.turnId, turnStatus: observationUnknown ? 'unknown' : (error.code === 'CODEX_TURN_INTERRUPTED' ? 'interrupted' : 'failed') },
      });
      await sessionStore.touchCodexBinding(state.binding, { messageId: state.messageId, lastError: error.message });
      throw error;
    });
  }

  async function execute(input, options = {}) {
    if (closing) throw coded('executor is closing', 'CODEX_EXECUTOR_CLOSING', { retryable: true });
    const actor = identity(input);
    const normalized = { ...input, prompt: String(input.prompt || ''), messageId: trim(input.messageId), busyPolicy: input.busyPolicy || 'steer' };
    if (!normalized.prompt.trim()) throw coded('empty prompt', 'CODEX_INVALID_INPUT');
    if (!['steer', 'reject'].includes(normalized.busyPolicy)) throw coded('invalid busy policy', 'CODEX_INVALID_INPUT');
    return client.lifecycle.run(async () => {
      const routed = await withKeyLock(bindingKey(actor), async () => {
      if (options.resume) {
        const binding = await sessionStore.loadBinding(actor);
        if (!binding?.codexSessionId) throw coded('resume has no durable binding', 'CODEX_RESUME_MISMATCH');
        validateResumeIdentity(binding, normalized, options.resume);
        const active = activeByBinding.get(bindingKey(actor));
        if (active) {
          if (active.threadId !== options.resume.threadId || active.turnId !== options.resume.turnId || active.messageId !== normalized.messageId) {
            throw coded('another turn currently holds this binding', 'CODEX_THREAD_HELD', { retryable: true });
          }
          return { state: active, resume: true };
        }
        return { state: await prepareKnownResume(binding, normalized, options.resume), resume: true };
      }
      const active = activeByBinding.get(bindingKey(actor));
      if (active) {
        if (active.bindingUncertain) {
          const error = coded('native turn started but durable binding is uncertain', 'CODEX_BINDING_UNCERTAIN', { outcome: 'unknown' });
          Object.assign(error, { threadId: active.threadId, turnId: active.turnId, startedAt: active.startedAt });
          throw error;
        }
        if (normalized.messageId && normalized.messageId === active.messageId) {
          return { completion: waitForTurn(active, normalized.messageId, { takeover: true, signal: options.signal }) };
        }
        if (normalized.busyPolicy === 'reject') throw coded('binding already has an active turn', 'CODEX_THREAD_BUSY', { retryable: true });
        if (active.settled) return { afterFinal: active.finalized, restart: { input: normalized } };
        const result = await steer(active, normalized);
        return result?.restart ? { restart: result } : { completion: Promise.resolve(result) };
      }
      let binding = await ensureBinding(actor, normalized.messageId);
      const duplicate = await sessionStore.findAcceptedMessageEvent(binding, normalized.messageId);
      if (duplicate) return { completion: Promise.resolve(duplicateResult(binding, duplicate)) };
      const reconciled = await reconcileSteer(binding, normalized.messageId, normalized.prompt);
      if (reconciled) return { completion: Promise.resolve(reconciled) };
      binding = await maybeRollover(binding, normalized.messageId);
      try { await ensureThreadReady(binding); }
      catch (error) {
        if (!/session\s+[^\s]+\s+is archived/i.test(error.message)) throw error;
        const archivedSessionId = String(error.message).match(/\bsession\s+([^\s]+)\s+is archived\b/i)?.[1]?.replace(/^[\"']+|[\"'.,;:]+$/g, '') || binding.codexSessionId;
        binding = await rollover(binding, normalized.messageId, 'codex_session_archived', {
          outText: 'Codex 原会话已归档，后续飞书消息承接到新 Codex 会话。',
          inText: '因原 Codex 会话已归档，本会话开始承接后续飞书消息。',
          detail: { archivedCodexSessionId: archivedSessionId, error: limitText(error.message, 1000) },
        });
      }
      const prompt = buildInitialPrompt({ binding, prompt: normalized.prompt, groupChatContext: normalized.groupChatContext, outboxRelativeRoot: config.outboxRelativeRoot, allowedGroupChatIds: config.allowedGroupChatIds });
      await persistUser(binding, normalized, 'user', prompt);
      const startedAt = now();
      await options.onStartIntent?.({ binding, threadId: binding.codexSessionId, messageId: normalized.messageId, startedAt });
      let response;
      pendingStartThreads.add(binding.codexSessionId);
      try {
        response = await client.request('turn/start', {
          threadId: binding.codexSessionId, input: [textInput(prompt)], cwd: config.cwd,
          approvalPolicy: config.approvalPolicy || 'auto', approvalsReviewer: config.approvalsReviewer || 'auto',
          ...(config.model ? { model: config.model } : {}), ...(config.reasoningEffort ? { effort: config.reasoningEffort } : {}),
        });
      } catch (error) {
        const archived = String(error?.message || '').match(/\bsession\s+([^\s]+)\s+is archived\b/i)?.[1]?.replace(/^['"]+|['".,;:]+$/g, '');
        if (archived === binding.codexSessionId) {
          loadedThreads.delete(binding.codexSessionId);
          throw coded('Codex thread was archived before turn start', 'CODEX_THREAD_ARCHIVED', { retryable: true, outcome: 'rejected' });
        }
        error.code ||= 'CODEX_TURN_START_UNCONFIRMED'; error.outcome ||= 'unknown'; throw error;
      } finally {
        pendingStartThreads.delete(binding.codexSessionId);
      }
      const turnId = trim(response?.turn?.id);
      if (!turnId) throw coded('Codex did not return a turn id', 'CODEX_TURN_START_UNCONFIRMED', { outcome: 'unknown' });
      const state = createTurnState(binding, normalized, turnId, startedAt);
      await registerState(state);
      try { await options.onBound?.({ threadId: state.threadId, turnId, startedAt }); }
      catch {
        state.bindingUncertain = true;
        waitForTurn(state, normalized.messageId, { created: binding.created }).catch(() => {});
        const error = coded('native turn started but durable binding failed', 'CODEX_BINDING_UNCERTAIN', { outcome: 'unknown' });
        Object.assign(error, { threadId: state.threadId, turnId, startedAt });
        throw error;
      }
      await sessionStore.saveCodexRealtimeEvent(binding, { messageId: normalized.messageId, eventKey: `public:${turnId}:started`, eventType: 'public_progress', role: 'activity', title: '执行进度', text: '', createdAt: startedAt, detail: { kind: 'started', id: turnId, turnId, at: startedAt } });
      return { completion: waitForTurn(state, normalized.messageId, { created: binding.created, signal: options.signal }) };
      });
      if (routed.restart) {
        if (routed.afterFinal) await routed.afterFinal.catch(() => {});
        return execute(routed.restart.input, options);
      }
      if (routed.state) return waitForTurn(routed.state, normalized.messageId, { created: false, signal: options.signal });
      return routed.completion;
    });
  }

  function validateResumeIdentity(binding, input, resume = {}) {
    if (!trim(resume.threadId) || !trim(resume.turnId)) throw coded('start outcome has no persisted turn identity', 'CODEX_START_UNCONFIRMED', { outcome: 'unknown' });
    if (resume.threadId !== binding.codexSessionId) throw coded('resume thread does not match binding', 'CODEX_RESUME_MISMATCH');
    if (!input.messageId) throw coded('resume message identity is required', 'CODEX_RESUME_MISMATCH');
    if (!Number.isFinite(Number(resume.startedAt)) || Number(resume.startedAt) <= 0) throw coded('resume startedAt is required', 'CODEX_RESUME_MISMATCH');
  }

  async function prepareKnownResume(binding, input, resume) {
    pendingKnownTurns.add(resume.turnId);
    let snapshot;
    try {
      const response = await client.request('thread/resume', threadDefaults({ threadId: resume.threadId,
        ...(config.reasoningEffort ? { config: { model_reasoning_effort: config.reasoningEffort } } : {}) }));
      snapshot = exactTurnSnapshot(response?.thread, resume.turnId);
      loadedThreads.add(resume.threadId);
    }
    catch (error) { pendingKnownTurns.delete(resume.turnId); throw error; }
    if (snapshot.status === 'unknown') { pendingKnownTurns.delete(resume.turnId); throw coded('persisted turn could not be confirmed', 'CODEX_TURN_UNKNOWN', { retryable: true, outcome: 'unknown' }); }
    const state = createTurnState(binding, input, resume.turnId, Number(resume.startedAt));
    await registerState(state);
    pendingKnownTurns.delete(resume.turnId);
    if (snapshot.status === 'completed') state.resolve({ turn: snapshot.turn });
    else if (snapshot.status !== 'inProgress') state.reject(coded(snapshot.turn?.error?.message || `Codex turn ${snapshot.status}`, snapshot.status === 'interrupted' ? 'CODEX_TURN_INTERRUPTED' : 'CODEX_TURN_FAILED'));
    return state;
  }

  async function waitForTurn(state, messageId, { created = false, takeover = false, signal } = {}) {
    const completion = state.finalized.then((result) => ({ ...result, created, takeover }));
    if (!signal) return completion;
    if (signal.aborted) throw coded('caller stopped waiting', 'CODEX_WAIT_ABORTED', { outcome: 'unknown' });
    let abort;
    const aborted = new Promise((_, reject) => {
      abort = () => reject(coded('caller stopped waiting', 'CODEX_WAIT_ABORTED', { outcome: 'unknown' }));
      signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([completion, aborted]); }
    finally { signal.removeEventListener('abort', abort); }
  }

  async function inspect({ binding, threadId, turnId }) {
    if (!binding || binding.codexSessionId !== threadId) throw coded('inspection identity does not match binding', 'CODEX_INSPECT_MISMATCH');
    const response = await client.lifecycle.run(() => client.request('thread/read', { threadId, includeTurns: true }));
    return exactTurnSnapshot(response?.thread, turnId);
  }

  async function interrupt({ binding, threadId, turnId, messageId }) {
    if (!binding || binding.codexSessionId !== threadId) return { status: 'unconfirmed' };
    const active = activeByTurn.get(turnId);
    if (active && (active.threadId !== threadId || active.messageId !== messageId || bindingKey(active.binding) !== bindingKey(binding))) return { status: 'unconfirmed' };
    if (active?.settled) return { status: 'already_finished' };
    if (!active) {
      const snapshot = await inspect({ binding, threadId, turnId });
      if (snapshot.status !== 'inProgress') return snapshot.status === 'unknown' ? { status: 'unconfirmed' } : { status: 'already_finished' };
    }
    try { await client.lifecycle.run(() => client.request('turn/interrupt', { threadId, turnId })); return { status: 'requested' }; }
    catch (error) { return isNoActiveTurnError(error) ? { status: 'already_finished' } : { status: 'unconfirmed' }; }
  }

  async function handleNotification(event) {
    const turnId = trim(event.params?.turnId || event.params?.turn?.id);
    const state = activeByTurn.get(turnId);
    if (!state) {
      const threadId = trim(event.params?.threadId || event.params?.thread?.id);
      if (turnId && (pendingKnownTurns.has(turnId) || pendingStartThreads.has(threadId)) && earlyNotifications.size < 32) {
        const queued = earlyNotifications.get(turnId) || [];
        if (queued.length < 100) queued.push(event);
        earlyNotifications.set(turnId, queued);
      }
      return;
    }
    const { method, params } = event;
    const progress = state.publicProgress(method, params);
    if (progress) sessionStore.saveCodexRealtimeEvent(state.binding, { messageId: state.messageId, eventKey: `public:${turnId}:${progress.id}:${method}`, eventType: 'public_progress', role: 'activity', title: '执行进度', text: '', createdAt: progress.at, detail: progress }).catch(() => log('warning', { module: 'agent-chat-bridge', component: 'codex-executor', operation: 'publish_progress', status: 'failed' }));
    if (method === 'agentMessage/delta' || method === 'item/agentMessage/delta') {
      const itemId = params.itemId || 'agent-delta';
      const next = limitText(`${state.itemText.get(itemId) || ''}${params.delta || ''}`, 12000);
      state.itemText.set(itemId, next); state.lastAgentMessage = next;
      await sessionStore.saveCodexRealtimeEvent(state.binding, { messageId: state.messageId, eventKey: `agent-delta:${turnId}:${itemId}`, eventType: 'agent_message', role: 'assistant', title: 'Codex', text: next, createdAt: now(), detail: { turnId, itemId, streaming: true } })
        .catch(() => log('warning', { module: 'agent-chat-bridge', component: 'codex-executor', operation: 'persist_delta', status: 'failed', threadId: state.threadId, turnId }));
    } else if (method === 'item/completed' && params.item) {
      await persistCompletedItem(state, params.item).catch(() => log('warning', { module: 'agent-chat-bridge', component: 'codex-executor', operation: 'persist_item', status: 'failed', threadId: state.threadId, turnId }));
    }
    else if (method === 'error' && params.willRetry !== true) state.reject(coded(params.error?.message || 'Codex turn failed', 'CODEX_TURN_FAILED'));
    else if (method === 'turn/completed') {
      for (const item of params.turn?.items || []) {
        await persistCompletedItem(state, item).catch(() => log('warning', { module: 'agent-chat-bridge', component: 'codex-executor', operation: 'persist_item', status: 'failed', threadId: state.threadId, turnId }));
      }
      if (params.turn?.status === 'failed' || params.turn?.status === 'interrupted') state.reject(coded(params.turn?.error?.message || `Codex turn ${params.turn.status}`, params.turn.status === 'interrupted' ? 'CODEX_TURN_INTERRUPTED' : 'CODEX_TURN_FAILED'));
      else state.resolve({ turn: params.turn });
    }
  }

  async function persistCompletedItem(state, item) {
    const projected = projectCodexItem(item);
    if (!projected) return;
    if (projected.role === 'assistant' && projected.text) state.lastAgentMessage = projected.text;
    await sessionStore.saveCodexRealtimeEvent(state.binding, {
      messageId: state.messageId,
      eventKey: `item:${state.turnId}:${item.id || stableKey(JSON.stringify(item))}`,
      ...projected,
      createdAt: now(),
      detail: { ...(projected.detail || {}), turnId: state.turnId, itemType: item.type || '' },
    });
  }

  async function maybeNotifyRestart() {
    if (!restartPending || restartNotified || activeByTurn.size) return;
    restartNotified = true;
    try { await onRestartRequired(restartPending); }
    catch { log('error', { module: 'agent-chat-bridge', component: 'codex-executor', operation: 'restart_required', status: 'failed' }); }
  }

  function checkMemory() {
    const usage = config.memoryUsage?.() || process.memoryUsage();
    const over = (config.memoryMaxRssBytes && usage.rss >= config.memoryMaxRssBytes) || (config.memoryMaxHeapUsedBytes && usage.heapUsed >= config.memoryMaxHeapUsedBytes);
    if (!over || restartPending) return;
    restartPending = 'memory_limit';
    maybeNotifyRestart();
  }
  if (Number(config.memoryCheckIntervalMs) >= 1000 && (config.memoryMaxRssBytes || config.memoryMaxHeapUsedBytes)) {
    memoryTimer = setInterval(checkMemory, Number(config.memoryCheckIntervalMs)); memoryTimer.unref?.();
  }

  return Object.freeze({
    execute, inspect, interrupt,
    status: () => ({ ready: client.ready, lifecycleActive: client.lifecycle.active, closing: Boolean(client.closing), activeTurns: activeByTurn.size, heldNotifications: [...earlyNotifications.values()].reduce((n, list) => n + list.length, 0), restartPending: restartPending || null }),
    async close() {
      closing = true;
      clearInterval(memoryTimer);
      client.lifecycle.stop();
      await client.close('shutdown');
      await Promise.allSettled([...activeByTurn.values()].map((state) => state.finalized));
    },
  });
}
