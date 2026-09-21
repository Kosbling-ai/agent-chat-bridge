// MySQL owns connection lifecycle and transaction isolation. The bridge used
// to add a process-wide GET_LOCK on a dedicated connection, which made one
// transient connection failure take the whole service offline. Concurrency is
// enforced by short SQL transactions, unique keys, row leases and the
// connection_id scope in the storage operations.
//
// Keep this compatibility surface while callers and older injected tests move
// away from the former writer-lock options. It deliberately acquires no
// connection and performs no advisory-lock probe.
export async function acquireWriter(_pool, _onLost = () => {}, _options = {}) {
  return { assert() {}, async verify() {}, async close() {} };
}
