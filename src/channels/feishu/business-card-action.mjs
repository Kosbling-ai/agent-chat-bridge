import { createHash } from 'node:crypto';

const acceptedToast = Object.freeze({ toast: { type: 'info', content: '已收到，处理结果稍后更新在卡片上' } });
const delayedToast = Object.freeze({ toast: { type: 'info', content: '已收到，系统记录延迟，请稍后确认卡片状态' } });
const disconnectedToast = Object.freeze({ toast: { type: 'info', content: '此群未接入该业务' } });
const feedbackAcceptedToast = Object.freeze({ toast: { type: 'info', content: '意见已记录，等待校验并处理，请稍后查看卡片' } });
const feedbackUnconfirmedToast = Object.freeze({ toast: { type: 'warning', content: '暂未确认意见提交成功，请稍后查看卡片后重试' } });
const invalidFormToast = Object.freeze({ toast: { type: 'error', content: '提交内容格式不正确或过长，请修改后重试' } });
const timedOut = Symbol('registration_timeout');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

// Transport limits only; field meanings and business authorization belong to the receiver.
function normalizeFormValue(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_form');
  let nodes = 0;
  function clone(item, depth) {
    if (++nodes > 256 || depth > 6) throw new Error('invalid_form');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string' && item.length <= 32768) return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(child => clone(child, depth + 1));
    if (!item || typeof item !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('invalid_form');
    return Object.fromEntries(Object.entries(item).map(([key, child]) => {
      if (key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('invalid_form');
      return [key, clone(child, depth + 1)];
    }));
  }
  const result = clone(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 32768) throw new Error('invalid_form');
  return result;
}

function firstString(...values) {
  return values.find(value => typeof value === 'string' && value) ?? '';
}

function occurredAt(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const magnitude = Math.abs(number);
    const milliseconds = magnitude < 1e11 ? number * 1000
      : magnitude < 1e14 ? number
        : magnitude < 1e17 ? number / 1000
          : magnitude < 1e20 ? number / 1e6 : NaN;
    const date = new Date(milliseconds);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return null;
}

function fallbackEventId({ messageId, operatorOpenId, value, actionTime, formValue }) {
  const hash = createHash('sha256');
  for (const part of [messageId, operatorOpenId, canonical(value), String(actionTime ?? '')]) {
    hash.update(String(part));
    hash.update('\0');
  }
  if (formValue !== undefined) { hash.update(canonical(formValue)); hash.update('\0'); }
  return hash.digest('hex');
}

function safeErrorCode(error) {
  const code = String(error?.code || '');
  return /^[a-z][a-z0-9_:-]{0,63}$/.test(code) ? code : 'card_action_registration_failed';
}

export function createBusinessCardAction({ hooks = [], connectionId, ingest,
  runAsync = operation => Promise.resolve().then(operation).catch(() => {}), log = () => {}, registrationTimeoutMs = 2000 } = {}) {
  if (typeof ingest !== 'function' || typeof connectionId !== 'string' || !connectionId
    || !Number.isInteger(registrationTimeoutMs) || registrationTimeoutMs < 1 || registrationTimeoutMs > 2000) {
    throw new Error('invalid_business_card_action_dependencies');
  }

  function handleCardAction(data) {
    const value = data?.action?.value;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.action !== 'business') return null;
    let formValue;
    try { formValue = normalizeFormValue(data?.action?.form_value); } catch { return invalidFormToast; }
    const hookId = firstString(value.hook_id);
    const chatId = firstString(data?.context?.open_chat_id, data?.chat_id);
    const messageId = firstString(data?.context?.open_message_id, data?.message_id);
    const operatorOpenId = firstString(data?.operator?.open_id, data?.operator_open_id);
    const operatorName = firstString(data?.operator?.name, data?.operator?.operator_name, data?.operator_name);
    const actionTime = data?.action?.action_time ?? data?.action_time ?? data?.event?.action_time
      ?? data?.create_time ?? data?.header?.create_time ?? data?.occurred_at;
    const eventId = firstString(data?.event_id, data?.eventId, data?.header?.event_id, data?.event?.event_id)
      || fallbackEventId({ messageId, operatorOpenId, value, actionTime, formValue });
    const hook = hooks.find(candidate => candidate.id === hookId);
    const fields = { component: 'card_action', hookId, eventId, chatId, messageId,
      kind: typeof value.kind === 'string' ? value.kind : '' };
    if (!hook || !hook.conversationIds.includes(chatId)) {
      log('info', 'receive', 'ignored', fields);
      return disconnectedToast;
    }

    const event = {
      schemaVersion: 1, channel: 'feishu', type: 'card.action',
      connectionId, eventId, chatId, messageId, operatorOpenId,
      ...(operatorName ? { operatorName } : {}), ...(formValue === undefined ? {} : { formValue }), value, occurredAt: occurredAt(actionTime),
    };
    const registration = Promise.resolve().then(() => ingest({ hookId, eventId, chatId, messageId, event }));
    const observed = registration.then(receipt => {
      log('info', 'receive', receipt?.duplicate ? 'duplicate' : 'accepted', fields);
      return { ok: true, receipt };
    }, error => {
      log('error', 'receive', 'failed', { ...fields, errorCode: safeErrorCode(error) });
      return { ok: false, error };
    });
    runAsync(() => observed);
    return (async () => {
      let timer;
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(timedOut), registrationTimeoutMs); });
      const result = await Promise.race([observed, timeout]);
      clearTimeout(timer);
      if (value.kind === 'feedback') return result !== timedOut && result.ok ? feedbackAcceptedToast : feedbackUnconfirmedToast;
      if (result === timedOut || result.ok) return acceptedToast;
      return delayedToast;
    })();
  }

  return Object.freeze({ handleCardAction });
}
