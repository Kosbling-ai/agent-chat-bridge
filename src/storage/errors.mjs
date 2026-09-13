export class StoreError extends Error {
  constructor(code) { super(code); this.name = 'StoreError'; this.code = code; }
}

export function databaseError(error) {
  if (error instanceof StoreError) return error;
  if (['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error?.code)) return new StoreError('store_contention');
  return new StoreError('store_unavailable');
}
