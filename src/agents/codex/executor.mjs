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
  if (message) return trim(message.text || (message.content || []).map((part) => part?.text || part?.output_text || '').join('\n'));
  return trim([...items].reverse().find((item) => item?.type === 'agentMessage' && trim(item.text))?.text);
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
    let reason = '';
    const idleMs = Number(config.rolloverIdleMs || 0);
    if (idleMs > 0 && binding.lastMessageAt > 0 && now() - binding.lastMessageAt >= idleMs) reason = 'session_idle';
    if (!reason && config.rolloverOnRulesUpdate !== false && config.rulesPaths?.length) {
      const rulesMtimeMs = Math.max(0, ...config.rulesPaths.map((path) => { try { return statSync(resolve(config.cwd, path)).mtimeMs || 0; } catch { return 0; } }));
      if (rulesMtimeMs) {
        try {
          const response = await client.request('thread/read', { threadId: binding.codexSessionId, includeTurns: false }, { timeoutMs: config.rolloverCheckTimeoutMs });
          const createdAt = codexThreadCreatedAtMs(response?.thread?.createdAt || response?.thread?.created_at);
          if (shouldRolloverForRules({ rulesMtimeMs, threadCreatedAtMs: createdAt })) reason = 'rules_updated';
        } catch { log('warning', { module: 'agent-chat-bridge', component: 'codex-executor', operation: 'rules_check', status: 'failed' }); }
      }
    }
    if (!reason) return binding;
    return rollover(binding, messageId, reason);
  }

  async function rollover(binding, messageId, reason) {
    const previous = binding.codexSessionId;
    const started = await startThread(binding);
    const next = { ...binding, codexSessionId: started.threadId, threadName: started.threadName, created: true, rolledOver: true };
    const detail = { oldCodexSessionId: previous, newCodexSessionId: started.threadId, reason, messageId };
    await sessionStore.saveCodexRealtimeEvent(binding, { messageId, eventKey: `rollover-out:${previous}:${started.threadId}`, eventType: 'session_rollover', role: 'activity', title: '会话承接', text: '后续消息承接到新 Codex 会话。', createdAt: now(), detail });
    await sessionStore.saveCodexBinding(next, { messageId, lastError: '' });
    await sessionStore.saveCodexRealtimeEvent(next, { messageId, eventKey: `rollover-in:${previous}:${started.threadId}`, eventType: 'session_rollover', role: 'activity', title: '会话承接', text: '本会话开始承接后续消息。', createdAt: now(), detail });
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
    activeByBinding.set(bindingKey(state.binding), state);
    activeByTurn.set(state.turnId, state);
    const releaseActivity = client.lifecycle.hold();
    state.completed.finally(() => {
      releaseActivity();
      activeByTurn.delete(state.turnId);
      if (activeByBinding.get(bindingKey(state.binding)) === state) activeByBinding.delete(bindingKey(state.binding));
      maybeNotifyRestart();
    }).catch(() => {});
    const early = earlyNotifications.get(state.turnId) || [];
    earlyNotifications.delete(state.turnId);
    for (const event of early) await handleNotification(event);
  }

  async function execute(input, options = {}) {
    if (closing) throw coded('executor is closing', 'CODEX_EXECUTOR_CLOSING', { retryable: true });
    const actor = identity(input);
    const normalized = { ...input, prompt: String(input.prompt || ''), messageId: trim(input.messageId), busyPolicy: input.busyPolicy || 'steer' };
    if (!normalized.prompt.trim()) throw coded('empty prompt', 'CODEX_INVALID_INPUT');
    if (!['steer', 'reject'].includes(normalized.busyPolicy)) throw coded('invalid busy policy', 'CODEX_INVALID_INPUT');
    return client.lifecycle.run(async () => {
      const routed = await withKeyLock(bindingKey(actor), async () => {
      const active = activeByBinding.get(bindingKey(actor));
      if (active) {
        if (active.bindingUncertain) {
          const error = coded('native turn started but durable binding is uncertain', 'CODEX_BINDING_UNCERTAIN', { outcome: 'unknown' });
          Object.assign(error, { threadId: active.threadId, turnId: active.turnId, startedAt: active.startedAt });
          throw error;
        }
        if (normalized.busyPolicy === 'reject') throw coded('binding already has an active turn', 'CODEX_THREAD_BUSY', { retryable: true });
        if (normalized.messageId && normalized.messageId === active.messageId) {
          return { completion: waitForTurn(active, normalized.messageId, { takeover: true, signal: options.signal }) };
        }
        const result = await steer(active, normalized);
        return result?.restart ? { restart: result } : { completion: Promise.resolve(result) };
      }
      let binding = await ensureBinding(actor, normalized.messageId);
      const duplicate = await sessionStore.findAcceptedMessageEvent(binding, normalized.messageId);
      if (duplicate) return { completion: Promise.resolve(duplicateResult(binding, duplicate)) };
      const reconciled = await reconcileSteer(binding, normalized.messageId, normalized.prompt);
      if (reconciled) return { completion: Promise.resolve(reconciled) };
      if (options.resume) return { completion: resumeKnown(binding, normalized, options) };
      binding = await maybeRollover(binding, normalized.messageId);
      try { await ensureThreadReady(binding); }
      catch (error) {
        if (!/session\s+[^\s]+\s+is archived/i.test(error.message)) throw error;
        binding = await rollover(binding, normalized.messageId, 'codex_session_archived');
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
      if (routed.restart) return execute(routed.restart.input, options);
      return routed.completion;
    });
  }

  async function resumeKnown(binding, input, options) {
    const resume = options.resume || {};
    if (!trim(resume.threadId) || !trim(resume.turnId)) throw coded('start outcome has no persisted turn identity', 'CODEX_START_UNCONFIRMED', { outcome: 'unknown' });
    if (resume.threadId !== binding.codexSessionId) throw coded('resume thread does not match binding', 'CODEX_RESUME_MISMATCH');
    pendingKnownTurns.add(resume.turnId);
    let snapshot;
    try {
      const response = await client.request('thread/resume', threadDefaults({ threadId: resume.threadId,
        ...(config.reasoningEffort ? { config: { model_reasoning_effort: config.reasoningEffort } } : {}) }));
      snapshot = exactTurnSnapshot(response?.thread, resume.turnId);
    }
    catch (error) { pendingKnownTurns.delete(resume.turnId); throw error; }
    if (snapshot.status === 'unknown') { pendingKnownTurns.delete(resume.turnId); throw coded('persisted turn could not be confirmed', 'CODEX_TURN_UNKNOWN', { retryable: true, outcome: 'unknown' }); }
    if (snapshot.status !== 'inProgress') { pendingKnownTurns.delete(resume.turnId); return resultFromSnapshot(binding, input, snapshot); }
    const state = createTurnState(binding, input, resume.turnId, Number(resume.startedAt) || now());
    await registerState(state);
    pendingKnownTurns.delete(resume.turnId);
    return waitForTurn(state, input.messageId, { created: false, signal: options.signal });
  }

  function resultFromSnapshot(binding, input, snapshot) {
    if (snapshot.status === 'completed') return { deferred: false, threadId: snapshot.threadId, turnId: snapshot.turnId, created: false, answer: limitText(finalAnswer(snapshot.turn), config.maxOutputChars || 3500), attachments: [] };
    throw coded(`Codex turn ${snapshot.status}`, snapshot.status === 'interrupted' ? 'CODEX_TURN_INTERRUPTED' : 'CODEX_TURN_FAILED');
  }

  async function waitForTurn(state, messageId, { created = false, takeover = false, signal } = {}) {
    const completion = state.completed.then(async ({ turn }) => {
      const answer = finalAnswer(turn) || state.lastAgentMessage;
      if (answer) await sessionStore.saveCodexRealtimeEvent(state.binding, { messageId, eventKey: `assistant-final:${messageId || stableKey(answer)}`, eventType: 'agent_message', role: 'assistant', title: 'Codex 回复', text: answer, createdAt: now(), detail: { phase: 'final_answer', turnId: state.turnId, takeover } });
      await sessionStore.touchCodexBinding(state.binding, { messageId, lastError: '' });
      return { deferred: false, threadId: state.threadId, turnId: state.turnId, created, takeover, answer: limitText(answer, config.maxOutputChars || 3500), attachments: collectOutboxAttachments(state.binding, state.outboxScanFromMs, { workspace: config.cwd, outboxRelativeRoot: config.outboxRelativeRoot, allowedGroupChatIds: config.allowedGroupChatIds, log }) };
    }, async (error) => {
      await sessionStore.saveCodexRealtimeEvent(state.binding, { messageId, eventKey: `error:${messageId || state.turnId}`, eventType: 'error', role: 'activity', title: 'Codex 会话失败', text: error.message, createdAt: now(), detail: { turnId: state.turnId, turnStatus: error.code === 'CODEX_TURN_INTERRUPTED' ? 'interrupted' : 'failed' } });
      await sessionStore.touchCodexBinding(state.binding, { messageId, lastError: error.message });
      throw error;
    });
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
    if (item?.type === 'agentMessage' && trim(item.text)) state.lastAgentMessage = item.text;
    if (!['agentMessage', 'message'].includes(item?.type)) return;
    const text = trim(item.text || (item.content || []).map((part) => part?.text || part?.output_text || '').join('\n'));
    if (!text) return;
    await sessionStore.saveCodexRealtimeEvent(state.binding, { messageId: state.messageId, eventKey: `item:${state.turnId}:${item.id || stableKey(JSON.stringify(item))}`, eventType: item.role === 'user' ? 'user_message' : 'agent_message', role: item.role === 'user' ? 'user' : 'assistant', title: item.phase === 'final_answer' ? 'Codex 回复' : 'Codex', text, createdAt: now(), detail: { turnId: state.turnId, itemType: item.type, phase: item.phase || '' } });
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
    async close() { closing = true; clearInterval(memoryTimer); client.lifecycle.stop(); await client.close('shutdown'); },
  });
}
