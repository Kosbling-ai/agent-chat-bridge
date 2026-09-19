import { createHash } from 'node:crypto';

const acceptedToast = Object.freeze({ toast: { type: 'info', content: '已收到，处理结果稍后更新在卡片上' } });
const disconnectedToast = Object.freeze({ toast: { type: 'info', content: '此群未接入该业务' } });

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value) ?? '';
}

function occurredAt(value, now) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    const number = Number(value);
    const date = new Date(number < 10_000_000_000 ? number * 1000 : number);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return new Date(now()).toISOString();
}

function fallbackEventId({ messageId, operatorOpenId, value, actionTime }) {
  const hash = createHash('sha256');
  for (const part of [messageId, operatorOpenId, canonical(value), String(actionTime ?? '')]) {
    hash.update(String(part));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function createBusinessCardAction({ hooks = [], ingest, runAsync = operation => Promise.resolve().then(operation).catch(() => {}),
  log = () => {}, now = Date.now } = {}) {
  if (typeof ingest !== 'function') throw new Error('invalid_business_card_action_dependencies');

  function handleCardAction(data) {
    const value = data?.action?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.action !== 'business') return null;
    const hookId = firstString(value.hook_id);
    const chatId = firstString(data?.context?.open_chat_id, data?.chat_id);
    const messageId = firstString(data?.context?.open_message_id, data?.message_id);
    const hook = hooks.find(candidate => candidate.id === hookId);
    const fields = { hookId, chatId, messageId, kind: typeof value.kind === 'string' ? value.kind : '' };
    if (!hook || !hook.conversationIds.includes(chatId)) {
      log('info', 'card_action', 'ignored', fields);
      return disconnectedToast;
    }

    const operatorOpenId = firstString(data?.operator?.open_id, data?.operator_open_id);
    const operatorName = firstString(data?.operator?.name, data?.operator?.operator_name, data?.operator_name);
    const actionTime = data?.action?.action_time ?? data?.action_time ?? data?.event?.action_time
      ?? data?.header?.create_time ?? data?.occurred_at;
    const eventId = firstString(data?.event_id, data?.eventId, data?.header?.event_id, data?.event?.event_id)
      || fallbackEventId({ messageId, operatorOpenId, value, actionTime });
    const event = {
      kind: 'card_action', event_id: eventId, operator_open_id: operatorOpenId,
      ...(operatorName ? { operator_name: operatorName } : {}),
      chat_id: chatId, message_id: messageId, value, occurred_at: occurredAt(actionTime, now),
    };
    runAsync(async () => {
      try {
        const receipt = await ingest({ hookId, eventId, chatId, messageId, event });
        log('info', 'card_action', receipt?.duplicate ? 'duplicate' : 'accepted', fields);
      } catch {
        log('warning', 'card_action', 'failed', fields);
      }
    });
    return acceptedToast;
  }

  return Object.freeze({ handleCardAction });
}
