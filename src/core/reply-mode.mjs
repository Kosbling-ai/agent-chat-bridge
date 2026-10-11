// Per-group reply style for human group turns. Returns the frozen text-mode
// policy `{ mode: 'text', ack, ackEmoji? }` for a bridge-delivered group job
// whose listed `bridge` group sets `reply.mode: "text"`, otherwise null (the
// execution card path). Private chats, business-event jobs and unlisted or
// hook-only groups always keep the card path.
export function resolveTextReplyPolicy(routing, { chatId, chatType, deliveryMode } = {}) {
  if (chatType !== 'group' || deliveryMode !== 'bridge' || !routing) return null;
  const group = (routing.groups || []).find(item => item.conversationId === chatId);
  if (!group?.capabilities?.includes('bridge') || group.reply?.mode !== 'text') return null;
  return group.reply;
}
