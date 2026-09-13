import { codexMessageText, extractFinalAnswer } from './format.mjs';

// Only assistant-bearing protocol shapes affect the reply. Tool/reasoning/user
// projections remain run events, never candidates for a user-visible answer.
export function projectAssistantItem(item) {
  if (item?.type !== 'agentMessage' && !(item?.type === 'message' && item.role === 'assistant')) return null;
  const text = item.type === 'agentMessage' ? item.text : codexMessageText(item);
  if (typeof text !== 'string' || !text.trim()) return null;
  return { type: item.type, phase: item.phase ?? '', text };
}

export function createAnswerProjection() {
  const itemText = new Map();
  let lastAgentMessage = '', finalAgentMessage = '', finalMessage = '';
  function completed(item) {
    const projected = projectAssistantItem(item);
    if (!projected) return;
    lastAgentMessage = projected.text;
    if (projected.phase === 'final_answer') {
      if (projected.type === 'agentMessage') finalAgentMessage = projected.text;
      else finalMessage = projected.text;
    }
  }
  return {
    observe({ method, params = {} }) {
      if (['agentMessage/delta', 'item/agentMessage/delta'].includes(method)) {
        const itemId = params.itemId || 'agent-delta';
        const next = `${itemText.get(itemId) || ''}${params.delta || ''}`.slice(-12000);
        itemText.set(itemId, next);
        if (itemText.size > 128) itemText.delete(itemText.keys().next().value);
        lastAgentMessage = next;
      } else if (method === 'item/completed') completed(params.item);
      else if (method === 'turn/completed') for (const item of params.turn?.items ?? []) completed(item);
    },
    answer(turn) {
      for (const item of turn?.items ?? []) completed(item);
      const explicitFinal = extractFinalAnswer({ items: (turn?.items ?? []).filter(item => item?.phase === 'final_answer') });
      // Unlike the old last-message-only fallback, a durable final cannot be
      // displaced by later commentary when the terminal snapshot is thin.
      return explicitFinal || finalAgentMessage || finalMessage || extractFinalAnswer(turn) || lastAgentMessage;
    },
  };
}
