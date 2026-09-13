import { createHash } from 'node:crypto';
import { createMediaFiles, MediaError } from './media-files.mjs';
import { safeObserver } from '../../logger.mjs';

// Ported from the old Feishu transport's extractText/stringifyPostContent.
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
export function stringifyPostContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const rows = value.map(item => stringifyPostContent(item)).filter(Boolean);
    return value.some(Array.isArray) ? rows.join('\n') : rows.join('');
  }
  if (value && typeof value === 'object') {
    if (typeof value.href === 'string' && value.href) {
      const linkText = typeof value.text === 'string' ? value.text.trim() : '';
      return linkText && linkText !== value.href ? `${linkText} (${value.href})` : value.href;
    }
    if (typeof value.text === 'string') return value.text;
    return stringifyPostContent(value.content || value.post);
  }
  return '';
}
function safeJson(value) { try { return JSON.parse(value || '{}') || {}; } catch { return {}; } }
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
  const out = new Set();
  collectImages(content.post || content.content || content, out);
  return [...out];
}
const extensions = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/bmp': '.bmp', 'image/heic': '.heic', 'image/heif': '.heif',
};
const labels = { image: '图片', file: '文件', media: '视频', audio: '语音', sticker: '表情', share_chat: '群名片', share_user: '用户名片', merge_forward: '合并转发消息' };
export function unsupportedReply(type) {
  return `暂不支持处理「${labels[type] || '该'}」类型的附件，请改用文字、图片或飞书云文档链接。`;
}
function addendum(paths) {
  if (paths.length === 1) return `（用户发来一张图片，已下载到 ${paths[0]}）`;
  return `（用户发来 ${paths.length} 张图片，已下载到：\n${paths.map(path => `- ${path}`).join('\n')}）`;
}

export async function createFeishuMedia({ chat, workspace, inboxDir, maxBytes = 20 * 1024 * 1024,
  maxImages = 9, maxTotalBytes = 128 * 1024 * 1024, timeoutMs = 15000, log = () => {} }) {
  if (!chat?.downloadResource || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20 * 1024 * 1024
    || !Number.isInteger(maxImages) || maxImages < 1 || maxImages > 9
    || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < maxBytes || maxTotalBytes > 1024 * 1024 * 1024
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new MediaError('invalid_media_config');
  const files = await createMediaFiles({ workspace, inboxDir, maxTotalBytes });
  log = safeObserver(log);
  return {
    async prepare(event, { runId, signal } = {}) {
      const text = extractMessageText(event);
      const result = status => ({ status, text, addendum: '', localPaths: [] });
      const type = event.message?.kind;
      const p2p = event.conversationType === 'p2p';
      if (!p2p && !['text', 'post'].includes(type)) return { ...result('ignored'), reason: 'group_media_ignored' };
      if (type === 'text' || (!p2p && type === 'post')) return result('ready');
      if (['share_chat', 'share_user'].includes(type)) return { ...result('ready'), addendum: `（用户分享了一张${labels[type]}）` };
      if (!['image', 'post'].includes(type)) return { ...result('unsupported'), reason: 'unsupported_media', replyText: unsupportedReply(type) };
      const keys = type === 'post' ? extractPostImageKeys(event) : [safeJson(event.message.content).image_key || safeJson(event.message.content).file_key];
      if (!keys.length) return result('ready');
      const started = Date.now();
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(abort, timeoutMs);
      log('info', 'media_prepare', 'started');
      try {
        if (keys.length > maxImages) throw new MediaError('media_too_many');
        if (!event.connectionId || !event.conversationId || !event.messageId || keys.some(key => typeof key !== 'string' || !key || key.length > 512)) throw new MediaError('invalid_media_resource');
        const identity = createHash('sha256').update(JSON.stringify([event.connectionId, event.conversationId, event.messageId, event.revision, keys])).digest('hex');
        const localPaths = await files.prepare({ runId, identity, resources: keys, maxBytes, signal: controller.signal,
          download: async key => {
            if (controller.signal.aborted) throw new MediaError('media_cancelled');
            let cancel;
            const cancelled = new Promise((_, reject) => { cancel = () => reject(new MediaError('media_cancelled')); });
            controller.signal.addEventListener('abort', cancel, { once: true });
            try {
              const request = Promise.resolve().then(() => chat.downloadResource({ messageId: event.messageId, fileKey: key, type: 'image' })).then(resource => {
                if (controller.signal.aborted) resource.stream?.destroy();
                return resource;
              });
              const resource = await Promise.race([request, cancelled]);
              const extension = extensions[String(resource.contentType || '').split(';')[0].trim().toLowerCase()];
              if (!extension) { resource.stream?.destroy(); throw new MediaError('media_mime_unsupported'); }
              return { stream: resource.stream, extension };
            } finally { controller.signal.removeEventListener('abort', cancel); }
          },
        });
        if (controller.signal.aborted) throw new MediaError('media_cancelled');
        log('info', 'media_prepare', 'succeeded', { durationMs: Date.now() - started });
        return { ...result('ready'), localPaths, addendum: addendum(localPaths) };
      } catch (error) {
        const reason = error instanceof MediaError ? error.code : 'image_download_failed';
        log('warning', 'media_prepare', 'failed', { code: reason, durationMs: Date.now() - started });
        return { ...result('failed'), reason, replyText: '图片下载失败了，请稍后重试，或改用文字描述需要我处理的内容。' };
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
    release: runId => files.release(runId),
  };
}
