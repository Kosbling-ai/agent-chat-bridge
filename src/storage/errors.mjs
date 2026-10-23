export class StoreError extends Error {
  constructor(code, { reason, errorCode, errno, sqlState } = {}) {
    super(code); this.name = 'StoreError'; this.code = code;
    // Never retain raw SQL, driver messages, credentials, or arbitrary causes.
    if (typeof reason === 'string' && /^[a-z_]{1,64}$/.test(reason)) this.reason = reason;
    if (typeof errorCode === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(errorCode)) this.errorCode = errorCode;
    if (Number.isSafeInteger(errno) && errno >= 0) this.errno = errno;
    if (typeof sqlState === 'string' && /^[A-Za-z0-9]{1,16}$/.test(sqlState)) this.sqlState = sqlState;
  }
}

// Driver errors that repeat identically on every retry (bad SQL, missing
// schema objects, missing privileges, rejected values). They are not a slow or
// unreachable database, so they map to the non-transient store_invalid: the
// communication worker stops and the health watchdog restarts the process.
export const DETERMINISTIC_DRIVER_ERRORS = new Set([
  'ER_PARSE_ERROR', 'ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE', 'ER_KEY_DOES_NOT_EXITS',
  'ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR',
  'ER_WRONG_VALUE_COUNT_ON_ROW', 'ER_BAD_NULL_ERROR', 'ER_DATA_TOO_LONG',
]);

export function databaseError(error) {
  if (error instanceof StoreError) return error;
  if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error?.code)) return new StoreError('store_contention', driverDetails(error));
  if (DETERMINISTIC_DRIVER_ERRORS.has(error?.code)) return new StoreError('store_invalid', driverDetails(error));
  return new StoreError('store_unavailable', driverDetails(error));
}

export function driverDetails(error) {
  return { errorCode: error?.code, errno: error?.errno, sqlState: error?.sqlState };
}
