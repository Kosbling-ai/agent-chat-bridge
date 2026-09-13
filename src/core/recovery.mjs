import { resolve } from 'node:path';
import { safeObserver } from '../logger.mjs';

class Rejected extends Error { constructor(code) { super(code); this.code = code; } }
export function createRecoveryHandler({ store, codex, workspace, connectionId, log }) {
  log = safeObserver(log);
  return async function recover(action) {
    const started = Date.now();
    log('info', 'agent_recovery', 'started');
    let verifiedNative;
    try {
      const attempt = await store.getAgentAttempt({ id: action.runId });
      if (!attempt || attempt.connectionId !== connectionId || attempt.conversationId !== action.conversationId
        || attempt.status !== 'unknown' || String(attempt.generation) !== String(action.expectedGeneration)) throw new Rejected('recovery_conflict');
      const threadId = action.action === 'adopt_turn' ? action.nativeThreadId : attempt.nativeThreadId;
      const turnId = action.action === 'adopt_turn' ? action.nativeTurnId : attempt.nativeTurnId;
      // Missing IDs may only be abandoned on the trusted administrator's durable
      // verification statement. This does not manufacture a retry or new turn.
      if (threadId) {
        const { thread } = await codex.readThread({ threadId, includeTurns: true });
        if (!thread || thread.id !== threadId || typeof thread.cwd !== 'string' || resolve(thread.cwd) !== workspace) throw new Rejected('recovery_workspace_mismatch');
        if (!Array.isArray(thread.turns)) throw new Rejected('recovery_turn_unresolved');
        const turn = thread.turns.find(item => item.id === turnId);
        if (turnId && !turn) throw new Rejected('recovery_turn_unresolved');
        if (action.action === 'adopt_turn') {
          if (!turn || !['inProgress', 'completed', 'failed', 'interrupted'].includes(turn.status)) throw new Rejected('recovery_turn_unresolved');
          verifiedNative = { threadId, turnId };
        } else if (thread.turns.some(item => !['completed', 'failed', 'interrupted'].includes(item.status))) throw new Rejected('recovery_turn_active');
      } else if (action.action === 'adopt_turn') throw new Rejected('recovery_turn_unresolved');
    } catch (error) {
      if (error instanceof Rejected) {
        await store.finishRecovery({ id: action.id, leaseToken: action.leaseToken, outcome: 'rejected', errorCode: error.code });
        log('warning', 'agent_recovery', 'rejected', { code: error.code, durationMs: Date.now() - started });
      } else {
        // Provider read failures prove nothing about the existing execution.
        // Leave the action leased; a later claim retries only this read.
        log('warning', 'agent_recovery', 'pending', { code: 'recovery_read_unavailable', durationMs: Date.now() - started });
      }
      return;
    }
    // Do not turn an uncertain application COMMIT into a contradictory rejection.
    try {
      await store.finishRecovery({ id: action.id, leaseToken: action.leaseToken, outcome: 'applied', ...(verifiedNative ? { verifiedNative } : {}) });
    } catch (error) {
      const recorded = await store.getRecovery({ id: action.id });
      if (recorded?.status === 'applied') return;
      if (['recovery_conflict', 'thread_scope_conflict'].includes(error.code)) {
        if (recorded?.status !== 'rejected') await store.finishRecovery({ id: action.id, leaseToken: action.leaseToken, outcome: 'rejected', errorCode: error.code });
        log('warning', 'agent_recovery', 'rejected', { code: error.code, durationMs: Date.now() - started });
        return;
      }
      log('error', 'agent_recovery', 'unconfirmed', { code: 'recovery_apply_unconfirmed', durationMs: Date.now() - started });
      return;
    }
    log('info', 'agent_recovery', 'succeeded', { durationMs: Date.now() - started });
  };
}
