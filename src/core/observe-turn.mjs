import { extractFinalAnswer } from './format.mjs';
const sleepDefault = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export const isTerminalTurn = turn => ['completed', 'failed', 'interrupted'].includes(turn?.status);

export async function observeNativeTurn({ store, codex, connectionId, job, attempt, turnId, stopped, leaseMs = 60000, sleep = sleepDefault }) {
  let cursor = 0, renewedAt = Date.now();
  while (!stopped()) {
    const rows = await store.readNativeEvents({ connectionId, nativeThreadId: attempt.nativeThreadId, nativeTurnId: turnId, afterSequence: cursor, limit: 100 });
    for (const row of rows) {
      cursor = row.sequence;
      const event = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      const params = event.params ?? {};
      if ((params.turnId ?? params.turn?.id) !== turnId || (params.threadId && params.threadId !== attempt.nativeThreadId)) continue;
      await store.appendRunEvent({ runId: job.id, eventKey: `native:${row.sequence}`, type: event.method, payload: params });
      if (event.method === 'turn/completed' || (event.method === 'error' && params.willRetry !== true)) {
        if (event.method === 'turn/completed' && isTerminalTurn(params.turn) && extractFinalAnswer(params.turn)) return params.turn;
        // A non-retrying error wakes native reconciliation; it does not prove
        // the admitted turn failed. Read refusal propagates to core's pending
        // recovery path; missing/in-progress/unknown status also stays pending.
        const result = await codex.readThread({ threadId: attempt.nativeThreadId, includeTurns: true });
        const recovered = result.thread?.turns?.find(turn => turn.id === turnId);
        return isTerminalTurn(recovered) ? recovered : null;
      }
    }
    if (Date.now() - renewedAt > 15000) {
      await store.renewJob({ id: job.id, leaseToken: job.leaseToken, leaseMs });
      renewedAt = Date.now();
    }
    if (codex.status().state !== 'ready') return null;
    if (rows.length < 100) await sleep(100);
  }
  return null;
}
