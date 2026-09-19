import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

const labels = { image: '图片', file: '文件', audio: '语音', video: '视频', sticker: '表情包', share_chat: '群名片', share_user: '用户名片', other: '其他消息' };
const extensions = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/bmp': '.bmp', 'image/heic': '.heic', 'image/heif': '.heif', 'application/pdf': '.pdf',
  'text/csv': '.csv', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'video/mp4': '.mp4',
};
const reasons = {
  over_limit: '超过 32 MiB 下载上限', sticker_not_downloadable: '表情包无法下载',
  download_error: '下载失败', media_disabled: '媒体下载已关闭', not_downloadable: '该附件无可下载的资源',
};
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const fileTypes = { '.pdf': 'pdf', '.doc': 'doc', '.xls': 'xls', '.ppt': 'ppt', '.mp4': 'mp4', '.opus': 'opus' };

export function resolveMediaInboxDir(value, root) {
  const raw = String(value || '').trim();
  if (!raw) return join(root, 'data', 'feishu-inbox');
  return isAbsolute(raw) ? raw : resolve(root, raw);
}
function safeJson(value) { try { return JSON.parse(value || '{}') || {}; } catch { return {}; } }
function safeSegment(value, fallback) { return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^_+|_+$/g, '') || fallback; }
function walkPost(node, visit) {
  if (Array.isArray(node)) { for (const item of node) walkPost(item, visit); return; }
  if (!node || typeof node !== 'object') return;
  visit(node);
  if (node.content) walkPost(node.content, visit);
  if (node.post) walkPost(node.post, visit);
}
export function extractPostImageKeys(event) {
  if (event.message?.kind !== 'post') return [];
  const content = safeJson(event.message.content);
  const out = [];
  walkPost(content.post || content.content || content, node => {
    if (node.tag === 'img' && typeof node.image_key === 'string' && node.image_key && !out.includes(node.image_key)) out.push(node.image_key);
  });
  return out;
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
  try {
    const content = JSON.parse(event.message.content || '{}');
    if (typeof content.text === 'string') return content.text;
    const postText = stringifyPostContent(content.post || content.content);
    if (postText) return [content.title, postText].filter(Boolean).join('\n');
  } catch { return event.message.content || ''; }
  return '';
}

