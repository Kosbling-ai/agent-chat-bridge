import { createHash, randomUUID } from 'node:crypto';
import { deriveExecutionScope, codexBindingOpenId } from '../agents/codex/thread-scope.mjs';
import { buildBusinessEventPrompt } from '../agents/codex/prompt.mjs';

const terminalTurnError = error => ['CODEX_TURN_FAILED', 'CODEX_TURN_INTERRUPTED', 'CODEX_USAGE_LIMIT_EXCEEDED'].includes(error?.code);
const isBusy = error => error?.code === 'CODEX_THREAD_BUSY';
const retryableError = error => {
  if (isBusy(error)) return false;
  if (terminalTurnError(error)) return false;
  const value = [error?.name, error?.code, error?.cause?.code, error?.message, error?.cause?.message]
    .filter(Boolean).join(' ');
  return /\b(?:AbortError|TimeoutError|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET)\b/i.test(value)
    || /steer delivery unconfirmed|timed out|timeout|network|socket hang up|fetch failed|aborted|stream disconnected before completion|error sending request/i.test(value);
};
const eventIdempotencyKey = (producerId, eventId) => `event\0${producerId}\0${eventId}`;
const eventMessageId = (producerId, eventId) => `event:${createHash('sha256').update(`${producerId}\0${eventId}`).digest('hex')}`;

