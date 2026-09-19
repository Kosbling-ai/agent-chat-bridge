import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { safeObserver } from './logger.mjs';

export const EVENTS_BODY_MAX_BYTES = 64 * 1024;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REF_ID_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const CONTROL_CHARACTER = /\p{Cc}/u;
const EVENT_TYPES = new Set(['mail.inbound', 'wait.due', 'wait.resolved']);
const EVENT_FIELDS = new Set(['event_id', 'producer_id', 'scope', 'type', 'correlation_id', 'occurred_at', 'ref_ids', 'prompt']);

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

const string = (value, max, code = 'invalid_request') => {
  if (typeof value !== 'string' || !value || value.length > max) throw new HttpError(400, code);
  return value;
};

function authenticate(request, inboundHooks) {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization || '');
  if (!match) throw new HttpError(401, 'unauthorized');
  const supplied = Buffer.from(match[1]);
  const found = inboundHooks.find(entry => {
    const expected = Buffer.from(typeof entry.token === 'string' ? entry.token : '');
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
  if (!found) throw new HttpError(401, 'unauthorized');
  return found;
}

async function readJson(request) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > EVENTS_BODY_MAX_BYTES) {
    request.resume();
    throw new HttpError(413, 'payload_too_large');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > EVENTS_BODY_MAX_BYTES) {
      request.resume();
      throw new HttpError(413, 'payload_too_large');
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'invalid_json'); }
}

function normalizeEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid_request');
  if (Object.keys(body).some(key => !EVENT_FIELDS.has(key))) throw new HttpError(400, 'unknown_field');
  const eventId = string(body.event_id, 128);
  if (!EVENT_ID.test(eventId)) throw new HttpError(400, 'invalid_event_id');
  const producerId = string(body.producer_id, 128);
  const scope = string(body.scope, 128);
  if (!SCOPE.test(scope)) throw new HttpError(400, 'invalid_scope');
  const type = string(body.type, 64);
  if (!EVENT_TYPES.has(type)) throw new HttpError(400, 'invalid_event_type');
  if (typeof body.correlation_id !== 'string' || !CORRELATION_ID.test(body.correlation_id)) {
    throw new HttpError(400, 'invalid_correlation_id');
  }
  const correlationId = body.correlation_id;
  if (typeof body.occurred_at !== 'string') throw new HttpError(400, 'invalid_occurred_at');
  const occurredAt = body.occurred_at;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) {
    throw new HttpError(400, 'invalid_occurred_at');
  }
  if (!body.ref_ids || typeof body.ref_ids !== 'object' || Array.isArray(body.ref_ids)
    || Object.keys(body.ref_ids).length > 16) throw new HttpError(400, 'invalid_ref_ids');
  const refIds = Object.fromEntries(Object.keys(body.ref_ids).sort().map(key => {
    const value = body.ref_ids[key];
    if (!REF_ID_KEY.test(key) || typeof value !== 'string' || value.length > 256 || CONTROL_CHARACTER.test(value)) {
      throw new HttpError(400, 'invalid_ref_ids');
    }
    return [key, value];
  }));
  if (typeof body.prompt !== 'string') throw new HttpError(400, 'invalid_prompt');
  if (body.prompt.length > 8000) throw new HttpError(413, 'payload_too_large');
  return { eventId, producerId, scope, type, correlationId, occurredAt, refIds, prompt: body.prompt };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

