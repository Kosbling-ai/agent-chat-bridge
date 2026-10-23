import { createHash } from 'node:crypto';

// Private-chat admission callback (routing.privateAdmission). The bridge asks a
// configured business endpoint whether a private sender may use the Agent and
// knows nothing about the business data behind the answer. Results are cached
// per open_id in memory only; nothing here is persisted.
//
// Never log the token, the union_id, the message text or the full open_id.
const DECISION_LIMIT = 1000;
const UNION_LIMIT = 10000;
const MESSAGE_LIMIT = 10000;
const LOOKUP_LIMIT = 10000;
const UNION_LOOKUP_RETRY_MS = 60000;
// Bridge-side refusals and refusals that may change once the sender is
// identified or the endpoint recovers are never remembered per message.
const TRANSIENT_DENY_REASONS = new Set(['no_union_id', 'open_id_missing']);
const DEADLINE_MARGIN_MS = 250;
const MAX_RESPONSE_CHARS = 4096;
const REASON = /^[A-Za-z0-9_]{1,64}$/;

// Feishu deduplicates sends that reuse a uuid for one hour, so one message can
// receive at most one admission reply even across restarts.
export function admissionReplyUuid(messageId) {
  return `private-admission-${createHash('sha256').update(String(messageId)).digest('hex').slice(0, 24)}`;
}

