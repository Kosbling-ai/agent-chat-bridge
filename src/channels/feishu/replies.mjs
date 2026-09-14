import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { canDeliverOutboxAttachments } from '../../agents/codex/outbox-policy.mjs';

const stableEventKey = value => createHash('sha1').update(String(value || '')).digest('hex').slice(0, 24);
const imageTypes = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export function publicAttachments(attachments = []) {
  return attachments.map((value, index) => {
    const path = typeof value === 'string' ? value : value?.filePath;
    const fileName = value?.fileName || basename(path || `attachment-${index}`);
    return {
      id: String(index), fileName,
      size: Number(value?.size || 0) || null,
      kind: value?.kind || (imageTypes.has(extname(fileName).toLowerCase()) ? 'image' : 'file'),
    };
  });
}

export function createFeishuReplies({ chat, outbound, sendAttachment, jobs, connectionId, allowedGroupChatIds = new Set(), replyAsPost = true, maxOutputChars = 3500, log = () => {} } = {}) {
  function artifactScope(job, result = job.result || {}) {
    const execution = result.execution || job.result?.execution || {};
    return {
      connectionId, conversationId: job.chatId, runId: job.id,
      conversationType: job.chatType, bindingOpenId: execution.bindingOpenId,
      sinceMs: Number(execution.startedAt || job.startedAt || job.createdAt),
    };
  }

  async function prepare(job, result) {
    if (job.deliveryMode !== 'caller' || !outbound || result.delivery?.artifactsPrepared) return result;
    const prepared = await outbound.prepare(artifactScope(job, result));
    const previous = new Map((result.delivery?.attachments || []).map(item => [item.artifactId, item]));
    const attachments = prepared.artifacts.map(artifact => ({
      artifactId: artifact.ref.artifactId,
      ...(previous.get(artifact.ref.artifactId) || { status: 'pending' }),
    }));
    const value = {
      ...result,
      attachments: prepared.artifacts,
      attachmentFailures: prepared.failures,
      attachmentsOmitted: prepared.omitted,
      delivery: { ...(result.delivery || {}), artifactsPrepared: true, attachments },
    };
    await jobs.patchReplyResult({ id: job.id, leaseOwner: job.leaseOwner, result: value });
    job.result = value;
    return value;
  }

  async function sendText(job, result, control) {
    const previous = job.result?.delivery?.text?.items || result.delivery?.text?.items;
    if (previous?.length) {
      if (previous.some(item => ['intent', 'unknown', 'pending'].includes(item.status))) return { sent: 0, status: 'unknown' };
      return { sent: previous.filter(item => item.status === 'sent').length,
        status: previous.some(item => item.status === 'failed') ? 'failed' : 'sent' };
    }
    const kind = replyAsPost ? 'post' : 'text';
    const chunkSize = replyAsPost ? 3000 : 1900;
    const chunks = chunkText(limitText(String(result.answer || 'Codex 没有返回可用结论。'), maxOutputChars), chunkSize);
    const prefix = codexReplyUuidPrefix(job, result);
    const sent = [];
    for (const [index, chunk] of chunks.entries()) {
      control.assertLease();
      const content = replyAsPost ? markdownToFeishuPost(chunk) : { text: chunk };
      const response = await chat.sendMessage({ conversationId: job.chatId, kind, content,
        uuid: stableEventKey(`${prefix}:${kind}:${index}`) });
      sent.push({ messageId: response?.message_id || response?.messageId || '', msgType: kind, text: chunk, content: JSON.stringify(content) });
    }
    return { sent: sent.length, status: 'sent', items: sent };
  }

  async function sendAttachments(job, result, control) {
    const legacy = job.result?.delivery?.attachments || result.delivery?.attachments || [];
    if (legacy.some(item => ['upload_intent', 'send_intent', 'unknown'].includes(item.status))) {
      return legacy.map((item, index) => ({ ...item, index, status: 'unknown' }));
    }
    const paths = Array.isArray(result.attachments) ? result.attachments.filter(value => typeof value === 'string' && value) : [];
    if (!paths.length || !sendAttachment) return [];
    if (!canDeliverOutboxAttachments({ chatType: job.chatType, chatId: job.chatId, allowedGroupChatIds })) {
      log('warning', 'forward_attachment', 'skipped', { code: 'attachment_conversation_not_allowed', attachments: paths.length });
      return [];
    }
    const prefix = codexReplyUuidPrefix(job, result);
    const facts = [];
    for (const [index, filePath] of paths.entries()) {
      try {
        control.assertLease();
        const response = await sendAttachment({ chatId: job.chatId, filePath,
          uuid: stableEventKey(`${prefix}:file:${index}`), maxBytes: 28 * 1024 * 1024 });
        await unlink(filePath).catch(() => log('warning', 'forward_attachment', 'cleanup_failed', { code: 'attachment_cleanup_failed' }));
        facts.push({ index, fileName: basename(filePath), messageId: response?.messageId || '', status: 'sent' });
      } catch (error) {
        if (error?.code === 'forward_lease_lost') throw error;
        log('warning', 'forward_attachment', 'failed', { code: error?.code || 'attachment_send_failed' });
        facts.push({ index, fileName: basename(filePath), status: 'failed', errorCode: error?.code || 'attachment_send_failed' });
      }
    }
    return facts;
  }

  return Object.freeze({
    prepare,
    async deliver(job, result, { skipText = false, signal, assertLease = () => {} } = {}) {
      if (signal?.aborted) throw Object.assign(new Error('forward_lease_lost'), { code: 'forward_lease_lost' });
      const control = { signal, assertLease };
      const text = skipText ? { sent: 0, status: 'sent' } : await sendText(job, result, control);
      const attachments = await sendAttachments(job, result, control);
      const statuses = [text.status, ...attachments.map(item => item.status)];
      const status = statuses.some(value => value === 'unknown') ? 'unknown'
        : text.status === 'failed' ? 'failed' : 'sent';
      log(status === 'sent' ? 'info' : 'warning', 'forward_reply', status === 'sent' ? 'succeeded' : status,
        { attachments: attachments.filter(item => ['sent', 'cleaned'].includes(item.status)).length });
      return { messages: text.sent, attachments, status };
    },
    async readResource(job, index) {
      const artifact = (job.result?.attachments || [])[index];
      if (!artifact?.ref || !outbound) return null;
      return outbound.read({ scope: artifactScope(job), ref: artifact.ref });
    },
    publicAttachments,
  });
}

