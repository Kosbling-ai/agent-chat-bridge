import mysql from 'mysql2/promise';
import { StoreError, databaseError } from './errors.mjs';

export function createPoolFromEnvironment(references, env = process.env) {
  const fields = ['hostEnv', 'portEnv', 'userEnv', 'passwordEnv', 'databaseEnv'];
  if (!references || typeof references !== 'object' || Array.isArray(references)
      || Object.keys(references).some((key) => !fields.includes(key))) throw new StoreError('invalid_storage_config');
  const values = {};
  for (const field of fields) {
    const name = references[field];
    if (typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(name)) throw new StoreError('invalid_storage_reference');
    if (typeof env[name] !== 'string' || !env[name]) throw new StoreError('storage_environment_missing');
    values[field.slice(0, -3)] = env[name];
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(values.database)) {
    throw new StoreError('invalid_storage_environment');
  }
  return mysql.createPool({
    ...values, port, connectionLimit: 6, waitForConnections: false,
    connectTimeout: 1000, multipleStatements: false, charset: 'utf8mb4',
    supportBigNumbers: true, bigNumberStrings: true,
  });
}

// Deadline owns the actual connection, including late pool acquisition. Never
// return a timed-out/uncertain transaction to the pool or keep it running there.
export function withConnection(pool, operation, { timeoutMs = 1800, transaction = false } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw new StoreError('invalid_storage_deadline');
  return new Promise((resolve, reject) => {
    let connection;
    let expired = false;
    let committing = false;
    const timer = setTimeout(() => {
      expired = true;
      connection?.destroy();
      reject(new StoreError(committing ? 'commit_unknown' : 'store_timeout'));
    }, timeoutMs);
    (async () => {
      try {
        connection = await pool.getConnection();
        if (expired) { connection.destroy(); return; }
        await connection.query('SET SESSION innodb_lock_wait_timeout = 1');
        if (transaction) await connection.beginTransaction();
        const value = await operation(connection);
        if (expired) return;
        if (transaction) {
          committing = true;
          await connection.commit();
        }
        if (!expired) resolve(value);
      } catch (error) {
        if (expired) return;
        // A transport error during COMMIT does not prove rollback. Destroy and
        // let stable keys discover the result on the next attempt.
        if (committing) {
          connection?.destroy();
          connection = undefined;
          reject(new StoreError('commit_unknown'));
        } else {
          if (transaction && connection) {
            try { await connection.rollback(); } catch { connection.destroy(); connection = undefined; }
          }
          reject(databaseError(error));
        }
      } finally {
        clearTimeout(timer);
        if (connection && !expired) connection.release();
      }
    })();
  });
}
