import { createHash } from 'node:crypto';
import { StoreError } from './errors.mjs';

// The connection remains dedicated for the complete writer lifetime.
export async function acquireWriter(pool, onLost = () => {}) {
  const connection = await pool.getConnection();
  let alive = true;
  let timer;
  const lose = () => { if (alive) { alive = false; clearInterval(timer); connection.destroy(); onLost(new StoreError('writer_lock_lost')); } };
  try {
    const [[db]] = await connection.query('SELECT DATABASE() AS name');
    const name = `bridge:writer:${createHash('sha256').update(db.name).digest('hex').slice(0, 40)}`;
    const [[row]] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [name]);
    if (Number(row.acquired) !== 1) throw new StoreError('writer_busy');
    connection.connection.on('error', lose);
    connection.connection.on('end', lose);
    let checking = false;
    timer = setInterval(async () => {
      if (checking || !alive) return;
      checking = true;
      const deadline = setTimeout(lose, 1000);
      try {
        const [[held]] = await connection.query('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS held', [name]);
        if (Number(held.held) !== 1) lose();
      } catch { lose(); }
      finally { clearTimeout(deadline); checking = false; }
    }, 500);
    timer.unref();
    return {
      assert() { if (!alive) throw new StoreError('writer_lock_lost'); },
      async verify() {
        if(!alive)throw new StoreError('writer_lock_lost');
        const deadline=setTimeout(lose,1000);
        try {const [[row]]=await connection.query('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS held',[name]);if(!alive || Number(row.held)!==1){lose();throw new StoreError('writer_lock_lost');}}
        catch {lose();throw new StoreError('writer_lock_lost');}
        finally {clearTimeout(deadline);}
      },
      async close() { alive = false; clearInterval(timer); connection.destroy(); },
    };
  } catch (error) { connection.destroy(); throw error instanceof StoreError ? error : new StoreError('store_unavailable'); }
}