export function canonicalJsonHash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export async function startServer({ config, log, readiness, eventRuntime, inboundTokens = {} }) {
  log = safeObserver(log);
  const inboundHooks = (config.hooks || []).filter(hook => hook.inbound).map(hook => ({ hook, token: inboundTokens[hook.id] }));
  let stopping = false;
  function reply(response, status, body) {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(JSON.stringify(body));
  }
  const server = http.createServer({ requestTimeout: 5000, headersTimeout: 5000 }, async (request, response) => {
    let eventLog;
    let responseStatus;
    try {
      const url = new URL(request.url, 'http://bridge.invalid');
      const eventMatch = /^\/v1\/events\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'POST' && url.pathname === '/v1/events') {
        const authenticated = authenticate(request, inboundHooks);
        const event = normalizeEvent(await readJson(request));
        eventLog = { hookId: authenticated.hook.id, eventId: event.eventId, type: event.type };
        if (event.producerId !== authenticated.hook.id) throw new HttpError(403, 'producer_forbidden');
        const scopePrefix = authenticated.hook.inbound.scopePrefixes.find(prefix => event.scope.startsWith(prefix));
        if (!scopePrefix) throw new HttpError(403, 'scope_forbidden');
        eventLog.scopePrefix = scopePrefix;
        if (!eventRuntime?.registerEvent) throw new HttpError(503, 'service_unavailable');
        let result;
        try { result = await eventRuntime.registerEvent({ ...event, chatId: authenticated.hook.inbound.defaultChatId,
          requestHash: canonicalJsonHash(event) }); }
        catch (error) {
          if (error?.code === 'job_conflict') throw new HttpError(409, 'event_conflict');
          throw error;
        }
        eventLog.jobId = result.jobId;
        responseStatus = 202;
        reply(response, 202, { job_id: result.jobId, binding_open_id: result.bindingOpenId, deduplicated: result.deduplicated });
      } else if (request.method === 'GET' && eventMatch) {
        const authenticated = authenticate(request, inboundHooks);
        let eventId;
        try { eventId = decodeURIComponent(eventMatch[1]); } catch { throw new HttpError(400, 'invalid_event_id'); }
        if (eventId.length > 128 || !EVENT_ID.test(eventId)) throw new HttpError(400, 'invalid_event_id');
        eventLog = { hookId: authenticated.hook.id, eventId };
        if (!eventRuntime?.getEvent) throw new HttpError(503, 'service_unavailable');
        const result = await eventRuntime.getEvent({ producerId: authenticated.hook.id, eventId });
        if (!result) throw new HttpError(404, 'not_found');
        eventLog.jobId = result.jobId;
        responseStatus = 200;
        reply(response, 200, { job_id: result.jobId, status: result.status, updated_at: result.updatedAt });
      } else if (request.method !== 'GET') {
        responseStatus = 405;
        reply(response, 405, { error: 'method_not_allowed' });
      } else if (request.url === '/health/live') {
        responseStatus = stopping ? 503 : 200;
        reply(response, responseStatus, { live: !stopping });
      } else if (request.url === '/health/ready') {
        const state = readiness ? await readiness() : {
          ready: false, reason: 'components_unconfigured',
          missing: ['feishu', 'codex', 'store'],
        };
        responseStatus = !stopping && state.ready ? 200 : 503;
        reply(response, responseStatus, { ...state, ready: !stopping && state.ready });
      } else {
        responseStatus = 404;
        reply(response, 404, { error: 'not_found' });
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      responseStatus = error instanceof HttpError ? error.status : 503;
      const code = error instanceof HttpError ? error.code : 'service_unavailable';
      eventLog = { ...eventLog, errorClass: code };
      reply(response, responseStatus, { error: code });
    } finally {
      if (request.url?.startsWith('/v1/events')) {
        log(responseStatus >= 500 ? 'error' : responseStatus >= 400 ? 'warning' : 'info', 'events_api', 'completed', {
          hookId: eventLog?.hookId,
          eventId: eventLog?.eventId,
          eventType: eventLog?.type,
          scopePrefix: eventLog?.scopePrefix,
          statusCode: responseStatus || 503,
          jobId: eventLog?.jobId,
          errorClass: eventLog?.errorClass || 'none',
        });
      }
    }
  });
  const startedAt = Date.now();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.listen.port, config.listen.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  log('info', 'listen', 'succeeded', { port: address.port, durationMs: Date.now() - startedAt });
  let closePromise;
  return {
    server,
    close() {
      if (closePromise) return closePromise;
      stopping = true;
      const closingAt = Date.now();
      log('info', 'shutdown', 'started');
      closePromise = new Promise((resolve) => {
        const timer = setTimeout(() => server.closeAllConnections(), 2000);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          log('info', 'shutdown', 'succeeded', { durationMs: Date.now() - closingAt });
          resolve();
        });
        server.closeIdleConnections();
      });
      return closePromise;
    },
  };
}
