import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withConnection } from './connection.mjs';
import { StoreError } from './errors.mjs';

const MIGRATIONS = await Promise.all([
  [1, './migrations/001-initial.sql'],
  [2, './migrations/002-codex-sessions.sql'],
  [3, './migrations/003-forward-runtime.sql'],
].map(async ([version, path]) => {
  const sql = await readFile(new URL(path, import.meta.url), 'utf8');
  return { version, sql, checksum: createHash('sha256').update(sql).digest('hex') };
}));
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
    if (rows.length !== MIGRATIONS.length || rows.some((row, index) => Number(row.version) !== MIGRATIONS[index].version || row.checksum !== MIGRATIONS[index].checksum)) throw new StoreError('schema_version_mismatch');
    return { version: MIGRATIONS.at(-1).version };
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
      if (versions.length > MIGRATIONS.length || versions.some((row, index) => Number(row.version) !== MIGRATIONS[index]?.version || row.checksum !== MIGRATIONS[index]?.checksum)) {
        throw new StoreError('schema_version_mismatch');
      }
      let applied = false;
      for (const migration of MIGRATIONS.slice(versions.length)) {
        for (const statement of migration.sql.split(';').map((s) => s.trim()).filter(Boolean)) await connection.query(statement);
        await connection.execute('INSERT INTO bridge_schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)', [migration.version, migration.checksum, Date.now()]);
        applied = true;
      }
      return { version: MIGRATIONS.at(-1).version, applied };
    } finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [lock]);
    }
  }, { timeoutMs: 30000 });
}
