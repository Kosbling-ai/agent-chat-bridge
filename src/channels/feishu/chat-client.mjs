import { Readable } from 'node:stream';

export class FeishuChatError extends Error {
  constructor(code, outcome, platformCode) {
    super(code); this.code = code; this.outcome = outcome;
    if (Number.isInteger(platformCode)) this.platformCode = platformCode;
  }
}
function required(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new FeishuChatError('invalid_chat_argument', 'failed');
  return value;
}
function page({ pageSize = 50, pageToken } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new FeishuChatError('invalid_page_size', 'failed');
  return { page_size: pageSize, ...(pageToken ? { page_token: required(pageToken) } : {}) };
}

// Exactly one SDK call per operation: the core owns retry and effect ledgers.
// Inject a client with a finite HTTP timeout and no transport retry interceptors.
export function createFeishuChatClient({ client, timeoutMs = 15000, maxMediaBytes = 20 * 1024 * 1024 }) {
  if (!client?.im?.v1 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
    || !Number.isSafeInteger(maxMediaBytes) || maxMediaBytes < 1 || maxMediaBytes > 100 * 1024 * 1024) throw new Error('invalid_feishu_chat_dependencies');
  const im = client.im.v1;
  async function call(resource, method, request, write = false, binary = false, uploadKey) {
    let timer;
    let expired = false;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => im[resource][method](request)).then((result) => {
          if (expired && binary) result?.getReadableStream?.()?.destroy?.();
          return result;
        }),
        new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('timeout')); }, timeoutMs); }),
      ]);
      if (binary) return result;
      // SDK upload methods already unwrap `res.data`, unlike message methods.
      if (uploadKey) {
        if (typeof result?.[uploadKey] !== 'string' || !result[uploadKey]) throw new FeishuChatError('feishu_upload_unconfirmed', 'unknown');
        return result;
      }
      if (result?.code !== 0) throw new FeishuChatError('feishu_api_rejected', write ? 'unknown' : 'failed', result?.code);
      return result.data;
    } catch (error) {
      if (error instanceof FeishuChatError) throw error;
      // A connection loss or timeout does not prove a write failed remotely.
      throw new FeishuChatError('feishu_transport_error', write ? 'unknown' : 'failed');
    } finally { clearTimeout(timer); }
  }
  function content(kind, value) {
    if (!['text', 'post', 'interactive', 'image', 'file'].includes(kind)) throw new FeishuChatError('unsupported_message_kind', 'failed');
    const encoded = typeof value === 'string' ? value : JSON.stringify(value);
    if (!encoded || Buffer.byteLength(encoded) > 30000) throw new FeishuChatError('invalid_message_content', 'failed');
    try { JSON.parse(encoded); } catch { throw new FeishuChatError('invalid_message_content', 'failed'); }
    return encoded;
  }
  function uuid(value) {
    required(value);
    if (value.length > 50) throw new FeishuChatError('invalid_message_uuid', 'failed');
    return value;
  }
  return {
    sendMessage({ conversationId, kind, content: body, uuid: effectId }) {
      return call('message', 'create', { params: { receive_id_type: 'chat_id' },
        data: { receive_id: required(conversationId), msg_type: kind, content: content(kind, body), uuid: uuid(effectId) } }, true);
    },
    replyMessage({ messageId, kind, content: body, uuid: effectId, replyInThread = false }) {
      if (typeof replyInThread !== 'boolean') throw new FeishuChatError('invalid_reply_in_thread', 'failed');
      return call('message', 'reply', { path: { message_id: required(messageId) },
        data: { msg_type: kind, content: content(kind, body), uuid: uuid(effectId), reply_in_thread: replyInThread } }, true);
    },
    getMessage({ messageId }) {
      return call('message', 'get', { path: { message_id: required(messageId) }, params: { user_id_type: 'open_id' } });
    },
    listMessages({ conversationId, pageSize, pageToken, startTime, endTime }) {
      for (const time of [startTime, endTime]) if (time !== undefined && !/^\d{1,13}$/.test(String(time))) throw new FeishuChatError('invalid_history_time', 'failed');
      return call('message', 'list', { params: { container_id_type: 'chat', container_id: required(conversationId),
        sort_type: 'ByCreateTimeAsc', ...page({ pageSize, pageToken }),
        ...(startTime !== undefined ? { start_time: String(startTime) } : {}), ...(endTime !== undefined ? { end_time: String(endTime) } : {}) } });
    },
    listMembers({ conversationId, pageSize, pageToken }) {
      return call('chatMembers', 'get', { path: { chat_id: required(conversationId) }, params: { member_id_type: 'open_id', ...page({ pageSize, pageToken }) } });
    },
    listReactions({ messageId, pageSize, pageToken }) {
      return call('messageReaction', 'list', { path: { message_id: required(messageId) }, params: { user_id_type: 'open_id', ...page({ pageSize, pageToken }) } });
    },
    addReaction({ messageId, emojiType }) {
      return call('messageReaction', 'create', { path: { message_id: required(messageId) }, data: { reaction_type: { emoji_type: required(emojiType) } } }, true);
    },
    removeReaction({ messageId, reactionId }) {
      return call('messageReaction', 'delete', { path: { message_id: required(messageId), reaction_id: required(reactionId) } }, true);
    },
    uploadImage({ bytes }) {
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > Math.min(maxMediaBytes, 10 * 1024 * 1024)) throw new FeishuChatError('invalid_media_bytes', 'failed');
      return call('image', 'create', { data: { image_type: 'message', image: bytes } }, true, false, 'image_key');
    },
    uploadFile({ bytes, fileName, fileType = 'stream' }) {
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > Math.min(maxMediaBytes, 30 * 1024 * 1024)) throw new FeishuChatError('invalid_media_bytes', 'failed');
      required(fileName);
      if (/[\\/\x00-\x1f]/.test(fileName)) throw new FeishuChatError('invalid_file_name', 'failed');
      if (!['stream', 'pdf', 'doc', 'xls', 'ppt', 'mp4', 'opus'].includes(fileType)) throw new FeishuChatError('invalid_file_type', 'failed');
      return call('file', 'create', { data: { file_type: fileType, file_name: fileName, file: bytes } }, true, false, 'file_key');
    },
    async downloadResource({ messageId, fileKey, type }) {
      if (!['image', 'file'].includes(type)) throw new FeishuChatError('invalid_resource_type', 'failed');
      const resource = await call('messageResource', 'get', { path: { message_id: required(messageId), file_key: required(fileKey) }, params: { type } }, false, true);
      const source = resource?.getReadableStream?.();
      if (!source?.[Symbol.asyncIterator] || typeof source.destroy !== 'function') throw new FeishuChatError('invalid_resource_stream', 'failed');
      const size = Number(resource.headers?.['content-length']);
      if (size > maxMediaBytes) { source.destroy(); throw new FeishuChatError('media_too_large', 'failed'); }
      // Stream with a byte cap and wall-clock deadline, never buffer unbounded data.
      const timer = setTimeout(() => source.destroy(new FeishuChatError('media_timeout', 'failed')), timeoutMs);
      const stream = Readable.from((async function* () {
        let total = 0;
        try {
          for await (const chunk of source) {
            total += Buffer.byteLength(chunk);
            if (total > maxMediaBytes) throw new FeishuChatError('media_too_large', 'failed');
            yield chunk;
          }
        } catch (error) {
          throw error instanceof FeishuChatError ? error : new FeishuChatError('media_read_failed', 'failed');
        } finally { clearTimeout(timer); source.destroy(); }
      })());
      stream.once('close', () => { clearTimeout(timer); source.destroy(); });
      // Attach a listener immediately; consumers still receive stream failures.
      source.on('error', () => {});
      return { stream, contentType: String(resource.headers?.['content-type'] || 'application/octet-stream'),
        ...(Number.isFinite(size) && size >= 0 ? { size } : {}) };
    },
  };
}
