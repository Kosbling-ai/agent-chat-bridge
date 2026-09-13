// Preserved pure response/source-label logic from the existing bridge.
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

export { extractFinalAnswer, codexMessageText, buildCodexForwardPrompt };

export function buildConversationPrompt({ event, text, context = [], newThread = false, group = {}, outboxDir }) {
  if (!event) return text; // Trusted background run prompt is already complete.
  const groupChat = event.conversationType !== 'p2p';
  let sourcePrompt = buildCodexForwardPrompt({ chat_type: event.conversationType }, {
    currentPrompt: text, mergedPrompt: text,
    senderName: event.actor?.name ?? '', senderOpenId: event.actor?.openId ?? '',
    recentPrompts: context.map(item => ({ prompt: item.text, senderName: item.event?.actor?.name ?? '', senderOpenId: item.event?.actor?.openId ?? '' })),
  });
  if (!groupChat && outboxDir) sourcePrompt += '\n\n回发文件发布约定：结束本轮回答前必须完成并关闭回发目录中的文件；回答结束后不得继续由后台任务或持有的文件句柄写入这些产物。';
  if (!newThread) return sourcePrompt;
  if (groupChat) {
    if (!group.name && !group.description) return sourcePrompt;
    return ['【飞书群聊上下文】', group.name ? `群名称：${group.name}` : '', group.description ? `群介绍：${group.description}` : '', `chat_id：${event.conversationId}`, '说明：这是本 Codex 会话绑定的飞书群，后续群成员 @ 机器人都会延续这个会话。'].filter(Boolean).join('\n') + '\n\n' + sourcePrompt;
  }
  return ['【飞书私聊会话】', `chat_id：${event.conversationId}`, event.actor?.openId ? `对方 open_id：${event.actor.openId}` : '', outboxDir ? `回发文件目录：${outboxDir}` : ''].filter(Boolean).join('\n') + '\n\n' + sourcePrompt;
}
