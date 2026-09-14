import { createHash, randomUUID } from 'node:crypto';
import { deriveExecutionScope, codexBindingOpenId } from '../agents/codex/thread-scope.mjs';
import { publicAttachments } from '../channels/feishu/replies.mjs';

const terminal = new Set(['completed', 'failed', 'deferred']);
const stableMessageId = value => `api:${createHash('sha256').update(value).digest('hex')}`;
const terminalTurnError = error => ['CODEX_TURN_FAILED', 'CODEX_TURN_INTERRUPTED'].includes(error?.code);
const preAdmissionBusy = error => error?.code === 'CODEX_THREAD_BUSY'
  && (error?.phase === 'pre_admission' || error?.outcome === 'rejected');
const retryableError = error => {
  if (error?.code === 'CODEX_THREAD_BUSY') return true;
  if (terminalTurnError(error)) return false;
  const value = [error?.name, error?.code, error?.cause?.code, error?.message, error?.cause?.message]
    .filter(Boolean).join(' ');
  return /\b(?:AbortError|TimeoutError|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET)\b/i.test(value)
    || /steer delivery unconfirmed|timed out|timeout|network|socket hang up|fetch failed|aborted|stream disconnected before completion|error sending request/i.test(value);
};

function trustedBusyQueue(job) {
  if (job.result?.policy?.queueIfBusy !== true || !job.executionNamespace || !job.callerId) return false;
  try {
    return deriveExecutionScope(job.callerId, job.executionNamespace) === job.result?.execution?.bindingOpenId;
  } catch { return false; }
}

export function publicRun(job) {
  const execution = job.result?.execution || {};
  const executionFailed = job.result?.failed === true || ['failed', 'interrupted'].includes(job.result?.turnStatus || execution.terminal);
  const deliveryFacts = job.result?.delivery || {};
  const deliveryStates = [deliveryFacts.text?.items || [], deliveryFacts.attachments || []].flat().map(item => item.status);
  const recordedDelivery = deliveryStates.some(status => status === 'unknown') ? 'unknown'
    : deliveryStates.some(status => status === 'failed') ? 'failed'
    : deliveryStates.length && deliveryStates.every(status => ['sent', 'cleaned'].includes(status)) ? 'sent' : null;
  const delivery = job.deliveryMode === 'caller'
    ? { mode: 'caller', status: terminal.has(job.status) ? 'not_requested' : 'pending' }
    : { mode: 'bridge', status: recordedDelivery || (job.replySentAt ? 'sent' : job.status === 'reply_pending' ? 'pending' : job.status === 'failed' ? 'failed' : 'waiting') };
  return {
    id: job.id, conversationId: job.chatId, status: job.status,
    executionStatus: job.status === 'pending' ? 'pending' : job.status === 'held' ? 'held' : terminal.has(job.status)
      ? (job.status === 'failed' ? 'failed' : 'completed')
      : job.status === 'reply_pending' ? (executionFailed ? 'failed' : 'completed') : 'running',
    deliveryStatus: delivery.status, deliveryMode: delivery.mode, executionNamespace: job.executionNamespace,
    answer: job.result?.answer ?? null, rawAnswer: job.result?.rawAnswer ?? null,
    attachments: publicAttachments(job.result?.attachments),
    native: { threadId: execution.threadId || job.result?.threadId || null, turnId: execution.turnId || job.result?.turnId || null, status: execution.terminal || execution.status || null },
    held: job.status === 'held' ? { reason: job.last_error || execution.heldReason || 'native_outcome_unknown' } : null,
    result: {
      answer: job.result?.answer ?? null, rawAnswer: job.result?.rawAnswer ?? null,
      attachments: publicAttachments(job.result?.attachments), deferred: job.result?.deferred === true,
      failed: job.result?.failed === true, turnStatus: job.result?.turnStatus || execution.terminal || null,
      native: { threadId: execution.threadId || job.result?.threadId || null, turnId: execution.turnId || job.result?.turnId || null, status: execution.terminal || execution.status || null },
      held: job.status === 'held' ? { reason: job.last_error || execution.heldReason || 'native_outcome_unknown' } : null,
      delivery,
    },
    errorCode: job.last_error || null, createdAt: job.createdAt, updatedAt: job.updatedAt,
  };
}

