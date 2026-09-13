// Frozen production-source snapshot for differential tests. No runtime imports.
// Source: kosbling-agent/scripts/codex-turn-recovery.mjs at 2c16174.
// SHA256 of original source: edadd657dd05ddb9df6247fa48200a6358f13113045a29de93386951ab030342
const ACTIVE_TURN_MISMATCH_RE = /expected active turn id\s+[`'"]?([^`'"\s]+)[`'"]?\s+but found\s+[`'"]?([^`'"\s]+)[`'"]?/i;
const NO_ACTIVE_TURN_RE = /(?:^|:\s*)no active turn(?:\s+to\s+(?:steer|interrupt))?\b/i;

export function parseActiveTurnMismatch(error, expectedTurnId = '') {
  const text = String(error?.message || error || '').trim();
  const match = text.match(ACTIVE_TURN_MISMATCH_RE);
  if (!match) return null;
  const expected = String(match[1] || '').trim();
  const actual = String(match[2] || '').trim();
  if (!expected || !actual) return null;
  if (expectedTurnId && expected !== expectedTurnId) return null;
  return { expectedTurnId: expected, actualTurnId: actual, text };
}

export function isNoActiveTurnError(error) {
  return NO_ACTIVE_TURN_RE.test(String(error?.message || error || '').trim());
}

export function inProgressTurnIds(thread) {
  const ids = [];
  const seen = new Set();
  for (const turn of thread?.turns || []) {
    const id = String(turn?.id || '').trim();
    if (!id || turn?.status !== 'inProgress' || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function isCodexTurnPredecessor(candidateTurnId, expectedTurnId) {
  const candidate = uuidV7Timestamp(candidateTurnId);
  const expected = uuidV7Timestamp(expectedTurnId);
  if (candidate == null || expected == null) return false;
  return candidate < expected;
}

export function isCodexTurnSuccessor(candidateTurnId, expectedTurnId) {
  const candidate = uuidV7Timestamp(candidateTurnId);
  const expected = uuidV7Timestamp(expectedTurnId);
  if (candidate == null || expected == null) return false;
  return candidate > expected;
}

export class TurnRecoverySupersededError extends Error {
  constructor(turnId, actualTurnId = '') {
    super(actualTurnId
      ? `Codex turn ${turnId} was superseded by newer active turn ${actualTurnId}`
      : `Codex turn ${turnId} completed before steering recovery finished`);
    this.name = 'TurnRecoverySupersededError';
    this.turnId = turnId;
    this.actualTurnId = actualTurnId;
  }
}

export async function interruptTurnAndPredecessors({
  request,
  threadId,
  expectedTurnId,
  maxAttempts = 12,
  retryDelayMs = 100,
  wait = defaultWait,
  onRecovery = () => {},
} = {}) {
  const interruptedTurnIds = [];
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await request('turn/interrupt', { threadId, turnId: expectedTurnId });
      interruptedTurnIds.push(expectedTurnId);
      return { interruptedTurnIds, noActiveTurn: false };
    } catch (error) {
      lastError = error;
      if (isNoActiveTurnError(error)) {
        return { interruptedTurnIds, noActiveTurn: true };
      }
      const mismatch = parseActiveTurnMismatch(error, expectedTurnId);
      if (!mismatch || mismatch.actualTurnId === expectedTurnId) throw error;
      if (!isCodexTurnPredecessor(mismatch.actualTurnId, expectedTurnId)) throw error;
      onRecovery({
        phase: 'interrupt',
        attempt,
        expectedTurnId,
        actualTurnId: mismatch.actualTurnId,
      });
      try {
        await request('turn/interrupt', {
          threadId,
          turnId: mismatch.actualTurnId,
        });
        interruptedTurnIds.push(mismatch.actualTurnId);
      } catch (interruptError) {
        lastError = interruptError;
        if (!isNoActiveTurnError(interruptError)) {
          const nextMismatch = parseActiveTurnMismatch(interruptError, mismatch.actualTurnId);
          if (!nextMismatch) throw interruptError;
        }
      }
      if (attempt < maxAttempts) await wait(retryDelayMs);
    }
  }
  throw lastError || new Error(`failed to interrupt Codex turn ${expectedTurnId}`);
}

export async function steerTurnWithMismatchRecovery({
  request,
  threadId,
  expectedTurnId,
  input,
  maxAttempts = 20,
  retryDelayMs = 150,
  wait = defaultWait,
  onRecovery = () => {},
  shouldContinue = () => true,
} = {}) {
  const interruptedTurnIds = new Set();
  let recoveryStarted = false;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    assertRecoveryCurrent(shouldContinue, expectedTurnId);
    try {
      return await request('turn/steer', {
        threadId,
        expectedTurnId,
        input,
      });
    } catch (error) {
      assertRecoveryCurrent(shouldContinue, expectedTurnId);
      lastError = error;
      const mismatch = parseActiveTurnMismatch(error, expectedTurnId);
      if (mismatch && mismatch.actualTurnId !== expectedTurnId) {
        if (!isCodexTurnPredecessor(mismatch.actualTurnId, expectedTurnId)) {
          if (isCodexTurnSuccessor(mismatch.actualTurnId, expectedTurnId)) {
            throw new TurnRecoverySupersededError(expectedTurnId, mismatch.actualTurnId);
          }
          throw error;
        }
        recoveryStarted = true;
        onRecovery({
          phase: 'steer',
          attempt,
          expectedTurnId,
          actualTurnId: mismatch.actualTurnId,
        });
        if (!interruptedTurnIds.has(mismatch.actualTurnId)) {
          assertRecoveryCurrent(shouldContinue, expectedTurnId);
          try {
            await request('turn/interrupt', {
              threadId,
              turnId: mismatch.actualTurnId,
            });
          } catch (interruptError) {
            if (!isNoActiveTurnError(interruptError)) {
              const interruptMismatch = parseActiveTurnMismatch(interruptError, mismatch.actualTurnId);
              if (!interruptMismatch) throw interruptError;
            }
          }
          interruptedTurnIds.add(mismatch.actualTurnId);
        }
      } else if (!(recoveryStarted && isNoActiveTurnError(error))) {
        throw error;
      }
      assertRecoveryCurrent(shouldContinue, expectedTurnId);
      if (attempt < maxAttempts) await wait(retryDelayMs);
    }
  }
  throw lastError || new Error(`failed to steer Codex turn ${expectedTurnId}`);
}

function defaultWait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function assertRecoveryCurrent(shouldContinue, expectedTurnId) {
  if (!shouldContinue()) throw new TurnRecoverySupersededError(expectedTurnId);
}

function uuidV7Timestamp(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) return null;
  const timestampHex = normalized.slice(0, 8) + normalized.slice(9, 13);
  const timestamp = Number.parseInt(timestampHex, 16);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}
