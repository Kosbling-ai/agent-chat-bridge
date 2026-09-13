// The only rollover inside an active native attempt is a proven refusal to
// resume its archived thread, before any turn/start was sent. Store preserves
// the replacement intent before a single new thread/start is permitted.
export async function admitThread({ store, codex, job, attempt }) {
  if (!attempt.nativeThreadId) return { thread: await codex.startThread(), newThread: true };
  try { return { thread: await codex.resumeThread({ threadId: attempt.nativeThreadId }), newThread: false }; }
  catch (error) {
    if (error.outcome !== 'rejected' || error.reason?.kind !== 'thread_archived'
      || error.reason.threadId !== attempt.nativeThreadId || attempt.nativeTurnId) throw error;
    const reset = await store.resetRejectedThreadAdmission({ id: job.id, leaseToken: job.leaseToken,
      expectedGeneration: attempt.generation, expectedThreadId: attempt.nativeThreadId, reason: 'thread_archived' });
    Object.assign(attempt, reset);
    if (reset.recoveryRequired) return { recoveryRequired: true };
    return { thread: await codex.startThread(), newThread: true };
  }
}
