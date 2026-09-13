import { createHash } from 'node:crypto';

export const RECEIVE = 'im.message.receive_v1';
export const RECALL = 'im.message.recalled_v1';

// Source/receipt time/self classification are local observations, not event identity.
export function feishuEventIdentity(event) {
  const { receivedAt, source, isSelf, ...semantic } = event;
  return semantic;
}

function id(value) { return typeof value === 'string' ? value : ''; }
function actor(value = {}) {
  const ids = value.sender_id || value.operator_id || value;
  return { type: id(value.sender_type || value.operator_type) || 'unknown',
    openId: id(ids.open_id), userId: id(ids.user_id), unionId: id(ids.union_id) };
}

// Accepts both the SDK's flattened event and the original v2 envelope.
// Never copy header tokens or the entire event into the persisted contract.
export function normalizeFeishuEvent(type, input, { connectionId, receivedAt = Date.now(), botOpenId = '' }) {
  if (![RECEIVE, RECALL].includes(type)) throw new Error('unsupported_feishu_event');
  const data = input?.event || input;
  const header = input?.header || input;
  const message = data?.message || data;
  if (!id(connectionId) || !id(message?.message_id) || !id(message?.chat_id)) {
    throw new Error('invalid_feishu_event_identity');
  }
  const content = id(message.content);
  let parsedContent = null;
  try { parsedContent = JSON.parse(content); } catch { /* Preserve unsupported/malformed content verbatim. */ }
  const revision = id(message.update_time || message.recall_time || message.create_time || header.create_time);
  const fingerprint = createHash('sha256').update(JSON.stringify([type, message.message_id, revision, content])).digest('hex');
  const sender = actor(type === RECEIVE ? data.sender : data.operator);
  const eventId = id(header.event_id) || `derived:${fingerprint}`;
  return {
    schemaVersion: 1, channel: 'feishu', connectionId,
    eventId, eventKey: `${type}:${eventId}`,
    type: type === RECEIVE ? 'message.received' : 'message.recalled',
    source: 'live', receivedAt,
    occurredAt: Number(message.recall_time || message.create_time || header.create_time) || null,
    conversationId: message.chat_id, conversationType: id(message.chat_type) || 'unknown',
    messageId: message.message_id, revision,
    actor: sender, isApp: sender.type === 'app', isSelf: Boolean(botOpenId && sender.openId === botOpenId),
    message: { kind: id(message.message_type), content, parsedContent,
      parentId: id(message.parent_id), rootId: id(message.root_id), threadId: id(message.thread_id),
      mentions: (Array.isArray(message.mentions) ? message.mentions : []).map((mention) => ({
        key: id(mention.key), name: id(mention.name), ...actor(mention.id),
      })) },
    platform: { feishu: { eventType: type, appId: id(header.app_id), tenantKey: id(header.tenant_key) } },
  };
}