export function createForwardRuntime({ config = {}, jobs, sessions, inbound, media, executor, feedback, replies,
  authorize = async () => true, log = () => {}, now = Date.now } = {}) {
  if (!jobs || !sessions || !executor) throw new Error('invalid_forward_runtime_dependencies');
  const owner = config.owner || randomUUID();
  const leaseMs = Number(config.leaseMs || 60_000);
  const pollMs = Number(config.pollMs || 30_000);
  const maxAttempts = Number(config.maxAttempts ?? 3);
  const retryDelayMs = Number(config.retryDelayMs ?? 60_000);
  const executeTimeoutMs = Number(config.executeTimeoutMs ?? 12 * 60 * 60 * 1000 + 10_000);
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
    const messageId = input.message?.messageId;
    if (jobs.getByMessageId) {
      const existing = await jobs.getByMessageId({ messageId });
      if (existing) return { ...existing, duplicate: true };
    }
    return jobs.upsert({
      callerId: input.callerId, idempotencyKey: input.idempotencyKey, conversationId, messageId,
      sourceMessageId: input.message?.messageId || null, bindingOpenId,
      chatType: input.message?.conversationType || input.chatType || 'group', messageType: input.message?.type || 'text',
      senderOpenId: input.actor?.openId || input.senderOpenId || bindingOpenId, senderName: input.actor?.name || input.senderName || '',
      executionNamespace: '', deliveryMode: 'bridge',
      prompt: input.prompt || input.message?.text || '', groupChatContext: input.groupChatContext || null,
      contextEntries: input.context || [], nextAttemptAt: input.notBefore,
      initialResult: { inputEvent: input.message?.event ?? null,
        contextAttachmentLimit: input.message?.contextAttachmentLimit ?? 10 },
    });
  }

  async function registerEvent(input) {
    const bindingOpenId = deriveExecutionScope(input.producerId, input.scope);
    const messageId = eventMessageId(input.producerId, input.eventId);
    const registered = await jobs.upsert({
      callerId: input.producerId,
      idempotencyKey: eventIdempotencyKey(input.producerId, input.eventId),
      requestHash: input.requestHash,
      conversationId: input.chatId,
      messageId,
      sourceMessageId: null,
      bindingOpenId,
      chatType: 'group',
      messageType: 'event',
      senderOpenId: `system:${input.producerId}`,
      senderName: input.producerId,
      executionNamespace: input.scope,
      deliveryMode: 'caller',
      prompt: buildBusinessEventPrompt(input),
      contextEntries: [],
      initialResult: { businessEvent: {
        eventId: input.eventId,
        type: input.type,
        correlationId: input.correlationId,
        occurredAt: input.occurredAt,
        refIds: input.refIds,
      } },
    });
    if (registered.messageId !== messageId
      || registered.callerId !== input.producerId || registered.executionNamespace !== input.scope) {
      throw Object.assign(new Error('job_conflict'), { code: 'job_conflict' });
    }
    if (!registered.duplicate && running && !stopping) track(processRegistered(registered.id));
    wakeWorker?.();
    return { jobId: registered.id, bindingOpenId, deduplicated: Boolean(registered.duplicate) };
  }

  async function getEvent({ producerId, eventId }) {
    const messageId = eventMessageId(producerId, eventId);
    const job = await jobs.getByIdempotencyKey({ callerId: producerId, idempotencyKey: eventIdempotencyKey(producerId, eventId) });
    return job?.messageId === messageId
      ? {
          jobId: job.id,
          status: job.status,
          updatedAt: job.updatedAt,
          type: job.result?.businessEvent?.type,
          scope: job.executionNamespace,
        } : null;
  }

  async function prepareRegistered(job) {
    const execution = job?.result?.execution || {};
    if (!job || execution.inputStatus || !media || !job.result?.inputEvent) return job;
    if (preparations.has(job.id)) return preparations.get(job.id);
    const operation = (async () => {
      const prepared = await media.prepare(job.result.inputEvent, { runId: job.id,
        contextEntries: job.contextEntries || [], contextAttachmentLimit: job.result.contextAttachmentLimit ?? 10 });
      const preparedExecution = {
        ...execution,
        inputStatus: prepared.status,
        preparedPrompt: [job.prompt, prepared.addendum].filter(Boolean).join('\n\n'),
        attachments: prepared.attachments,
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
    try {
      const prompt = execution.inputStatus === 'ready' && typeof execution.preparedPrompt === 'string'
        ? execution.preparedPrompt : job.prompt;
      const input = {
        bindingOpenId: job.executionNamespace ? deriveExecutionScope(job.callerId, job.executionNamespace)
          : (execution.bindingOpenId || codexBindingOpenId({ feishuOpenId: job.senderOpenId, chatId: job.chatId, chatType: job.chatType })),
        chatId: job.chatId, chatType: job.chatType, messageId: job.messageId,
        senderOpenId: job.senderOpenId, senderName: job.senderName, prompt, attachments: execution.attachments || [], groupChatContext: job.groupChatContext,
        busyPolicy: config.steering === false || (job.executionNamespace && !job.result?.businessEvent) ? 'reject' : 'steer',
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
          code: result.turnStatus === 'interrupted' ? 'CODEX_TURN_INTERRUPTED' : ['CODEX_USAGE_LIMIT_EXCEEDED', 'CODEX_SERVER_OVERLOADED'].includes(result.errorCode) ? result.errorCode : 'CODEX_TURN_FAILED',
          ...(result.errorMessage ? { publicMessage: result.errorMessage } : {}),
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
      if (retryableError(error) && job.attempts < maxAttempts) {
        const nextRetryAt = now() + retryDelayMs;
        await feedback?.wait?.(job, state).catch(() => {});
        await jobs.markRetry({ id: job.id, leaseOwner: job.leaseOwner,
          errorCode: error.code || 'forward_execution_failed', nextAttemptAt: nextRetryAt });
        log('warning', 'forward_execution', 'retrying', {
          code: error.code || 'forward_execution_failed', runId: job.id, attempt: job.attempts, maxAttempts, nextRetryAt,
        });
        return;
      }
      execution = { ...execution, terminal: error.code === 'CODEX_TURN_INTERRUPTED' ? 'interrupted' : 'failed', finishedAt: now() };
      let busyFork;
      if (isBusy(error) && job.deliveryMode === 'bridge' && job.sourceMessageId
        && !job.senderOpenId.startsWith('system:') && !job.senderOpenId.startsWith('group:')) {
        const scopedBindingOpenId = execution.bindingOpenId || codexBindingOpenId({
          feishuOpenId: job.senderOpenId, chatId: job.chatId, chatType: job.chatType,
        });
        const current = await sessions.loadBinding({ feishuOpenId: scopedBindingOpenId, chatId: job.chatId, chatType: job.chatType }).catch(() => null);
        if (current?.codexSessionId) busyFork = { sourceThreadId: current.codexSessionId, bindingOpenId: scopedBindingOpenId, chatId: job.chatId };
      }
      const failed = { failed: true, turnStatus: execution.terminal,
        answer: error.publicMessage || (error.code === 'CODEX_USAGE_LIMIT_EXCEEDED' ? 'Codex 额度不足，本次执行已停止。请在额度恢复后再继续；不会自动重试此任务。' : error.code === 'CODEX_TURN_INTERRUPTED' ? '执行已停止。' : isBusy(error) ? '会话被其他客户端占用，请释放后重试。原会话绑定保持不变。' : '执行未完成，请稍后重试。'),
        rawAnswer: '', attachments: [], execution, ...(busyFork ? { busyFork } : {}) };
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
    handleMessage, registerEvent, getEvent, recover,
    start() { if (running) throw new Error('forward_runtime_already_started'); running = true; worker = loop(); },
    beginStop,
    async stop() { beginStop(); await worker; await Promise.allSettled(active); },
    status() { return { running: running && !stopping && healthy, healthy, active: active.size, recoveryRunning, owner }; },
  });
}