function codexReplyUuidPrefix(job, result = {}) {
  return stableEventKey([
    'codex-reply',
    job.messageId || '',
    result.turnId || result.execution?.turnId || '',
    result.threadId || result.sessionId || result.execution?.threadId || '',
  ].join(':'));
}

export function markdownToFeishuPost(markdown) {
  const content = [];
  let inCodeBlock = false;
  for (const rawLine of String(markdown || '').split(/\r?\n/)) {
    if (/^\s*```/.test(rawLine)) {
      inCodeBlock = !inCodeBlock;
      content.push([{ tag: 'text', text: rawLine || '```' }]);
      continue;
    }
    const line = inCodeBlock ? rawLine : normalizeMarkdownLine(rawLine);
    if (!line.trim()) {
      content.push([{ tag: 'text', text: ' ' }]);
      continue;
    }
    content.push(markdownInlineToFeishuElements(line));
  }
  return { zh_cn: { title: '', content: content.length ? content : [[{ tag: 'text', text: '' }]] } };
}

function normalizeMarkdownLine(line) {
  return String(line || '')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function markdownInlineToFeishuElements(line) {
  const elements = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let index = 0;
  let match;
  while ((match = pattern.exec(line))) {
    if (match.index > index) elements.push({ tag: 'text', text: line.slice(index, match.index) });
    elements.push({ tag: 'a', text: match[1], href: match[2] });
    index = pattern.lastIndex;
  }
  if (index < line.length) elements.push({ tag: 'text', text: line.slice(index) });
  return elements.length ? elements : [{ tag: 'text', text: line }];
}

function chunkText(text, size) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size));
  return chunks.length ? chunks : [''];
}

function limitText(text, max = 12000) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[已截断 ${value.length - max} 字符]`;
}
