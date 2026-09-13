export function parseOutboundGroupChatIds(value) {
  return new Set(String(value || '').split(',').map((item) => item.trim()).filter(Boolean));
}

export function canDeliverOutboxAttachments({ chatType = '', chatId = '', allowedGroupChatIds = new Set() } = {}) {
  if (!chatId) return false;
  if (chatType === 'p2p') return true;
  if (!chatType) return false;
  return allowedGroupChatIds.has(chatId);
}

