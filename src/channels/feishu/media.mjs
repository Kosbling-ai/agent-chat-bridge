import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

const labels = { image: '图片', file: '文件', media: '视频', audio: '语音', sticker: '表情', share_chat: '群名片', share_user: '用户名片', merge_forward: '合并转发消息' };
const mediaTypes = new Set(['image', 'file', 'media', 'audio', 'sticker', 'share_chat', 'share_user']);
const extensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp', 'image/heic': '.heic', 'image/heif': '.heif' };
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const fileTypes = { '.pdf': 'pdf', '.doc': 'doc', '.xls': 'xls', '.ppt': 'ppt', '.mp4': 'mp4', '.opus': 'opus' };

export function resolveMediaInboxDir(value, root) {
  const raw = String(value || '').trim();
  if (!raw) return join(root, 'data', 'feishu-inbox');
  return isAbsolute(raw) ? raw : resolve(root, raw);
}
function safeJson(value) { try { return JSON.parse(value || '{}') || {}; } catch { return {}; } }
function safeSegment(value, fallback) { return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^_+|_+$/g, '') || fallback; }
function collectImages(node, out) {
  if (Array.isArray(node)) { for (const item of node) collectImages(item, out); return; }
  if (node && typeof node === 'object') {
    if (node.tag === 'img' && typeof node.image_key === 'string' && node.image_key) out.add(node.image_key);
    if (node.content) collectImages(node.content, out);
    if (node.post) collectImages(node.post, out);
  }
}
export function extractPostImageKeys(event) {
  if (event.message?.kind !== 'post') return [];
  const content = safeJson(event.message.content);
  const out = new Set(); collectImages(content.post || content.content || content, out); return [...out];
}
export function stringifyPostContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) { const rows = value.map(item => stringifyPostContent(item)).filter(Boolean); return value.some(Array.isArray) ? rows.join('\n') : rows.join(''); }
  if (value && typeof value === 'object') {
    if (typeof value.href === 'string' && value.href) { const text = typeof value.text === 'string' ? value.text.trim() : ''; return text && text !== value.href ? `${text} (${value.href})` : value.href; }
    if (typeof value.text === 'string') return value.text;
    return stringifyPostContent(value.content || value.post);
  }
  return '';
}
export function extractMessageText(event) {
  if (!['text', 'post'].includes(event.message?.kind)) return '';
  const content = safeJson(event.message.content);
  if (typeof content.text === 'string') return content.text;
  const text = stringifyPostContent(content.post || content.content); return [content.title, text].filter(Boolean).join('\n');
}
export function unsupportedReply(type, template) {
  return String(template || '暂不支持处理「{{type}}」类型的附件，请改用文字、图片或飞书云文档链接。').replaceAll('{{type}}', labels[type] || '该');
}

export async function sendOutboundAttachment({ client, chatId, filePath, uuid = '', maxBytes = 0 } = {}) {
  if (!chatId || !filePath) throw new Error('invalid_outbound_attachment');
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error('invalid_outbound_attachment');
  if (maxBytes && info.size > maxBytes) throw new Error('attachment_too_large');
  const ext = extname(filePath).toLowerCase();
  let kind; let content;
  if (imageExtensions.has(ext)) {
    const response = await client.im.v1.image.create({ data: { image_type: 'message', image: createReadStream(filePath) } });
    const imageKey = response?.image_key || response?.data?.image_key;
    if (!imageKey) throw new Error('attachment_upload_unconfirmed');
    kind = 'image'; content = { image_key: imageKey };
  } else {
    const response = await client.im.v1.file.create({ data: { file_type: fileTypes[ext] || 'stream', file_name: basename(filePath), file: createReadStream(filePath) } });
    const fileKey = response?.file_key || response?.data?.file_key;
    if (!fileKey) throw new Error('attachment_upload_unconfirmed');
    kind = 'file'; content = { file_key: fileKey };
  }
  const sent = await client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: {
    receive_id: chatId, msg_type: kind, content: JSON.stringify(content), ...(uuid ? { uuid } : {}),
  } });
  return { ok: true, messageId: sent?.data?.message_id || sent?.message_id || '' };
}
function addendum(paths) {
  if (paths.length === 1) return `（用户发来一张图片，已下载到 ${paths[0]}）`;
  return `（用户发来 ${paths.length} 张图片，已下载到：\n${paths.map(path => `- ${path}`).join('\n')}）`;
}

