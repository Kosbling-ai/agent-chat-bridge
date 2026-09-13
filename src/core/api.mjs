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
function identifier(value, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ApiError('invalid_identifier');
  return value;
}
export function createApi({ config, store, forwardRuntime, chat, tokens }) {
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
    identifier(conversationId, 255);
    if (!client.conversationIds.includes(conversationId)) throw new ApiError('forbidden', 403);
  }
  async function ownedMessage(client, messageId) {
    identifier(messageId);
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
      const input = fields(await body(request, 512 * 1024), ['conversationId', 'idempotencyKey', 'text', 'executionNamespace', 'deliveryMode'], ['conversationId', 'idempotencyKey']);
      if (typeof input.text !== 'string' || !input.text.trim()) throw new ApiError('invalid_text');
      if (Buffer.byteLength(input.text) > 64 * 1024) throw new ApiError('text_too_large', 413);
      if (input.executionNamespace !== undefined && (typeof input.executionNamespace !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(input.executionNamespace))) throw new ApiError('invalid_execution_namespace');
      if (input.deliveryMode !== undefined && !['bridge','caller'].includes(input.deliveryMode)) throw new ApiError('invalid_delivery_mode');
      authorize(client, input.conversationId);
      const idempotencyKey = identifier(input.idempotencyKey, 255);
      const result = await forwardRuntime.submit({source:'api',callerId:client.id,idempotencyKey,executionNamespace:input.executionNamespace,message:{conversationId:input.conversationId,conversationType:'group',text:input.text},actor:{type:'service',id:client.id},prompt:input.text,deliveryMode:input.deliveryMode||'bridge'});
      return { status: 202, body: { id: result.id, duplicate: result.duplicate } };
    }
    const resource = /^\/v1\/runs\/([\w-]+)\/resources\/(\d+)$/.exec(path);
    if(request.method==='GET'&&resource){const current=await forwardRuntime.getRun({id:resource[1]});if(!current)throw new ApiError('not_found',404);authorize(client,current.conversationId);const value=await forwardRuntime.getResource({id:resource[1],index:Number(resource[2])});if(!value)throw new ApiError('not_found',404);return{status:200,body:value};}
    const run = /^\/v1\/runs\/([\w-]+)(\/(?:events|attempt))?$/.exec(path);
    if (request.method === 'GET' && run) {
      const row = await forwardRuntime.getRun({ id: run[1] });
      if (!row) throw new ApiError('not_found', 404);
      authorize(client, row.conversationId);
      if (run[2] === '/attempt') {
        if (!client.admin) throw new ApiError('forbidden', 403);
        throw new ApiError('unsupported_execution_model',409);
      }
      const page=pagination(url);
      if (!run[2]) return { status: 200, body: row };
      const events = await forwardRuntime.readRunEvents({ id: row.id, after: page.afterSequence, limit: page.limit });
      return { status: 200, body: { events: events.items, nextCursor: events.nextCursor } };
    }
    if (request.method === 'POST' && path === '/v1/recoveries') {
      if (!client.admin) throw new ApiError('forbidden', 403);
      const input = fields(await body(request), ['runId', 'idempotencyKey', 'generation', 'action', 'evidence', 'nativeThreadId', 'nativeTurnId'], ['runId', 'idempotencyKey', 'action']);
      identifier(input.runId, 36);
      const job = await forwardRuntime.getRun({ id: input.runId });
      if (!job) throw new ApiError('not_found', 404);
      authorize(client, job.conversationId);
      if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new ApiError('invalid_generation');
      if (!['adopt_turn', 'abandon_verified', 'abandon_guidance_verified'].includes(input.action) || typeof input.evidence !== 'string' || !input.evidence.trim() || input.evidence.length > 4096) throw new ApiError('invalid_recovery');
      if (input.action === 'adopt_turn') { identifier(input.nativeThreadId, 255); identifier(input.nativeTurnId, 255); }
      else if (input.nativeThreadId !== undefined || input.nativeTurnId !== undefined) throw new ApiError('invalid_recovery');
      throw new ApiError('unsupported_execution_model',409);
    }
    const recovery = /^\/v1\/recoveries\/([\w-]+)$/.exec(path);
    if (request.method === 'GET' && recovery) {
      if (!client.admin) throw new ApiError('forbidden', 403);
      const action = await store.getRecovery({ id: identifier(recovery[1], 36) });
      if (!action || action.connectionId !== connectionId) throw new ApiError('not_found', 404);
      authorize(client, action.conversationId);
      return { status: 200, body: action };
    }
    if (request.method === 'POST' && path === '/v1/deliveries') {
      const input = fields(await body(request, 3 * 1024 * 1024), ['conversationId', 'idempotencyKey', 'kind', 'messageId', 'content', 'messageKind', 'emojiType', 'reactionId', 'mediaType', 'base64', 'fileName'], ['conversationId', 'idempotencyKey', 'kind']);
      authorize(client, input.conversationId);
      const idempotencyKey = identifier(`api:${client.id}:${input.idempotencyKey}`, 255);
      if (!['create', 'reply', 'reaction', 'upload'].includes(input.kind)) throw new ApiError('unsupported_delivery_kind', 422);
      let effect;
      if (input.kind === 'reaction') {
        if (typeof input.messageId !== 'string' || (!input.reactionId && typeof input.emojiType !== 'string')) throw new ApiError('invalid_reaction');
        identifier(input.reactionId ?? input.emojiType);
        if (input.reactionId !== undefined && input.emojiType !== undefined) throw new ApiError('invalid_reaction');
        const { message } = await ownedMessage(client, input.messageId);
        if (message.chat_id !== input.conversationId) throw new ApiError('conversation_mismatch', 403);
        effect = { messageId: input.messageId, ...(input.reactionId ? { reactionId: input.reactionId } : { emojiType: input.emojiType }) };
      } else if (input.kind === 'upload') {
        if (!['image', 'file'].includes(input.mediaType) || typeof input.base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64) || input.base64.length % 4 !== 0) throw new ApiError('invalid_media');
        if (Buffer.from(input.base64, 'base64').length > 2 * 1024 * 1024) throw new ApiError('payload_too_large', 413);
        if (input.mediaType === 'file' && (typeof input.fileName !== 'string' || !input.fileName.trim() || input.fileName.length > 200 || /[\\/\x00-\x1f]/.test(input.fileName))) throw new ApiError('invalid_filename');
        effect = { mediaType: input.mediaType, base64: input.base64, ...(input.fileName ? { fileName: input.fileName } : {}) };
      } else {
      const kind = input.messageKind ?? 'text';
      if (!['text', 'post', 'interactive', 'image', 'file'].includes(kind)) throw new ApiError('invalid_message_kind');
      const content = kind === 'text' && typeof input.content === 'string' ? { text: input.content } : input.content;
      if (!content || typeof content !== 'object' || Array.isArray(content) || Buffer.byteLength(JSON.stringify(content)) > 20000) throw new ApiError('invalid_content');
      if (kind === 'text' && (typeof content.text !== 'string' || !content.text.trim())) throw new ApiError('invalid_content');
      if (kind === 'image') identifier(content.image_key);
      if (kind === 'file') identifier(content.file_key);
      if (input.kind === 'reply') {
        if (typeof input.messageId !== 'string') throw new ApiError('message_id_required');
        const { message } = await ownedMessage(client, input.messageId);
        if (message.chat_id !== input.conversationId) throw new ApiError('conversation_mismatch', 403);
      } else if (input.messageId !== undefined) throw new ApiError('invalid_payload');
      effect = { kind, content, ...(input.messageId ? { messageId: input.messageId } : {}) };
      }
      const result = await store.recordOutbox({ connectionId, conversationId: input.conversationId, idempotencyKey, kind: input.kind, payload: effect });
      return { status: 202, body: { id: result.id, duplicate: result.duplicate } };
    }
    const delivery = /^\/v1\/deliveries\/([\w-]+)$/.exec(path);
    if (request.method === 'GET' && delivery) {
      const row = await store.getOutbox({ id: delivery[1] });
      if (!row || row.connectionId !== connectionId) throw new ApiError('not_found', 404);
      authorize(client, row.conversationId);
      return { status: 200, body: { ...publicJob(row), blocked: row.blocked ?? false, predecessorStatus: row.predecessorStatus ?? null } };
    }
    if (request.method === 'POST' && path === '/v1/sessions/reset') {
      const input = fields(await body(request), ['conversationId', 'generation'], ['conversationId']);
      authorize(client, input.conversationId);
      if (!client.admin) throw new ApiError('forbidden', 403);
      if (!Number.isInteger(input.generation) || input.generation < 1) throw new ApiError('invalid_generation');
      throw new ApiError('unsupported_execution_model',409);
    }
    throw new ApiError('not_found', 404);
  };
}