export function createForwardRuntime({ config = {}, jobs, sessions, inbound, media, executor, feedback, replies,
  authorize = async () => true, allowBusyQueue = async () => false, log = () => {}, now = Date.now } = {}) {
  if (!jobs || !sessions || !executor) throw new Error('invalid_forward_runtime_dependencies');
  const owner = config.owner || randomUUID();
  const leaseMs = Number(config.leaseMs || 60_000);
  const pollMs = Number(config.pollMs || 30_000);
  const maxAttempts = Number(config.maxAttempts ?? 3);
  const retryDelayMs = Number(config.retryDelayMs ?? 60_000);
  const executeTimeoutMs = Number(config.executeTimeoutMs ?? 3 * 60 * 60 * 1000 + 10_000);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('invalid_forward_max_attempts');
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 10_000 || retryDelayMs > 1_800_000) throw new Error('invalid_forward_retry_delay');
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 600_000) throw new Error('invalid_forward_poll');
  if (!Number.isSafeInteger(executeTimeoutMs) || executeTimeoutMs < 10_000) throw new Error('invalid_forward_timeout');
  const active = new Set();
  const preparations = new Map();
  const leaseControllers = new Set();
  let running = false;
  let stopping = false;
  let healthy = true;
  let recoveryRunning = false;
  let worker;
  let wakeWorker;

  const claimOwner = () => `${owner.slice(0, 150)}:${randomUUID()}`;
  const wait = milliseconds => new Promise(resolve => {
    const timer = setTimeout(() => { wakeWorker = undefined; resolve(); }, milliseconds);
    timer.unref?.();
    wakeWorker = () => { clearTimeout(timer); wakeWorker = undefined; resolve(); };
  });
  function track(operation) {
    const promise = Promise.resolve(operation).catch(error => {
      log('error', 'forward_worker', 'failed', { code: error?.code || 'forward_worker_failed' });
    }).finally(() => active.delete(promise));
    active.add(promise);
    return promise;
  }
  function identity(input) {
    if (input.executionNamespace) return deriveExecutionScope(input.callerId, input.executionNamespace);
    return codexBindingOpenId({ feishuOpenId: input.actor?.openId || input.senderOpenId,
      chatId: input.message?.conversationId || input.conversationId,
      chatType: input.message?.conversationType || input.chatType });
  }
  async function register(input) {
    const conversationId = input.message?.conversationId || input.conversationId;
    if (!(await authorize({ source: input.source, callerId: input.callerId, actor: input.actor, conversationId, operation: 'run' }))) {
      throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
    }
    const bindingOpenId = identity(input);
    const messageId = input.message?.messageId || stableMessageId(`${input.callerId}\0${input.idempotencyKey}`);
    if (input.message?.messageId && jobs.getByMessageId) {
      const existing = await jobs.getByMessageId({ messageId });
      if (existing) return { ...existing, duplicate: true };
    }
    return jobs.upsert({
      callerId: input.callerId, idempotencyKey: input.idempotencyKey, conversationId, messageId,
      sourceMessageId: input.message?.messageId || null, bindingOpenId,
      chatType: input.message?.conversationType || input.chatType || 'group', messageType: input.message?.type || 'text',
      senderOpenId: input.actor?.openId || input.senderOpenId || bindingOpenId, senderName: input.actor?.name || input.senderName || '',
      executionNamespace: input.executionNamespace || '', deliveryMode: input.deliveryMode || input.delivery?.mode || 'bridge',
      prompt: input.prompt || input.message?.text || '', groupChatContext: input.executionNamespace ? null : (input.groupChatContext || null),
      contextEntries: input.executionNamespace ? [] : (input.context || []), nextAttemptAt: input.notBefore,
      initialResult: { inputEvent: input.message?.event ?? null, policy: { queueIfBusy: input.queueIfBusy === true } },
    });
  }

  async function prepareRegistered(job) {
    const execution = job?.result?.execution || {};
    if (!job || execution.inputStatus || !media || !job.result?.inputEvent) return job;
    if (preparations.has(job.id)) return preparations.get(job.id);
    const operation = (async () => {
      const prepared = await media.prepare(job.result.inputEvent, { runId: job.id });
      const preparedExecution = {
        ...execution,
        inputStatus: prepared.status,
        ...(prepared.status === 'ready' ? {
          preparedPrompt: [job.prompt, prepared.addendum].filter(Boolean).join('\n\n'),
        } : {
          inputReason: prepared.reason || `input_${prepared.status}`,
          inputReplyText: prepared.replyText || '',
        }),
      };
      return jobs.patchPreparedInput
        ? await jobs.patchPreparedInput({ id: job.id, execution: preparedExecution })
        : { ...job, result: { ...job.result, execution: preparedExecution } };
    })().finally(() => preparations.delete(job.id));
    preparations.set(job.id, operation);
    return operation;
  }

  async function withLease(job, operation) {
    let lost = false;
    const controller = new AbortController();
    leaseControllers.add(controller);
    const lose = () => { lost = true; controller.abort(); };
    const heartbeatMs = Number(config.heartbeatMs || Math.max(1000, Math.floor(leaseMs / 3)));
    let timer;
    try {
      await jobs.renew({ id: job.id, leaseOwner: job.leaseOwner, leaseMs });
      timer = setInterval(() => jobs.renew({ id: job.id, leaseOwner: job.leaseOwner, leaseMs }).catch(lose), heartbeatMs);
      timer.unref?.();
      const assertOwned = () => {
        if (lost) throw Object.assign(new Error('forward_lease_lost'), { code: 'forward_lease_lost' });
        if (stopping) throw Object.assign(new Error('forward_runtime_stopping'), { code: 'forward_runtime_stopping' });
      };
      const result = await operation({ signal: controller.signal, assertOwned, assertLease: assertOwned });
      assertOwned();
      return result;
    } finally {
      clearInterval(timer);
      leaseControllers.delete(controller);
    }
  }

  async function executeOwnedJob(job, lease) {
    let execution = { ...(job.result?.execution || {}) };
    let state;
    let needsDelivery = false;
    let queueIfBusy = false;
    try {
      queueIfBusy = trustedBusyQueue(job) && await allowBusyQueue({ callerId: job.callerId, conversationId: job.chatId });
      if (execution.inputStatus && execution.inputStatus !== 'ready') {
        const result = { inputStatus: execution.inputStatus,
          errorCode: execution.inputReason || `input_${execution.inputStatus}`,
          answer: execution.inputReplyText || '', rawAnswer: '', attachments: [], execution };
        if (execution.inputStatus === 'ignored') {
          await jobs.markFinishedWithoutReply({ id: job.id, leaseOwner: job.leaseOwner, status: 'completed', result });
        } else {
          await feedback?.prepare?.(job, result, null);
          await jobs.markReplyPending({ id: job.id, leaseOwner: job.leaseOwner, result, errorCode: result.errorCode });
          needsDelivery = true;
        }
        return;
      }
      const prompt = execution.inputStatus === 'ready' && typeof execution.preparedPrompt === 'string'
        ? execution.preparedPrompt : job.prompt;
      const input = {
        bindingOpenId: job.executionNamespace ? deriveExecutionScope(job.callerId, job.executionNamespace)
          : (execution.bindingOpenId || codexBindingOpenId({ feishuOpenId: job.senderOpenId, chatId: job.chatId, chatType: job.chatType })),
        chatId: job.chatId, chatType: job.chatType, messageId: job.messageId,
        senderOpenId: job.senderOpenId, senderName: job.senderName, prompt, groupChatContext: job.groupChatContext,
        busyPolicy: job.executionNamespace || config.steering === false ? 'reject' : 'steer',
        queueIfBusy,
      };
      state = job.deliveryMode === 'bridge'
        ? await (job.recovered ? feedback?.restore?.(job, lease) : feedback?.start?.(job, lease)) : null;
      feedback?.observe?.(job, state, { bindingOpenId: input.bindingOpenId });
      lease.assertOwned();
      const timeout = AbortSignal.timeout(executeTimeoutMs);
      let result;
      try {
        result = await executor.execute(input, { signal: AbortSignal.any([lease.signal, timeout]) });
      } catch (error) {
        if (timeout.aborted && !lease.signal.aborted) throw Object.assign(new Error('forward_timeout'), { code: 'CODEX_FORWARD_TIMEOUT', retryable: true });
        throw error;
      }
      lease.assertOwned();
      if (result.failed === true || ['failed','interrupted'].includes(result.turnStatus)) {
        throw Object.assign(new Error('codex_turn_failed'), {
          code: result.turnStatus === 'interrupted' ? 'CODEX_TURN_INTERRUPTED' : 'CODEX_TURN_FAILED',
        });
      }
      execution = { ...execution, bindingOpenId: input.bindingOpenId, threadId: result.threadId || result.sessionId || '',
        turnId: result.turnId || '', terminal: result.deferred ? 'deferred' : 'completed', finishedAt: now() };
      result = { ...result, execution };
      if (inbound && (!result.deferred || result.accepted !== false)) {
        await inbound.markForwarded({ entries: job.contextEntries, threadId: result.threadId || result.sessionId, turnId: result.turnId });
      }
      if (result.deferred) {
        await feedback?.prepare?.(job, result, state);
        await jobs.markFinishedWithoutReply({ id: job.id, leaseOwner: job.leaseOwner, status: 'deferred', result });
        return;
      }
      await feedback?.prepare?.(job, result, state);
      await jobs.markReplyPending({ id: job.id, leaseOwner: job.leaseOwner, result });
      needsDelivery = true;
    } catch (error) {
      if (lease.signal.aborted || ['forward_lease_lost', 'forward_runtime_stopping'].includes(error?.code)) {
        lease.assertOwned();
        throw error;
      }
      lease.assertOwned();
      const queueBusy = preAdmissionBusy(error) && queueIfBusy;
      if (retryableError(error) && (queueBusy || job.attempts < maxAttempts)) {
        const nextRetryAt = now() + retryDelayMs;
        await feedback?.wait?.(job, state).catch(() => {});
        await jobs.markRetry({ id: job.id, leaseOwner: job.leaseOwner, preserveAttempt: queueBusy,
          errorCode: error.code || 'forward_execution_failed', nextAttemptAt: nextRetryAt });
        log('warning', 'forward_execution', queueBusy ? 'waiting' : 'retrying', {
          code: error.code || 'forward_execution_failed', runId: job.id, attempt: job.attempts, maxAttempts, nextRetryAt,
        });
        return;
      }
      execution = { ...execution, terminal: error.code === 'CODEX_TURN_INTERRUPTED' ? 'interrupted' : 'failed', finishedAt: now() };
      const failed = { failed: true, turnStatus: execution.terminal,
        answer: error.code === 'CODEX_TURN_INTERRUPTED' ? '执行已停止。' : preAdmissionBusy(error) ? '会话被其他客户端占用，请释放后重试或新建会话。' : '执行未完成，请稍后重试。',
        rawAnswer: '', attachments: [], execution };
      await feedback?.prepare?.(job, failed, state);
      await jobs.markReplyPending({ id: job.id, leaseOwner: job.leaseOwner, result: failed, errorCode: error.code || 'forward_execution_failed' });
      needsDelivery = true;
    } finally {
      feedback?.abandon?.(state);
      if (state && !needsDelivery) await feedback?.cleanup?.(job, { ...lease, reaction: state.typing }).catch(() => {
        log('warning', 'typing_reaction', 'cleanup_failed', { code: 'typing_reaction_cleanup_failed' });
      });
    }
    return state?.typing || null;
  }

  async function executeJob(job) {
    try { return await withLease(job, lease => executeOwnedJob(job, lease)); }
    catch (error) {
      if (!['forward_lease_lost', 'forward_runtime_stopping'].includes(error?.code)) throw error;
      log('warning', 'forward_execution', 'stopped', { code: error.code });
    }
  }
  async function deliverJob(job, reaction = null) {
    try {
      await withLease(job, async lease => {
        let result = job.result || {};
        if (!result.deferred) result = await replies?.prepare?.(job, result) || result;
        lease.assertOwned();
        let delivery = { status: job.deliveryMode === 'caller' ? 'not_requested' : 'sent' };
        try {
          if (job.deliveryMode === 'bridge') {
            const cardDelivered = await feedback?.finish?.(job, result, null, lease);
            lease.assertOwned();
            delivery = await replies.deliver(job, result, { skipText: cardDelivered || result.deferred,
              signal: lease.signal, assertLease: lease.assertOwned });
            if (delivery.status === 'unknown') {
              await jobs.markRetry({ id: job.id, leaseOwner: job.leaseOwner, replyPending: true,
                errorCode: 'reply_delivery_unknown', nextAttemptAt: now() + retryDelayMs });
              return;
            }
          }
          lease.assertOwned();
          const status = result.deferred ? 'deferred' : result.failed ? 'failed' : 'completed';
          await jobs.markFinished({ id: job.id, leaseOwner: job.leaseOwner, status, result,
            replySent: job.deliveryMode === 'bridge' && delivery.status === 'sent',
            errorCode: delivery.status === 'failed' ? 'reply_delivery_failed' : job.last_error || result.errorCode });
          if (inbound && job.deliveryMode === 'bridge' && delivery.status === 'sent') {
            await inbound.recordReply({ messageId: `bridge-reply:${job.id}`, chatId: job.chatId,
              chatType: job.chatType, text: result.answer || '', createdAt: now() });
          }
        } finally {
          if (job.deliveryMode === 'bridge') await feedback?.cleanup?.(job, { ...lease, reaction }).catch(() => {
            log('warning', 'typing_reaction', 'cleanup_failed', { code: 'typing_reaction_cleanup_failed' });
          });
        }
      });
    } catch (error) {
      if (['forward_lease_lost', 'forward_runtime_stopping'].includes(error?.code)) return;
      await jobs.markRetry({ id: job.id, leaseOwner: job.leaseOwner, replyPending: true,
        errorCode: error.code || 'reply_delivery_unknown', nextAttemptAt: now() + retryDelayMs });
      log('warning', 'forward_delivery', 'pending', { code: error.code || 'reply_delivery_unknown' });
    }
  }

  const claimOne = async id => jobs.claimById
    ? jobs.claimById({ id, owner: claimOwner(), leaseMs })
    : (await jobs.claim({ owner: claimOwner(), leaseMs, limit: 1 }))[0] || null;
  const claimReplyOne = async id => jobs.claimReplyById
    ? jobs.claimReplyById({ id, owner: claimOwner(), leaseMs })
    : (await jobs.claimReplyPending({ owner: claimOwner(), leaseMs, limit: 1 }))[0] || null;
  async function processRegistered(id, { recovered = false } = {}) {
    if (stopping) return null;
    const pending = await jobs.getRun({ id });
    if (['pending','running'].includes(pending?.status)) await prepareRegistered(pending);
    const job = await claimOne(id);
    const reaction = job ? await executeJob({ ...job, recovered }) : null;
    const reply = await claimReplyOne(id);
    if (reply) await deliverJob(reply, reaction);
    return jobs.getRun({ id });
  }
  async function submit(input) {
    const registered = await register(input);
    track(processRegistered(registered.id));
    return registered;
  }
  async function handleMessage(input) {
    const registered = await register(input);
    const result = await processRegistered(registered.id);
    return result?.result || result || registered;
  }
  async function recover() {
    if (recoveryRunning || stopping) return;
    recoveryRunning = true;
    try {
      for (const reply of await jobs.claimReplyPending({ owner: claimOwner(), leaseMs, limit: 5 })) await deliverJob(reply);
      if (jobs.loadRecoverable) {
        for (const job of await jobs.loadRecoverable({ limit: 5 })) await processRegistered(job.id, { recovered: true });
      } else {
        for (const job of await jobs.claim({ owner: claimOwner(), leaseMs, limit: 5 })) {
          const reaction = await executeJob({ ...job, recovered: true });
          const reply = await claimReplyOne(job.id);
          if (reply) await deliverJob(reply, reaction);
        }
      }
    } finally { recoveryRunning = false; }
  }
  async function loop() {
    await wait(Math.min(5000, pollMs));
    while (!stopping) {
      try { await recover(); }
      catch (error) {
        log('error', 'forward_worker', 'failed', { code: error?.code || 'worker_poll_failed' });
      }
      if (!stopping) await wait(pollMs);
    }
  }
  function beginStop() {
    stopping = true;
    wakeWorker?.();
    for (const controller of leaseControllers) controller.abort();
  }
  return Object.freeze({
    submit, handleMessage, recover,
    getRun: async ({ id }) => { const job = await jobs.getRun({ id }); return job ? publicRun(job) : null; },
    readRunEvents: async input => { const items = await jobs.readEvents(input); return { items, nextCursor: items.at(-1)?.sequence ?? String(input.after ?? '0') }; },
    getResource: async ({ id, index }) => { const job = await jobs.getRun({ id }); return job ? replies.readResource(job, index) : null; },
    start() { if (running) throw new Error('forward_runtime_already_started'); running = true; worker = loop(); },
    beginStop,
    async stop() { beginStop(); await worker; await Promise.allSettled(active); },
    status() { return { running: running && !stopping && healthy, healthy, active: active.size, recoveryRunning, owner }; },
  });
}
