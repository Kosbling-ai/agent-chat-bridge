export const CODEX_RULES_ROLLOVER_MARGIN_MS = 1000;

export function codexThreadCreatedAtMs(rawCreatedAt) {
  const value = Number(rawCreatedAt || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1e12 ? value : value * 1000;
}

export function shouldRolloverForRules({ rulesMtimeMs, threadCreatedAtMs }) {
  const rulesTime = Number(rulesMtimeMs || 0);
  const threadTime = Number(threadCreatedAtMs || 0);
  if (!Number.isFinite(rulesTime) || !Number.isFinite(threadTime)) return false;
  if (rulesTime <= 0 || threadTime <= 0) return false;

  // Native Codex createdAt is second-granularity. The margin avoids rolling a
  // freshly-created replacement thread again when the rule file and the new
  // thread were created within the same wall-clock second.
  return rulesTime > threadTime + CODEX_RULES_ROLLOVER_MARGIN_MS;
}
