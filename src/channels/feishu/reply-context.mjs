import { extractMessageText } from './media.mjs';
import { formatMessageMetadata } from './input.mjs';

export const DEFAULT_REPLY_CONTEXT_MAX_CHARS = 4000;
const REPLY_FETCH_TIMEOUT_MS = 5000;
const UNAVAILABLE = '被回复内容不可得';

// Keys that carry callback parameters, links, identities or layout rather than visible text.
const HIDDEN_KEYS = new Set(['value', 'behaviors', 'url', 'multi_url', 'href', 'confirm', 'image_key', 'img_key', 'user_id', 'open_id',
  'union_id', 'name', 'action_type', 'type', 'tag', 'template_id', 'template_version_name', 'template_variable', 'icon', 'ud_icon', 'config',
  'options', 'initial_option', 'initial_options', 'initial_date', 'initial_time', 'initial_datetime', 'fallback', 'style', 'card_link']);
const TEXT_KEYS = new Set(['title', 'subtitle', 'text', 'content']);
const CONTROL_TAGS = new Set(['select_static', 'multi_select_static', 'select_person', 'multi_select_person', 'select_img', 'overflow',
  'date_picker', 'picker_time', 'picker_datetime', 'input', 'checker']);

const clean = value => String(value ?? '').replace(/\r\n?/g, '\n').trim();
const visibleText = value => {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return typeof value.content === 'string' ? value.content : (typeof value.text === 'string' ? value.text : '');
  return '';
};

// Flattens both the received-card structure ({title, elements:[[...]]}) and the
// original card JSON in document order. Buttons contribute only their label.
export function flattenCardText(card) {
  const lines = [];
  const push = value => { const text = clean(value); if (text) lines.push(text); };
  const walk = (node, depth) => {
    if (depth > 32 || lines.length >= 1000 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    const tag = typeof node.tag === 'string' ? node.tag : '';
    if (tag === 'button') { push(`[按钮] ${clean(visibleText(node.text))}`); return; }
    if (tag === 'at') { const name = clean(node.user_name || node.name); if (name) push(`@${name}`); return; }
    if (tag === 'img' || tag === 'image' || tag === 'img_combination') { push('[图片]'); return; }
    if (tag === 'hr') return;
    if (CONTROL_TAGS.has(tag)) { push(`[控件] ${clean(visibleText(node.placeholder))}`); return; }
    for (const [key, child] of Object.entries(node)) {
      if (HIDDEN_KEYS.has(key) || key.startsWith('i18n')) continue;
      if (typeof child === 'string') { if (TEXT_KEYS.has(key)) push(child); }
      else walk(child, depth + 1);
    }
  };
  walk(card, 0);
  return lines.join('\n');
}

function messageBodyText(item) {
  const type = String(item?.msg_type || '');
  const content = typeof item?.body?.content === 'string' ? item.body.content : '';
  if (type === 'text' || type === 'post') {
    let text = extractMessageText({ message: { kind: type, content } });
    for (const mention of Array.isArray(item.mentions) ? item.mentions : []) {
      if (mention?.key && mention?.name) text = text.replaceAll(mention.key, `@${mention.name}`);
    }
    return clean(text);
  }
  if (type === 'interactive') { try { return flattenCardText(JSON.parse(content)); } catch { return ''; } }
  if (type === 'image') return '[图片]';
  if (type === 'file') { try { return clean(`[文件] ${JSON.parse(content).file_name || ''}`); } catch { return '[文件]'; } }
  return `[${type || '未知类型'} 消息]`;
}

function truncate(text, maxChars) {
  const characters = Array.from(text);
  return characters.length > maxChars ? `${characters.slice(0, maxChars).join('')}…（已截断）` : text;
}

const quote = text => text.split('\n').map(line => `> ${line}`).join('\n');

function segment(metadata, body, extra = []) {
  return ['【被回复消息】', metadata, quote(body), ...extra].filter(Boolean).join('\n');
}

// Builds the replied-to message section for a group trigger. A parent already in the
// passive context is referenced rather than repeated; failures never block the turn.
export async function loadReplySegment({ chat, parentId, chatId = '', contextEntries = [], cardJson = false,
  maxChars = DEFAULT_REPLY_CONTEXT_MAX_CHARS, log = () => {} } = {}) {
  if (!parentId) return '';
  const observe = (code, stage) => { try { Promise.resolve(log('warning', 'reply_context', 'unavailable', { code, stage, chatId, messageId: parentId })).catch(() => {}); } catch { /* never blocks */ } };
  const known = contextEntries.find(entry => entry?.messageId === parentId);
  if (known) {
    return segment(formatMessageMetadata({ messageId: parentId, parentId: known.parentId, rootId: known.rootId, senderOpenId: known.senderOpenId,
      createdAt: known.messageCreatedAt || known.createdAt }), '内容见上方同 message_id 的群消息');
  }
  let item;
  try {
    if (typeof chat?.getMessage !== 'function') throw Object.assign(new Error('reply_fetch_unavailable'), { code: 'reply_fetch_unavailable' });
    item = (await chat.getMessage({ messageId: parentId, timeoutMs: REPLY_FETCH_TIMEOUT_MS }))?.items?.[0];
    if (!item || item.deleted) throw Object.assign(new Error('reply_message_missing'), { code: 'reply_message_missing' });
  } catch (error) {
    observe(error?.code || 'reply_fetch_failed', 'message');
    return segment(formatMessageMetadata({ messageId: parentId }), UNAVAILABLE);
  }
  const sender = item.sender || {};
  const metadata = formatMessageMetadata({ messageId: item.message_id || parentId, msgType: item.msg_type, parentId: item.parent_id, rootId: item.root_id,
    senderType: sender.sender_type, senderOpenId: sender.id_type === 'open_id' ? sender.id : '', senderAppId: sender.id_type === 'app_id' ? sender.id : '',
    createdAt: item.create_time });
  const body = messageBodyText(item);
  const extra = [];
  if (cardJson && item.msg_type === 'interactive') {
    let raw = '';
    try { raw = (await chat.getMessage({ messageId: parentId, cardContentType: 'user_card_content', timeoutMs: REPLY_FETCH_TIMEOUT_MS }))?.items?.[0]?.body?.content || ''; }
    catch (error) { observe(error?.code || 'reply_fetch_failed', 'card_json'); }
    let compact = '';
    try { compact = raw ? JSON.stringify(JSON.parse(raw)) : ''; } catch { compact = ''; }
    if (!compact && raw) observe('reply_card_json_invalid', 'card_json');
    extra.push('【被回复卡片 JSON】', quote(compact ? truncate(compact, maxChars) : '卡片 JSON 不可得'));
  }
  return segment(metadata, body ? truncate(body, maxChars) : '（无可见文本）', extra);
}
