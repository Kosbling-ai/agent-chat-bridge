// A stop request is valid only for the exact active task identity.
export async function stopCardTurn(active, expected, interrupt) {
  if (!active || active.settled || active.turnId !== expected.turnId || active.messageId !== expected.messageId) return { status: 'stale' };
  if (active.stopRequested) return { status: 'requested' };
  if (!active.stopRequest) {
    active.stopRequest = Promise.resolve()
      .then(() => interrupt({ threadId: active.threadId, turnId: active.turnId }))
      .then(() => { active.stopRequested = true; return { status: 'requested' }; })
      .finally(() => { active.stopRequest = null; });
  }
  return active.stopRequest;
}