function baseAttachment(index, kind, messageType, values = {}) {
  return { index, kind, messageType, fileKey: null, fileName: null, durationMs: null, refId: null, raw: null,
    status: 'skipped', path: null, bytes: null, reason: 'not_downloadable', ...values };
}
function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function directAttachments(event, content) {
  const type = event.message?.kind || '';
  if (type === 'text' || type === 'post') return [];
  if (type === 'image') return [baseAttachment(1, 'image', type, { fileKey: content.image_key || content.file_key || null })];
  if (type === 'file') return [baseAttachment(1, 'file', type, { fileKey: content.file_key || null, fileName: content.file_name || null })];
  if (type === 'audio') return [baseAttachment(1, 'audio', type, { fileKey: content.file_key || null, fileName: content.file_name || null, durationMs: nullableNumber(content.duration) })];
  if (type === 'media') return [baseAttachment(1, 'video', type, { fileKey: content.file_key || null, fileName: content.file_name || null, durationMs: nullableNumber(content.duration) })];
  if (type === 'sticker') return [baseAttachment(1, 'sticker', type, { fileKey: content.file_key || content.image_key || null, reason: 'sticker_not_downloadable' })];
  if (type === 'share_chat') return [baseAttachment(1, 'share_chat', type, { refId: content.chat_id || null })];
  if (type === 'share_user') return [baseAttachment(1, 'share_user', type, { refId: content.user_id || content.open_id || null })];
  return [baseAttachment(1, 'other', type, { raw: event.message?.content ?? '' })];
}
function postAttachments(event, content) {
  const attachments = [];
  walkPost(content.post || content.content || content, node => {
    const index = attachments.length + 1;
    if (node.tag === 'img') attachments.push(baseAttachment(index, 'image', 'img', { fileKey: node.image_key || null, fileName: node.file_name || null }));
    if (node.tag === 'file') attachments.push(baseAttachment(index, 'file', 'file', { fileKey: node.file_key || null, fileName: node.file_name || null }));
    if (node.tag === 'media') attachments.push(baseAttachment(index, 'video', 'media', { fileKey: node.file_key || null, fileName: node.file_name || null,
      durationMs: nullableNumber(node.duration) }));
  });
  return attachments;
}
function downloadType(attachment) { return attachment.kind === 'image' ? 'image' : 'file'; }
function isDownloadable(attachment) { return ['image', 'file', 'audio', 'video'].includes(attachment.kind) && Boolean(attachment.fileKey); }
function failureReason(error) {
  if (error?.code === 'media_too_large') return 'over_limit';
  if (Number.isInteger(error?.platformCode)) return `feishu_${error.platformCode}`;
  return 'download_error';
}
function humanReason(reason) {
  if (reasons[reason]) return reasons[reason];
  if (/^feishu_-?\d+$/.test(reason || '')) return `飞书返回错误 ${reason.slice(7)}`;
  return reasons.download_error;
}
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
function renderAttachment(attachment, total) {
  let line = `【附件 ${attachment.index}/${total}】${labels[attachment.kind]}`;
  if (attachment.fileName) line += ` ${attachment.fileName}`;
  line += ` （类型 ${attachment.messageType}`;
  if (attachment.durationMs !== null) line += `，时长 ${attachment.durationMs / 1000} 秒`;
  if (attachment.refId) line += `，${attachment.refId}`;
  if (attachment.status === 'downloaded') line += `，${formatBytes(attachment.bytes)}，已下载：${attachment.path}`;
  else line += `，未能下载：${humanReason(attachment.reason)}`;
  line += '）';
  if (attachment.kind === 'other') line += `\n${attachment.raw}`;
  return line;
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

export async function createFeishuMedia({ chat, inboxDir, enabled = true, maxBytes = 32 * 1024 * 1024, downloadTimeoutMs = 120000, log = () => {} } = {}) {
  if (!chat?.downloadResource || !isAbsolute(inboxDir || '') || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024
    || !Number.isSafeInteger(downloadTimeoutMs) || downloadTimeoutMs < 1 || downloadTimeoutMs > 120000) throw new Error('invalid_media_config');
  async function download(event, attachment, runId) {
    const dir = join(inboxDir, safeSegment(event.conversationId, 'chat'), safeSegment(event.messageId, 'msg'));
    await mkdir(dir, { recursive: true });
    const resource = await chat.downloadResource({ messageId: event.messageId, fileKey: attachment.fileKey, type: downloadType(attachment),
      maxBytes, timeoutMs: downloadTimeoutMs });
    const candidateExtension = extname(attachment.fileName || '');
    const namedExtension = /^\.[A-Za-z0-9]{1,16}$/.test(candidateExtension) ? candidateExtension : '';
    const contentType = String(resource.contentType || '').split(';')[0].trim().toLowerCase();
    const extension = namedExtension || extensions[contentType] || '.bin';
    const path = join(dir, `${safeSegment(attachment.fileKey, 'attachment')}${extension}`);
    const temporary = `${path}.${safeSegment(runId, 'run')}.part`;
    try {
      await pipeline(resource.stream, createWriteStream(temporary, { flags: 'wx' }));
      const info = await stat(temporary);
      if (info.size > maxBytes) throw Object.assign(new Error('media_too_large'), { code: 'media_too_large' });
      await rename(temporary, path);
      return { ...attachment, status: 'downloaded', path, bytes: info.size, reason: null };
    } catch (error) { await rm(temporary, { force: true }); throw error; }
  }
  return Object.freeze({
    async prepare(event, { runId = 'run' } = {}) {
      const text = extractMessageText(event);
      const content = safeJson(event.message?.content);
      let attachments = event.message?.kind === 'post' ? postAttachments(event, content) : directAttachments(event, content);
      if (event.conversationType !== 'p2p') attachments = [];
      const prepared = [];
      for (const attachment of attachments) {
        if (!isDownloadable(attachment)) prepared.push(attachment);
        else if (!enabled) prepared.push({ ...attachment, status: 'skipped', reason: 'media_disabled' });
        else {
          try { prepared.push(await download(event, attachment, runId)); }
          catch (error) {
            const reason = failureReason(error);
            log('warning', 'media_prepare', 'failed', { code: reason, attachmentIndex: attachment.index });
            prepared.push({ ...attachment, status: 'failed', reason });
          }
        }
      }
      attachments = prepared;
      return { status: 'ready', text, addendum: attachments.map(item => renderAttachment(item, attachments.length)).join('\n'), attachments };
    },
    async release() {},
  });
}
