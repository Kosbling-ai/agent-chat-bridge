// Per-group reply style for human group turns.
//
// resolveReplyPolicy returns the configured `reply` object of a listed
// `bridge` group (`{ mode: 'card' }` or `{ mode: 'text', ack, ackEmoji? }`) for
// a bridge-delivered group job, otherwise null. Private chats, business-event
// jobs, unlisted or hook-only groups and groups without the key return null.
export function resolveReplyPolicy(routing, { chatId, chatType, deliveryMode } = {}) {
  if (chatType !== 'group' || deliveryMode !== 'bridge' || !routing) return null;
  const group = (routing.groups || []).find(item => item.conversationId === chatId);
  if (!group?.capabilities?.includes('bridge') || !group.reply) return null;
  return group.reply;
}

// The reply style a job uses: the one recorded on the job when its turn
// started (kept across retries and restarts), otherwise none for a job that
// already has an execution card, otherwise the current configuration.
export function jobReplyPolicy(job, result, resolve = () => null) {
  if (job?.deliveryMode !== 'bridge') return null;
  const recorded = result?.replyMode ?? job.result?.replyMode;
  if (recorded) return recorded;
  if (result?.executionCard || job.result?.executionCard) return null;
  return resolve(job) ?? null;
}

export function textReplyFor(job, result, resolve) {
  const policy = jobReplyPolicy(job, result, resolve);
  return policy?.mode === 'text' ? policy : null;
}
