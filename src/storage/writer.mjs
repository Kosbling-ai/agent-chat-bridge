import { createHash } from 'node:crypto';
import { StoreError } from './errors.mjs';

function acquireLockedConnection(pool, timeoutMs) {
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
        const name = `bridge:writer:${createHash('sha256').update(db.name).digest('hex').slice(0, 40)}`;
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
export async function acquireWriter(pool, onLost = () => {}, { timeoutMs = 1800 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw new StoreError('invalid_storage_deadline');
  const { connection, name } = await acquireLockedConnection(pool, timeoutMs);
  let alive = true;
  let timer;
  const lose = () => {
    if (!alive) return;
    alive = false;
    clearInterval(timer);
    connection.destroy();
    try { Promise.resolve(onLost(new StoreError('writer_lock_lost'))).catch(() => {}); } catch {}
  };
  async function verify() {
    if (!alive) throw new StoreError('writer_lock_lost');
    const deadline = setTimeout(lose, 1000);
    try {
      const [[row]] = await connection.query('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS held', [name]);
      if (!alive || Number(row.held) !== 1) {
        lose();
        throw new StoreError('writer_lock_lost');
      }
    } catch {
      lose();
      throw new StoreError('writer_lock_lost');
    } finally { clearTimeout(deadline); }
  }
  connection.connection.on('error', lose);
  connection.connection.on('end', lose);
  let checking = false;
  timer = setInterval(async () => {
    if (checking || !alive) return;
    checking = true;
    try { await verify(); } catch { /* The writer is already failed closed. */ }
    finally { checking = false; }
  }, 500);
  timer.unref();
  return {
    assert() { if (!alive) throw new StoreError('writer_lock_lost'); },
    verify,
    async close() {
      alive = false;
      clearInterval(timer);
      connection.destroy();
    },
  };
}
