import { extractMessageText } from './media.mjs';

const DEFAULT_RECENT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_RECENT_LIMIT = 10;
const optionalText = value => String(value || '').trim();
const messageTime = value => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number < 1e12 ? number * 1000 : number);
};

export function stripBotMention(text, mentions = [], botOpenId = '') {
  let value = String(text || '');
  for (const mention of mentions || []) {
    if (botOpenId && mention?.openId !== botOpenId && mention?.id?.open_id !== botOpenId) continue;
    if (mention?.key) value = value.replaceAll(mention.key, '');
    if (mention?.name) value = value.replaceAll(`@${mention.name}`, '');
  }
  return value.trim();
}

export const removeBotMention = stripBotMention;

export function normalizeFeishuInput(event, { botOpenId = '' } = {}) {
  const mentions = event.message?.mentions || event.mentions || [];
  const rawText = extractMessageText(event);
  const senderName = optionalText(event.actor?.name || event.senderName || event.sender?.sender_name);
  const botMentioned = mentions.some(item => item?.openId === botOpenId || item?.id?.open_id === botOpenId);
  const createdAt = messageTime(event.occurredAt || event.message?.create_time) || Date.now();
  return {
    messageId: event.messageId || event.message?.message_id || '',
    chatId: event.conversationId || event.message?.chat_id || '',
    chatType: event.conversationType || event.message?.chat_type || '',
    messageType: event.message?.kind || event.message?.type || event.message?.message_type || 'text',
    senderOpenId: event.actor?.openId || event.sender?.sender_id?.open_id || '',
    senderUnionId: event.actor?.unionId || event.sender?.sender_id?.union_id || '',
    parentId: optionalText(event.message?.parentId || event.message?.parent_id),
    rootId: optionalText(event.message?.rootId || event.message?.root_id),
    senderName, rawText, text: stripBotMention(rawText, mentions, botOpenId), mentions, botMentioned, createdAt,
    updatedAt: messageTime(event.message?.updatedAt || event.message?.update_time) || createdAt, raw: event,
  };
}

export function createRecentMentionPrompts({ now = Date.now, ttlMs = DEFAULT_RECENT_TTL_MS,
  limit = DEFAULT_RECENT_LIMIT, maxChats = 500 } = {}) {
  const prompts = new Map();
  const prune = () => {
    const at = now();
    for (const [chatId, entries] of prompts) {
      const fresh = entries.filter(entry => at - entry.createdAt <= ttlMs).slice(-limit);
      if (fresh.length) prompts.set(chatId, fresh); else prompts.delete(chatId);
    }
    while (prompts.size > maxChats) prompts.delete(prompts.keys().next().value);
  };
  return Object.freeze({
    remember(input) {
      if (!input.chatId || !optionalText(input.prompt)) return;
      prune();
      const entries = prompts.get(input.chatId) || [];
      entries.push({ prompt: optionalText(input.prompt), messageId: input.messageId || '',
        parentId: input.parentId || '', rootId: input.rootId || '', messageCreatedAt: input.createdAt || 0,
        senderOpenId: input.senderOpenId || '', senderUnionId: input.senderUnionId || '', senderName: input.senderName || '', createdAt: now(), source: 'recent_group_context' });
      prompts.set(input.chatId, entries.slice(-limit));
    },
    take(chatId) { prune(); return [...(prompts.get(chatId) || [])]; },
    consume(entries = []) {
      const ids = new Set(entries.map(entry => entry?.messageId).filter(Boolean));
      if (!ids.size) return;
      for (const [chatId, remembered] of prompts) prompts.set(chatId, remembered.filter(entry => !ids.has(entry.messageId)));
      prune();
    },
  });
}

export function mergeMentionPrompts(recentPrompts = [], currentPrompt = '') {
  const parts = [];
  if (recentPrompts.length) parts.push(`最近未处理的群消息（仅作上下文，工具身份仍以当前 @ 消息发送者为准）：\n${recentPrompts.map((entry, index) => `${index + 1}. ${entry.prompt}`).join('\n')}`);
  if (currentPrompt) parts.push(`当前 @ 消息：\n${currentPrompt}`);
  return parts.join('\n\n');
}

