import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withConnection } from './connection.mjs';
import { StoreError } from './errors.mjs';

const SQL = await readFile(new URL('./migrations/001-initial.sql', import.meta.url), 'utf8');
const CHECKSUM = createHash('sha256').update(SQL).digest('hex');
const LEDGER = `CREATE TABLE IF NOT EXISTS bridge_schema_migrations (
  version INT UNSIGNED PRIMARY KEY, checksum CHAR(64) CHARACTER SET ascii NOT NULL,
  applied_at BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB`;

export async function assertSchemaCurrent(pool) {
  return withConnection(pool, async (connection) => {
    let rows;
    try { [rows] = await connection.query('SELECT version, checksum FROM bridge_schema_migrations ORDER BY version'); }
    catch (error) {
      if (error.code === 'ER_NO_SUCH_TABLE') throw new StoreError('schema_migration_required');
      throw error;
    }
    if (rows.length !== 1 || Number(rows[0].version) !== 1 || rows[0].checksum !== CHECKSUM) throw new StoreError('schema_version_mismatch');
    return { version: 1 };
  });
}

export async function migrate(pool) {
  // Explicit DDL only. Initial statements are restartable CREATE IF NOT EXISTS;
  // MySQL DDL auto-commits, so never claim a migration-wide transaction.
  return withConnection(pool, async (connection) => {
    const [[identity]] = await connection.query('SELECT DATABASE() AS name');
    const lock = `bridge:migrate:${createHash('sha256').update(identity.name).digest('hex').slice(0, 40)}`;
    const [[row]] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [lock]);
    if (Number(row.acquired) !== 1) throw new StoreError('migration_busy');
    try {
      await connection.query(LEDGER);
      const [versions] = await connection.query('SELECT version, checksum FROM bridge_schema_migrations ORDER BY version');
      if (versions.length) {
        if (versions.length !== 1 || Number(versions[0].version) !== 1 || versions[0].checksum !== CHECKSUM) throw new StoreError('schema_version_mismatch');
        return { version: 1, applied: false };
      }
      for (const statement of SQL.split(';').map((s) => s.trim()).filter(Boolean)) await connection.query(statement);
      await connection.execute('INSERT INTO bridge_schema_migrations (version, checksum, applied_at) VALUES (1, ?, ?)', [CHECKSUM, Date.now()]);
      return { version: 1, applied: true };
    } finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [lock]);
    }
  }, { timeoutMs: 30000 });
}
