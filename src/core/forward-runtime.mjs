import { createHash, randomUUID } from 'node:crypto';
import { deriveExecutionScope, codexBindingOpenId } from '../agents/codex/thread-scope.mjs';
import { publicAttachments } from '../channels/feishu/replies.mjs';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const terminal = new Set(['completed', 'failed', 'deferred']);
const retryable = error => error?.retryable === true || ['CODEX_THREAD_BUSY', 'CODEX_EXECUTOR_CLOSING'].includes(error?.code);
const held = error => error?.outcome === 'unknown' || [
  'CODEX_BINDING_UNCERTAIN', 'CODEX_TURN_START_UNCONFIRMED', 'CODEX_START_UNCONFIRMED',
  'CODEX_TURN_UNKNOWN', 'CODEX_OBSERVATION_LOST',
].includes(error?.code);
const stableMessageId = value => `api:${createHash('sha256').update(value).digest('hex')}`;

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
    deliveryStatus: delivery.status, deliveryMode: delivery.mode,
    executionNamespace: job.executionNamespace,
    answer: job.result?.answer ?? null, rawAnswer: job.result?.rawAnswer ?? null,
    attachments: publicAttachments(job.result?.attachments),
    native: { threadId: execution.threadId || job.result?.threadId || null, turnId: execution.turnId || job.result?.turnId || null, status: execution.terminal || execution.status || null },
    held: job.status === 'held' ? { reason: job.last_error || execution.heldReason || 'native_outcome_unknown' } : null,
    result: {
      answer: job.result?.answer ?? null, rawAnswer: job.result?.rawAnswer ?? null,
      attachments: publicAttachments(job.result?.attachments),
      deferred: job.result?.deferred === true, failed: job.result?.failed === true,
      turnStatus: job.result?.turnStatus || execution.terminal || null,
      native: { threadId: execution.threadId || job.result?.threadId || null, turnId: execution.turnId || job.result?.turnId || null, status: execution.terminal || execution.status || null },
      held: job.status === 'held' ? { reason: job.last_error || execution.heldReason || 'native_outcome_unknown' } : null,
      delivery,
    },
    errorCode: job.last_error || null, createdAt: job.createdAt, updatedAt: job.updatedAt,
  };
}

