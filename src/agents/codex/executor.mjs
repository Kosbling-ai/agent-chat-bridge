import { codexTurnError } from './turn-error.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CodexAppServerClient } from './app-server-client.mjs';
import { buildInitialPrompt } from './prompt.mjs';
import { collectOutboxAttachments } from './outbound-files.mjs';
import { codexThreadCreatedAtMs, shouldRolloverForRules } from './codex-rules-rollover.mjs';
import { exactTurnSnapshot, inProgressTurnIds, interruptTurnAndPredecessors, isNoActiveTurnError, steerTurnWithMismatchRecovery, TurnRecoverySupersededError } from './codex-turn-recovery.mjs';
import { createPublicProgressProjector } from '../../shared/public-progress.mjs';
import { normalizeUserInputAnswers, normalizeUserInputRequest, typedRequestKey } from './user-input-request.mjs';
import { databaseError } from '../../storage/errors.mjs';

const textInput = (text) => ({ type: 'text', text, text_elements: [] });
const trim = (value) => String(value || '').trim();
const limitText = (value, max) => String(value || '').slice(0, max || undefined);
const stableKey = (value) => createHash('sha1').update(String(value || '')).digest('hex').slice(0, 24);
const bindingKey = ({ feishuOpenId, chatId }) => `${feishuOpenId || 'unknown'}:${chatId || 'unknown'}`;
const normalizeApprovalPolicy = (value) => !trim(value) || trim(value) === 'auto' ? 'on-request' : trim(value);
const normalizeApprovalsReviewer = (value) => !trim(value) || trim(value) === 'auto' ? 'auto_review' : trim(value);

export function createDeltaCoalescer({ write, onError = () => {}, now = Date.now } = {}) {
  if (typeof write !== 'function') throw new Error('delta writer is required');
  const entries = new Map();
  return (key, value) => {
    const current = entries.get(key);
    if (current) {
      current.value = value;
      current.pending = true;
      return current.promise;
    }
    const entry = { value, pending: false, promise: null };
    entries.set(key, entry);
    entry.promise = (async () => {
      while (true) {
        entry.pending = false;
        const snapshot = entry.value;
        const startedAt = now();
        try { await write(snapshot); }
        catch (error) {
          try { Promise.resolve(onError(error, Math.max(0, now() - startedAt), snapshot)).catch((_observerError) => {}); }
          catch { /* observability never alters delta coalescing */ }
        }
        if (entry.pending) continue;
        entries.delete(key);
        return;
      }
    })();
    return entry.promise;
  };
}

function coded(message, code, { retryable = false, outcome, phase, busyOrigin } = {}) {
  const error = new Error(message); error.code = code; error.retryable = retryable;
  if (outcome) error.outcome = outcome;
  if (phase) error.phase = phase;
  if (busyOrigin) error.busyOrigin = busyOrigin;
  return error;
}

function uncertainObservation(error, { threadId, turnId, startedAt, phase, intent } = {}) {
  const value = coded('Codex native state could not be confirmed', error?.code || 'CODEX_OBSERVATION_LOST', {
    retryable: true, outcome: 'unknown', phase,
  });
  Object.assign(value, {
    rpcMethod: error?.rpcMethod,
    threadId, turnId, startedAt,
    ...(intent ? { intent } : {}),
  });
  return value;
}

function parseDetail(row) {
  try { return JSON.parse(row?.detail_json || '{}'); } catch { return {}; }
}

