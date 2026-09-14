import { createHash } from 'node:crypto';

const stable = value => createHash('sha1').update(String(value || '')).digest('hex').slice(0, 24);
const detail = (reactionId, emoji) => `reaction_id=${reactionId} emoji=${emoji}`;

export function createProcessingTyping({ chat, inbound, enabled = true, emoji = 'Typing',
  fallbackText = '收到，正在查询。', log = () => {} } = {}) {
  async function record(job, event, reactionId, reason) {
    if (!inbound?.recordEvent || !job.sourceMessageId) return;
    try {
      await inbound.recordEvent({ messageId: job.sourceMessageId, chatId: job.chatId,
        chatType: job.chatType, messageType: job.messageType, event, ok: true,
        reason, detail: detail(reactionId, emoji) });
    } catch {
      log('warning', 'typing_reaction', 'audit_failed', { code: 'typing_reaction_audit_failed' });
    }
  }
  async function add(job) {
    if (!enabled || !job.sourceMessageId) return null;
    try {
      const response = await chat.addReaction({ messageId: job.sourceMessageId, emojiType: emoji });
      const reactionId = response?.reaction_id || response?.reactionId || '';
      if (!reactionId) {
        log('warning', 'typing_reaction', 'missing', { code: 'typing_reaction_unconfirmed' });
        return null;
      }
      const reaction = { reactionId };
      await record(job, 'processing_reaction_added', reactionId, emoji);
      return reaction;
    } catch {
      log('warning', 'typing_reaction', 'failed', { code: 'typing_reaction_failed' });
      return null;
    }
  }
  async function fallback(job) {
    if (!fallbackText || !job.chatId) return false;
    try {
      await chat.sendMessage({ conversationId: job.chatId, kind: 'text', content: { text: fallbackText },
        uuid: stable(`processing-fallback:${job.messageId || job.id}`) });
      return true;
    } catch {
      log('warning', 'typing_fallback', 'failed', { code: 'typing_fallback_failed' });
      return false;
    }
  }
  async function remove(job, reaction, source = 'finally') {
    if (!reaction?.reactionId || !job.sourceMessageId) return false;
    try {
      await chat.removeReaction({ messageId: job.sourceMessageId, reactionId: reaction.reactionId });
      await record(job, 'processing_reaction_removed', reaction.reactionId, source);
      return true;
    } catch {
      log('warning', 'typing_reaction', 'remove_failed', { code: 'typing_reaction_remove_failed' });
      return false;
    }
  }
  async function cleanup(job, reaction = null) {
    if (!enabled || !job.sourceMessageId) return;
    if (reaction) await remove(job, reaction, 'finally');
    let persisted = new Set();
    try { persisted = await inbound?.loadOpenProcessingReactionIds?.({ messageId: job.sourceMessageId }) || new Set(); }
    catch { log('warning', 'typing_reaction', 'load_failed', { code: 'typing_reaction_load_failed' }); }
    for (const reactionId of persisted) await remove(job, { reactionId }, 'persisted');
    let listed = [];
    try {
      const response = await chat.listReactions({ messageId: job.sourceMessageId, pageSize: 50 });
      listed = (response?.items || []).filter(item => item?.operator?.operator_type === 'app'
        && item?.reaction_type?.emoji_type === emoji);
    } catch { log('warning', 'typing_reaction', 'list_failed', { code: 'typing_reaction_list_failed' }); }
    for (const item of listed) {
      const reactionId = item?.reaction_id || '';
      if (reactionId && !persisted.has(reactionId)) await remove(job, { reactionId }, 'listed');
    }
  }
  return Object.freeze({
    async start(job) {
      const reaction = await add(job);
      if (!reaction?.reactionId) await fallback(job);
      return reaction;
    },
    cleanup,
  });
}
