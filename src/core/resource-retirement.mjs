import { safeObserver } from '../logger.mjs';

// A resource seal is durable and forbids later native adoption of retired input.
// Filesystem work runs outside the transaction, under the same local ownership
// used for artifact cleanup; a crash resumes a sealed row without new execution.
export function createResourceRetirement({ store, media, outbound, guard, connectionId, log, stopped = () => false }) {
  log = safeObserver(log);
  let cursor;
  return async function retire() {
    const page = await store.listRetirableResources({ connectionId, afterRunId: cursor, limit: 10 });
    for (const row of page.items) {
      if (stopped()) break;
      await guard.cleanup(JSON.stringify([connectionId, row.conversationId]), async () => {
        // The seal transaction rechecks native/guidance occupancy, including
        // replay of an existing seal. Listed eligibility is never permission.
        for (const kind of ['input', 'output']) {
          if (stopped() || !row[`${kind}Retirable`] || (kind === 'input' ? !media : !outbound)) continue;
          const started = Date.now();
          try {
            const seal = await store.sealResourceRetirement({ runId: row.runId, kind });
            if (seal.state === 'complete') continue;
            log('info', 'resource_retirement', 'started', { code: `${kind}_retirement` });
            if (kind === 'input') await media.release(row.runId);
            else {
              const result = await outbound.releaseRun({ connectionId, conversationId: row.conversationId, runId: row.runId });
              if (!result.retired) {
                log('info', 'resource_retirement', 'retained', { code: 'output_source_claim_retained', durationMs: Date.now() - started });
                continue;
              }
            }
            await store.completeResourceRetirement({ runId: row.runId, kind });
            log('info', 'resource_retirement', 'succeeded', { code: `${kind}_retired`, durationMs: Date.now() - started });
          } catch {
            // Seals survive uncertain commits/deletes. Do not restore an old
            // native binding or mark FS success from a failed acknowledgement.
            log('warning', 'resource_retirement', 'pending', { code: `${kind}_retirement_pending`, durationMs: Date.now() - started });
          }
        }
      });
    }
    cursor = page.nextCursor ?? undefined;
  };
}
