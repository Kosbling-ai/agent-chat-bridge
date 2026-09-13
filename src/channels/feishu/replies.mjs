import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { splitReplyCards } from './reply-card.mjs';

const stable = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
const imageTypes = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const effectUnknown = code => Object.assign(new Error(code), { code, outcome: 'unknown' });

export function publicAttachments(attachments = []) {
  return attachments.map((value, index) => {
    const path = typeof value === 'string' ? value : value?.filePath;
    const fileName = value?.fileName || basename(path || `attachment-${index}`);
    return {
      id: value?.ref?.artifactId || String(index), fileName,
      size: Number(value?.size || 0) || null,
      kind: value?.kind || (imageTypes.has(extname(fileName).toLowerCase()) ? 'image' : 'file'),
    };
  });
}

export function createFeishuReplies({ chat, outbound, jobs, connectionId, log = () => {} } = {}) {
  function artifactScope(job, result = job.result || {}) {
    const execution = result.execution || job.result?.execution || {};
    return {
      connectionId, conversationId: job.chatId, runId: job.id,
      conversationType: job.chatType, bindingOpenId: execution.bindingOpenId,
      sinceMs: Number(execution.startedAt || job.startedAt || job.createdAt),
    };
  }

  async function persist(job, delivery) {
    await jobs.patchFeedback({ id: job.id, leaseOwner: job.leaseOwner, key: 'delivery', value: delivery });
    job.result = { ...job.result, delivery };
  }

  async function prepare(job, result) {
    if (!outbound || result.delivery?.artifactsPrepared) return result;
    const prepared = await outbound.prepare(artifactScope(job, result));
    const previous = new Map((result.delivery?.attachments || []).map(item => [item.artifactId, item]));
    const attachments = prepared.artifacts.map(artifact => ({
      artifactId: artifact.ref.artifactId,
      ...(previous.get(artifact.ref.artifactId) || { status: 'pending' }),
    }));
    return {
      ...result,
      attachments: prepared.artifacts,
      attachmentFailures: prepared.failures,
      attachmentsOmitted: prepared.omitted,
      delivery: { ...(result.delivery || {}), artifactsPrepared: true, attachments },
    };
  }

  async function sendText(job, result, control) {
    const cards = splitReplyCards(String(result.answer || 'Codex 没有返回可用结论。'));
    const delivery = structuredClone(job.result?.delivery || result.delivery || {});
    delivery.text ||= { items: cards.map((_, index) => ({ index, status: 'pending' })) };
    for (const [index, content] of cards.entries()) {
      const item = delivery.text.items[index] ||= { index, status: 'pending' };
      if (['sent', 'failed', 'unknown'].includes(item.status)) continue;
      item.status = 'intent';
      await persist(job, delivery);
      control.assertLease();
      const args = { kind: 'interactive', content, uuid: stable(`run:${job.id}:answer:${index}`) };
      try {
        const response = job.sourceMessageId
          ? await chat.replyMessage({ ...args, messageId: job.sourceMessageId })
          : await chat.sendMessage({ ...args, conversationId: job.chatId });
        item.status = 'sent';
        item.messageId = response?.message_id || response?.messageId || '';
      } catch (error) {
        item.status = error?.outcome === 'failed' ? 'failed' : 'unknown';
        item.errorCode = error?.code || 'reply_delivery_unknown';
      }
      await persist(job, delivery);
      if (item.status === 'unknown') throw effectUnknown(item.errorCode);
    }
    return delivery.text.items.filter(item => item.status === 'sent').length;
  }

  async function sendAttachments(job, result, control) {
    if (!outbound) return [];
    const scope = artifactScope(job, result);
    const delivery = structuredClone(job.result?.delivery || result.delivery || {});
    delivery.attachments ||= [];
    const facts = [];
    for (const [index, artifact] of (result.attachments || []).entries()) {
      const artifactId = artifact.ref?.artifactId;
      let item = delivery.attachments.find(value => value.artifactId === artifactId);
      if (!item) {
        item = { artifactId, status: 'pending' };
        delivery.attachments.push(item);
      }
      if (['cleaned', 'failed', 'unknown'].includes(item.status)) { facts.push({ ...item, index }); continue; }
      if (!item.uploadResult) {
        item.status = 'upload_intent';
        await persist(job, delivery);
        control.assertLease();
        try {
          item.uploadResult = await outbound.upload({ scope, ref: artifact.ref });
          item.status = 'uploaded';
        } catch (error) {
          item.status = error?.outcome === 'failed' ? 'failed' : 'unknown';
          item.errorCode = error?.code || 'attachment_upload_unknown';
        }
        await persist(job, delivery);
        if (['failed', 'unknown'].includes(item.status)) { facts.push({ ...item, index }); continue; }
      }
      if (!item.messageId) {
        item.status = 'send_intent';
        await persist(job, delivery);
        control.assertLease();
        try {
          const response = await outbound.send({ scope, ref: artifact.ref, uploadResult: item.uploadResult,
            uuid: stable(`run:${job.id}:attachment:${index}`) });
          item.messageId = response?.message_id || response?.messageId || '';
          if (!item.messageId) throw effectUnknown('attachment_send_unconfirmed');
          item.status = 'sent';
        } catch (error) {
          item.status = error?.outcome === 'failed' ? 'failed' : 'unknown';
          item.errorCode = error?.code || 'attachment_send_unknown';
        }
        await persist(job, delivery);
        if (['failed', 'unknown'].includes(item.status)) { facts.push({ ...item, index }); continue; }
      }
      control.assertLease();
      try {
        await outbound.cleanup({ scope, ref: artifact.ref, confirmedSent: true });
        item.status = 'cleaned';
        item.cleanedAt = Date.now();
        await persist(job, delivery);
      } catch (error) {
        item.status = 'cleanup_pending';
        item.errorCode = error?.code || 'attachment_cleanup_pending';
        await persist(job, delivery);
        throw error;
      }
      facts.push({ ...item, index });
    }
    return facts;
  }

  return Object.freeze({
    prepare,
    async deliver(job, result, { skipText = false, signal, assertLease = () => {} } = {}) {
      if (signal?.aborted) throw Object.assign(new Error('forward_lease_lost'), { code: 'forward_lease_lost' });
      const control = { signal, assertLease };
      const messages = skipText ? 0 : await sendText(job, result, control);
      const attachments = await sendAttachments(job, result, control);
      log('info', 'forward_reply', 'succeeded', { attachments: attachments.filter(item => item.status === 'cleaned').length });
      return { messages, attachments };
    },
    async readResource(job, index) {
      const artifact = (job.result?.attachments || [])[index];
      if (!artifact?.ref || !outbound) return null;
      return outbound.read({ scope: artifactScope(job), ref: artifact.ref });
    },
    publicAttachments,
  });
}
