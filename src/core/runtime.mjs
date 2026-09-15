import { splitReplyCards } from '../channels/feishu/reply-card.mjs';
import { randomUUID } from 'node:crypto';
import { feishuEventIdentity } from '../channels/feishu/normalize.mjs';
import { safeObserver } from '../logger.mjs';
import { extractFinalAnswer, buildConversationPrompt } from './format.mjs';
import { extractMessageText } from '../channels/feishu/media.mjs';
import { createAnswerProjection } from './answer-projection.mjs';
import { createRecoveryHandler } from './recovery.mjs';
import { createSessionRotation } from './session-rotation.mjs';
import { createSteeringHandler } from './steering.mjs';
import { createConversationGuard } from './conversation-guard.mjs';
import { admitThread } from './thread-admission.mjs';
import { createResourceRetirement } from './resource-retirement.mjs';
import { observeNativeTurn, isTerminalTurn } from './observe-turn.mjs';

const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const nativeIds = ({ params = {} }) => ({ nativeThreadId: params.threadId ?? params.thread?.id, nativeTurnId: params.turnId ?? params.turn?.id });

export function createRuntime({ config, store, codex, chat, media, outbound, workspace, hookTokens = {}, fetchImpl = fetch, log = () => {} }) {
  log = safeObserver(log);
  const connectionId = config.feishu.connectionId;
  const owner = randomUUID();
  const leaseMs = 60000;
  let stopping = false, started = false, healthy = true;
  let worker;
  let cleanupAt = 0, cleanupRunning = false, cleanupCursor;
  let retirementAt = 0, retirementRunning = false;
  const active = new Set();
  const conversationGuard = createConversationGuard();
  const guardKey = row => JSON.stringify([row.connectionId ?? connectionId, row.conversationId]);
  const stopController = new AbortController();
  const scope = conversationId => ({ connectionId, conversationId });
  const recover = workspace ? createRecoveryHandler({ store, codex, workspace, connectionId, log }) : null;
  const rotate = workspace ? createSessionRotation({ store, codex, workspace, connectionId, config: config.codex ?? {}, log }) : null;
  const retireResources = media || outbound ? createResourceRetirement({ store, media, outbound, guard: conversationGuard, connectionId, log, stopped: () => stopping }) : null;
  const steer = createSteeringHandler({ store, codex, log, enabled: config.codex?.steering !== false });
  function fault(code) { healthy = false; log('error', 'core', 'failed', { code }); }
  async function ingest(event, context = {}) {
    if (stopping || context.signal?.aborted) throw new Error('ingress_stopped');
    const group = config.routing.groups.find(item => item.conversationId === event.conversationId);
    // A history user_id/union_id cannot be compared with an open-id allowlist.
    // Refuse before canonical receipt so a later complete live event can route;
    // catchup keeps its checkpoint and never guesses identity via a directory.
    if (event.source === 'history_catchup' && event.type === 'message.received' && !event.isApp && !event.isSelf
      && (!event.actor.type || event.actor.type === 'unknown' || (event.actor.type === 'user' && !event.actor.openId
        && (event.conversationType === 'p2p' || group?.userIds !== undefined))
        || (group?.trigger === 'mention' && event.message?.mentions?.some(mention => !mention.openId)))) {
      throw Object.assign(new Error('history_authorization_identity_missing'), { code: 'history_authorization_identity_missing' });
    }
    const human = !event.isApp && !event.isSelf && event.actor.type === 'user';
    const allowed = human && (event.conversationType === 'p2p' ? config.routing.privateUserIds.includes(event.actor.openId) : Boolean(group && (group.userIds === undefined || group.userIds.includes(event.actor.openId))));
    const mentioned = event.message?.mentions?.some(mention => mention.openId === config.feishu.botOpenId);
    const triggered = allowed && event.type === 'message.received' && (event.conversationType === 'p2p' || group?.trigger === 'all' || mentioned);
    const text = extractMessageText(event);
    // Unsupported attachment-only input is retained in inbox/hooks, never misread as text.
    const agentJob = triggered ? { payload: { text: typeof text === 'string' ? text : '', unsupported: !(typeof text === 'string' && text.trim()), messageId: event.messageId, source: 'chat', event } } : undefined;
    const hooks = config.hooks.filter(hook => hook.conversationIds.includes(event.conversationId) && !event.isSelf && !event.isApp).map(hook => ({ hookId: hook.id, payload: event }));
    const result = await store.acceptInbound({ ...scope(event.conversationId), source: event.source, conversationType: event.conversationType, eventKey: event.eventKey, eventType: event.type, messageId: event.messageId, ...(event.type === 'message.recalled' ? { recalledMessageId: event.messageId } : {}), revision: event.revision, occurredAt: event.occurredAt, payload: event, semanticPayload: feishuEventIdentity(event), policyVersion: config.routing.version, passiveContext: Boolean(allowed && !triggered && group?.passiveContext && event.type === 'message.received'), agentJob, hooks });
    return result;
  }
  async function notification(message) {
    await store.bufferNativeEvent({ connectionId, eventKey: randomUUID(), ...nativeIds(message), payload: message });
  }
  async function hold(job, code) {
    await store.holdAgentAttempt({ id: job.id, leaseToken: job.leaseToken, errorCode: code });
    log('error', 'agent_run', 'recovery_required', { code });
  }
  function awaitTurn(job, attempt, turnId) {
    return observeNativeTurn({ store, codex, connectionId, job, attempt, turnId, leaseMs, stopped: () => stopping });
  }
  async function durableFinalAnswer(job, attempt, turn) {
    const final = extractFinalAnswer({ items: (turn.items ?? []).filter(item => item?.phase === 'final_answer') });
    if (final) return final;
    let cursor = 0, renewedAt = Date.now();
    const projection = createAnswerProjection();
    for (let page = 0; page < 1000; page++) {
      const rows = await store.readNativeEvents({ connectionId, nativeThreadId: attempt.nativeThreadId, nativeTurnId: turn.id, afterSequence: cursor, limit: 100 });
      for (const row of rows) {
        cursor = row.sequence;
        const event = parse(row.payload);
        if (nativeIds(event).nativeTurnId !== turn.id) continue;
        projection.observe(event);
      }
      if (rows.length < 100) return projection.answer(turn);
      if (Date.now() - renewedAt > 15000) { await store.renewJob({ id: job.id, leaseToken: job.leaseToken, leaseMs }); renewedAt = Date.now(); }
    }
    // Do not silently return a prefix when bounded recovery cannot reach the tail.
    throw new Error('native_history_recovery_limit');
  }
  async function finish(job, turn, attempt) {
    if (turn.status !== 'completed') {
      await store.retryJob({ id: job.id, leaseToken: job.leaseToken, terminal: true, errorCode: 'agent_turn_failed' });
      return;
    }
    let text = await durableFinalAnswer(job, attempt, turn);
    const payload = parse(job.payload);
    const artifactScope = { ...scope(job.conversationId), runId: job.id };
    let output;
    if (outbound && payload.event?.conversationType === 'p2p') {
      const native = await store.getAgentAttempt({ id: job.id });
      output = await outbound.prepare({ ...artifactScope, conversationType: 'p2p', sinceMs: Number(native.createdAt) });
      if (output.failures.length || output.omitted) text += `\n\n附件处理提示：${output.failures.length} 个文件准备失败，${output.omitted} 个文件超过单次发送数量上限。`;
    }
    const outbox = splitReplyCards(text).map((content, index) => ({
      idempotencyKey: `run:${job.id}:final-card:${index}`,
      kind: payload.messageId ? 'reply' : 'create',
      payload: { kind: 'interactive', content, ...(payload.messageId ? { messageId: payload.messageId } : {}) },
    }));
    for (const artifact of output?.artifacts ?? []) for (const effect of ['upload', 'send']) outbox.push({ idempotencyKey: `run:${job.id}:artifact:${artifact.ref.artifactId}:${effect}`, kind: `artifact_${effect}`, payload: { scope: artifactScope, ref: artifact.ref } });
    await store.finishJobWithOutbox({ id: job.id, leaseToken: job.leaseToken, result: { nativeTurnId: turn.id, status: turn.status,
      ...(output ? { artifactCount: output.artifacts.length, artifactFailures: output.failures, artifactOmitted: output.omitted } : {}) }, outbox });
    if (output?.failures.length) log('error', 'artifact_prepare', 'failed', { code: 'artifact_prepare_partial_failure' });
    log('info', 'agent_run', 'succeeded');
  }
  async function execute(job) {
    log('info', 'agent_run', 'started');
    let attempt, rpcPhase;
    try {
      const previousGuidance = await store.getSteerAttempt({ id: job.id });
      if (['intent', 'unknown'].includes(previousGuidance?.status)) {
        // This input may already be inside a native turn. No preparation failure
        // or config toggle may relabel it as unsubmitted or create a new turn.
        await steer(job, '');
        return;
      }
      if (rotate) {
        try { await rotate(job); }
        catch {
          await store.retryJob({ id: job.id, leaseToken: job.leaseToken, errorCode: 'session_rotation_pending', nextAttemptAt: Date.now() + 1000 });
          log('warning', 'session_rotation', 'pending', { code: 'session_rotation_pending' });
          return;
        }
      }
      const payload = parse(job.payload);
      const outboxDir = outbound && payload.event?.conversationType === 'p2p' ? await outbound.directory({ ...scope(job.conversationId), runId: job.id }) : undefined;
      let prepared;
      if (media && payload.event && !await store.getAgentAttempt({ id: job.id })) {
        prepared = await media.prepare(payload.event, { runId: job.id, signal: stopController.signal });
        await store.renewJob({ id: job.id, leaseToken: job.leaseToken, leaseMs });
        if (stopping) {
          await store.retryJob({ id: job.id, leaseToken: job.leaseToken, errorCode: 'input_prepare_interrupted', nextAttemptAt: Date.now() + 1000 });
          return;
        }
      }
      const rejected = prepared && prepared.status !== 'ready' ? prepared.status : (!prepared && payload.unsupported && !media ? 'unsupported' : null);
      if (rejected) {
        const reply = prepared?.replyText ?? (rejected === 'failed' ? '图片准备失败，这条消息尚未交给 Agent，请重试或改用文字。' : '这条消息的附件类型暂不支持，尚未交给 Agent，请改用文字或图片。');
        const outbox = rejected === 'ignored' ? [] : splitReplyCards(reply, rejected === 'failed' ? 'failed' : 'rejected').map((content, index) => ({
          idempotencyKey: `run:${job.id}:input-status-card:${index}`,
          kind: payload.messageId ? 'reply' : 'create',
          payload: { ...(payload.messageId ? { messageId: payload.messageId } : {}), kind: 'interactive', content },
        }));
        await store.finishJobWithOutbox({
          id: job.id, leaseToken: job.leaseToken,
          result: { status: `input_${rejected}`, ...(prepared?.reason ? { code: prepared.reason } : {}) }, outbox,
        });
        log(rejected === 'failed' ? 'error' : 'warning', 'agent_run', 'rejected', { code: `input_${rejected}` });
        return;
      }
      if (steer && await steer(job, buildConversationPrompt({ event: payload.event,
        text: prepared ? [prepared.text, prepared.addendum].filter(Boolean).join('\n\n') : payload.text,
        newThread: false, group: config.routing.groups.find(group => group.conversationId === job.conversationId) }))) return;
      attempt = await store.beginAgentAttempt({ id: job.id, leaseToken: job.leaseToken, agentId: 'codex' });
      if (attempt.recoveryRequired) {
        if (!attempt.nativeThreadId || !attempt.nativeTurnId) { await hold(job, 'agent_admission_unknown'); return; }
        rpcPhase = 'recovery_read';
        const result = await codex.readThread({ threadId: attempt.nativeThreadId, includeTurns: true });
        const turn = result.thread?.turns?.find(item => item.id === attempt.nativeTurnId);
        if (isTerminalTurn(turn)) { await finish(job, turn, attempt); return; }
        if (!turn || turn.status !== 'inProgress') throw new Error('agent_turn_unresolved');
      } else {
        rpcPhase = 'thread_admission';
        const oldGeneration = attempt.generation;
        const admission = await admitThread({ store, codex, job, attempt });
        if (admission.recoveryRequired) { await hold(job, 'agent_admission_unknown'); return; }
        if (attempt.generation !== oldGeneration) log('warning', 'agent_run', 'fallback', { code: 'archived_thread_replaced' });
        const { thread, newThread } = admission;
        if (!thread.thread?.id) throw Object.assign(new Error('invalid_thread_result'), { outcome: 'unknown' });
        attempt.nativeThreadId = thread.thread.id;
        await store.bindAgentAttempt({ id: job.id, leaseToken: job.leaseToken, expectedGeneration: attempt.generation, nativeThreadId: attempt.nativeThreadId });
        const context = await store.readPassiveContext({ ...scope(job.conversationId), limit: 100 });
        const contextEntries = context.map(item => { const event = parse(item.payload); return { event, text: extractMessageText(event) }; }).filter(item => item.text);
        const inputText = buildConversationPrompt({ event: payload.event, text: prepared ? [prepared.text, prepared.addendum].filter(Boolean).join('\n\n') : payload.text, context: contextEntries, newThread, outboxDir, group: config.routing.groups.find(group => group.conversationId === job.conversationId) });
        rpcPhase = 'turn_admission';
        const result = await codex.startTurn({ threadId: attempt.nativeThreadId, input: [{ type: 'text', text: inputText }], clientUserMessageId: job.id });
        if (!result.turn?.id) throw Object.assign(new Error('invalid_turn_result'), { outcome: 'unknown' });
        attempt.nativeTurnId = result.turn.id;
        await store.bindAgentAttempt({ id: job.id, leaseToken: job.leaseToken, expectedGeneration: attempt.generation, nativeThreadId: attempt.nativeThreadId, nativeTurnId: attempt.nativeTurnId });
        if (context.length) await store.consumePassiveContext({ ...scope(job.conversationId), runId: job.id, throughSequence: context.at(-1).sequence });
      }
      rpcPhase = 'observe_turn';
      const turn = await awaitTurn(job, attempt, attempt.nativeTurnId);
      if (turn) await finish(job, turn, attempt);
      else if (attempt.nativeThreadId && attempt.nativeTurnId) {
        // Keep the durable native admission and active session. The next worker
        // must enter recoveryRequired/readThread, never start another turn.
        await store.retryJob({ id: job.id, leaseToken: job.leaseToken, errorCode: 'agent_recovery_pending', nextAttemptAt: Date.now() + 1000 });
      } else await hold(job, 'agent_execution_interrupted');
    } catch (error) {
      if (error.code === 'session_busy') {
        await store.retryJob({ id: job.id, leaseToken: job.leaseToken, errorCode: 'session_busy', nextAttemptAt: Date.now() + 1000 });
      } else if (attempt && !attempt.recoveryRequired && error.outcome === 'rejected' && ['thread_admission', 'turn_admission'].includes(rpcPhase)) {
        await store.retryJob({ id: job.id, leaseToken: job.leaseToken, terminal: true, errorCode: 'agent_rpc_rejected' });
      } else if (attempt?.nativeThreadId && attempt?.nativeTurnId) {
        // A read/observation rejection says nothing about the admitted turn's
        // effects. Retain the attempt and session for a later native read.
        await store.retryJob({ id: job.id, leaseToken: job.leaseToken, errorCode: 'agent_recovery_pending', nextAttemptAt: Date.now() + 1000 });
        log('warning', 'agent_recovery', 'pending', { code: 'agent_recovery_pending' });
      } else if (attempt) await hold(job, 'agent_execution_unknown');
      else throw error;
    }
  }
  async function deliver(row) {
    let result;
    try {
      const payload = parse(row.payload);
      if (row.kind === 'reply') result = await chat.replyMessage({ ...payload, uuid: row.platformUuid });
      else if (row.kind === 'create') result = await chat.sendMessage({ ...payload, conversationId: row.conversationId, uuid: row.platformUuid });
      else if (row.kind === 'reaction') result = payload.reactionId ? await chat.removeReaction(payload) : await chat.addReaction(payload);
      else if (row.kind === 'upload') result = payload.mediaType === 'image' ? await chat.uploadImage({ bytes: Buffer.from(payload.base64, 'base64') }) : await chat.uploadFile({ bytes: Buffer.from(payload.base64, 'base64'), fileName: payload.fileName });
      else if (row.kind === 'artifact_upload' && outbound) result = await outbound.upload(payload);
      else if (row.kind === 'artifact_send' && outbound) {
        const effect = await store.getOutbox({ id: row.id });
        if (effect?.predecessorStatus !== 'sent') throw Object.assign(new Error('artifact_predecessor_unconfirmed'), { outcome: 'failed' });
        result = await outbound.send({ ...payload, uploadResult: parse(effect.predecessorResult), uuid: row.platformUuid });
      }
      else throw Object.assign(new Error('unsupported_delivery'), { outcome: 'failed' });
    } catch (error) {
      await settleDelivery(row, { status: error.outcome === 'failed' ? 'failed' : 'unknown', errorCode: 'chat_delivery_unconfirmed', nextAttemptAt: Date.now() + 5000 });
      log('warning', 'chat_delivery', 'unconfirmed', { code: 'chat_delivery_unconfirmed' });
      return;
    }
    // Database settlement is not part of the platform call. In particular a
    // lost sent COMMIT response cannot justify writing the opposite outcome.
    await settleDelivery(row, { status: 'sent', result });
  }
  async function settleDelivery(row, outcome) {
    try { await store.settleOutbox({ id: row.id, leaseToken: row.leaseToken, ...outcome }); }
    catch {
      const recorded = await store.getOutbox({ id: row.id });
      if (recorded?.status === 'sent') {
        log('info', 'chat_delivery', 'succeeded', { code: 'delivery_commit_confirmed' });
        return;
      }
      // Another lease owner or an unconfirmed write is reconciled by durable
      // outbox claiming. Keep its facts intact; never reclassify a DB error as
      // an uncertain platform effect or stop unrelated workers for stale lease.
      log('warning', 'chat_delivery', 'pending', { code: 'delivery_settlement_unconfirmed' });
    }
  }
  async function cleanupArtifacts() {
    cleanupRunning = true;
    try {
      const page = await store.listPendingCleanup({ afterId: cleanupCursor, limit: 10 });
      for (const row of page.items) {
        if (stopping) break;
        try {
          await conversationGuard.cleanup(guardKey(row), async () => {
            // Local ownership closes check-to-filesystem races. Persisted native
            // and guidance facts protect execution left active before restart.
            const activity = await store.getConversationActivity({ connectionId: row.connectionId, conversationId: row.conversationId, agentId: 'codex' });
            if (activity.activeRunId || activity.unresolvedGuidance) return;
            await outbound.cleanup({ ...parse(row.payload), confirmedSent: true });
            await store.completeOutboxCleanup({ id: row.id, connectionId: row.connectionId, conversationId: row.conversationId });
            log('info', 'artifact_cleanup', 'succeeded');
          });
        } catch { log('warning', 'artifact_cleanup', 'pending', { code: 'artifact_cleanup_pending' }); }
      }
      cleanupCursor = page.nextCursor ?? undefined;
    } finally { cleanupRunning = false; }
  }
  async function hook(job) {
    const configHook = config.hooks.find(item => item.id === job.hookId);
    try {
      if (!configHook) throw new Error('hook_removed');
      const response = await fetchImpl(configHook.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000), headers: { 'content-type': 'application/json', authorization: `Bearer ${hookTokens[configHook.id]}`, 'idempotency-key': job.id }, body: JSON.stringify({ deliveryId: job.id, event: parse(job.payload) }) });
      // 204 means the recipient durably accepted the delivery, not business completion.
      await response.body?.cancel();
      if (response.status !== 204) throw new Error('hook_unacknowledged');
      await store.finishJobWithOutbox({ id: job.id, leaseToken: job.leaseToken, result: { accepted: true } });
    } catch {
      await store.retryJob({ id: job.id, leaseToken: job.leaseToken, terminal: !configHook || job.attempts >= 8, errorCode: 'hook_unacknowledged', nextAttemptAt: Date.now() + Math.min(60000, 1000 * 2 ** job.attempts) });
      log(job.attempts >= 8 ? 'error' : 'warning', 'hook_delivery', 'unacknowledged', { code: 'hook_unacknowledged' });
    }
  }
  function launch(operation) {
    const promise = operation.catch(() => fault('worker_failed')).finally(() => active.delete(promise));
    active.add(promise);
  }
  async function loop() {
    while (!stopping && healthy) {
      try {
        if (active.size < 8) {
          if (retireResources && !retirementRunning && Date.now() >= retirementAt) {
            retirementAt = Date.now() + 30000; retirementRunning = true;
            launch(retireResources().then(result => { if (result.hasMore) retirementAt = Date.now() + 1000; }).finally(() => { retirementRunning = false; }));
          }
          if (outbound && !cleanupRunning && Date.now() >= cleanupAt) { cleanupAt = Date.now() + 1000; launch(cleanupArtifacts()); }
          if (recover && codex.status().state === 'ready') for (const action of await store.claimRecoveries({ owner, leaseMs, limit: 1 })) launch(conversationGuard.native(guardKey(action), () => stopping ? undefined : recover(action)));
          if (codex.status().state === 'ready') for (const job of await store.claimJobs({ kind: 'agent', owner, leaseMs, limit: 1 })) launch(conversationGuard.native(guardKey(job), () => stopping ? undefined : execute(job)));
          for (const job of await store.claimJobs({ kind: 'hook', owner, leaseMs, limit: 1 })) launch(hook(job));
          for (const row of await store.claimOutbox({ owner, leaseMs, limit: 1 })) launch(deliver(row));
        }
      } catch { fault('worker_poll_failed'); }
      await sleep(100);
    }
  }
  return {
    ingest, notification,
    onFault: async () => log('error', 'codex_connection', 'failed', { code: 'codex_connection_failed' }),
    status: () => ({ running: started && !stopping && healthy }),
    start() { if (started) throw new Error('runtime_already_started'); started = true; worker = loop(); },
    async stop() { stopping = true; stopController.abort(); await worker; await Promise.allSettled(active); },
  };
}
