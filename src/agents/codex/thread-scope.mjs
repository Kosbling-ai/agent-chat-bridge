import { createHash } from 'node:crypto';

// Synthetic identities are created only by trusted callers; prompt text is never inspected.
export function isScheduledBinding(openId) {
  return String(openId || '').startsWith('system:');
}

export function deriveExecutionScope(callerId, namespace) {
  if (typeof callerId !== 'string' || !callerId.trim() || callerId.length > 128) throw new Error('invalid callerId');
  if (namespace === undefined) return '';
  if (typeof namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(namespace)) throw new Error('invalid execution namespace');
  return `system:${createHash('sha256').update(`${callerId}\0${namespace}`).digest('hex')}`;
}

export function codexBindingOpenId({ feishuOpenId, chatId, chatType }) {
  if (isScheduledBinding(feishuOpenId)) return feishuOpenId;
  if (chatType && chatType !== 'p2p') {
    return `group:${createHash('sha1').update(String(chatId || '')).digest('hex').slice(0, 24)}`;
  }
  return feishuOpenId;
}
