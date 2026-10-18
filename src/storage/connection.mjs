import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { StoreError, databaseError, driverDetails } from './errors.mjs';
import { isStorageDiagnosticsEnabled, recordStorageDiagnostic } from './diagnostics.mjs';

const STORAGE_REFERENCE_FIELDS = ['hostEnv', 'portEnv', 'userEnv', 'passwordEnv', 'databaseEnv'];

export function storageConnectionReferences(storage) {
  if (!storage || typeof storage !== 'object' || Array.isArray(storage)) throw new StoreError('invalid_storage_config');
  return Object.fromEntries(STORAGE_REFERENCE_FIELDS.map(field => [field, storage[field]]));
}

export function createPoolFromEnvironment(references, env = process.env) {
  const fields = STORAGE_REFERENCE_FIELDS;
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
    ...values, port, connectionLimit: 6, waitForConnections: true, queueLimit: 64,
    connectTimeout: 1000, multipleStatements: false, charset: 'utf8mb4',
    supportBigNumbers: true, bigNumberStrings: true,
  });
}

// Deadline owns the actual connection, including late pool acquisition. Never
// return a timed-out/uncertain transaction to the pool or keep it running there.
export function withConnection(pool, operation, { timeoutMs = 1800, transaction = false } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw new StoreError('invalid_storage_deadline');
  const diagnosticsEnabled = isStorageDiagnosticsEnabled(pool);
  return new Promise((resolve, reject) => {
    let connection;
    let expired = false;
    let committing = false;
    let diagnosticRecorded = false;
    let dbConnectionId;
    const operationId = diagnosticsEnabled ? randomUUID() : undefined;
    const startedAt = diagnosticsEnabled ? performance.now() : 0;
    const timings = diagnosticsEnabled ? {
      poolWaitMs: 0,
      setupMs: 0,
      beginMs: 0,
      operationMs: 0,
      commitMs: 0,
      rollbackMs: 0,
    } : undefined;
    const timingFields = {
      acquire: 'poolWaitMs', setup: 'setupMs', begin: 'beginMs',
      operation: 'operationMs', commit: 'commitMs', rollback: 'rollbackMs',
    };
    let stage = 'acquire';
    let stageStartedAt = startedAt;
    let stageActive = diagnosticsEnabled;

    const finishStage = () => {
      if (!diagnosticsEnabled || !stageActive) return;
      const now = performance.now();
      timings[timingFields[stage]] += Math.max(0, now - stageStartedAt);
      stageActive = false;
    };
    const startStage = (nextStage) => {
      if (!diagnosticsEnabled) return;
      stage = nextStage;
      stageStartedAt = performance.now();
      stageActive = true;
    };
    const timingSnapshot = (now = performance.now(), deadlineExpired = false) => {
      const snapshot = { ...timings };
      if (stageActive) snapshot[timingFields[stage]] += Math.max(0, now - stageStartedAt);
      snapshot.durationMs = Math.max(0, now - startedAt);
      snapshot.timeoutMs = timeoutMs;
      snapshot.timeoutOvershootMs = deadlineExpired ? Math.max(0, snapshot.durationMs - timeoutMs) : 0;
      for (const [key, value] of Object.entries(snapshot)) snapshot[key] = Math.round(value);
      return snapshot;
    };
    const record = (status, eventStage, normalized, now, deadlineExpired = false) => {
      if (!diagnosticsEnabled || diagnosticRecorded || expired && status === 'slow') return;
      now ??= performance.now();
      diagnosticRecorded = true;
      const event = {
        operationId,
        code: status === 'slow' ? 'storage_operation_slow' : 'storage_operation_failed',
        status,
        stage: eventStage,
        transaction,
        ...timingSnapshot(now, deadlineExpired),
      };
      if (dbConnectionId !== undefined) event.dbConnectionId = dbConnectionId;
      if (normalized) {
        event.errorClass = normalized.code;
        for (const field of ['reason', 'errorCode', 'errno', 'sqlState']) {
          if (normalized[field] !== undefined) event[field] = normalized[field];
        }
      }
      try { recordStorageDiagnostic(pool, event); } catch { /* diagnostics must not affect storage behavior */ }
    };
    const timer = setTimeout(() => {
      expired = true;
      connection?.destroy();
      const error = new StoreError(committing ? 'commit_unknown' : 'store_timeout', {
        reason: committing ? 'commit_timeout' : 'operation_timeout',
      });
      record('failed', stage, error, undefined, true);
      reject(error);
    }, timeoutMs);
    (async () => {
      try {
        connection = await pool.getConnection();
        if (expired) { connection.destroy(); return; }
        if (diagnosticsEnabled && Number.isSafeInteger(connection?.threadId) && connection.threadId >= 0) {
          dbConnectionId = connection.threadId;
        }
        finishStage();
        startStage('setup');
        await connection.query('SET SESSION innodb_lock_wait_timeout = 1');
        finishStage();
        if (transaction) {
          startStage('begin');
          await connection.beginTransaction();
          finishStage();
        }
        startStage('operation');
        const value = await operation(connection);
        if (expired) return;
        finishStage();
        if (transaction) {
          committing = true;
          startStage('commit');
          await connection.commit();
          finishStage();
        }
        if (!expired) {
          if (diagnosticsEnabled) {
            const finishedAt = performance.now();
            if (finishedAt - startedAt >= 500) record('slow', stage, undefined, finishedAt);
          }
          resolve(value);
        }
      } catch (error) {
        if (expired) return;
        finishStage();
        const failedStage = stage;
        // A transport error during COMMIT does not prove rollback. Destroy and
        // let stable keys discover the result on the next attempt.
        if (committing) {
          connection?.destroy();
          connection = undefined;
          const normalized = new StoreError('commit_unknown', { reason: 'commit_error', ...driverDetails(error) });
          record('failed', failedStage, normalized);
          reject(normalized);
        } else {
          if (transaction && connection) {
            startStage('rollback');
            try { await connection.rollback(); } catch { connection.destroy(); connection = undefined; }
            finishStage();
          }
          if (expired) return;
          const normalized = databaseError(error);
          record('failed', failedStage, normalized);
          reject(normalized);
        }
      } finally {
        clearTimeout(timer);
        if (connection && !expired) connection.release();
      }
    })();
  });
}
