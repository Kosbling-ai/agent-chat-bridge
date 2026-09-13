import { randomUUID } from 'node:crypto';
import { feishuEventIdentity } from '../channels/feishu/normalize.mjs';
import { safeObserver } from '../logger.mjs';

const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const nativeIds = ({ params = {} }) => ({ nativeThreadId: params.threadId ?? params.thread?.id, nativeTurnId: params.turnId ?? params.turn?.id });

export function createRuntime({ config, store, codex, chat, hookTokens = {}, fetchImpl = fetch, log = () => {} }) {
  log = safeObserver(log);
  const connectionId = config.feishu.connectionId;
  const owner = randomUUID();
  const leaseMs = 60000;
  let stopping = false, started = false, healthy = true;
  let worker;
  const active = new Set();
  const scope = conversationId => ({ connectionId, conversationId });
  function fault(code) { healthy = false; log('error', 'core', 'failed', { code }); }
  async function ingest(event, context = {}) {
    if (stopping || context.signal?.aborted) throw new Error('ingress_stopped');
    const group = config.routing.groups.find(item => item.conversationId === event.conversationId);
    const human = !event.isApp && !event.isSelf && event.actor.type === 'user';
    const allowed = human && (event.conversationType === 'p2p' ? config.routing.privateUserIds.includes(event.actor.openId) : Boolean(group && (group.userIds === undefined || group.userIds.includes(event.actor.openId))));
    const mentioned = event.message?.mentions?.some(mention => mention.openId === config.feishu.botOpenId);
    const triggered = allowed && event.type === 'message.received' && (event.conversationType === 'p2p' || group?.trigger === 'all' || mentioned);
    const text = event.message?.kind === 'text' ? event.message.parsedContent?.text : undefined;
    // Unsupported attachment-only input is retained in inbox/hooks, never misread as text.
    const agentJob = triggered ? { payload: { text: typeof text === 'string' ? text : '', unsupported: !(typeof text === 'string' && text.trim()), messageId: event.messageId, source: 'chat' } } : undefined;
    const hooks = config.hooks.filter(hook => hook.conversationIds.includes(event.conversationId) && !event.isSelf && !event.isApp).map(hook => ({ hookId: hook.id, payload: event }));
    const result = await store.acceptInbound({ ...scope(event.conversationId), eventKey: event.eventKey, eventType: event.type, messageId: event.messageId, ...(event.type === 'message.recalled' ? { recalledMessageId: event.messageId } : {}), revision: event.revision, occurredAt: event.occurredAt, payload: event, semanticPayload: feishuEventIdentity(event), policyVersion: config.routing.version, passiveContext: Boolean(allowed && !triggered && group?.passiveContext && event.type === 'message.received'), agentJob, hooks });
    return result;
  }
  async function notification(message) {
    await store.bufferNativeEvent({ connectionId, eventKey: randomUUID(), ...nativeIds(message), payload: message });
  }
  async function hold(job, code) {
    await store.holdAgentAttempt({ id: job.id, leaseToken: job.leaseToken, errorCode: code });
    log('error', 'agent_run', 'recovery_required', { code });
  }
  async function awaitTurn(job, attempt, turnId) {
    let cursor = 0, renewedAt = Date.now();
    while (!stopping) {
      const rows = await store.readNativeEvents({ connectionId, nativeThreadId: attempt.nativeThreadId, afterSequence: cursor, limit: 100 });
      for (const row of rows) {
        cursor = row.sequence;
        const event = parse(row.payload);
        const ids = nativeIds(event);
        if (ids.nativeTurnId !== turnId) continue;
        await store.appendRunEvent({ runId: job.id, eventKey: `native:${row.sequence}`, type: event.method, payload: event.params });
        if (event.method === 'turn/completed') {
          // Some protocol versions omit item bodies from terminal notifications.
          if (Array.isArray(event.params.turn?.items) && event.params.turn.items.length) return event.params.turn;
          const result = await codex.readThread({ threadId: attempt.nativeThreadId, includeTurns: true });
          return result.thread?.turns?.find(turn => turn.id === turnId) ?? null;
        }
      }
      if (Date.now() - renewedAt > 15000) {
        await store.renewJob({ id: job.id, leaseToken: job.leaseToken, leaseMs });
        renewedAt = Date.now();
      }
      if (codex.status().state !== 'ready') return null;
      if (rows.length < 100) await sleep(100);
    }
    return null;
  }
  async function finish(job, turn) {
    if (turn.status !== 'completed') {
      await store.retryJob({ id: job.id, leaseToken: job.leaseToken, terminal: true, errorCode: 'agent_turn_failed' });
      return;
    }
    const text = (turn.items ?? []).filter(item => item.type === 'agentMessage').map(item => item.text ?? '').filter(Boolean).join('\n');
    const payload = parse(job.payload);
    // Independent text effects are small enough for the platform JSON limit.
    const pieces = [];
    let piece = '';
    for (const char of text) { if (Buffer.byteLength(piece + char) > 12000) { pieces.push(piece); piece = ''; } piece += char; }
    if (piece) pieces.push(piece);
    const outbox = pieces.map((content, index) => ({ idempotencyKey: `run:${job.id}:text:${index}`, kind: payload.messageId ? 'reply' : 'create', payload: { kind: 'text', content: { text: content }, ...(payload.messageId ? { messageId: payload.messageId } : {}) } }));
    await store.finishJobWithOutbox({ id: job.id, leaseToken: job.leaseToken, result: { nativeTurnId: turn.id, status: turn.status }, outbox });
    log('info', 'agent_run', 'succeeded');
  }
  async function execute(job) {
    log('info', 'agent_run', 'started');
    let attempt, rpcPhase;
    try {
      if (parse(job.payload).unsupported) {
        await store.finishJobWithOutbox({ id: job.id, leaseToken: job.leaseToken, result: { status: 'unsupported_input' }, outbox: [{ idempotencyKey: `run:${job.id}:unsupported`, kind: 'reply', payload: { messageId: parse(job.payload).messageId, kind: 'text', content: { text: '当前桥接版本仅支持文本输入；这条消息尚未交给 Agent。' } } }] });
        log('warning', 'agent_run', 'rejected', { code: 'unsupported_input' });
        return;
      }
      attempt = await store.beginAgentAttempt({ id: job.id, leaseToken: job.leaseToken, agentId: 'codex' });
      if (attempt.recoveryRequired) {
        if (!attempt.nativeThreadId || !attempt.nativeTurnId) { await hold(job, 'agent_admission_unknown'); return; }
        rpcPhase = 'recovery_read';
        const result = await codex.readThread({ threadId: attempt.nativeThreadId, includeTurns: true });
        const turn = result.thread?.turns?.find(item => item.id === attempt.nativeTurnId);
        if (turn && turn.status !== 'inProgress') { await finish(job, turn); return; }
        if (!turn) { await hold(job, 'agent_turn_unresolved'); return; }
      } else {
        rpcPhase = 'thread_admission';
        const thread = attempt.nativeThreadId
          ? await codex.resumeThread({ threadId: attempt.nativeThreadId }) : await codex.startThread();
        if (!thread.thread?.id) throw Object.assign(new Error('invalid_thread_result'), { outcome: 'unknown' });
        attempt.nativeThreadId = thread.thread.id;
        await store.bindAgentAttempt({ id: job.id, leaseToken: job.leaseToken, expectedGeneration: attempt.generation, nativeThreadId: attempt.nativeThreadId });
        const context = await store.readPassiveContext({ ...scope(job.conversationId), limit: 100 });
        const lines = context.map(item => parse(item.payload).message?.parsedContent?.text).filter(value => typeof value === 'string');
        const payload = parse(job.payload);
        const inputText = [...lines, payload.text].join('\n');
        rpcPhase = 'turn_admission';
        const result = await codex.startTurn({ threadId: attempt.nativeThreadId, input: [{ type: 'text', text: inputText }], clientUserMessageId: job.id });
        if (!result.turn?.id) throw Object.assign(new Error('invalid_turn_result'), { outcome: 'unknown' });
        attempt.nativeTurnId = result.turn.id;
        await store.bindAgentAttempt({ id: job.id, leaseToken: job.leaseToken, expectedGeneration: attempt.generation, nativeThreadId: attempt.nativeThreadId, nativeTurnId: attempt.nativeTurnId });
        if (context.length) await store.consumePassiveContext({ ...scope(job.conversationId), runId: job.id, throughSequence: context.at(-1).sequence });
      }
      rpcPhase = 'observe_turn';
      const turn = await awaitTurn(job, attempt, attempt.nativeTurnId);
      if (turn) await finish(job, turn);
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
    try {
      const payload = parse(row.payload);
      let result;
      if (row.kind === 'reply') result = await chat.replyMessage({ ...payload, uuid: row.platformUuid });
      else if (row.kind === 'create') result = await chat.sendMessage({ ...payload, conversationId: row.conversationId, uuid: row.platformUuid });
      else if (row.kind === 'reaction') result = payload.reactionId ? await chat.removeReaction(payload) : await chat.addReaction(payload);
      else if (row.kind === 'upload') result = payload.mediaType === 'image' ? await chat.uploadImage({ bytes: Buffer.from(payload.base64, 'base64') }) : await chat.uploadFile({ bytes: Buffer.from(payload.base64, 'base64'), fileName: payload.fileName });
      else throw Object.assign(new Error('unsupported_delivery'), { outcome: 'failed' });
      await store.settleOutbox({ id: row.id, leaseToken: row.leaseToken, status: 'sent', result });
    } catch (error) {
      await store.settleOutbox({ id: row.id, leaseToken: row.leaseToken, status: error.outcome === 'failed' ? 'failed' : 'unknown', errorCode: 'chat_delivery_unconfirmed', nextAttemptAt: Date.now() + 5000 });
      log('warning', 'chat_delivery', 'unconfirmed', { code: 'chat_delivery_unconfirmed' });
    }
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
          if (codex.status().state === 'ready') for (const job of await store.claimJobs({ kind: 'agent', owner, leaseMs, limit: 1 })) launch(execute(job));
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
    async stop() { stopping = true; await worker; await Promise.allSettled(active); },
  };
}
