// Production parsers moved to the protocol boundary: preserve classification,
// never expose arbitrary provider error text to core, HTTP or logging.
const ACTIVE_TURN_MISMATCH_RE = /expected active turn id\s+[`'"]?([^`'"\s]+)[`'"]?\s+but found\s+[`'"]?([^`'"\s]+)[`'"]?/i;
const NO_ACTIVE_TURN_RE = /(?:^|:\s*)no active turn(?:\s+to\s+(?:steer|interrupt))?\b/i;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);

export function classifyCodexRpcError(error, { method, threadId, expectedTurnId } = {}) {
  const text = typeof error === 'string' ? error : error?.message || error?.description;
  if (typeof text !== 'string' || text.length > 8192) return undefined;
  if (['thread/resume', 'thread/read', 'turn/start'].includes(method) && safeId(threadId)) {
    const archived = text.match(/\bsession\s+([^\s]+)\s+is archived\b/i);
    const sessionId = archived?.[1]?.replace(/^['"]+|['".,;:]+$/g, '');
    if (sessionId === threadId) return { kind: 'thread_archived', threadId };
  }
  if (['turn/steer', 'turn/interrupt'].includes(method)) {
    if (NO_ACTIVE_TURN_RE.test(text)) return { kind: 'no_active_turn' };
    const match = text.match(ACTIVE_TURN_MISMATCH_RE);
    if (match && safeId(match[1]) && safeId(match[2]) && match[1] === expectedTurnId) return { kind: 'active_turn_mismatch', expectedTurnId: match[1], actualTurnId: match[2] };
  }
  return undefined;
}
