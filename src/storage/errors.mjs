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

export function databaseError(error) {
  if (error instanceof StoreError) return error;
  if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error?.code)) return new StoreError('store_contention', driverDetails(error));
  return new StoreError('store_unavailable', driverDetails(error));
}

export function driverDetails(error) {
  return { errorCode: error?.code, errno: error?.errno, sqlState: error?.sqlState };
}
