// Frozen production-source snapshot for differential tests. No runtime imports.
// Source: agent-server.mjs and feishu-transport.mjs at 2c16174.
// SHA256 of function source: eae583d876765351163532d47cf1512a0dfd89f178e62ab865c5195e0f7dd6a0
function extractFinalAnswer(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const final = [...items].reverse().find((item) => item?.type === 'agentMessage' && item.phase === 'final_answer' && String(item.text || '').trim());
  if (final) return String(final.text || '').trim();
  const finalMessage = [...items].reverse().find((item) => (
    item?.type === 'message'
    && item.role === 'assistant'
    && item.phase === 'final_answer'
    && codexMessageText(item).trim()
  ));
  if (finalMessage) return codexMessageText(finalMessage).trim();
  const last = [...items].reverse().find((item) => item?.type === 'agentMessage' && String(item.text || '').trim());
  return last ? String(last.text || '').trim() : '';
}

function codexMessageText(item = {}) {
  if (typeof item.text === 'string') return item.text;
  const content = Array.isArray(item.content) ? item.content : [];
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    return part.text || part.input_text || part.output_text || '';
  }).filter(Boolean).join('\n');
}

function buildCodexForwardPrompt(message, { currentPrompt, mergedPrompt, recentPrompts = [], senderName = '', senderOpenId = '' } = {}) {
  if (!isGroupMessage(message)) {
    const privateName = optionalText(senderName) || maskFeishuOpenId(senderOpenId);
    return [`【发给你的飞书消息 来自 ${privateName}】`, mergedPrompt]
      .map((part) => String(part || '').trim())
      .filter(Boolean)
      .join('\n\n');
  }
  const parts = [];
  for (const entry of recentPrompts || []) {
    const name = groupSenderIdentityLabel(entry.senderName, entry.senderOpenId);
    if (entry.prompt) parts.push(`【群消息 来自 ${name}】\n${entry.prompt}`);
  }
  const currentName = groupSenderIdentityLabel(senderName, senderOpenId);
  if (currentPrompt) parts.push(`【提到你的消息 来自 ${currentName}】\n${currentPrompt}`);
  return parts.length > 0 ? parts.join('\n\n') : `【提到你的消息 来自 ${currentName}】\n${mergedPrompt || ''}`;
}

function groupSenderIdentityLabel(senderName, senderOpenId) {
  const name = optionalText(senderName) || optionalText(senderOpenId) || '未知用户';
  const openId = optionalText(senderOpenId);
  return openId ? `${name}（open_id=${openId}）` : name;
}

function maskFeishuOpenId(openId) {
  const text = String(openId || '').trim();
  if (!text) return '未知用户';
  return text.length <= 8 ? text : `open_id:${text.slice(-8)}`;
}

function optionalText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function isGroupMessage(message) {
  return message.chat_type && message.chat_type !== 'p2p';
}

export { extractFinalAnswer, buildCodexForwardPrompt };
