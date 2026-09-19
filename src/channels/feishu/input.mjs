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
        senderOpenId: input.senderOpenId || '', senderName: input.senderName || '', createdAt: now(), source: 'recent_group_context' });
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

function identityLabel(senderName, senderOpenId) {
  const name = optionalText(senderName) || optionalText(senderOpenId) || '未知用户';
  const openId = optionalText(senderOpenId);
  return openId ? `${name}（open_id=${openId}）` : name;
}

export function buildCodexForwardPrompt({ chatType, currentPrompt = '', mergedPrompt = '', recentPrompts = [],
  senderName = '', senderOpenId = '' } = {}) {
  if (chatType === 'p2p') {
    const privateName = optionalText(senderName) || optionalText(senderOpenId) || '未知用户';
    return [`【发给你的飞书消息 来自 ${privateName}】`, mergedPrompt].map(optionalText).filter(Boolean).join('\n\n');
  }
  const parts = recentPrompts.filter(entry => entry.prompt).map(entry => `【群消息 来自 ${identityLabel(entry.senderName, entry.senderOpenId)}】\n${entry.prompt}`);
  const currentName = identityLabel(senderName, senderOpenId);
  if (currentPrompt) parts.push(`【提到你的消息 来自 ${currentName}】\n${currentPrompt}`);
  return parts.length ? parts.join('\n\n') : `【提到你的消息 来自 ${currentName}】\n${mergedPrompt}`;
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
