// Final-only subset of Kosbling-Agent's production execution-card renderer.
// Keep provider delivery/retry state outside this pure rendering module.
export const REPLY_CARD_MAX_BYTES = 20000;
const labels = { completed: '已完成', rejected: '未处理', failed: '处理失败' };
export function renderReplyCard(text, status = 'completed') {
  if (typeof text !== 'string' || !Object.hasOwn(labels, status)) throw new Error('invalid_reply_card');
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: `Agent · ${labels[status]}` } },
    header: { template: status === 'completed' ? 'green' : status === 'failed' ? 'red' : 'blue', title: { tag: 'plain_text', content: 'Agent' } },
    body: { elements: [
      { tag: 'markdown', content: text || '本次处理已结束。' },
      { tag: 'markdown', content: `**${labels[status]}**` },
    ] },
  };
}
export function splitReplyCards(text, status = 'completed') {
  if (typeof text !== 'string') throw new Error('invalid_reply_card');
  // Measure the complete serialized card: quotes, backslashes, UTF-8 and
  // schema scaffolding all count. Never truncate or split a Unicode code point.
  const chars = Array.from(text);
  const cards = [];
  let offset = 0;
  do {
    let low = 0, high = Math.min(chars.length - offset, REPLY_CARD_MAX_BYTES);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const card = renderReplyCard(chars.slice(offset, offset + middle).join(''), status);
      if (Buffer.byteLength(JSON.stringify(card)) <= REPLY_CARD_MAX_BYTES) low = middle;
      else high = middle - 1;
    }
    if (!low && offset < chars.length) throw new Error('reply_card_budget_exceeded');
    cards.push(renderReplyCard(chars.slice(offset, offset + low).join(''), status));
    offset += low;
  } while (offset < chars.length);
  return cards;
}
