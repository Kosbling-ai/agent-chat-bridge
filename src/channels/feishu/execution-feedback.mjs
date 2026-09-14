import { createHash } from 'node:crypto';
import { ExecutionCard, observeExecutionCard } from './execution-card.mjs';
import { codexBindingOpenId } from '../../agents/codex/thread-scope.mjs';

const stable = value => createHash('sha1').update(String(value || '')).digest('hex').slice(0, 24);
const toast = (content, type = 'info') => ({ toast: { type, content } });
const unconfirmedCard = saved => saved?.delivery === 'unknown'
  || ['intent', 'unknown'].includes(saved?.deliveryState?.status);
const productionCardState = saved => {
  if (!saved) return saved;
  const { desiredRevision, ackedRevision, deliveryState, observerCursor, observerSeen, ...state } = saved;
  return state;
};

export function createExecutionFeedback({ jobs, sessions, chat, typing, cardClient, authorize = async () => true,
  executor, config = {}, log = () => {}, now = Date.now } = {}) {
  const bindingOpenId = (job, result = job.result || {}) => result.execution?.bindingOpenId
    || codexBindingOpenId({ feishuOpenId: job.senderOpenId, chatId: job.chatId, chatType: job.chatType });

  function stateFor(job, control = {}) {
    return { result: structuredClone(job.result || {}), control, card: null, observer: null, typing: null };
  }

  async function persist(job, state, key, value) {
    state.control.assertOwned?.();
    await jobs.patchFeedback({ id: job.id, leaseOwner: job.leaseOwner, key, value });
    state.control.assertOwned?.();
    state.result = { ...state.result, [key]: structuredClone(value) };
  }

  function cardFor(job, state, saved) {
    if (unconfirmedCard(saved)) return null;
    return new ExecutionCard({
      client: cardClient, chatId: job.chatId, jobId: job.id, messageId: job.messageId,
      displayName: config.displayName, uuid: stable(`execution-card:${job.messageId}`),
      intervalMs: config.executionCardIntervalMs || 1000,
      persist: value => persist(job, state, 'executionCard', value),
      audit: event => sessions?.saveCodexRealtimeEvent?.({
        feishuOpenId: bindingOpenId(job, state.result), chatId: job.chatId, chatType: job.chatType,
        codexSessionId: state.result.execution?.threadId || event.threadId || '',
      }, {
        messageId: job.messageId, eventKey: `feedback:${job.id}:${event.status}:${now()}`,
        eventType: 'execution_card', role: 'activity', title: '执行卡片', text: '', createdAt: now(), detail: event,
      }),
      saved: productionCardState(saved),
    });
  }

  async function start(job, control = {}) {
    if (job.deliveryMode === 'caller') return null;
    const state = stateFor(job, control);
    state.card = cardFor(job, state, state.result.executionCard);
    state.typing = await typing?.start?.(job) || null;
    state.card?.push({ kind: 'started' });
    return state;
  }

  function observe(job, state, execution) {
    if (!state?.card || state.observer) return state?.observer || null;
    state.observer = observeExecutionCard({
      card: state.card, since: Number(job.createdAt || now()),
      load: async next => {
        state.control.assertOwned?.();
        const bound = execution.threadId ? null : await sessions.loadBinding({
          feishuOpenId: execution.bindingOpenId || bindingOpenId(job, state.result), chatId: job.chatId, chatType: job.chatType,
        });
        const threadId = execution.threadId || bound?.codexSessionId;
        if (!threadId) return [];
        const rows = await sessions.readPublicProgress({
          binding: { feishuOpenId: bindingOpenId(job, state.result), chatId: job.chatId },
          threadId, messageId: job.messageId, cursor: next, limit: 100,
        });
        state.control.assertOwned?.();
        return rows.map(row => ({ ...row, progress_json: row.detail_json }));
      },
    });
    return state.observer;
  }

  async function restore(job, control = {}) {
    if (job.deliveryMode === 'caller') return null;
    const state = stateFor(job, control);
    await typing?.cleanup?.(job).catch(() => {});
    state.card = cardFor(job, state, state.result.executionCard);
    state.card?.push({ kind: 'started', turnId: state.result.execution?.turnId });
    return state;
  }

  function restoreWaiting(job, control = {}) {
    if (job.deliveryMode === 'caller') return null;
    const state = stateFor(job, control);
    state.card = cardFor(job, state, state.result.executionCard);
    return state;
  }

  function activate(job, state, execution) {
    if (!state || state.result.executionCard?.status !== 'retrying') return;
    state.card?.push({ kind: 'started', turnId: execution?.turnId });
    state.card?.enqueue?.();
  }

  async function wait(job, state) {
    if (job.deliveryMode === 'caller' || !state) return;
    if (state.observer) {
      state.result.executionCard = await state.observer.stop();
      state.observer = null;
    }
    if (state.result.executionCard?.status !== 'retrying' && state.card) {
      state.result.executionCard = await state.card.pause();
    }
    await typing?.cleanup?.(job, state.typing).catch(() => {});
  }

  async function prepare(job, result, state) {
    if (job.deliveryMode === 'caller' || !state) return;
    if (state.typing?.reactionId) result.processingReaction = { reactionId: state.typing.reactionId };
    if (state.observer) result.executionCard = await state.observer.stop();
    else if (state.card) {
      state.card.stop();
      await state.card.chain;
      result.executionCard = state.card.snapshot();
    }
  }

  async function finish(job, result, _unused, control = {}) {
    if (job.deliveryMode === 'caller') return false;
    const state = stateFor({ ...job, result }, control);
    const snapshot = result.executionCard || state.result.executionCard;
    let delivered = false;
    let cardError;
    if (snapshot) {
      const card = cardFor(job, state, snapshot);
      if (!card) cardError = Object.assign(new Error('existing card delivery is unconfirmed'), {
        code: 'execution_card_delivery_unknown', outcome: 'unknown',
      });
      else {
        const terminal = result.turnStatus || result.execution?.terminal;
        const status = terminal === 'interrupted' ? 'interrupted' : result.failed || terminal === 'failed' ? 'failed'
          : result.deferred ? 'deferred' : 'completed';
        try {
          delivered = await card.finish(result.answer || 'Codex 没有返回可用结论。', status);
          result.executionCard = card.snapshot();
        } catch (error) { cardError = error; }
      }
    }
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
    const turnId = execution.turnId || job.result?.executionCard?.turnId || '';
    if (!turnId || turnId !== value.expectedTurnId) return toast('该卡片已失效');
    const binding = await sessions.loadBinding({ feishuOpenId: bindingOpenId(job), chatId: job.chatId, chatType: job.chatType });
    const threadId = execution.threadId || binding?.codexSessionId || '';
    if (!threadId) return toast('该卡片已失效');
    const begun = await jobs.beginStop({ id: job.id, threadId, turnId, bindingThreadId: binding.codexSessionId,
      messageId: job.messageId, actor: operator });
    if (begun.outcome === 'already_finished') return toast('该任务已结束');
    if (['not_found', 'stale'].includes(begun.outcome)) return toast('该卡片已失效');
    if (begun.stop?.outcome === 'requested') return toast('已请求停止执行');
    if (begun.stop?.outcome === 'already_finished') return toast('该执行已结束，不会影响新的任务');

    let response;
    if (begun.outcome === 'replay') {
      const snapshot = await executor.inspect({ binding, threadId, turnId });
      response = snapshot.status === 'inProgress' || snapshot.status === 'unknown'
        ? { status: 'unconfirmed' } : { status: 'already_finished' };
    } else {
      response = await executor.interrupt({ binding, threadId, turnId, messageId: job.messageId });
    }
    const stop = { ...begun.stop, outcome: response.status, confirmedAt: now() };
    await jobs.finishStop({ id: job.id, stop });
    return response.status === 'requested' ? toast('已请求停止执行')
      : response.status === 'already_finished' ? toast('该执行已结束，不会影响新的任务')
      : toast('暂未确认停止，请稍后重试', 'error');
  }

  function abandon(state) {
    state?.observer?.cancel?.();
    state?.card?.stop?.();
  }

  async function cleanup(job, control = {}) {
    if (job.deliveryMode === 'caller' || !job.sourceMessageId) return;
    control.assertOwned?.();
    await typing?.cleanup?.(job, control.reaction || job.result?.processingReaction || null);
    control.assertOwned?.();
  }

  return Object.freeze({ start, observe, restore, restoreWaiting, activate, wait, prepare, finish, handleCardAction, abandon, cleanup });
}
