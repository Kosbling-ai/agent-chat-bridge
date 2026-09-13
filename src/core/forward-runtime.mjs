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
  const delivery = job.deliveryMode === 'caller'
    ? { mode: 'caller', status: terminal.has(job.status) ? 'not_requested' : 'pending' }
    : { mode: 'bridge', status: job.replySentAt ? 'sent' : job.status === 'reply_pending' ? 'pending' : job.status === 'failed' ? 'failed' : 'waiting' };
  return {
    id: job.id, conversationId: job.chatId, status: job.status,
    executionStatus: job.status === 'held' ? 'held' : terminal.has(job.status)
      ? (job.status === 'failed' ? 'failed' : 'completed')
      : job.status === 'reply_pending' ? 'completed' : 'running',
    deliveryStatus: delivery.status, deliveryMode: delivery.mode,
    executionNamespace: job.executionNamespace,
    answer: job.result?.answer ?? null, rawAnswer: job.result?.rawAnswer ?? null,
    attachments: publicAttachments(job.result?.attachments),
    native: { threadId: execution.threadId || job.result?.threadId || null, turnId: execution.turnId || job.result?.turnId || null, status: execution.terminal || execution.status || null },
    held: job.status === 'held' ? { reason: job.last_error || execution.heldReason || 'native_outcome_unknown' } : null,
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
      callerId: input.callerId, idempotencyKey: input.idempotencyKey, conversationId, messageId, bindingOpenId,
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
      await jobs.renew({ id: job.id, leaseOwner: owner, leaseMs });
      timer = setInterval(() => jobs.renew({ id: job.id, leaseOwner: owner, leaseMs }).catch(lose), heartbeatMs);
      timer.unref?.();
      const assertOwned = () => {
        if (lost) throw Object.assign(new Error('forward_lease_lost'), { code: 'forward_lease_lost' });
        if (stopping) throw Object.assign(new Error('forward_runtime_stopping'), { code: 'forward_runtime_stopping' });
      };
      const result = await operation({ signal: controller.signal, assertOwned });
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
        await jobs.patchExecution({ id: job.id, leaseOwner: owner, execution });
        await jobs.markRetry({ id: job.id, leaseOwner: owner, held: true, errorCode: 'native_start_unconfirmed' });
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
            await jobs.markFinishedWithoutReply({ id: job.id, leaseOwner: owner, status: 'completed', result });
          } else {
            await jobs.markReplyPending({ id: job.id, leaseOwner: owner, result, errorCode: result.errorCode });
          }
          return;
        }
        prompt = [job.prompt, prepared.addendum].filter(Boolean).join('\n\n');
        execution = { ...execution, preparedPrompt: prompt, inputStatus: 'ready' };
        await jobs.patchExecution({ id: job.id, leaseOwner: owner, execution });
      }

      const known = execution.threadId && execution.turnId && execution.startedAt;
      state = job.deliveryMode === 'bridge'
        ? await (known ? feedback?.restore?.(job) : feedback?.start(job))
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
      const result = await executor.execute(input, {
        signal: lease.signal,
        ...(known ? { resume: { threadId: execution.threadId, turnId: execution.turnId, startedAt: execution.startedAt } } : {}),
        onStartIntent: async value => {
          lease.assertOwned();
          execution = { ...execution, bindingOpenId: value.binding.feishuOpenId, threadId: value.threadId, messageId: value.messageId, startedAt: value.startedAt, status: 'start_intent', unconfirmed: true };
          await jobs.patchExecution({ id: job.id, leaseOwner: owner, execution });
        },
        onBound: async value => {
          lease.assertOwned();
          execution = { ...execution, threadId: value.threadId, turnId: value.turnId, startedAt: value.startedAt, status: 'bound', unconfirmed: false };
          await jobs.patchExecution({ id: job.id, leaseOwner: owner, execution });
          feedback?.observe?.(job, state, execution);
        },
      });
      lease.assertOwned();
      execution = { ...execution, threadId: result.threadId || execution.threadId, turnId: result.turnId || execution.turnId, terminal: result.deferred ? 'deferred' : 'completed', unconfirmed: false, finishedAt: now() };
      if (inbound && !result.deferred) await inbound.markForwarded({ entries: job.contextEntries, threadId: result.threadId, turnId: result.turnId });
      if (result.deferred) {
        await jobs.markFinishedWithoutReply({ id: job.id, leaseOwner: owner, status: 'deferred', result: { ...result, execution } });
        return;
      }
      await feedback?.prepare?.(job, result, state);
      await jobs.markReplyPending({ id: job.id, leaseOwner: owner, result: { ...result, execution } });
    } catch (error) {
      lease.assertOwned();
      if (['forward_lease_lost', 'forward_runtime_stopping'].includes(error?.code)) throw error;
      if (held(error)) {
        execution = { ...execution, threadId: error.threadId || execution.threadId, turnId: error.turnId || execution.turnId, startedAt: error.startedAt || execution.startedAt, status: 'unknown', unconfirmed: true, heldReason: error.code || 'native_outcome_unknown' };
        await feedback?.prepare?.(job, {}, state).catch(() => {});
        await jobs.patchExecution({ id: job.id, leaseOwner: owner, execution });
        await jobs.markRetry({ id: job.id, leaseOwner: owner, held: true, errorCode: error.code || 'native_outcome_unknown' });
        log('warning', 'forward_execution', 'held', { code: error.code || 'native_outcome_unknown' });
        return;
      }
      if (retryable(error) && (error.code === 'CODEX_THREAD_BUSY' || job.attempts < maxAttempts)) {
        await feedback?.prepare?.(job, {}, state).catch(() => {});
        await jobs.markRetry({ id: job.id, leaseOwner: owner, preserveAttempt: error.code === 'CODEX_THREAD_BUSY', errorCode: error.code || 'forward_execution_failed', nextAttemptAt: now() + 1000 });
        log('warning', 'forward_execution', 'retrying', { code: error.code || 'forward_execution_failed' });
        return;
      }
      execution = { ...execution, terminal: error.code === 'CODEX_TURN_INTERRUPTED' ? 'interrupted' : 'failed', finishedAt: now() };
      const failed = { failed: true, turnStatus: execution.terminal, answer: error.code === 'CODEX_TURN_INTERRUPTED' ? '执行已停止。' : '执行未完成，请稍后重试。', rawAnswer: '', attachments: [], execution };
      await feedback?.prepare?.(job, failed, state);
      await jobs.markReplyPending({ id: job.id, leaseOwner: owner, result: failed, errorCode: error.code || 'forward_execution_failed' });
      log('error', 'forward_execution', 'failed', { code: error.code || 'forward_execution_failed' });
    }
  }

  async function deliverJob(job) {
    try {
      await withLease(job, async lease => {
        const result = job.result || {};
        lease.assertOwned();
        if (job.deliveryMode === 'bridge') {
          const cardDelivered = await feedback?.finish(job, result, null, null);
          lease.assertOwned();
          if (!cardDelivered) await replies.deliver(job, result, { signal: lease.signal, assertLease: lease.assertOwned });
        }
        lease.assertOwned();
        await jobs.markFinished({ id: job.id, leaseOwner: owner, status: result.failed ? 'failed' : 'completed', result, replySent: job.deliveryMode === 'bridge' });
        if (inbound && job.deliveryMode === 'bridge') await inbound.recordReply({ messageId: `bridge-reply:${job.id}`, chatId: job.chatId, chatType: job.chatType, text: result.answer || '', createdAt: now() });
      });
    } catch (error) {
      if (['forward_lease_lost', 'forward_runtime_stopping'].includes(error?.code)) {
        log('warning', 'forward_delivery', 'stopped', { code: error.code });
        return;
      }
      await jobs.markRetry({ id: job.id, leaseOwner: owner, replyPending: true, errorCode: error.code || 'reply_delivery_unknown', nextAttemptAt: now() + 1000 });
      log('warning', 'forward_delivery', 'pending', { code: error.code || 'reply_delivery_unknown' });
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
          const replies = await jobs.claimReplyPending({ owner, leaseMs, limit: Math.min(5, capacity) });
          for (const job of replies) launch(deliverJob(job));
          const remaining = maxActive - active.size;
          if (remaining > 0) for (const job of await jobs.claim({ owner, leaseMs, limit: Math.min(5, remaining) })) launch(executeJob(job));
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
    readRunEvents: async input => { const items = await jobs.readEvents(input); return { items, nextCursor: items.at(-1)?.id ?? String(input.after ?? '0') }; },
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