function publicResult(result) {
  if (!result || typeof result !== 'object' || !result.threadId || result.sessionId) return result;
  return { ...result, sessionId: result.threadId };
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

export function buildTurnInput(prompt, attachments = []) {
  return [textInput(prompt), ...attachments
    .filter(attachment => attachment?.status === 'downloaded' && attachment.kind === 'image' && attachment.path)
    .map(attachment => ({ type: 'localImage', path: attachment.path }))];
}

export function createCodexExecutor({ config, sessionStore, childEnv = {}, log = () => {}, spawnImpl, spawnSyncImpl, now = Date.now, onRestartRequired = async () => {}, onUserInput = async () => {}, onUserInputClosed = async () => {}, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  if (!config || !sessionStore) throw new Error('config and sessionStore are required');
  const locks = new Map();
  const activeByBinding = new Map();
  const activeByTurn = new Map();
  const startingByThread = new Map();
  const resolvedUserInputs = new Set();
  const loadedThreads = new Set();
  let memoryTimer;
  let closing = false;
  let restartPending = '';
  let restartNotified = false;
  const persistDelta = createDeltaCoalescer({
    now,
    write: ({ state, event }) => sessionStore.saveCodexRealtimeEvent(state.binding, event),
    onError: (error, durationMs, snapshot) => log('warning', {
      module: 'agent-chat-bridge', component: 'codex-executor', operation: 'persist_delta', status: 'failed',
      errorClass: databaseError(error).code, errno: error?.errno, sqlState: error?.sqlState, durationMs,
      threadId: snapshot.state.threadId, turnId: snapshot.event.detail.turnId,
    }),
  });
  const rememberResolvedUserInput=key=>{resolvedUserInputs.add(key);if(resolvedUserInputs.size>100)resolvedUserInputs.delete(resolvedUserInputs.values().next().value);};

  const client = new CodexAppServerClient({
    config, childEnv, spawnImpl, spawnSyncImpl, log, now,
    eventSink: (event) => handleNotification(event),
    serverRequestSink: (request) => handleServerRequest(request),
    onDisconnect: (error) => handleDisconnect(error),
    onIdle: () => { maybeNotifyRestart().catch((_error) => {}); },
  });

  async function withKeyLock(key, operation) {
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((done) => { release = done; });
    const chained = previous.then(() => current, () => current);
    locks.set(key, chained);
    await previous.catch((_error) => {});
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
      approvalPolicy: normalizeApprovalPolicy(config.approvalPolicy),
      approvalsReviewer: normalizeApprovalsReviewer(config.approvalsReviewer),
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
    if (existing?.codexSessionId) return { ...existing, threadName: existing.threadName || buildThreadName(actor) };
    const started = await startThread(actor);
    const binding = { ...actor, codexSessionId: started.threadId, threadName: started.threadName, created: true };
    await sessionStore.saveCodexBinding(binding, { messageId, lastError: '' });
    return binding;
  }

  async function ensureThreadReady(binding) {
    if (loadedThreads.has(binding.codexSessionId)) return;
    let response;
    try {
      response = await client.request('thread/resume', threadDefaults({ threadId: binding.codexSessionId,
        ...(config.reasoningEffort ? { config: { model_reasoning_effort: config.reasoningEffort } } : {}) }));
    } catch (error) {
      if (error?.code === 'CODEX_THREAD_BUSY' && error.outcome === 'rejected') {
        error.phase = 'pre_admission';
        error.busyOrigin = 'native';
      }
      throw error;
    }
    for (const turnId of inProgressTurnIds(response?.thread)) {
      await interruptTurnAndPredecessors({
        request: (...args) => client.request(...args),
        threadId: binding.codexSessionId,
        expectedTurnId: turnId,
        onRecovery: ({ attempt, expectedTurnId, actualTurnId }) => log('warning', {
          module: 'agent-chat-bridge', component: 'codex-executor', operation: 'resume_cleanup', status: 'recovering',
          attempt, threadId: binding.codexSessionId, expectedTurnId, actualTurnId,
        }),
      });
    }
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
      detail: { senderOpenId: input.senderOpenId || '', senderUnionId: input.senderUnionId || '', senderName: input.senderName || '', chatType: binding.chatType || '', ...detail },
    });
  }

  function duplicateResult(binding, event, turnId = '') {
    const key = String(event?.event_key || '');
    if (key.startsWith('assistant-final:') && event.event_type === 'agent_message' && event.role === 'assistant' && trim(event.text)) {
      const rawAnswer = trim(event.text);
      return { deferred: false, duplicate: true, reason: 'duplicate_final_answer', threadId: binding.codexSessionId, turnId, answer: limitText(rawAnswer, config.maxOutputChars || 3500), rawAnswer };
    }
    if (key.startsWith('error:')) {
      const detail = parseDetail(event);
      return { failed: true, errorCode: detail.errorCode === 'CODEX_USAGE_LIMIT_EXCEEDED' ? detail.errorCode : 'CODEX_TURN_FAILED', turnStatus: detail.turnStatus === 'interrupted' ? 'interrupted' : 'failed', deferred: false, duplicate: true, reason: 'duplicate_error', threadId: binding.codexSessionId, turnId, answer: 'Codex 会话失败。' };
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
    try {
      const response = await client.request('thread/read', { threadId: binding.codexSessionId, includeTurns: true });
      const turn = (response?.thread?.turns || []).find((entry) => entry.id === detail.turnId);
      const baseline = new Set(detail.baselineIds || []);
      const matches = (turn?.items || []).filter((item) => item.type === 'userMessage' && !baseline.has(item.id)
        && (item.content || []).filter((part) => part.type === 'text').map((part) => part.text || '').join('') === prompt);
      if (matches.length !== 1) throw coded('steer delivery unconfirmed', 'CODEX_STEER_UNCONFIRMED', { outcome: 'unknown' });
      await persistUser(binding, { messageId }, 'user-steer-confirmed', prompt, { attemptId: detail.attemptId });
      return accepted();
    } catch (error) {
      throw uncertainObservation(error, {
        threadId: binding.codexSessionId,
        turnId: detail.turnId,
        phase: 'steer_confirmation',
        intent: { kind: 'steer', attemptId: detail.attemptId, messageId },
      });
    }
  }

  async function steer(active, input, { signal } = {}) {
    const operation = active.steerQueue.then(() => steerLocked(active, input, { signal }));
    active.steerQueue = operation.catch((_error) => {});
    const result = await operation;
    return result?.followUp || result;
  }

  async function steerLocked(active, input, { signal } = {}) {
    if (active.settled) return { restart: true, input };
    if (input.messageId && input.messageId === active.messageId) {
      if (hasOpenWaiter(active)) return { deferred: true, accepted: true, rootMessageId: active.messageId, threadId: active.threadId, turnId: active.turnId };
      return { followUp: waitForTurn(active, input.messageId, { takeover: true, signal }) };
    }
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
      await steerTurnWithMismatchRecovery({ request: (...args) => client.request(...args), threadId: active.threadId, expectedTurnId: active.turnId, input: buildTurnInput(input.prompt, input.attachments), shouldContinue: () => !active.settled });
    } catch (error) {
      if (isNoActiveTurnError(error) || error instanceof TurnRecoverySupersededError) {
        active.pendingSteerId = null;
        await persistUser(active.binding, input, 'user-steer-rejected', input.prompt, { attemptId });
        const latest = await client.request('thread/read', { threadId: active.threadId, includeTurns: true });
        const ended = (latest?.thread?.turns || []).find((turn) => turn.id === active.turnId);
        if (!ended || ended.status === 'inProgress') throw coded('steer rejection could not be reconciled', 'CODEX_STEER_UNCONFIRMED', { outcome: 'unknown' });
        if (!active.settled) {
          if (ended.status === 'completed') active.resolve({ turn: ended });
          else active.reject(codexTurnError(ended.error, ended.status));
        }
        await active.completed.catch((_error) => {});
        while (activeByBinding.get(bindingKey(active.binding)) === active) await new Promise((resolvePromise) => setImmediate(resolvePromise));
        return { restart: true, input };
      }
      throw coded('steer delivery unconfirmed', 'CODEX_STEER_UNCONFIRMED', { outcome: 'unknown' });
    }
    try { await persistUser(active.binding, input, 'user-steer-confirmed', input.prompt, { attemptId }); }
    catch { throw coded('steer delivery unconfirmed', 'CODEX_STEER_UNCONFIRMED', { outcome: 'unknown' }); }
    active.pendingSteerId = null;
    if (!hasOpenWaiter(active)) return { followUp: waitForTurn(active, input.messageId, { takeover: true, signal }) };
    return { deferred: true, accepted: true, rootMessageId: active.messageId, threadId: active.threadId, turnId: active.turnId };
  }

  function createTurnState(binding, input, turnId, startedAt) {
    let resolveCompletion; let rejectCompletion;
    let timeoutTimer;
    const state = {
      binding, threadId: binding.codexSessionId, turnId, messageId: input.messageId,
      startedAt, outboxScanFromMs: startedAt, itemText: new Map(), publicProgress: createPublicProgressProjector(),
      lastAgentMessage: '', pendingSteerId: null, settled: false, stopRequested: false,
      userInput: null,
      userInputQueue: Promise.resolve(),
      steerQueue: Promise.resolve(), waiters: new Set(),
      finalized: null,
      completed: new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; }),
      resolve(value) { if (state.settled) return; state.settled = true; clearTimeout(timeoutTimer); resolveCompletion(value); },
      reject(error) { if (state.settled) return; state.settled = true; clearTimeout(timeoutTimer); rejectCompletion(error); },
    };
    const turnTimeoutMs = Number(config.turnTimeoutMs ?? 12 * 60 * 60 * 1000);
    if (turnTimeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        state.reject(coded(`Codex turn timed out after ${turnTimeoutMs}ms`, 'CODEX_TURN_TIMEOUT'));
        const release = client.lifecycle.hold();
        interruptTurnAndPredecessors({ request: (...args) => client.request(...args), threadId: state.threadId, expectedTurnId: state.turnId })
          .catch((_error) => log('warning', { module: 'agent-chat-bridge', component: 'codex-executor', operation: 'timeout_cleanup', status: 'unconfirmed', threadId: state.threadId, turnId: state.turnId }))
          .finally(release);
      }, turnTimeoutMs);
      timeoutTimer.unref?.();
    }
    return state;
  }

  async function registerState(state) {
    state.finalized = finalizeTurn(state).finally(() => expireUserInput(state, 'turn_finished'));
    activeByBinding.set(bindingKey(state.binding), state);
    activeByTurn.set(state.turnId, state);
    const releaseActivity = client.lifecycle.hold();
    state.finalized.finally(() => {
      releaseActivity();
      activeByTurn.delete(state.turnId);
      if (activeByBinding.get(bindingKey(state.binding)) === state) activeByBinding.delete(bindingKey(state.binding));
      maybeNotifyRestart();
    }).catch((_error) => {});
  }

  function startAdmission(threadId, messageId) {
    let resolveAdmission; let rejectAdmission;
    const promise = new Promise((resolvePromise, rejectPromise) => { resolveAdmission = resolvePromise; rejectAdmission = rejectPromise; });
    promise.catch((_error) => {});
    const admission = { threadId, messageId, promise, resolve: resolveAdmission, reject: rejectAdmission };
    startingByThread.set(threadId, admission);
    return admission;
  }

  async function expireUserInput(state, reason, { resolved = false } = {}) {
    const pending = state?.userInput;
    if (!pending || pending.settled) return;
    pending.settled = true; pending.controller?.abort(); state.userInput = null;
    try {
      if (resolved) pending.request.abandon();
      else await pending.request.respondError(-32002, 'User input request expired');
    } catch { /* a disconnected child is already expired */ }
    await onUserInputClosed({ ...pending.public, reason }).catch((_error) => {});
  }

  async function handleServerRequest(request) {
    let normalized;
    try { normalized = normalizeUserInputRequest(request); }
    catch (error) {
      await request.respondError(-32602, error.code === 'CODEX_USER_INPUT_SECRET_UNSUPPORTED' ? 'Secret questions are unsupported' : 'Invalid user input request').catch((_error) => {});
      return;
    }
    if (closing || config.requestUserInput !== true) {
      await request.respondError(-32002, 'User input request unavailable').catch((_error) => {}); return;
    }
    const resolvedKey = `${request.generation}:${normalized.threadId}:${typedRequestKey(normalized.requestId)}`;
    if (resolvedUserInputs.delete(resolvedKey)) { request.abandon(); return; }
    let state = activeByTurn.get(normalized.turnId);
    if (!state) {
      const admission = startingByThread.get(normalized.threadId);
      if (!admission) { await request.respondError(-32002, 'User input request has no active turn').catch((_error) => {}); return; }
      try { state = await admission.promise; } catch { await request.respondError(-32002, 'User input request expired before turn admission').catch((_error) => {}); return; }
    }
    const operation=state.userInputQueue.then(async()=>{
      if(resolvedUserInputs.delete(resolvedKey)){request.abandon();return;}
      if (state.threadId !== normalized.threadId || state.turnId !== normalized.turnId || state.settled || closing) {
        await request.respondError(-32002, 'User input request does not match the active turn').catch((_error) => {}); return;
      }
      await expireUserInput(state, 'superseded');
      if(resolvedUserInputs.delete(resolvedKey)){request.abandon();return;}
      const controller=new AbortController();
      const publicRequest = {
        ...normalized, messageId: state.messageId, binding: state.binding, signal:controller.signal,
        requestKey: typedRequestKey(normalized.requestId),
      };
      state.userInput = { request, public: publicRequest, controller, settled: false };
      try { await onUserInput(publicRequest); }
      catch {
        if(state.userInput?.request===request)await expireUserInput(state, 'delivery_failed');
        log('error', { module: 'agent-chat-bridge', component: 'codex-executor', operation: 'user_input_card', status: 'failed', threadId: state.threadId, turnId: state.turnId });
      }
    });
    state.userInputQueue=operation.catch(()=>{});
    await operation;
  }

  async function answerUserInput({ threadId, turnId, requestId, itemId, messageId, answers }) {
    const state = activeByTurn.get(turnId);
    const pending = state?.userInput;
    if (!state || state.threadId !== threadId || state.messageId !== messageId || !pending || pending.settled
      || typedRequestKey(pending.public.requestId) !== typedRequestKey(requestId) || pending.public.itemId !== itemId) return { status: 'expired' };
    let result;
    try { result = normalizeUserInputAnswers(pending.public.questions, answers); }
    catch (error) { return { status: 'invalid', code: error.code }; }
    pending.settled = true; pending.controller?.abort(); state.userInput = null;
    try { await pending.request.respondResult(result); return { status: 'submitted' }; }
    catch { return { status: 'unknown' }; }
  }

  function handleDisconnect(error) {
    loadedThreads.clear();
    resolvedUserInputs.clear();
    for (const state of activeByTurn.values()) {
      expireUserInput(state, 'disconnected', { resolved: true }).catch((_error) => {});
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
        rawAnswer: answer,
        attachments: collectOutboxAttachments(state.binding, state.outboxScanFromMs, { workspace: config.cwd, outboxRelativeRoot: config.outboxRelativeRoot, allowedGroupChatIds: config.allowedGroupChatIds, log }),
      };
    }, async (error) => {
      const observationEvent = {
        messageId: state.messageId,
        eventKey: `error:${state.messageId || state.turnId}`,
        eventType: 'error', role: 'activity',
        title: '执行失败',
        text: error.message, createdAt: now(),
        detail: { errorCode: error.code, turnId: state.turnId, turnStatus: error.code === 'CODEX_TURN_INTERRUPTED' ? 'interrupted' : 'failed' },
      };
      try { await sessionStore.saveCodexRealtimeEvent(state.binding, observationEvent); }
      catch { logObservationPersistenceFailure(state, 'event'); }
      try { await sessionStore.touchCodexBinding(state.binding, { messageId: state.messageId, lastError: error.message }); }
      catch { logObservationPersistenceFailure(state, 'touch'); }
      throw error;
    });
  }

  function logObservationPersistenceFailure(state, stage) {
    try {
      log('error', {
        module: 'agent-chat-bridge', component: 'codex-executor', operation: 'persist_observation_loss', status: 'failed',
        stage, threadId: state.threadId, turnId: state.turnId,
      });
    } catch { /* diagnostics must not replace the native unknown result */ }
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
            throw uncertainObservation(coded('another turn currently holds this binding', 'CODEX_THREAD_HELD', { retryable: true }), {
              threadId: options.resume.threadId,
              turnId: options.resume.turnId,
              startedAt: Number(options.resume.startedAt),
              phase: 'known_resume',
              intent: { kind: 'observe', messageId: normalized.messageId },
            });
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
          if (hasOpenWaiter(active)) return { completion: Promise.resolve({ deferred: true, accepted: true, rootMessageId: active.messageId, threadId: active.threadId, turnId: active.turnId }) };
          return { completion: waitForTurn(active, normalized.messageId, { takeover: true, signal: options.signal }) };
        }
        if (normalized.busyPolicy === 'reject') throw coded('binding already has an active turn', 'CODEX_THREAD_BUSY', {
          retryable: true, outcome: 'rejected', phase: 'pre_admission', busyOrigin: 'local',
        });
        if (active.settled) return { afterFinal: active.finalized, restart: { input: normalized } };
        return { completion: steer(active, normalized, { signal: options.signal }).then((result) => result?.restart ? execute(result.input, options) : result) };
      }
      let binding = await ensureBinding(actor, normalized.messageId);
      const duplicate = await sessionStore.findAcceptedMessageEvent(binding, normalized.messageId);
      if (duplicate) return { completion: Promise.resolve(duplicateResult(binding, duplicate)) };
      const reconciled = await reconcileSteer(binding, normalized.messageId, normalized.prompt);
      if (reconciled) return { completion: Promise.resolve(reconciled) };
      binding = await maybeRollover(binding, normalized.messageId);
      binding = await ensureBindingThreadReadyWithArchiveRecovery(binding, normalized.messageId);
      let prompt = buildInitialPrompt({ binding, prompt: normalized.prompt, groupChatContext: normalized.groupChatContext, outboxRelativeRoot: config.outboxRelativeRoot, allowedGroupChatIds: config.allowedGroupChatIds });
      await persistUser(binding, normalized, 'user', prompt);
      const startedAt = now();
      await options.onStartIntent?.({ binding, threadId: binding.codexSessionId, messageId: normalized.messageId, startedAt });
      let response;
      let admission = startAdmission(binding.codexSessionId, normalized.messageId);
      try {
        response = await client.request('turn/start', {
          threadId: binding.codexSessionId, input: buildTurnInput(prompt, normalized.attachments), cwd: config.cwd,
          approvalPolicy: normalizeApprovalPolicy(config.approvalPolicy), approvalsReviewer: normalizeApprovalsReviewer(config.approvalsReviewer),
          ...(config.model ? { model: config.model } : {}), ...(config.reasoningEffort ? { effort: config.reasoningEffort } : {}),
        });
      } catch (error) {
        if (error?.code === 'CODEX_THREAD_ARCHIVED') {
          startingByThread.delete(admission.threadId); admission.reject(error);
          loadedThreads.delete(binding.codexSessionId);
          binding = await rolloverArchivedBinding(binding, normalized.messageId, error);
          await ensureThreadReady(binding);
          prompt = buildInitialPrompt({ binding, prompt: normalized.prompt, groupChatContext: normalized.groupChatContext, outboxRelativeRoot: config.outboxRelativeRoot, allowedGroupChatIds: config.allowedGroupChatIds });
          await persistUser(binding, normalized, 'user', prompt);
          admission = startAdmission(binding.codexSessionId, normalized.messageId);
          response = await client.request('turn/start', {
            threadId: binding.codexSessionId, input: buildTurnInput(prompt, normalized.attachments), cwd: config.cwd,
            approvalPolicy: normalizeApprovalPolicy(config.approvalPolicy), approvalsReviewer: normalizeApprovalsReviewer(config.approvalsReviewer),
            ...(config.model ? { model: config.model } : {}), ...(config.reasoningEffort ? { effort: config.reasoningEffort } : {}),
          }).catch((failure) => { startingByThread.delete(admission.threadId); admission.reject(failure); throw failure; });
        } else {
          startingByThread.delete(admission.threadId); admission.reject(error);
          error.code ||= 'CODEX_TURN_START_UNCONFIRMED'; error.outcome ||= 'unknown'; error.phase ||= 'turn_start'; throw error;
        }
      }
      const turnId = trim(response?.turn?.id);
      if (!turnId) {
        const error = coded('Codex did not return a turn id', 'CODEX_TURN_START_UNCONFIRMED', { outcome: 'unknown' });
        startingByThread.delete(admission.threadId); admission.reject(error); throw error;
      }
      const state = createTurnState(binding, normalized, turnId, startedAt);
      try { await registerState(state); }
      catch (error) { startingByThread.delete(admission.threadId); admission.reject(error); throw error; }
      try { await options.onBound?.({ threadId: state.threadId, turnId, startedAt }); }
      catch {
        startingByThread.delete(admission.threadId); admission.reject(coded('durable binding failed', 'CODEX_BINDING_UNCERTAIN'));
        state.bindingUncertain = true;
        waitForTurn(state, normalized.messageId, { created: binding.created }).catch((_error) => {});
        const error = coded('native turn started but durable binding failed', 'CODEX_BINDING_UNCERTAIN', { outcome: 'unknown' });
        Object.assign(error, { threadId: state.threadId, turnId, startedAt });
        throw error;
      }
      startingByThread.delete(admission.threadId); admission.resolve(state);
      await sessionStore.saveCodexRealtimeEvent(binding, { messageId: normalized.messageId, eventKey: `public:${turnId}:started`, eventType: 'public_progress', role: 'activity', title: '执行进度', text: '', createdAt: startedAt, detail: { kind: 'started', id: turnId, turnId, at: startedAt } })
        .catch((_error) => log('warning', { module: 'agent-chat-bridge', component: 'codex-executor', operation: 'publish_started', status: 'failed', threadId: binding.codexSessionId, turnId }));
      return { completion: waitForTurn(state, normalized.messageId, { created: binding.created, signal: options.signal }) };
      });
      if (routed.restart) {
        if (routed.afterFinal) await routed.afterFinal.catch((_error) => {});
        return execute(routed.restart.input, options);
      }
      if (routed.state) return publicResult(await waitForTurn(routed.state, normalized.messageId, { created: false, signal: options.signal }));
      return publicResult(await routed.completion);
    });
  }

  async function ensureBindingThreadReadyWithArchiveRecovery(binding, messageId) {
    try { await ensureThreadReady(binding); return binding; }
    catch (error) {
      if (error?.code !== 'CODEX_THREAD_ARCHIVED') throw error;
      const next = await rolloverArchivedBinding(binding, messageId, error);
      await ensureThreadReady(next);
      return next;
    }
  }

  function rolloverArchivedBinding(binding, messageId, error) {
    const archivedSessionId = error?.reason?.kind === 'thread_archived' ? error.reason.threadId : binding.codexSessionId;
    if (archivedSessionId !== binding.codexSessionId) throw error;
    return rollover(binding, messageId, 'codex_session_archived', {
      outText: 'Codex 原会话已归档，后续飞书消息承接到新 Codex 会话。',
      inText: '因原 Codex 会话已归档，本会话开始承接后续飞书消息。',
      detail: { archivedCodexSessionId: archivedSessionId, error: limitText(error.message, 1000) },
    });
  }

  function validateResumeIdentity(binding, input, resume = {}) {
    if (!trim(resume.threadId) || !trim(resume.turnId)) throw coded('start outcome has no persisted turn identity', 'CODEX_START_UNCONFIRMED', { outcome: 'unknown' });
    if (resume.threadId !== binding.codexSessionId) throw coded('resume thread does not match binding', 'CODEX_RESUME_MISMATCH');
    if (!input.messageId) throw coded('resume message identity is required', 'CODEX_RESUME_MISMATCH');
    if (!Number.isFinite(Number(resume.startedAt)) || Number(resume.startedAt) <= 0) throw coded('resume startedAt is required', 'CODEX_RESUME_MISMATCH');
  }

  async function prepareKnownResume(binding, input, resume) {
    loadedThreads.delete(resume.threadId);
    let snapshot;
    try {
      const response = await client.request('thread/resume', threadDefaults({ threadId: resume.threadId,
        ...(config.reasoningEffort ? { config: { model_reasoning_effort: config.reasoningEffort } } : {}) }));
      snapshot = exactTurnSnapshot(response?.thread, resume.turnId);
      const otherActiveIds = inProgressTurnIds(response?.thread).filter((turnId) => turnId !== resume.turnId);
      if (snapshot.status !== 'unknown' && otherActiveIds.length === 0) loadedThreads.add(resume.threadId);
    }
    catch (error) {
      throw uncertainObservation(error, {
        threadId: resume.threadId,
        turnId: resume.turnId,
        startedAt: Number(resume.startedAt),
        phase: 'known_resume',
        intent: { kind: 'observe', messageId: input.messageId },
      });
    }
    if (snapshot.status === 'unknown') throw coded('persisted turn could not be confirmed', 'CODEX_TURN_UNKNOWN', { retryable: true, outcome: 'unknown' });
    const state = createTurnState(binding, input, resume.turnId, Number(resume.startedAt));
    await registerState(state);
    if (snapshot.status === 'completed') state.resolve({ turn: snapshot.turn });
    else if (snapshot.status !== 'inProgress') state.reject(codexTurnError(snapshot.turn?.error, snapshot.status));
    return state;
  }

  async function waitForTurn(state, messageId, { created = false, takeover = false, signal } = {}) {
    const waiter = {};
    state.waiters.add(waiter);
    const completion = state.finalized.then(async (result) => {
      if (takeover && messageId && messageId !== state.messageId) {
        const answer = result.rawAnswer || result.answer || '';
        if (answer) await sessionStore.saveCodexRealtimeEvent(state.binding, {
          messageId, eventKey: `assistant-final:${messageId}`, eventType: 'agent_message', role: 'assistant', title: 'Codex 回复',
          text: answer, createdAt: now(), detail: { phase: 'final_answer', turnId: state.turnId, takeover: true },
        });
        await sessionStore.touchCodexBinding(state.binding, { messageId, lastError: '' });
      }
      return { ...result, created, takeover };
    }, async (error) => {
      if (takeover && messageId && messageId !== state.messageId) {
        await sessionStore.saveCodexRealtimeEvent(state.binding, {
          messageId, eventKey: `error:${messageId}`, eventType: 'error', role: 'activity', title: '执行失败',
          text: error.message, createdAt: now(), detail: { errorCode: error.code, turnId: state.turnId, takeover: true, turnStatus: error.code === 'CODEX_TURN_INTERRUPTED' ? 'interrupted' : 'failed' },
        }).catch((_error) => {});
        await sessionStore.touchCodexBinding(state.binding, { messageId, lastError: error.message }).catch((_error) => {});
      }
      throw error;
    });
    if (!signal) {
      try { return await completion; } finally { state.waiters.delete(waiter); }
    }
    if (signal.aborted) { state.waiters.delete(waiter); throw coded('caller stopped waiting', 'CODEX_WAIT_ABORTED', { outcome: 'unknown' }); }
    let abort;
    const aborted = new Promise((_, reject) => {
      abort = () => reject(coded('caller stopped waiting', 'CODEX_WAIT_ABORTED', { outcome: 'unknown' }));
      signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([completion, aborted]); }
    finally { signal.removeEventListener('abort', abort); state.waiters.delete(waiter); }
  }

  function hasOpenWaiter(state) { return Boolean(state?.waiters?.size); }

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

  async function forkBinding({ binding, expectedSourceThreadId, onForked }) {
    if (closing) throw coded('executor is closing', 'CODEX_EXECUTOR_CLOSING', { retryable: true });
    const actor = identity({ bindingOpenId: binding.bindingOpenId || binding.feishuOpenId, chatId: binding.chatId, chatType: binding.chatType });
    const sourceThreadId = trim(expectedSourceThreadId);
    if (!sourceThreadId || typeof onForked !== 'function') throw coded('invalid fork request', 'CODEX_INVALID_INPUT');
    return client.lifecycle.run(() => withKeyLock(bindingKey(actor), async () => {
      if (activeByBinding.has(bindingKey(actor))) throw coded('binding has an active turn', 'CODEX_THREAD_BUSY', {
        outcome: 'rejected', phase: 'pre_admission', busyOrigin: 'local',
      });
      const current = await sessionStore.loadBinding(actor);
      if (!current || current.codexSessionId !== sourceThreadId) throw coded('fork source binding changed', 'CODEX_FORK_SOURCE_CHANGED', { outcome: 'rejected' });
      let response;
      try {
        response = await client.request('thread/fork', threadDefaults({
          threadId: sourceThreadId, ephemeral: false, deferGoalContinuation: true,
          ...(config.reasoningEffort ? { config: { model_reasoning_effort: config.reasoningEffort } } : {}),
        }));
      } catch (error) {
        error.code ||= 'CODEX_FORK_UNCONFIRMED';
        error.outcome ||= 'unknown';
        throw error;
      }
      const thread = response?.thread;
      const targetThreadId = trim(thread?.id);
      if (!targetThreadId || targetThreadId === sourceThreadId || !trim(thread?.cwd) || resolve(trim(thread.cwd)) !== resolve(config.cwd)
        || thread?.ephemeral === true || (thread?.forkedFromId && thread.forkedFromId !== sourceThreadId)) {
        throw coded('fork response could not be verified', 'CODEX_FORK_UNCONFIRMED', { outcome: 'unknown' });
      }
      let committed;
      try { committed = await onForked({ sourceThreadId, targetThreadId }); }
      catch (error) {
        error.outcome = 'unknown';
        error.forkTargetThreadId = targetThreadId;
        throw error;
      }
      loadedThreads.add(targetThreadId);
      return { sourceThreadId, targetThreadId, committed };
    }));
  }

  async function handleNotification(event) {
    if (event.method === 'serverRequest/resolved') {
      const threadId = trim(event.params?.threadId);
      const requestId = event.params?.requestId;
      if (!threadId || !((typeof requestId === 'string' && requestId) || (typeof requestId === 'number' && Number.isSafeInteger(requestId)))) return;
      const key = `${event.generation}:${threadId}:${typedRequestKey(requestId)}`;
      const state = [...activeByTurn.values()].find(candidate => candidate.threadId === threadId
        && candidate.userInput && typedRequestKey(candidate.userInput.public.requestId) === typedRequestKey(requestId));
      if (state) await expireUserInput(state, 'native_resolved', { resolved: true });
      else if (startingByThread.has(threadId)||[...activeByTurn.values()].some(candidate=>candidate.threadId===threadId)) rememberResolvedUserInput(key);
      return;
    }
    const turnId = trim(event.params?.turnId || event.params?.turn?.id);
    const state = activeByTurn.get(turnId);
    if (!state) return;
    const { method, params } = event;
    const progress = state.publicProgress(method, params);
    if (progress) sessionStore.saveCodexRealtimeEvent(state.binding, { messageId: state.messageId, eventKey: `public:${turnId}:${progress.id}:${method}`, eventType: 'public_progress', role: 'activity', title: '执行进度', text: '', createdAt: progress.at, detail: progress }).catch((_error) => log('warning', { module: 'agent-chat-bridge', component: 'codex-executor', operation: 'publish_progress', status: 'failed' }));
    if (method === 'agentMessage/delta' || method === 'item/agentMessage/delta') {
      const itemId = params.itemId || 'agent-delta';
      const next = limitText(`${state.itemText.get(itemId) || ''}${params.delta || ''}`, 12000);
      state.itemText.set(itemId, next); state.lastAgentMessage = next;
      await persistDelta(`${turnId}:${itemId}`, { state, event: { messageId: state.messageId, eventKey: `agent-delta:${turnId}:${itemId}`, eventType: 'agent_message', role: 'assistant', title: 'Codex', text: next, createdAt: now(), detail: { turnId, itemId, streaming: true } } });
    } else if (method === 'item/completed' && params.item) {
      await persistCompletedItem(state, params.item).catch((_error) => log('warning', { module: 'agent-chat-bridge', component: 'codex-executor', operation: 'persist_item', status: 'failed', threadId: state.threadId, turnId }));
    }
    else if (method === 'error' && params.willRetry !== true) state.reject(codexTurnError(params.error));
    else if (method === 'turn/completed') {
      for (const item of params.turn?.items || []) {
        await persistCompletedItem(state, item).catch((_error) => log('warning', { module: 'agent-chat-bridge', component: 'codex-executor', operation: 'persist_item', status: 'failed', threadId: state.threadId, turnId }));
      }
      if (params.turn?.status === 'failed' || params.turn?.status === 'interrupted') state.reject(codexTurnError(params.turn?.error, params.turn.status));
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
    if (!restartPending || restartNotified || activeByBinding.size || client.lifecycle.active) return;
    restartNotified = true;
    try { await onRestartRequired(restartPending); }
    catch { log('error', { module: 'agent-chat-bridge', component: 'codex-executor', operation: 'restart_required', status: 'failed' }); }
  }

  function checkMemory() {
    const usage = config.memoryUsage?.() || process.memoryUsage();
    const overRss = config.memoryMaxRssBytes && usage.rss >= config.memoryMaxRssBytes;
    const overHeap = config.memoryMaxHeapUsedBytes && usage.heapUsed >= config.memoryMaxHeapUsedBytes;
    if ((!overRss && !overHeap) || restartPending) return;
    restartPending = [overRss ? `rss ${usage.rss} >= ${config.memoryMaxRssBytes}` : '', overHeap ? `heapUsed ${usage.heapUsed} >= ${config.memoryMaxHeapUsedBytes}` : ''].filter(Boolean).join('; ');
    maybeNotifyRestart();
  }
  if (Number(config.memoryCheckIntervalMs) >= 1000 && (config.memoryMaxRssBytes || config.memoryMaxHeapUsedBytes)) {
    memoryTimer = setIntervalImpl(checkMemory, Number(config.memoryCheckIntervalMs)); memoryTimer?.unref?.();
  }

  return Object.freeze({
    execute, inspect, interrupt, forkBinding, answerUserInput,
    status: () => ({ ready: client.ready, lifecycleActive: client.lifecycle.active, closing: Boolean(client.closing), fault: client.fault || null, activeTurns: activeByTurn.size, activeTurnResponseWaiters: [...activeByBinding.values()].filter(hasOpenWaiter).length, restartPending: restartPending || null }),
    async close() {
      closing = true;
      clearIntervalImpl(memoryTimer);
      for (const admission of startingByThread.values()) admission.reject(coded('executor is closing', 'CODEX_EXECUTOR_CLOSING'));
      startingByThread.clear();
      await Promise.allSettled([...activeByTurn.values()].map(state => expireUserInput(state, 'shutdown', { resolved:true })));
      client.lifecycle.stop();
      await client.close('shutdown');
      await Promise.allSettled([...activeByTurn.values()].map((state) => state.finalized));
    },
  });
}