export function createForwardRuntime({ config = {}, jobs, sessions, inbound, media, executor, feedback, replies, authorize = async () => true, log = () => {}, now = Date.now } = {}) {
  if (!jobs || !sessions || !executor) throw new Error('invalid_forward_runtime_dependencies');
  const owner = config.owner || randomUUID();
  const leaseMs = Number(config.leaseMs || 60000);
  const pollMs = Number(config.pollMs || 100);
  const maxAttempts = Number(config.maxAttempts || 3);
  const maxActive = Math.max(1, Math.min(8, Number(config.maxActive || 5)));
  const claimOwner = () => `${owner.slice(0, 150)}:${randomUUID()}`;
  const active = new Set();
  const leaseControllers = new Set();
  let running = false;
  let stopping = false;
  let healthy = true;
  let worker;

  function identity(input) {
    if (input.executionNamespace) return deriveExecutionScope(input.callerId, input.executionNamespace);
    return codexBindingOpenId({ feishuOpenId: input.actor?.openId || input.senderOpenId, chatId: input.message?.conversationId || input.conversationId, chatType: input.message?.conversationType || input.chatType });
  }

  async function submit(input) {
    const conversationId = input.message?.conversationId || input.conversationId;
    if (!(await authorize({ source: input.source, callerId: input.callerId, actor: input.actor, conversationId, operation: 'run' }))) {
      throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
    }
    const bindingOpenId = identity(input);
    const messageId = input.message?.messageId || stableMessageId(`${input.callerId}\0${input.idempotencyKey}`);
    return jobs.upsert({
      callerId: input.callerId, idempotencyKey: input.idempotencyKey, conversationId, messageId,
      sourceMessageId: input.message?.messageId || null, bindingOpenId,
      chatType: input.message?.conversationType || input.chatType || 'group', messageType: input.message?.type || 'text',
      senderOpenId: input.actor?.openId || input.senderOpenId || bindingOpenId, senderName: input.actor?.name || input.senderName || '',
      executionNamespace: input.executionNamespace || '', deliveryMode: input.deliveryMode || input.delivery?.mode || 'bridge',
      prompt: input.prompt || input.message?.text || '', groupChatContext: input.executionNamespace ? null : (input.groupChatContext || null),
      contextEntries: input.executionNamespace ? [] : (input.context || []), nextAttemptAt: input.notBefore,
    });
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
      if (timer) clearInterval(timer);
      leaseControllers.delete(controller);
    }
  }

  async function executeJob(job) {
    try {
      return await withLease(job, lease => executeOwnedJob(job, lease));
    } catch (error) {
      if (['forward_lease_lost', 'forward_runtime_stopping'].includes(error?.code)) {
        log('warning', 'forward_execution', 'stopped', { code: error.code });
        return;
      }
      throw error;
    }
  }

  async function executeOwnedJob(job, lease) {
    let execution = { ...(job.result?.execution || {}) };
    let state;
    try {
      if (execution.threadId && (!execution.turnId || !execution.startedAt)) {
        execution = { ...execution, status: 'unknown', unconfirmed: true, heldReason: 'native_start_unconfirmed' };
        try { await feedback?.cleanup?.(job, lease); }
        catch (error) {
          lease.assertOwned();
          log('warning', 'typing_reaction', 'pending', { code: error?.code || 'typing_reaction_unknown' });
        }
        await jobs.patchExecution({ id: job.id, leaseOwner: job.leaseOwner, execution });
        await jobs.markRetry({ id: job.id, leaseOwner: job.leaseOwner, held: true, errorCode: 'native_start_unconfirmed' });
        log('warning', 'forward_execution', 'held', { code: 'native_start_unconfirmed' });
        return;
      }

      const inputPrepared = execution.inputStatus === 'ready' && typeof execution.preparedPrompt === 'string';
      let prompt = inputPrepared ? execution.preparedPrompt : job.prompt;
      if (!execution.threadId && !inputPrepared && media && job.result?.inputEvent) {
        const prepared = await media.prepare(job.result.inputEvent, { runId: job.id, signal: lease.signal });
        lease.assertOwned();
        if (prepared.status !== 'ready') {
          const result = { inputStatus: prepared.status, errorCode: prepared.reason || `input_${prepared.status}`, answer: prepared.replyText || '', rawAnswer: '', attachments: [], execution: { ...execution, inputStatus: prepared.status } };
          if (prepared.status === 'ignored') {
            await jobs.markFinishedWithoutReply({ id: job.id, leaseOwner: job.leaseOwner, status: 'completed', result });
          } else {
            await jobs.markReplyPending({ id: job.id, leaseOwner: job.leaseOwner, result, errorCode: result.errorCode });
          }
          return;
        }
        prompt = [job.prompt, prepared.addendum].filter(Boolean).join('\n\n');
        execution = { ...execution, preparedPrompt: prompt, inputStatus: 'ready' };
        await jobs.patchExecution({ id: job.id, leaseOwner: job.leaseOwner, execution });
      }

      const known = execution.threadId && execution.turnId && execution.startedAt;
      state = job.deliveryMode === 'bridge'
        ? await (known ? feedback?.restore?.(job, lease) : feedback?.start(job, lease))
        : null;
      if (known) feedback?.observe?.(job, state, execution);
      lease.assertOwned();
      const input = {
        bindingOpenId: job.executionNamespace
          ? deriveExecutionScope(job.callerId, job.executionNamespace)
          : (execution.bindingOpenId || codexBindingOpenId({ feishuOpenId: job.senderOpenId, chatId: job.chatId, chatType: job.chatType })),
        chatId: job.chatId, chatType: job.chatType, messageId: job.messageId,
        senderOpenId: job.senderOpenId, senderName: job.senderName, prompt,
        groupChatContext: job.groupChatContext, busyPolicy: job.executionNamespace || config.steering === false ? 'reject' : 'steer',
      };
      let result = await executor.execute(input, {
        signal: lease.signal,
        ...(known ? { resume: { threadId: execution.threadId, turnId: execution.turnId, startedAt: execution.startedAt } } : {}),
        onStartIntent: async value => {
          lease.assertOwned();
          execution = { ...execution, bindingOpenId: value.binding.feishuOpenId, threadId: value.threadId, messageId: value.messageId, startedAt: value.startedAt, status: 'start_intent', unconfirmed: true };
          await jobs.patchExecution({ id: job.id, leaseOwner: job.leaseOwner, execution });
        },
        onBound: async value => {
          lease.assertOwned();
          execution = { ...execution, threadId: value.threadId, turnId: value.turnId, startedAt: value.startedAt, status: 'bound', unconfirmed: false };
          await jobs.patchExecution({ id: job.id, leaseOwner: job.leaseOwner, execution });
          feedback?.observe?.(job, state, execution);
        },
      });
      lease.assertOwned();
      execution = { ...execution, threadId: result.threadId || execution.threadId, turnId: result.turnId || execution.turnId, terminal: result.deferred ? 'deferred' : 'completed', unconfirmed: false, finishedAt: now() };
      result = { ...result, execution };
      if (inbound && !result.deferred) await inbound.markForwarded({ entries: job.contextEntries, threadId: result.threadId, turnId: result.turnId });
      if (result.deferred) {
        if (job.deliveryMode === 'bridge') {
          await feedback?.prepare?.(job, result, state);
          await jobs.markReplyPending({ id: job.id, leaseOwner: job.leaseOwner, result });
        }
        else await jobs.markFinishedWithoutReply({ id: job.id, leaseOwner: job.leaseOwner, status: 'deferred', result });
        return;
      }
      await feedback?.prepare?.(job, result, state);
      await jobs.markReplyPending({ id: job.id, leaseOwner: job.leaseOwner, result });
    } catch (error) {
      if (lease.signal.aborted || ['forward_lease_lost', 'forward_runtime_stopping', 'CODEX_WAIT_ABORTED'].includes(error?.code)) {
        feedback?.abandon?.(state);
        lease.assertOwned();
        throw error;
      }
      lease.assertOwned();
      if (held(error)) {
        execution = { ...execution, threadId: error.threadId || execution.threadId, turnId: error.turnId || execution.turnId, startedAt: error.startedAt || execution.startedAt, status: 'unknown', unconfirmed: true, heldReason: error.code || 'native_outcome_unknown' };
        await feedback?.prepare?.(job, {}, state).catch(() => {});
        await jobs.patchExecution({ id: job.id, leaseOwner: job.leaseOwner, execution });
        await jobs.markRetry({ id: job.id, leaseOwner: job.leaseOwner, held: true, errorCode: error.code || 'native_outcome_unknown' });
        log('warning', 'forward_execution', 'held', { code: error.code || 'native_outcome_unknown', stage: error.rpcMethod || 'execute' });
        return;
      }
      if (retryable(error) && (error.code === 'CODEX_THREAD_BUSY' || job.attempts < maxAttempts)) {
        await feedback?.prepare?.(job, {}, state).catch(() => {});
        await jobs.markRetry({ id: job.id, leaseOwner: job.leaseOwner, preserveAttempt: error.code === 'CODEX_THREAD_BUSY', errorCode: error.code || 'forward_execution_failed', nextAttemptAt: now() + 1000 });
        log('warning', 'forward_execution', 'retrying', { code: error.code || 'forward_execution_failed', stage: error.rpcMethod || 'execute' });
        return;
      }
      execution = { ...execution, terminal: error.code === 'CODEX_TURN_INTERRUPTED' ? 'interrupted' : 'failed', finishedAt: now() };
      const failed = { failed: true, turnStatus: execution.terminal, answer: error.code === 'CODEX_TURN_INTERRUPTED' ? '执行已停止。' : '执行未完成，请稍后重试。', rawAnswer: '', attachments: [], execution };
      await feedback?.prepare?.(job, failed, state);
      await jobs.markReplyPending({ id: job.id, leaseOwner: job.leaseOwner, result: failed, errorCode: error.code || 'forward_execution_failed' });
      log('error', 'forward_execution', 'failed', { code: error.code || 'forward_execution_failed', stage: error.rpcMethod || 'execute' });
    }
  }

  async function deliverJob(job) {
    try {
      await withLease(job, async lease => {
        let result = job.result || {};
        lease.assertOwned();
        if (!result.deferred) result = await replies?.prepare?.(job, result) || result;
        lease.assertOwned();
        let delivery = { status: job.deliveryMode === 'caller' ? 'not_requested' : 'sent' };
        if (job.deliveryMode === 'bridge') {
          const cardDelivered = await feedback?.finish(job, result, null, lease);
          lease.assertOwned();
          delivery = await replies.deliver(job, result, { skipText: cardDelivered || result.deferred, signal: lease.signal, assertLease: lease.assertOwned });
          if (delivery.status === 'unknown') {
            await jobs.markRetry({ id: job.id, leaseOwner: job.leaseOwner, replyPending: true, errorCode: 'reply_delivery_unknown', nextAttemptAt: now() + 300000 });
            return;
          }
        }
        lease.assertOwned();
        const status = result.deferred ? 'deferred' : result.failed ? 'failed' : 'completed';
        await jobs.markFinished({ id: job.id, leaseOwner: job.leaseOwner, status, result,
          replySent: job.deliveryMode === 'bridge' && delivery.status === 'sent',
          errorCode: delivery.status === 'failed' ? 'reply_delivery_failed' : job.last_error || result.errorCode });
        if (inbound && job.deliveryMode === 'bridge' && delivery.status === 'sent') {
          await inbound.recordReply({ messageId: `bridge-reply:${job.id}`, chatId: job.chatId, chatType: job.chatType, text: result.answer || '', createdAt: now() });
        }
      });
    } catch (error) {
      if (['forward_lease_lost', 'forward_runtime_stopping'].includes(error?.code)) {
        log('warning', 'forward_delivery', 'stopped', { code: error.code });
        return;
      }
      await jobs.markRetry({ id: job.id, leaseOwner: job.leaseOwner, replyPending: true, errorCode: error.code || 'reply_delivery_unknown', nextAttemptAt: now() + 1000 });
      log('warning', 'forward_delivery', 'pending', { code: error.code || 'reply_delivery_unknown' });
    }
  }

  async function cleanupFeedback(job) {
    try {
      await withLease(job, async lease => {
        await feedback?.cleanup?.(job, lease);
        lease.assertOwned();
        await jobs.releaseFeedback({ id: job.id, leaseOwner: job.leaseOwner });
      });
    } catch (error) {
      if (['forward_lease_lost', 'forward_runtime_stopping'].includes(error?.code)) return;
      try {
        await jobs.releaseFeedback({ id: job.id, leaseOwner: job.leaseOwner, nextAttemptAt: now() + 1000 });
      } catch { /* another owner or a later terminal write owns recovery */ }
      log('warning', 'forward_feedback_cleanup', 'pending', { code: error?.code || 'feedback_cleanup_pending' });
    }
  }

  function launch(operation) {
    const promise = operation.catch(() => {
      healthy = false;
      log('error', 'forward_worker', 'failed', { code: 'worker_failed' });
    }).finally(() => active.delete(promise));
    active.add(promise);
  }

  async function loop() {
    while (!stopping && healthy) {
      try {
        const capacity = maxActive - active.size;
        if (capacity > 0) {
          const replies = await jobs.claimReplyPending({ owner: claimOwner(), leaseMs, limit: Math.min(5, capacity) });
          for (const job of replies) launch(deliverJob(job));
          const remaining = maxActive - active.size;
          if (remaining > 0 && jobs.claimFeedbackPending) {
            for (const job of await jobs.claimFeedbackPending({ owner: claimOwner(), leaseMs, limit: Math.min(5, remaining) })) launch(cleanupFeedback(job));
          }
          const executionSlots = maxActive - active.size;
          if (executionSlots > 0) for (const job of await jobs.claim({ owner: claimOwner(), leaseMs, limit: Math.min(5, executionSlots) })) launch(executeJob(job));
        }
      } catch {
        healthy = false;
        log('error', 'forward_worker', 'failed', { code: 'worker_poll_failed' });
      }
      await sleep(pollMs);
    }
  }

  function beginStop() {
    stopping = true;
    for (const controller of leaseControllers) controller.abort();
  }

  return Object.freeze({
    submit,
    getRun: async ({ id }) => { const job = await jobs.getRun({ id }); return job ? publicRun(job) : null; },
    readRunEvents: async input => { const items = await jobs.readEvents(input); return { items, nextCursor: items.at(-1)?.sequence ?? String(input.after ?? '0') }; },
    getResource: async ({ id, index }) => { const job = await jobs.getRun({ id }); return job ? replies.readResource(job, index) : null; },
    start() {
      if (running) throw new Error('forward_runtime_already_started');
      running = true;
      worker = loop();
    },
    beginStop,
    async stop() { beginStop(); await worker; await Promise.allSettled(active); },
    status() { return { running: running && !stopping && healthy, healthy, active: active.size, owner }; },
  });
}