function identityLabel(senderName, senderOpenId, senderUnionId) {
  const name = optionalText(senderName) || optionalText(senderOpenId) || '未知用户';
  const openId = optionalText(senderOpenId);
  const unionId = optionalText(senderUnionId);
  const ids = [openId ? `open_id=${openId}` : '', unionId ? `union_id=${unionId}` : ''].filter(Boolean);
  return ids.length ? `${name}（${ids.join('，')}）` : name;
}

// Only platform identifiers with a conservative character set enter the block,
// so a malformed value cannot close the bracket or add another prompt line.
const metadataId = value => {
  const text = optionalText(value);
  return /^[A-Za-z0-9_.:-]{1,191}$/.test(text) ? text : '';
};
const metadataTime = value => {
  const date = new Date(messageTime(value));
  return date.getTime() > 0 ? date.toISOString() : '';
};

// Generic Feishu message identity for one group-prompt entry. Fields without a
// usable value are omitted; message text and other profile fields never enter it.
export function formatMessageMetadata({ messageId, chatId, msgType, parentId, rootId, senderType, senderOpenId, senderAppId, createdAt } = {}) {
  const fields = [['message_id', metadataId(messageId)], ['chat_id', metadataId(chatId)], ['msg_type', metadataId(msgType)],
    ['parent_id', metadataId(parentId)], ['root_id', metadataId(rootId)], ['sender_type', metadataId(senderType)],
    ['sender_open_id', metadataId(senderOpenId)], ['sender_app_id', metadataId(senderAppId)], ['create_time', metadataTime(createdAt)]]
    .filter(([, value]) => value).map(([key, value]) => `${key}=${value}`);
  return fields.length ? `[msg ${fields.join(' ')}]` : '';
}

function groupEntry(label, identity, metadata, body, replySegment = '') {
  return [`【${label} 来自 ${identity}】`, metadata, replySegment, optionalText(body)].filter(Boolean).join('\n');
}

export function buildCodexForwardPrompt({ chatType, currentPrompt = '', mergedPrompt = '', recentPrompts = [],
  senderName = '', senderOpenId = '', senderUnionId = '', chatId = '', messageId = '', parentId = '', rootId = '', createdAt = 0, replySegment = '' } = {}) {
  if (chatType === 'p2p') {
    const privateName = optionalText(senderName) || optionalText(senderOpenId) || '未知用户';
    return [`【发给你的飞书消息 来自 ${privateName}】`, mergedPrompt].map(optionalText).filter(Boolean).join('\n\n');
  }
  const parts = recentPrompts.filter(entry => entry.prompt).map(entry => groupEntry('群消息',
    identityLabel(entry.senderName, entry.senderOpenId, entry.senderUnionId),
    formatMessageMetadata({ messageId: entry.messageId, parentId: entry.parentId, rootId: entry.rootId,
      senderOpenId: entry.senderOpenId, createdAt: entry.messageCreatedAt || entry.createdAt }), entry.prompt));
  // The triggering message is always identified, even when it has no text body.
  const body = currentPrompt || (parts.length ? '' : mergedPrompt);
  parts.push(groupEntry('提到你的消息', identityLabel(senderName, senderOpenId, senderUnionId),
    formatMessageMetadata({ messageId, chatId, parentId, rootId, senderOpenId, createdAt }), body, optionalText(replySegment)));
  return parts.join('\n\n');
}

export function formatGroupContext(entries = []) {
  return entries.slice(-DEFAULT_RECENT_LIMIT).map(item => `${item.senderName || '群成员'}：${item.prompt ?? item.text ?? ''}`).join('\n');
}

export function isBotJoinNotice(input) {
  if (input.chatType === 'p2p' || !input.botMentioned) return false;
  const prompt = optionalText(input.text);
  if (!prompt) return false;
  return [/(?:邀请|邀請|添加|拉).{0,60}(?:群|群聊)/, /(?:群|群聊).{0,60}(?:邀请|邀請|添加)/,
    /(?:added|invited).{0,80}(?:group chat|group|chat)/i].some(pattern => pattern.test(prompt));
}
