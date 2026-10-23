import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { canDeliverOutboxAttachments } from '../../agents/codex/outbox-policy.mjs';
import { adaptLocalMarkdownImages, referencedCollectedLocalImages } from './markdown-images.mjs';
import { textReplyFor } from '../../core/reply-mode.mjs';

const stableEventKey = value => createHash('sha1').update(String(value || '')).digest('hex').slice(0, 24);
const MENTIONS = /<at (?:user_id|open_id)="[^"]*"><\/at>|@\{[^}]*\}/g;
// Text mode accepts every common at spelling, with or without quotes and a
// display name: <at user_id="ou_x">Name</at>, <at id=ou_x></at>, @{ou_x}.
const TEXT_MODE_MENTIONS = /<at\s+(?:id|user_id|open_id)\s*=\s*["']?[A-Za-z0-9_-]+["']?\s*>[^<\n]*<\/at>|@\{[^}\n]*\}/g;
// Any open_id left in text mode output (an unparsable tag, a bare ID) is masked.
const OPEN_ID_TEXT = /(?<![A-Za-z0-9_-])ou_[A-Za-z0-9_-]{8,}/g;
const MASKED_MEMBER = '@成员';
const FAILURE_LINE_MAX_CHARS = 200;
// Feishu reply rejections that mean the triggering message is gone; only these
// fall back to a new chat message. 230011: "The message is recalled."
const REPLY_TARGET_GONE_CODES = new Set([230011]);
export function createFeishuReplies({ chat, outbound, sendAttachment, jobs, inbound, botOpenId, connectionId, workspace, allowedGroupChatIds = new Set(), mentionAllGroupChatIds = new Set(), replyAsPost = true, maxOutputChars = 3500, replyPolicy = () => null, log = () => {} } = {}) {
  async function recordSent(job, messageId, messageType) {
    if (!messageId || !inbound?.recordReply || !botOpenId) return;
    try {
      await inbound.recordReply({ messageId, chatId: job.chatId, chatType: job.chatType,
        messageType, senderOpenId: botOpenId });
    } catch (error) {
      log('warning', 'forward_reply', 'record_failed', { code: error?.code || 'outbound_message_record_failed' });
    }
  }
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
    if (job.sourceMessageId && textReplyFor(job, result, replyPolicy)) return sendTextReply(job, result, control);
    const chunkSize = replyAsPost ? 3000 : 1900;
    const answer = adaptLocalMarkdownImages(result.answer, result.attachments, { workspace });
    const chunks = chunkText(limitText(answer || 'Codex 没有返回可用结论。', maxOutputChars), chunkSize);
    const prefix = codexReplyUuidPrefix(job, result);
    const sent = [];
    for (const [index, chunk] of chunks.entries()) {
      control.assertLease();
      const post = markdownToFeishuPost(chunk, { allowMentionAll: job.chatType === 'group' && mentionAllGroupChatIds.has(job.chatId) });
      const kind = replyAsPost || post.zh_cn.content.some(line => line.some(element => element.tag === 'at')) ? 'post' : 'text';
      const content = kind === 'post' ? post : { text: chunk };
      const response = await chat.sendMessage({ conversationId: job.chatId, kind, content,
        uuid: stableEventKey(`${prefix}:${kind}:${index}`) });
      const messageId = response?.message_id || response?.messageId || '';
      await recordSent(job, messageId, kind);
      sent.push({ messageId, msgType: kind, text: chunk, content: JSON.stringify(content) });
    }
    return { sent: sent.length, status: 'sent', items: sent };
  }

  // Group text mode: every message replies to the triggering message (no
  // thread). A completed answer uses text for one plain line and post for
  // anything with mentions, line breaks or Markdown; a failure is one short
  // text line. Only a reply rejected because the trigger is gone is sent to
  // the chat instead; each failed message logs one warning.
  async function sendTextReply(job, result, control) {
    const prefix = codexReplyUuidPrefix(job, result);
    const failed = result.failed === true || ['failed', 'interrupted'].includes(result.turnStatus || result.execution?.terminal);
    let messages;
    if (failed) {
      const text = maskOpenIds(failureLine(result.answer));
      messages = [{ kind: 'text', content: { text }, text }];
    } else {
      const answer = adaptLocalMarkdownImages(result.answer, result.attachments, { workspace });
      const allowMentionAll = mentionAllGroupChatIds.has(job.chatId);
      messages = chunkText(limitText(answer || 'Codex 没有返回可用结论。', maxOutputChars), 3000, TEXT_MODE_MENTIONS).map(chunk => {
        const post = markdownToFeishuPost(chunk, { allowMentionAll, textMode: true });
        return plainLine(chunk, post) ? { kind: 'text', content: { text: maskOpenIds(chunk) }, text: chunk } : { kind: 'post', content: post, text: chunk };
      });
    }
    const sent = [];
    for (const [index, message] of messages.entries()) {
      control.assertLease();
      const { kind, content } = message;
      let response;
      try {
        response = await chat.replyMessage({ messageId: job.sourceMessageId, kind, content, replyInThread: false,
          uuid: stableEventKey(`${prefix}:reply:${kind}:${index}`) });
      } catch (error) {
        const gone = error?.outcome === 'failed' && error?.code === 'feishu_api_rejected' && REPLY_TARGET_GONE_CODES.has(error?.platformCode);
        if (!gone) {
          if (error?.outcome === 'failed') logReplyFailure(job, error, 'reply');
          throw error;
        }
        try {
          control.assertLease();
          response = await chat.sendMessage({ conversationId: job.chatId, kind, content,
            uuid: stableEventKey(`${prefix}:reply-create:${kind}:${index}`) });
        } catch (createError) {
          if (createError?.code !== 'forward_lease_lost') logReplyFailure(job, createError, 'create', error.platformCode);
          throw createError;
        }
        log('warning', 'forward_reply', 'reply_rejected', { code: 'reply_target_gone', runId: job.id, platformCode: error.platformCode });
      }
      const messageId = response?.message_id || response?.messageId || '';
      await recordSent(job, messageId, kind);
      sent.push({ messageId, msgType: kind, text: message.text, content: JSON.stringify(content) });
    }
    return { sent: sent.length, status: 'sent', items: sent };
  }

  function logReplyFailure(job, error, stage, replyPlatformCode) {
    log('warning', 'forward_reply', 'reply_failed', { code: typeof error?.code === 'string' ? error.code : 'reply_delivery_failed', stage, runId: job.id,
      ...(Number.isInteger(error?.platformCode) ? { platformCode: error.platformCode } : {}),
      ...(Number.isInteger(replyPlatformCode) ? { replyPlatformCode } : {}) });
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

  async function reportAttachmentFailures(job, result, attachments, control) {
    const paths = Array.isArray(result.attachments) ? result.attachments : [];
    const referenced = referencedCollectedLocalImages(result.answer, paths, { workspace });
    const failed = attachments.filter(item => item.status === 'failed' && referenced.has(paths[item.index]));
    if (!failed.length) return 0;
    const lines = failed.map(() => '图片未能发送。');
    try {
      control.assertLease();
      const kind = replyAsPost ? 'post' : 'text';
      const content = replyAsPost ? markdownToFeishuPost(lines.join('\n')) : { text: lines.join('\n') };
      await chat.sendMessage({ conversationId: job.chatId, kind, content,
        uuid: stableEventKey(`${codexReplyUuidPrefix(job, result)}:attachment-failures`) });
      return 1;
    } catch (error) {
      if (error?.code === 'forward_lease_lost') throw error;
      log('warning', 'forward_attachment', 'failed', { code: 'attachment_failure_notice_failed' });
      return 0;
    }
  }

  return Object.freeze({
    prepare,
    async deliver(job, result, { skipText = false, signal, assertLease = () => {} } = {}) {
      if (signal?.aborted) throw Object.assign(new Error('forward_lease_lost'), { code: 'forward_lease_lost' });
      const control = { signal, assertLease };
      const text = skipText ? { sent: 0, status: 'sent' } : await sendText(job, result, control);
      const attachments = await sendAttachments(job, result, control);
      const failureMessages = await reportAttachmentFailures(job, result, attachments, control);
      const statuses = [text.status, ...attachments.map(item => item.status)];
      const status = statuses.some(value => value === 'unknown') ? 'unknown'
        : text.status === 'failed' ? 'failed' : 'sent';
      log(status === 'sent' ? 'info' : 'warning', 'forward_reply', status === 'sent' ? 'succeeded' : status,
        { attachments: attachments.filter(item => ['sent', 'cleaned'].includes(item.status)).length });
      return { messages: text.sent + failureMessages, attachments, status };
    },
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

// textMode (group text replies) also converts mentions inside code, accepts
// every at spelling with an optional display name and masks any open_id left
// in text. The default conversion is the original fallback-reply format.
export function markdownToFeishuPost(markdown, { allowMentionAll = false, textMode = false } = {}) {
  const content = [];
  let inCodeBlock = false;
  for (const rawLine of String(markdown || '').split(/\r?\n/)) {
    const isCodeLine = inCodeBlock || /^\s*```/.test(rawLine);
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
    content.push(markdownInlineToFeishuElements(line, { allowMentionAll, allowMentions: textMode || !isCodeLine, textMode }));
  }
  const lines = content.length ? content : [[{ tag: 'text', text: '' }]];
  return { zh_cn: { title: '', content: textMode ? lines.map(line => line.map(maskElement)) : lines } };
}

function normalizeMarkdownLine(line) {
  return String(line || '')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function mentionElements(text, { allowMentionAll, allowMentions, textMode = false }) {
  if (!allowMentions) return [{ tag: 'text', text }];
  const elements = [];
  const pattern = textMode ? /<at\s+(id|user_id|open_id)\s*=\s*["']?([A-Za-z0-9_-]+)["']?\s*>([^<\n]*)<\/at>|@\{([^}\n]*)\}/g
    : /<at (user_id|open_id)="([^"]*)"><\/at>|@\{([^}]*)\}/g;
  const validId = textMode ? /^ou_[A-Za-z0-9_-]+$/ : /^ou_[a-z0-9]+$/;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const id = textMode ? match[2] ?? match[4] : match[2] ?? match[3];
    if (!validId.test(id) && !(allowMentionAll && match[1] === 'user_id' && id === 'all')) continue;
    if (match.index > index) elements.push({ tag: 'text', text: text.slice(index, match.index) });
    const label = textMode ? String(match[3] ?? '').trim() : '';
    const name = label.search(OPEN_ID_TEXT) === -1 ? label : '';
    elements.push(name ? { tag: 'at', user_id: id, user_name: name } : { tag: 'at', user_id: id });
    index = match.index + match[0].length;
  }
  if (index < text.length) elements.push({ tag: 'text', text: text.slice(index) });
  return elements.length ? elements : [{ tag: 'text', text }];
}

function markdownInlineToFeishuElements(line, options) {
  const elements = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let index = 0;
  let match;
  while ((match = pattern.exec(line))) {
    if (match.index > index) elements.push(...mentionElements(line.slice(index, match.index), options));
    elements.push({ tag: 'a', text: match[1], href: match[2] });
    index = pattern.lastIndex;
  }
  if (index < line.length) elements.push(...mentionElements(line.slice(index), options));
  return elements.length ? elements : [{ tag: 'text', text: line }];
}

function chunkText(text, size, pattern = MENTIONS) {
  const chunks = [];
  const mentions = new RegExp(pattern.source, 'g');
  for (let index = 0; index < text.length;) {
    let end = Math.min(index + size, text.length);
    mentions.lastIndex = index;
    let match;
    while ((match = mentions.exec(text)) && match.index < end) {
      if (match.index + match[0].length > end && match.index > index) {
        end = match.index;
        break;
      }
    }
    chunks.push(text.slice(index, end));
    index = end;
  }
  return chunks.length ? chunks : [''];
}

function maskOpenIds(text) {
  return String(text).replace(OPEN_ID_TEXT, MASKED_MEMBER);
}

function maskElement(element) {
  return ['text', 'a'].includes(element.tag) && typeof element.text === 'string' ? { ...element, text: maskOpenIds(element.text) } : element;
}

// One plain line that a text message shows exactly as the post would.
function plainLine(chunk, post) {
  const lines = post.zh_cn.content;
  return lines.length === 1 && lines[0].length === 1 && lines[0][0].tag === 'text' && lines[0][0].text === chunk
    && chunk.trim() !== '' && !chunk.includes('<at');
}

function failureLine(answer) {
  const line = String(answer || '').replace(/\s+/g, ' ').trim() || '执行未完成，请稍后重试。';
  const chars = Array.from(line);
  return chars.length <= FAILURE_LINE_MAX_CHARS ? line : `${chars.slice(0, FAILURE_LINE_MAX_CHARS - 1).join('')}…`;
}

function limitText(text, max = 12000) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[已截断 ${value.length - max} 字符]`;
}
