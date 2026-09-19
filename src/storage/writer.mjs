import { createHash } from 'node:crypto';
import { StoreError } from './errors.mjs';

const MAX_TIMER_MS = 2_147_483_647;

function acquireLockedConnection(pool, timeoutMs, connectionId) {
  return new Promise((resolve, reject) => {
    let connection;
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      connection?.destroy();
      reject(new StoreError('writer_start_timeout'));
    }, timeoutMs);
    (async () => {
      try {
        connection = await pool.getConnection();
        if (expired) { connection.destroy(); return; }
        const [[db]] = await connection.query('SELECT DATABASE() AS name');
        if (expired) return;
        const name = `bridge:writer:${createHash('sha256').update(JSON.stringify([db.name, connectionId])).digest('hex').slice(0, 40)}`;
        const [[row]] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [name]);
        if (expired) return;
        if (Number(row.acquired) !== 1) throw new StoreError('writer_busy');
        resolve({ connection, name });
      } catch (error) {
        connection?.destroy();
        if (!expired) reject(error instanceof StoreError ? error : new StoreError('store_unavailable'));
      } finally { clearTimeout(timer); }
    })();
  });
}

// The connection remains dedicated for the complete writer lifetime.
export async function acquireWriter(pool, onLost = () => {}, {
  timeoutMs = 1800,
  connectionId,
  probeIntervalMs = 500,
  probeTimeoutMs = 5_000,
  probeMaxMisses = 2,
  log = () => {},
  now = Date.now,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw new StoreError('invalid_storage_deadline');
  if (typeof connectionId !== 'string' || !connectionId || connectionId.length > 128) throw new StoreError('invalid_store_input');
  if (![probeIntervalMs, probeTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMER_MS)
      || !Number.isSafeInteger(probeMaxMisses) || probeMaxMisses <= 0) throw new StoreError('invalid_store_input');
  const { connection, name } = await acquireLockedConnection(pool, timeoutMs, connectionId);
  let alive = true;
  let timer;
  let probe;
  let probeDeadline;
  let consecutiveMisses = 0;
  let lossError;
  const observe = (level, status, { code, reason, durationMs, misses }) => {
    try {
      Promise.resolve(log(level, 'store_writer_probe', status, {
        code, reason, durationMs, consecutiveMisses: misses,
      })).catch(() => {});
    } catch { /* Observability cannot alter lock fencing. */ }
  };
  const lostError = (reason, durationMs, misses) => Object.assign(new StoreError('writer_lock_lost'), {
    reason, durationMs, consecutiveMisses: misses,
  });
  const lose = (reason, durationMs = 0, misses = consecutiveMisses) => {
    if (!alive) return;
    alive = false;
    clearInterval(timer);
    clearTimeout(probeDeadline);
    connection.destroy();
    const error = lostError(reason, durationMs, misses);
    lossError = error;
    observe('warning', 'failed', { code: 'writer_lost', reason, durationMs, misses });
    try { Promise.resolve(onLost(error)).catch(() => {}); } catch {}
  };
  function armDeadline(startedAt) {
    clearTimeout(probeDeadline);
    probeDeadline = setTimeout(() => {
      if (!alive || !probe) return;
      consecutiveMisses += 1;
      const durationMs = Math.max(0, now() - startedAt);
      observe('warning', 'suspected', { code: 'writer_probe_timeout', reason: 'probe_timeout', durationMs, misses: consecutiveMisses });
      if (consecutiveMisses >= probeMaxMisses) lose('probe_timeout', durationMs, consecutiveMisses);
      else armDeadline(startedAt);
    }, probeTimeoutMs);
    probeDeadline.unref?.();
  }
  function verify() {
    if (!alive) throw lossError ?? new StoreError('writer_lock_lost');
    if (probe) return probe;
    const startedAt = now();
    probe = (async () => {
      try {
        const [[row]] = await connection.query('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS held', [name]);
        const durationMs = Math.max(0, now() - startedAt);
        if (!alive) throw lossError ?? new StoreError('writer_lock_lost');
        if (Number(row.held) !== 1) {
          lose('lock_not_held', durationMs, consecutiveMisses);
          throw lostError('lock_not_held', durationMs, consecutiveMisses);
        }
        if (durationMs > 1_000 || consecutiveMisses > 0) {
          observe('warning', consecutiveMisses > 0 ? 'recovered' : 'slow', {
            code: consecutiveMisses > 0 ? 'writer_probe_recovered' : 'writer_probe_slow',
            reason: consecutiveMisses > 0 ? 'probe_timeout' : 'probe_slow', durationMs, misses: consecutiveMisses,
          });
        }
        consecutiveMisses = 0;
      } catch (error) {
        if (!alive) throw lossError ?? new StoreError('writer_lock_lost');
        lose('probe_query_failed', Math.max(0, now() - startedAt), consecutiveMisses);
        throw error?.code === 'writer_lock_lost' ? error : lossError;
      } finally {
        clearTimeout(probeDeadline);
        probeDeadline = undefined;
        probe = undefined;
      }
    })();
    armDeadline(startedAt);
    return probe;
  }
  const onConnectionError = () => lose('connection_error');
  const onConnectionEnd = () => lose('connection_end');
  connection.connection.on('error', onConnectionError);
  connection.connection.on('end', onConnectionEnd);
  timer = setInterval(() => {
    if (!alive || probe) return;
    try { Promise.resolve(verify()).catch(() => {}); } catch { /* The writer is already failed closed. */ }
  }, probeIntervalMs);
  timer.unref();
  return {
    assert() { if (!alive) throw lossError ?? new StoreError('writer_lock_lost'); },
    verify,
    async close() {
      alive = false;
      clearInterval(timer);
      clearTimeout(probeDeadline);
      connection.connection.off('error', onConnectionError);
      connection.connection.off('end', onConnectionEnd);
      connection.destroy();
    },
  };
}
