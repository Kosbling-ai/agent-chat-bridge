import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { withConnection } from './connection.mjs';
import { StoreError } from './errors.mjs';

const MIGRATIONS = await Promise.all([
  [1, './migrations/001-initial.sql'],
  [2, './migrations/002-codex-sessions.sql'],
  [3, './migrations/003-forward-runtime.sql'],
  [4, './migrations/004-bot-connection.sql'],
].map(async ([version, path]) => {
  const sql = await readFile(new URL(path, import.meta.url), 'utf8');
  return { version, sql, checksum: createHash('sha256').update(sql).digest('hex') };
}));
const LEDGER = `CREATE TABLE IF NOT EXISTS bridge_schema_migrations (
  version INT UNSIGNED PRIMARY KEY, checksum CHAR(64) CHARACTER SET ascii NOT NULL,
  applied_at BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB`;
const LEGACY_SCOPE = `CREATE TABLE IF NOT EXISTS bridge_migration_004_scope (
  id TINYINT UNSIGNED PRIMARY KEY,
  legacy_connection_id VARCHAR(128) NULL
) ENGINE=InnoDB`;
const ASSISTANT_TABLES = [
  'assistant_codex_sessions', 'assistant_codex_events', 'assistant_codex_forward_jobs',
  'assistant_inbound_messages', 'assistant_message_events',
];

function statements(sql) { return sql.split(';').map((part) => part.trim()).filter(Boolean); }

async function column(connection, table) {
  const [rows] = await connection.execute(`SELECT DATA_TYPE AS type, CHARACTER_MAXIMUM_LENGTH AS size, IS_NULLABLE AS nullable
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'connection_id'`, [table]);
  return rows[0];
}

async function index(connection, table, name) {
  const [rows] = await connection.execute(`SELECT COLUMN_NAME AS name, SUB_PART AS prefix, NON_UNIQUE AS nonUnique
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX`, [table, name]);
  return rows;
}

function expectedIndex(statement) {
  const match = /^ALTER TABLE (\w+) ADD (UNIQUE )?INDEX (\w+) \((.+)\)$/i.exec(statement);
  if (!match) return null;
  return { table: match[1], name: match[3], unique: Boolean(match[2]), columns: match[4].split(',').map((part) => {
    const columnMatch = /^(\w+)(?:\((\d+)\))?(?: DESC)?$/.exec(part.trim());
    if (!columnMatch) throw new StoreError('schema_version_mismatch');
    return { name: columnMatch[1], prefix: columnMatch[2] ? Number(columnMatch[2]) : null };
  }) };
}

function indexMatches(actual, expected) {
  return actual.length === expected.columns.length && actual.every((part, position) =>
    part.name === expected.columns[position].name && Number(part.prefix ?? 0) === Number(expected.columns[position].prefix ?? 0)
    && Number(part.nonUnique) === Number(!expected.unique));
}

async function run004Step(connection, statement, desiredIndexes) {
  const addColumn = /^ALTER TABLE (\w+) ADD COLUMN connection_id /i.exec(statement);
  const modifyColumn = /^ALTER TABLE (\w+) MODIFY COLUMN connection_id /i.exec(statement);
  const dropIndex = /^ALTER TABLE (\w+) DROP INDEX (\w+)$/i.exec(statement);
  const addIndex = expectedIndex(statement);
  if (addColumn) {
    if (!await column(connection, addColumn[1])) await connection.query(statement);
  } else if (modifyColumn) {
    const current = await column(connection, modifyColumn[1]);
    if (!current || current.nullable === 'YES') await connection.query(statement);
  } else if (dropIndex) {
    const actual = await index(connection, dropIndex[1], dropIndex[2]);
    const desired = desiredIndexes.get(`${dropIndex[1]}.${dropIndex[2]}`);
    if (actual.length && (!desired || !indexMatches(actual, desired))) await connection.query(statement);
  } else if (addIndex) {
    const actual = await index(connection, addIndex.table, addIndex.name);
    if (!actual.length) await connection.query(statement);
    else if (!indexMatches(actual, addIndex)) throw new StoreError('schema_version_mismatch');
  } else throw new StoreError('schema_version_mismatch');
}

