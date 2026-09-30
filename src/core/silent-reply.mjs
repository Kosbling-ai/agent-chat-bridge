// Generic "no reply needed" sentinel for human group turns. The bridge does not
// define any sentinel value; operators list them in configuration.

// Returns the effective policy for a job's conversation, or null when the
// feature does not apply. Private chats and unlisted or hook-only groups are
// never silenced. Group fields override the routing-level defaults one by one.
export function resolveSilentReplyPolicy(routing, { chatId, chatType } = {}) {
  if (chatType !== 'group' || !routing) return null;
  const group = (routing.groups || []).find(item => item.conversationId === chatId);
  if (!group?.capabilities?.includes('bridge')) return null;
  const defaults = routing.silentReply || {};
  const tokens = group.silentReply?.tokens ?? defaults.tokens ?? [];
  if (!tokens.length) return null;
  return Object.freeze({ tokens, card: group.silentReply?.card ?? defaults.card ?? 'delete' });
}

// Exact, case-sensitive comparison after trimming surrounding whitespace only.
// Prefix, substring and case-folded matches are deliberately not supported.
export function matchSilentReply(answer, policy) {
  if (!policy?.tokens?.length || typeof answer !== 'string') return '';
  const value = answer.trim();
  return value && policy.tokens.includes(value) ? value : '';
}
