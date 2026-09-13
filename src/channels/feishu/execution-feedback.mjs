import { createHash } from 'node:crypto';
import { ExecutionCard, observeExecutionCard } from './execution-card.mjs';
import { codexBindingOpenId } from '../../agents/codex/thread-scope.mjs';

const stable = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
const toast = (content, type = 'info') => ({ toast: { type, content } });

export function createExecutionFeedback({ jobs, sessions, chat, cardClient, authorize = async () => true,
  executor, config = {}, log = () => {}, now = Date.now } = {}) {
  const emoji = config.typingEmoji || 'Typing';
  const bindingOpenId = (job, result = job.result || {}) => result.execution?.bindingOpenId
    || codexBindingOpenId({ feishuOpenId: job.senderOpenId, chatId: job.chatId, chatType: job.chatType });

  function stateFor(job, control = {}) {
    return { result: structuredClone(job.result || {}), control, card: null, observer: null, typing: null };
  }

  async function persist(job, state, key, value) {
    state.control.assertLease?.();
    await jobs.patchFeedback({ id: job.id, leaseOwner: job.leaseOwner, key, value });
    state.result = { ...state.result, [key]: structuredClone(value) };
  }

  async function listTyping(job, state) {
    state.control.assertLease?.();
    const response = await chat.listReactions({ messageId: job.sourceMessageId, pageSize: 50 });
    return (response?.items || []).filter(reaction => reaction?.operator?.operator_type === 'app'
      && reaction?.reaction_type?.emoji_type === emoji)
      .map(reaction => reaction.reaction_id).filter(Boolean);
  }

  async function typingDesired(job, state, desired) {
    if (!job.sourceMessageId) return { desired: false, outcome: 'not_applicable' };
    const previous = state.result.typing || {};
    const intent = { ...previous, desired, operation: desired ? 'add' : 'remove', intentAt: now(), outcome: 'pending' };
    await persist(job, state, 'typing', intent);
    try {
      if (desired) {
        state.control.assertLease?.();
        const response = await chat.addReaction({ messageId: job.sourceMessageId, emojiType: emoji });
        const reactionId = response?.reaction_id || response?.reactionId || '';
        if (!reactionId) throw Object.assign(new Error('typing add unconfirmed'), { code: 'typing_add_unconfirmed', outcome: 'unknown' });
        if (state.result.typing?.desired === false) {
          const late = { ...state.result.typing, reactionId, outcome: 'late_add_confirmed', confirmedAt: now() };
          await persist(job, state, 'typing', late);
          return typingDesired(job, state, false);
        }
        const confirmed = { ...intent, reactionId, outcome: 'confirmed', confirmedAt: now() };
        await persist(job, state, 'typing', confirmed);
        return confirmed;
      }

      const reactionIds = new Set(previous.reactionId ? [previous.reactionId] : []);
      if (!previous.reactionId || previous.outcome !== 'confirmed') {
        for (const reactionId of await listTyping(job, state)) reactionIds.add(reactionId);
      }
      for (const reactionId of reactionIds) {
        state.control.assertLease?.();
        await chat.removeReaction({ messageId: job.sourceMessageId, reactionId });
      }
      const confirmed = { ...intent, reactionId: '', removedReactionIds: [...reactionIds], outcome: 'confirmed', confirmedAt: now() };
      await persist(job, state, 'typing', confirmed);
      return confirmed;
    } catch (error) {
      const unknown = { ...intent, outcome: error?.outcome === 'failed' ? 'failed' : 'unknown',
        errorCode: error?.code || 'typing_reaction_unknown', nextRetryAt: now() + 1000 };
      await persist(job, state, 'typing', unknown);
      throw error;
    }
  }

  function cardFor(job, state, saved) {
    return new ExecutionCard({
      client: cardClient, chatId: job.chatId, jobId: job.id, messageId: job.messageId,
      displayName: config.displayName, uuid: stable(`execution-card:${job.messageId}`), saved,
      intervalMs: config.executionCardIntervalMs || 1000,
      persist: value => persist(job, state, 'executionCard', value),
      audit: event => sessions?.saveCodexRealtimeEvent?.({
        feishuOpenId: bindingOpenId(job, state.result), chatId: job.chatId, chatType: job.chatType,
        codexSessionId: state.result.execution?.threadId || event.threadId || '',
      }, {
        messageId: job.messageId, eventKey: `feedback:${job.id}:${event.status}:${now()}`,
        eventType: 'execution_card', role: 'activity', title: '执行卡片', text: '', createdAt: now(), detail: event,
      }),
    });
  }

  async function start(job, control = {}) {
    if (job.deliveryMode === 'caller') return null;
    const state = stateFor(job, control);
    state.card = cardFor(job, state, state.result.executionCard);
    state.typing = typingDesired(job, state, true).catch(error => {
      log('warning', 'typing_reaction', 'pending', { code: error?.code || 'typing_reaction_unknown' });
      return null;
    });
    state.card.push({ kind: 'started' });
    return state;
  }

  function observe(job, state, execution) {
    if (!state?.card || state.observer) return state?.observer || null;
    const cursor = state.result.executionCard?.observerCursor;
    state.observer = observeExecutionCard({
      card: state.card, since: Number(job.createdAt || now()), cursor,
      load: async next => (await sessions.readPublicProgress({
        binding: { feishuOpenId: bindingOpenId(job, state.result), chatId: job.chatId },
        threadId: execution.threadId, messageId: job.messageId, cursor: next.id, limit: 100,
      })).map(row => ({ ...row, progress_json: row.detail_json })),
    });
    return state.observer;
  }

  async function restore(job, control = {}) {
    if (job.deliveryMode === 'caller') return null;
    const state = stateFor(job, control);
    await typingDesired(job, state, false).catch(error => {
      log('warning', 'typing_reaction', 'pending', { code: error?.code || 'typing_reaction_unknown' });
    });
    state.card = cardFor(job, state, state.result.executionCard);
    state.typing = typingDesired(job, state, true).catch(() => null);
    state.card.push({ kind: 'started', turnId: state.result.execution?.turnId });
    return state;
  }

  async function prepare(job, result, state) {
    if (job.deliveryMode === 'caller' || !state) return;
    if (state.observer) result.executionCard = await state.observer.stop();
    else if (state.card) {
      state.card.stop();
      await state.card.chain;
      result.executionCard = state.card.snapshot();
    }
    const pending = { ...(state.result.typing || {}), desired: false, operation: 'remove', intentAt: now(), outcome: 'pending' };
    await persist(job, state, 'typing', pending);
    await state.typing;
    await typingDesired(job, state, false).catch(error => {
      log('warning', 'typing_reaction', 'pending', { code: error?.code || 'typing_reaction_unknown' });
    });
  }

  async function finish(job, result, _unused, control = {}) {
    if (job.deliveryMode === 'caller') return false;
    const state = stateFor({ ...job, result }, control);
    const snapshot = result.executionCard || state.result.executionCard;
    let delivered = false;
    let cardError;
    if (snapshot) {
      const card = cardFor(job, state, snapshot);
      const terminal = result.turnStatus || result.execution?.terminal;
      const status = terminal === 'interrupted' ? 'interrupted' : result.failed || terminal === 'failed' ? 'failed'
        : result.deferred ? 'deferred' : 'completed';
      try {
        delivered = await card.finish(result.answer || 'Codex 没有返回可用结论。', status);
        result.executionCard = card.snapshot();
      } catch (error) { cardError = error; }
    }
    await typingDesired(job, state, false);
    if (cardError) throw cardError;
    return delivered;
  }

  async function handleCardAction(data) {
    const value = data?.action?.value || {};
    if (value.action !== 'stop_execution') return {};
    const operator = data?.operator?.open_id || '';
    const job = await jobs.getRun({ id: String(value.jobId || '') });
    if (!job || !operator || job.chatId !== data?.context?.open_chat_id
      || job.result?.executionCard?.messageId !== data?.context?.open_message_id) return toast('该卡片已失效');
    if (job.status !== 'running') return toast('该任务已结束');
    if (!job.senderOpenId.startsWith('system:') && !job.senderOpenId.startsWith('group:') && job.senderOpenId !== operator) {
      return toast('只有本次任务的发起者可以停止执行', 'error');
    }
    if (!(await authorize({ source: 'card', callerId: job.callerId, actor: { openId: operator }, conversationId: job.chatId, operation: 'stop' }))) {
      return toast('没有停止该任务的权限', 'error');
    }
    const execution = job.result?.execution || {};
    if (!execution.turnId || execution.turnId !== value.expectedTurnId) return toast('该卡片已失效');
    const begun = await jobs.beginStop({ id: job.id, threadId: execution.threadId, turnId: execution.turnId,
      messageId: job.messageId, actor: operator });
    if (begun.outcome === 'already_finished') return toast('该任务已结束');
    if (['not_found', 'stale'].includes(begun.outcome)) return toast('该卡片已失效');
    if (begun.stop?.outcome === 'requested') return toast('已请求停止执行');
    if (begun.stop?.outcome === 'already_finished') return toast('该执行已结束，不会影响新的任务');

    const binding = await sessions.loadBinding({ feishuOpenId: bindingOpenId(job), chatId: job.chatId, chatType: job.chatType });
    let response;
    if (begun.outcome === 'replay') {
      const snapshot = await executor.inspect({ binding, threadId: execution.threadId, turnId: execution.turnId });
      response = snapshot.status === 'inProgress' || snapshot.status === 'unknown'
        ? { status: 'unconfirmed' } : { status: 'already_finished' };
    } else {
      response = await executor.interrupt({ binding, threadId: execution.threadId, turnId: execution.turnId, messageId: job.messageId });
    }
    const stop = { ...begun.stop, outcome: response.status, confirmedAt: now() };
    await jobs.finishStop({ id: job.id, stop });
    return response.status === 'requested' ? toast('已请求停止执行')
      : response.status === 'already_finished' ? toast('该执行已结束，不会影响新的任务')
      : toast('暂未确认停止，请稍后重试', 'error');
  }

  function abandon(state) {
    state?.observer?.stop?.().catch(() => {});
    state?.card?.stop?.();
  }

  async function cleanup(job, control = {}) {
    if (job.deliveryMode === 'caller' || !job.sourceMessageId) return;
    const state = stateFor(job, control);
    await typingDesired(job, state, false);
  }

  return Object.freeze({ start, observe, restore, prepare, finish, handleCardAction, abandon, cleanup });
}