async function migrate004(connection, legacyConnectionId, database) {
  if (legacyConnectionId !== undefined && (typeof legacyConnectionId !== 'string' || !legacyConnectionId.trim() || legacyConnectionId.length > 128)) {
    throw new StoreError('invalid_legacy_connection_id');
  }
  // A running pre-004 writer uses the database-level lock and can still write unscoped rows.
  const oldWriterLock = `bridge:writer:${createHash('sha256').update(database).digest('hex').slice(0, 40)}`;
  const [[writer]] = await connection.query('SELECT GET_LOCK(?, 0) AS acquired', [oldWriterLock]);
  if (Number(writer.acquired) !== 1) throw new StoreError('writer_busy');
  try {
  let hasLegacyRows = false;
  for (const table of ASSISTANT_TABLES) {
    const [[row]] = await connection.query(`SELECT EXISTS(SELECT 1 FROM ${table} LIMIT 1) AS present`);
    hasLegacyRows ||= Number(row.present) === 1;
  }
  if (hasLegacyRows && legacyConnectionId === undefined) throw new StoreError('legacy_connection_id_required');
  await connection.query(LEGACY_SCOPE);
  const [scopeRows] = await connection.query('SELECT legacy_connection_id AS legacyConnectionId FROM bridge_migration_004_scope WHERE id = 1');
  if (scopeRows.length && (scopeRows[0].legacyConnectionId ?? undefined) !== legacyConnectionId) throw new StoreError('legacy_connection_id_mismatch');
  if (!scopeRows.length) await connection.execute('INSERT INTO bridge_migration_004_scope (id, legacy_connection_id) VALUES (1, ?)', [legacyConnectionId ?? null]);

  const sql = statements(MIGRATIONS[3].sql);
  const firstModify = sql.findIndex((part) => /^ALTER TABLE \w+ MODIFY COLUMN/i.test(part));
  if (firstModify !== ASSISTANT_TABLES.length) throw new StoreError('schema_version_mismatch');
  const desiredIndexes = new Map(sql.map(expectedIndex).filter(Boolean).map((entry) => [`${entry.table}.${entry.name}`, entry]));
  for (const statement of sql.slice(0, firstModify)) await run004Step(connection, statement, desiredIndexes);
  if (legacyConnectionId !== undefined) {
    for (const table of ASSISTANT_TABLES) await connection.execute(`UPDATE ${table} SET connection_id = ? WHERE connection_id IS NULL`, [legacyConnectionId]);
  }
  for (const statement of sql.slice(firstModify)) await run004Step(connection, statement, desiredIndexes);
  for (const table of ASSISTANT_TABLES) {
    const definition = await column(connection, table);
    if (definition?.type !== 'varchar' || Number(definition.size) !== 128 || definition.nullable !== 'NO') throw new StoreError('schema_version_mismatch');
    const [[row]] = await connection.query(`SELECT EXISTS(SELECT 1 FROM ${table} WHERE connection_id IS NULL LIMIT 1) AS present`);
    if (Number(row.present) !== 0) throw new StoreError('schema_version_mismatch');
  }
  for (const desired of desiredIndexes.values()) {
    if (!indexMatches(await index(connection, desired.table, desired.name), desired)) throw new StoreError('schema_version_mismatch');
  }
  } finally { await connection.query('SELECT RELEASE_LOCK(?)', [oldWriterLock]); }
}

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

export async function migrate(pool, { legacyConnectionId } = {}) {
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
        if (migration.version === 4) await migrate004(connection, legacyConnectionId, identity.name);
        else for (const statement of statements(migration.sql)) await connection.query(statement);
        await connection.execute('INSERT INTO bridge_schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)', [migration.version, migration.checksum, Date.now()]);
        applied = true;
      }
      return { version: MIGRATIONS.at(-1).version, applied };
    } finally {
      await connection.query('SELECT RELEASE_LOCK(?)', [lock]);
    }
  }, { timeoutMs: 30000 });
}
