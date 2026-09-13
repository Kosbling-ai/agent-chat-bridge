import { createHash, timingSafeEqual } from 'node:crypto';

export class ApiError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export function fields(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))
      || required.some(key => typeof value[key] !== 'string' || !value[key] || value[key].length > 2048)) throw new ApiError('invalid_payload');
  return value;
}
const digest = value => createHash('sha256').update(value).digest();
export function createApi({ config, store, chat, tokens }) {
  const connectionId = config.feishu.connectionId;
  const clients = config.auth.clients.map(client => {
    const token = tokens[client.id];
    if (typeof token !== 'string' || token.length < 24) throw new ApiError('invalid_auth_environment');
    return { ...client, digest: digest(token) };
  });
  if (new Set(Object.values(tokens)).size !== clients.length) throw new ApiError('duplicate_auth_tokens');
  function authenticate(header) {
    if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length > 8192) throw new ApiError('unauthorized', 401);
    const candidate = digest(header.slice(7));
    const client = clients.find(item => timingSafeEqual(candidate, item.digest));
    if (!client) throw new ApiError('unauthorized', 401);
    return client;
  }
  function authorize(client, conversationId) {
    if (!client.conversationIds.includes(conversationId)) throw new ApiError('forbidden', 403);
  }
  async function ownedMessage(client, messageId) {
    const result = await chat.getMessage({ messageId });
    const message = result.items?.find(item => item.message_id === messageId);
    if (!message?.chat_id) throw new ApiError('message_not_found', 404);
    authorize(client, message.chat_id);
    return { result, message };
  }
  async function body(request, maxBytes = 65536) {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > maxBytes) throw new ApiError('payload_too_large', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError('invalid_json'); }
  }
  function pagination(url) {
    const afterSequence = url.searchParams.get('after') ?? '0';
    const limit = Number(url.searchParams.get('limit') ?? 50);
    if (!/^\d{1,20}$/.test(afterSequence) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError('invalid_page');
    return { afterSequence, limit };
  }
  function publicJob(row) {
    return { id: row.id, conversationId: row.conversationId, status: row.status, result: row.result, errorCode: row.errorCode ?? null, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }
  return async function handle(request) {
    const client = authenticate(request.headers.authorization);
    const url = new URL(request.url, 'http://bridge.local');
    const path = url.pathname;
    if (request.method === 'POST' && path === '/v1/runs') {
      const input = fields(await body(request, 512 * 1024), ['conversationId', 'idempotencyKey', 'text'], ['conversationId', 'idempotencyKey']);
      if (typeof input.text !== 'string' || !input.text.trim()) throw new ApiError('invalid_text');
      if (Buffer.byteLength(input.text) > 64 * 1024) throw new ApiError('text_too_large', 413);
      authorize(client, input.conversationId);
      const result = await store.enqueueJob({ connectionId, conversationId: input.conversationId, kind: 'agent', idempotencyKey: `api:${client.id}:${input.idempotencyKey}`, payload: { text: input.text, source: 'api', callerId: client.id } });
      return { status: 202, body: { id: result.id, duplicate: result.duplicate } };
    }
    const run = /^\/v1\/runs\/([\w-]+)(\/events)?$/.exec(path);
    if (request.method === 'GET' && run) {
      const row = await store.getJob({ id: run[1] });
      if (!row || row.connectionId !== connectionId || row.kind !== 'agent') throw new ApiError('not_found', 404);
      authorize(client, row.conversationId);
      return { status: 200, body: run[2] ? { events: await store.readRunEvents({ runId: row.id, ...pagination(url) }) } : publicJob(row) };
    }
    if (request.method === 'POST' && path === '/v1/deliveries') {
      const input = fields(await body(request, 3 * 1024 * 1024), ['conversationId', 'idempotencyKey', 'kind', 'messageId', 'content', 'messageKind', 'emojiType', 'reactionId', 'mediaType', 'base64', 'fileName'], ['conversationId', 'idempotencyKey', 'kind']);
      authorize(client, input.conversationId);
      if (!['create', 'reply', 'reaction', 'upload'].includes(input.kind)) throw new ApiError('unsupported_delivery_kind', 422);
      let effect;
      if (input.kind === 'reaction') {
        if (typeof input.messageId !== 'string' || (!input.reactionId && typeof input.emojiType !== 'string')) throw new ApiError('invalid_reaction');
        const { message } = await ownedMessage(client, input.messageId);
        if (message.chat_id !== input.conversationId) throw new ApiError('conversation_mismatch', 403);
        effect = { messageId: input.messageId, ...(input.reactionId ? { reactionId: input.reactionId } : { emojiType: input.emojiType }) };
      } else if (input.kind === 'upload') {
        if (!['image', 'file'].includes(input.mediaType) || typeof input.base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64) || input.base64.length % 4 !== 0) throw new ApiError('invalid_media');
        if (Buffer.from(input.base64, 'base64').length > 2 * 1024 * 1024) throw new ApiError('payload_too_large', 413);
        if (input.mediaType === 'file' && (typeof input.fileName !== 'string' || input.fileName.length > 200)) throw new ApiError('invalid_filename');
        effect = { mediaType: input.mediaType, base64: input.base64, ...(input.fileName ? { fileName: input.fileName } : {}) };
      } else {
      const kind = input.messageKind ?? 'text';
      if (!['text', 'post', 'interactive', 'image', 'file'].includes(kind)) throw new ApiError('invalid_message_kind');
      const content = kind === 'text' && typeof input.content === 'string' ? { text: input.content } : input.content;
      if (!content || typeof content !== 'object' || Array.isArray(content) || Buffer.byteLength(JSON.stringify(content)) > 20000) throw new ApiError('invalid_content');
      if (input.kind === 'reply') {
        if (typeof input.messageId !== 'string') throw new ApiError('message_id_required');
        const { message } = await ownedMessage(client, input.messageId);
        if (message.chat_id !== input.conversationId) throw new ApiError('conversation_mismatch', 403);
      } else if (input.messageId !== undefined) throw new ApiError('invalid_payload');
      effect = { kind, content, ...(input.messageId ? { messageId: input.messageId } : {}) };
      }
      const result = await store.recordOutbox({ connectionId, conversationId: input.conversationId, idempotencyKey: `api:${client.id}:${input.idempotencyKey}`, kind: input.kind, payload: effect });
      return { status: 202, body: { id: result.id, duplicate: result.duplicate } };
    }
    const delivery = /^\/v1\/deliveries\/([\w-]+)$/.exec(path);
    if (request.method === 'GET' && delivery) {
      const row = await store.getOutbox({ id: delivery[1] });
      if (!row || row.connectionId !== connectionId) throw new ApiError('not_found', 404);
      authorize(client, row.conversationId);
      return { status: 200, body: publicJob(row) };
    }
    if (request.method === 'POST' && path === '/v1/sessions/reset') {
      const input = fields(await body(request), ['conversationId', 'generation'], ['conversationId']);
      authorize(client, input.conversationId);
      if (!client.admin) throw new ApiError('forbidden', 403);
      if (!Number.isInteger(input.generation) || input.generation < 1) throw new ApiError('invalid_generation');
      return { status: 200, body: await store.resetSession({ connectionId, conversationId: input.conversationId, agentId: 'codex', expectedGeneration: input.generation }) };
    }
    const list = /^\/v1\/conversations\/([^/]+)\/(messages|members)$/.exec(path);
    if (request.method === 'GET' && list) {
      const conversationId = decodeURIComponent(list[1]); authorize(client, conversationId);
      const { limit } = pagination(url);
      const pageToken = url.searchParams.get('pageToken') ?? undefined;
      if (pageToken && pageToken.length > 2048) throw new ApiError('invalid_page');
      return { status: 200, body: await chat[list[2] === 'messages' ? 'listMessages' : 'listMembers']({ conversationId, pageSize: limit, pageToken }) };
    }
    const message = /^\/v1\/messages\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && message) return { status: 200, body: (await ownedMessage(client, decodeURIComponent(message[1]))).result };
    const resource = /^\/v1\/messages\/([^/]+)\/(resources|reactions)$/.exec(path);
    if (request.method === 'GET' && resource) {
      const messageId = decodeURIComponent(resource[1]);
      await ownedMessage(client, messageId);
      if (resource[2] === 'reactions') return { status: 200, body: await chat.listReactions({ messageId, pageSize: pagination(url).limit, pageToken: url.searchParams.get('pageToken') ?? undefined }) };
      const fileKey = url.searchParams.get('fileKey');
      const type = url.searchParams.get('type');
      if (!fileKey || fileKey.length > 512 || !['image', 'file'].includes(type)) throw new ApiError('invalid_resource');
      const result = await chat.downloadResource({ messageId, fileKey, type });
      return { status: 200, stream: result.stream };
    }
    throw new ApiError('not_found', 404);
  };
}
