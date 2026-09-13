import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { codexThreadCreatedAtMs, shouldRolloverForRules } from '../agents/codex/rollover.mjs';
import { safeObserver } from '../logger.mjs';

export function createSessionRotation({ store, codex, connectionId, workspace, config, log, now = Date.now }) {
  log = safeObserver(log);
  return async function prepare(job) {
    if (await store.getAgentAttempt({ id: job.id })) return;
    const scope = { connectionId, conversationId: job.conversationId, agentId: 'codex' };
    const session = await store.getSession(scope);
    if (!session?.nativeThreadId || session.activeRunId) return;
    let rulesMtimeMs = 0;
    if (config.rolloverOnRulesUpdate !== false) {
      for (const path of config.rulesFiles ?? ['AGENTS.md']) {
        try { const file = await stat(resolve(workspace, path)); if (file.isFile()) rulesMtimeMs = Math.max(rulesMtimeMs, file.mtimeMs); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    const idleMs = config.rolloverIdleMs ?? 2 * 24 * 60 * 60 * 1000;
    if (!rulesMtimeMs && (!idleMs || (session.lastMessageAt && now() - Number(session.lastMessageAt) < idleMs))) return;
    let thread, reason;
    try { ({ thread } = await codex.readThread({ threadId: session.nativeThreadId, includeTurns: true })); }
    catch (error) {
      if (error.outcome === 'rejected' && error.reason?.kind === 'thread_archived' && error.reason.threadId === session.nativeThreadId) reason = 'thread_archived';
      else throw error;
    }
    if (!reason) {
      if (!thread || thread.id !== session.nativeThreadId || typeof thread.cwd !== 'string' || resolve(thread.cwd) !== workspace || !Array.isArray(thread.turns)) throw new Error('rotation_native_unresolved');
      if (thread.turns.some(turn => !['completed', 'failed', 'interrupted'].includes(turn.status))) throw new Error('rotation_native_active');
      const createdAt = codexThreadCreatedAtMs(thread.createdAt);
      if (shouldRolloverForRules({ rulesMtimeMs, threadCreatedAtMs: createdAt })) reason = 'rules_updated';
      else {
        const activity = Number(session.lastMessageAt || createdAt);
        if (idleMs && activity > 0 && now() - activity >= idleMs) reason = 'session_idle';
      }
    }
    if (!reason) return;
    await store.rotateIdleSession({ ...scope, idempotencyKey: `run:${job.id}:${reason}:${session.generation}`, expectedGeneration: session.generation, expectedThreadId: session.nativeThreadId, reason,
      ...(reason === 'session_idle' ? { expectedLastMessageAt: session.lastMessageAt ?? null } : {}) });
    log('info', 'session_rotation', 'succeeded', { code: reason });
  };
}