export async function createFeishuMedia({ client, inboxDir, enabled = true, maxBytes = 20 * 1024 * 1024, unsupportedReplyText, log = () => {} } = {}) {
  if (!client?.im?.v1?.messageResource?.get || !isAbsolute(inboxDir || '') || !Number.isFinite(maxBytes) || maxBytes < 0) throw new Error('invalid_media_config');
  async function download(event, fileKey) {
    if (!fileKey) throw new Error('image_key_missing');
    const dir = join(inboxDir, safeSegment(event.conversationId, 'chat'), safeSegment(event.messageId, 'msg'));
    await mkdir(dir, { recursive: true });
    const response = await client.im.v1.messageResource.get({ params: { type: 'image' }, path: { message_id: event.messageId, file_key: fileKey } });
    const contentType = String(response?.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    const path = join(dir, `${safeSegment(fileKey, 'image')}${extensions[contentType] || '.jpg'}`);
    await response.writeFile(path);
    try { const info = await stat(path); if (maxBytes && info.size > maxBytes) log('warning', 'media_prepare', 'oversize', { code: 'media_advisory_limit_exceeded' }); }
    catch { /* The production size check is advisory. */ }
    return path;
  }
  const base = (event, status) => ({ status, text: extractMessageText(event), addendum: '', localPaths: [] });
  return Object.freeze({
    async prepare(event) {
      const type = event.message?.kind || ''; const p2p = event.conversationType === 'p2p';
      if (type === 'post') {
        if (!p2p || !enabled) return base(event, 'ready');
        const keys = extractPostImageKeys(event); if (!keys.length) return base(event, 'ready');
        try { const paths = []; for (const key of keys) paths.push(await download(event, key)); return { ...base(event, 'ready'), localPaths: paths, addendum: addendum(paths) }; }
        catch { log('warning', 'media_prepare', 'failed', { code: 'image_download_failed' }); return { ...base(event, 'failed'), reason: 'image_download_failed', replyText: '图片下载失败了，请稍后重试，或改用文字描述需要我处理的内容。' }; }
      }
      if (type === 'text') return base(event, 'ready');
      if (!mediaTypes.has(type)) return p2p ? { ...base(event, 'unsupported'), reason: 'unsupported_media', replyText: unsupportedReply(type, unsupportedReplyText) } : { ...base(event, 'ignored'), reason: 'group_media_ignored' };
      if (!p2p || !enabled) return { ...base(event, 'ignored'), reason: !p2p ? 'group_media_ignored' : 'media_disabled' };
      if (type === 'image') {
        try { const content = safeJson(event.message.content); const path = await download(event, content.image_key || content.file_key); return { ...base(event, 'ready'), localPaths: [path], addendum: addendum([path]) }; }
        catch { log('warning', 'media_prepare', 'failed', { code: 'image_download_failed' }); return { ...base(event, 'failed'), reason: 'image_download_failed', replyText: '图片下载失败了，请稍后重试，或改用文字描述需要我处理的内容。' }; }
      }
      if (['share_chat', 'share_user'].includes(type)) return { ...base(event, 'ready'), addendum: `（用户分享了一张${labels[type]}）` };
      return { ...base(event, 'unsupported'), reason: 'unsupported_media', replyText: unsupportedReply(type, unsupportedReplyText) };
    },
    async release() {},
  });
}
