import { safeObserver } from '../logger.mjs';

export function createSteeringHandler({ store, codex, log, enabled = true }) {
  log = safeObserver(log);
  return async function steer(job, inputText) {
    if (!enabled) {
      const previous = await store.getSteerAttempt({ id: job.id });
      if (!['intent', 'unknown'].includes(previous?.status)) return false;
    }
    const admission = await store.beginSteerAttempt({ id: job.id, leaseToken: job.leaseToken, agentId: 'codex' });
    if (admission.kind === 'inactive') return false;
    const started = Date.now();
    log('info', 'agent_steer', 'started');
    let outcome = 'unknown', errorCode = 'steer_admission_unknown';
    if (admission.kind === 'new') {
      try {
        const result = await codex.steerTurn({ threadId: admission.nativeThreadId, expectedTurnId: admission.nativeTurnId,
          input: [{ type: 'text', text: inputText }], clientUserMessageId: admission.clientMessageId });
        // TurnSteerResponse requires turnId. A missing/wrong ID does not prove
        // non-admission and must never enter the rejected/deferred replay path.
        if (result?.turnId === admission.nativeTurnId) { outcome = 'accepted'; errorCode = undefined; }
      } catch (error) {
        if (error.outcome === 'rejected') { outcome = 'rejected'; errorCode = 'steer_rpc_rejected'; }
      }
    }
    try { await store.finishSteerAttempt({ id: job.id, leaseToken: job.leaseToken, outcome, ...(errorCode ? { errorCode } : {}) }); }
    catch {
      const recorded = await store.getSteerAttempt({ id: job.id });
      if (!['accepted', 'rejected', 'unknown'].includes(recorded?.status)) {
        log('error', 'agent_steer', 'unconfirmed', { code: 'steer_settlement_unconfirmed', durationMs: Date.now() - started });
        return true;
      }
      outcome = recorded.status;
    }
    log(outcome === 'accepted' ? 'info' : outcome === 'rejected' ? 'warning' : 'error', 'agent_steer', outcome === 'accepted' ? 'succeeded' : outcome === 'rejected' ? 'deferred' : 'recovery_required', {
      ...(outcome === 'accepted' ? {} : { code: outcome === 'rejected' ? 'steer_rpc_rejected' : 'steer_admission_unknown' }), durationMs: Date.now() - started,
    });
    return true;
  };
}