function remember(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

export function createPrivateAdmission({ settings, connectionId, token, fetchImpl = fetch, log = () => {}, now = Date.now } = {}) {
  if (!settings?.url || typeof token !== 'string' || !token || typeof connectionId !== 'string' || !connectionId
    || typeof fetchImpl !== 'function') throw new Error('invalid_private_admission_dependencies');
  const decisions = new Map(); // open_id -> { decision, reason, unionId, expiresAt, replied }
  const unions = new Map(); // open_id -> union_id seen on a live event
  const messages = new Map(); // message_id -> { decision, reason } of an explicit business denial
  const lookups = new Map(); // open_id -> time before which no Store union lookup is repeated
  const inFlight = new Map();

  function report({ decision, reason, cached, durationMs, statusCode }, { openId, messageId } = {}) {
    log('info', 'private_admission', decision, { decision, reason, cached,
      ...(openId ? { openId } : {}), ...(messageId ? { messageId } : {}),
      ...(durationMs === undefined ? {} : { durationMs }), ...(statusCode === undefined ? {} : { statusCode }) });
  }
  function learn(actor = {}) {
    if (typeof actor.openId === 'string' && actor.openId && typeof actor.unionId === 'string' && actor.unionId) {
      remember(unions, actor.openId, actor.unionId, UNION_LIMIT);
    }
  }
  async function request({ openId, unionId, userId, chatId, timeoutMs }) {
    const started = now();
    let outcome;
    try {
      const response = await fetchImpl(settings.url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ connectionId, chatId, sender: { openId, unionId: unionId || null, userId: userId || null } }),
      });
      if (response.status !== 200) {
        try { await response.body?.cancel(); } catch { /* the status already decided the outcome */ }
        outcome = { decision: 'unavailable', reason: 'http_status', statusCode: response.status };
      } else {
        const text = await response.text();
        let body;
        try { body = text.length <= MAX_RESPONSE_CHARS ? JSON.parse(text) : undefined; } catch { body = undefined; }
        outcome = !body || typeof body !== 'object' || Array.isArray(body) || typeof body.allowed !== 'boolean'
          ? { decision: 'unavailable', reason: 'invalid_response' }
          : { decision: body.allowed ? 'allow' : 'deny', reason: typeof body.reason === 'string' && REASON.test(body.reason) ? body.reason : 'unspecified' };
      }
    } catch (error) {
      outcome = { decision: 'unavailable', reason: ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network_error' };
    }
    return { ...outcome, durationMs: Math.max(0, now() - started) };
  }
  // Resolves to { decision: 'allow'|'deny'|'unavailable', reason, cached }.
  // Fails closed: every failure is 'unavailable', which is never an admission.
  async function check({ openId, unionId = '', userId = '', chatId = '', deadlineAt, messageId } = {}) {
    if (typeof openId !== 'string' || !openId) {
      const result = { decision: 'deny', reason: 'open_id_missing', cached: false };
      report(result, { messageId });
      return result;
    }
    learn({ openId, unionId });
    const knownUnion = unionId || unions.get(openId) || '';
    const entry = decisions.get(openId);
    // A result obtained without a union_id is not reused once one is known.
    if (entry && entry.expiresAt > now() && !(entry.unionId === '' && knownUnion)) {
      const result = { decision: entry.decision, reason: entry.reason, cached: true };
      if (result.decision !== 'allow') report(result, { openId, messageId });
      return result;
    }
    const key = JSON.stringify([openId, knownUnion]);
    const pending = inFlight.get(key);
    if (pending) {
      const outcome = await pending;
      const result = { decision: outcome.decision, reason: outcome.reason, cached: true };
      if (result.decision !== 'allow') report(result, { openId, messageId });
      return result;
    }
    const operation = (async () => {
      const timeoutMs = deadlineAt === undefined ? settings.timeoutMs
        : Math.min(settings.timeoutMs, Math.floor(deadlineAt - now() - DEADLINE_MARGIN_MS));
      // Out of ingest budget: refuse this message without caching a result the
      // endpoint never produced.
      const outcome = timeoutMs < 1 ? { decision: 'unavailable', reason: 'deadline', durationMs: 0 }
        : await request({ openId, unionId: knownUnion, userId, chatId, timeoutMs });
      if (outcome.reason !== 'deadline') {
        remember(decisions, openId, { decision: outcome.decision, reason: outcome.reason, unionId: knownUnion, replied: false,
          expiresAt: now() + (outcome.decision === 'allow' ? settings.allowCacheMs : settings.denyCacheMs) }, DECISION_LIMIT);
      }
      report({ ...outcome, cached: false }, { openId, messageId });
      return outcome;
    })();
    inFlight.set(key, operation);
    try {
      const outcome = await operation;
      return { decision: outcome.decision, reason: outcome.reason, cached: false };
    } finally { if (inFlight.get(key) === operation) inFlight.delete(key); }
  }
  // Returns the reply text once per refused, unexpired cache entry, then ''.
  function replyFor(openId, decision) {
    const entry = decisions.get(openId);
    if (!entry || entry.decision === 'allow' || entry.decision !== decision || entry.replied || entry.expiresAt < now()) return '';
    entry.replied = true;
    return decision === 'deny' ? settings.denyText : settings.unavailableText;
  }
  // A message the endpoint explicitly denied stays refused: later observations
  // (history catch-up, redelivery) never admit it after the decision changes.
  // Unavailable, deadline and no_union_id refusals are re-checked instead.
  function refuseMessage(messageId, { decision, reason }) {
    if (decision !== 'deny' || TRANSIENT_DENY_REASONS.has(reason)) return;
    if (typeof messageId === 'string' && messageId) remember(messages, messageId, { decision, reason }, MESSAGE_LIMIT);
  }
  function refused(messageId) {
    const entry = messages.get(messageId);
    return entry ? { decision: entry.decision, reason: entry.reason } : undefined;
  }
  // True at most once per UNION_LOOKUP_RETRY_MS for a sender whose union_id is unknown.
  function shouldLookupUnion(openId) {
    if (typeof openId !== 'string' || !openId || unions.has(openId) || (lookups.get(openId) || 0) > now()) return false;
    remember(lookups, openId, now() + UNION_LOOKUP_RETRY_MS, LOOKUP_LIMIT);
    return true;
  }
  return Object.freeze({ learn, check, replyFor, refuseMessage, refused, shouldLookupUnion, report });
}
