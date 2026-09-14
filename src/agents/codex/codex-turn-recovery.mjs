const ACTIVE_TURN_MISMATCH_RE = /expected active turn id\s+[`'"]?([^`'"\s]+)[`'"]?\s+but found\s+[`'"]?([^`'"\s]+)[`'"]?/i;
const NO_ACTIVE_TURN_RE = /(?:^|:\s*)no active turn(?:\s+to\s+(?:steer|interrupt))?\b/i;
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);

export function parseActiveTurnMismatch(error, expectedTurnId = '') {
  const reason = error?.reason;
  if (reason?.kind === 'active_turn_mismatch') {
    const expected = reason.expectedTurnId;
    const actual = reason.actualTurnId;
    if (!safeId(expected) || !safeId(actual) || (expectedTurnId && expected !== expectedTurnId)) return null;
    return { expectedTurnId: expected, actualTurnId: actual, text: 'active_turn_mismatch' };
  }
  const text = String(error?.message || error || '').trim();
  const match = text.match(ACTIVE_TURN_MISMATCH_RE);
  if (!match) return null;
  const expected = String(match[1] || '').trim();
  const actual = String(match[2] || '').trim();
  if (!expected || !actual || (expectedTurnId && expected !== expectedTurnId)) return null;
  return { expectedTurnId: expected, actualTurnId: actual, text };
}
export function isNoActiveTurnError(error) {
  if (error?.reason?.kind === 'no_active_turn') return true;
  return NO_ACTIVE_TURN_RE.test(String(error?.message || error || '').trim());
}

export function inProgressTurnIds(thread) {
  const ids = [];
  const seen = new Set();
  for (const turn of thread?.turns || []) {
    const id = String(turn?.id || '').trim();
    if (!id || turn?.status !== 'inProgress' || seen.has(id)) continue;
    seen.add(id); ids.push(id);
  }
  return ids;
}

function uuidV7Timestamp(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) return null;
  const timestamp = Number.parseInt(normalized.slice(0, 8) + normalized.slice(9, 13), 16);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}

export function isCodexTurnPredecessor(candidateTurnId, expectedTurnId) {
  const candidate = uuidV7Timestamp(candidateTurnId);
  const expected = uuidV7Timestamp(expectedTurnId);
  return candidate != null && expected != null && candidate < expected;
}

export function isCodexTurnSuccessor(candidateTurnId, expectedTurnId) {
  const candidate = uuidV7Timestamp(candidateTurnId);
  const expected = uuidV7Timestamp(expectedTurnId);
  return candidate != null && expected != null && candidate > expected;
}

export class TurnRecoverySupersededError extends Error {
  constructor(turnId, actualTurnId = '') {
    super(actualTurnId ? `Codex turn ${turnId} was superseded by newer active turn ${actualTurnId}` : `Codex turn ${turnId} completed before steering recovery finished`);
    this.name = 'TurnRecoverySupersededError';
    this.turnId = turnId;
    this.actualTurnId = actualTurnId;
  }
}

// Production cleanup retries the requested turn after removing only native
// predecessors explicitly named by the app-server mismatch response.
export async function interruptTurnAndPredecessors({
  request, threadId, expectedTurnId, maxAttempts = 12, retryDelayMs = 100,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onRecovery = () => {},
} = {}) {
  const interruptedTurnIds = [];
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await request('turn/interrupt', { threadId, turnId: expectedTurnId });
      interruptedTurnIds.push(expectedTurnId);
      return { interruptedTurnIds, noActiveTurn: false };
    } catch (error) {
      lastError = error;
      if (isNoActiveTurnError(error)) return { interruptedTurnIds, noActiveTurn: true };
      const mismatch = parseActiveTurnMismatch(error, expectedTurnId);
      if (!mismatch || mismatch.actualTurnId === expectedTurnId || !isCodexTurnPredecessor(mismatch.actualTurnId, expectedTurnId)) throw error;
      onRecovery({ phase: 'interrupt', attempt, expectedTurnId, actualTurnId: mismatch.actualTurnId });
      try {
        await request('turn/interrupt', { threadId, turnId: mismatch.actualTurnId });
        interruptedTurnIds.push(mismatch.actualTurnId);
      } catch (interruptError) {
        lastError = interruptError;
        if (!isNoActiveTurnError(interruptError) && !parseActiveTurnMismatch(interruptError, mismatch.actualTurnId)) throw interruptError;
      }
      if (attempt < maxAttempts) await wait(retryDelayMs);
    }
  }
  throw lastError || new Error(`failed to interrupt Codex turn ${expectedTurnId}`);
}

// Mismatch recovery is allowed only after native evidence names an older turn
// in the same thread. Generic orphan/predecessor cleanup is intentionally absent.
export async function steerTurnWithMismatchRecovery({
  request, threadId, expectedTurnId, input, maxAttempts = 20,
  retryDelayMs = 150, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRecovery = () => {}, shouldContinue = () => true,
} = {}) {
  const interruptedTurnIds = new Set();
  let recoveryStarted = false;
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!shouldContinue()) throw new TurnRecoverySupersededError(expectedTurnId);
    try {
      return await request('turn/steer', { threadId, expectedTurnId, input });
    } catch (error) {
      lastError = error;
      const mismatch = parseActiveTurnMismatch(error, expectedTurnId);
      if (mismatch && mismatch.actualTurnId !== expectedTurnId) {
        if (!isCodexTurnPredecessor(mismatch.actualTurnId, expectedTurnId)) {
          if (isCodexTurnSuccessor(mismatch.actualTurnId, expectedTurnId)) throw new TurnRecoverySupersededError(expectedTurnId, mismatch.actualTurnId);
          throw error;
        }
        recoveryStarted = true;
        onRecovery({ phase: 'steer', attempt, expectedTurnId, actualTurnId: mismatch.actualTurnId });
        if (!interruptedTurnIds.has(mismatch.actualTurnId)) {
          if (!shouldContinue()) throw new TurnRecoverySupersededError(expectedTurnId);
          try { await request('turn/interrupt', { threadId, turnId: mismatch.actualTurnId }); }
          catch (interruptError) {
            if (!isNoActiveTurnError(interruptError) && !parseActiveTurnMismatch(interruptError, mismatch.actualTurnId)) throw interruptError;
          }
          interruptedTurnIds.add(mismatch.actualTurnId);
        }
      } else if (!(recoveryStarted && isNoActiveTurnError(error))) throw error;
      if (!shouldContinue()) throw new TurnRecoverySupersededError(expectedTurnId);
      if (attempt < maxAttempts) await wait(retryDelayMs);
    }
  }
  throw lastError || new Error(`failed to steer Codex turn ${expectedTurnId}`);
}

export function exactTurnSnapshot(thread, turnId) {
  const turn = (thread?.turns || []).find((candidate) => candidate?.id === turnId);
  if (!turn) return { threadId: thread?.id || '', turnId, status: 'unknown' };
  return { threadId: thread?.id || '', turnId, status: turn.status || 'unknown', turn };
}
