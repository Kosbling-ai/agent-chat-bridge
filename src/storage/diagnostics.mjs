import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { loadavg } from 'node:os';
import { safeObserver } from '../logger.mjs';
import { databaseError } from './errors.mjs';

const recorders = new WeakMap();
export function isStorageDiagnosticsEnabled(pool) { return recorders.has(pool); }
export function configureStorageDiagnosticRecorder(pool, callback) {
  const recorder = safeObserver(callback);
  recorders.set(pool, recorder);
  return () => { if (recorders.get(pool) === recorder) recorders.delete(pool); };
}
export function recordStorageDiagnostic(pool, event) { recorders.get(pool)?.(event); }

const STATUS_FIELDS = {
  Threads_connected:'dbThreadsConnected', Threads_running:'dbThreadsRunning',
  Innodb_buffer_pool_read_requests:'dbReadRequests', Innodb_buffer_pool_reads:'dbPhysicalReads',
  Innodb_data_pending_reads:'dbPendingReads', Innodb_data_pending_writes:'dbPendingWrites',
  Innodb_data_pending_fsyncs:'dbPendingFsyncs', Innodb_log_waits:'dbLogWaits',
  Innodb_row_lock_current_waits:'dbRowLockWaits', Innodb_row_lock_time:'dbRowLockTimeMs',
  Uptime:'dbUptimeSeconds',
};
const statusSql = `SHOW GLOBAL STATUS WHERE Variable_name IN (${Object.keys(STATUS_FIELDS).map(k=>`'${k}'`).join(',')})`;
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

// Read-only, bounded diagnostics. No query text, bound values, account names or
// message content enters an event. Server counters are shared across all bots.
export function attachStorageDiagnostics(pool, { log, intervalMs = 60000, burstLimit = 20,
  sampleServer, now = () => performance.now() } = {}) {
  log = safeObserver(log);
  const histogram = monitorEventLoopDelay({resolution:20});
  histogram.enable();
  let closed=false, pending, windowStart=now(), emitted=0, suppressed=0, lastSnapshot=-Infinity;
  let cpu=process.cpuUsage(), cpuAt=now();
  function context() {
    const native=pool?.pool;
    const fields={eventLoopDelayMaxMs:Math.round(histogram.max/1e6),
      rssMb:Math.round(process.memoryUsage().rss/1024/1024),hostLoad1Milli:Math.round(loadavg()[0]*1000)};
    for (const [field,key] of [['poolConnections','_allConnections'],['poolFree','_freeConnections'],['poolQueued','_connectionQueue']]) {
      const count=integer(native?.[key]?.length);if(count!==undefined)fields[field]=count;
    }
    return fields;
  }
  async function snapshot() {
    if(closed||pending)return pending;
    lastSnapshot=now();
    const contextFields=context(), currentCpu=process.cpuUsage();
    const stats={...contextFields,sampleWindowMs:Math.max(0,Math.round(lastSnapshot-cpuAt)),
      cpuUserMs:Math.max(0,Math.round((currentCpu.user-cpu.user)/1000)),
      cpuSystemMs:Math.max(0,Math.round((currentCpu.system-cpu.system)/1000)),diagnosticSuppressed:suppressed};
    cpu=currentCpu;cpuAt=lastSnapshot;suppressed=0;histogram.reset();
    pending=(async()=>{
      try {
        let rows;
        if(sampleServer)rows=await sampleServer();
        else {
          // This diagnostic read has its own short deadline and is deliberately
          // not instrumented: a failed probe cannot recursively trigger itself.
          const {withConnection}=await import('./connection.mjs');
          rows=await withConnection({getConnection:()=>pool.getConnection()},async c=>(await c.query(statusSql))[0],{timeoutMs:1500});
        }
        for(const row of rows??[]) {
          const key=STATUS_FIELDS[row.Variable_name],value=integer(Number(row.Value));
          if(key&&value!==undefined)stats[key]=value;
        }
        log('info','storage_snapshot','captured',stats);
      } catch(error) {
        const failure=databaseError(error);
        log('warning','storage_snapshot','unavailable',{...stats,errorClass:failure.code,
          reason:failure.reason,errorCode:failure.errorCode,errno:failure.errno,sqlState:failure.sqlState});
      }
    })().finally(()=>{pending=undefined;});
    return pending;
  }
  const detach=configureStorageDiagnosticRecorder(pool,event=>{
    const at=now();
    if(at-windowStart>=60000){windowStart=at;emitted=0;}
    if(emitted<burstLimit){emitted++;log('warning','storage_operation',event.status,{...event,...context()});}
    else suppressed++;
    if(at-lastSnapshot>=30000)void snapshot().catch(()=>{});
  });
  const timer=setInterval(()=>{void snapshot().catch(()=>{});},intervalMs);timer.unref?.();
  return {snapshot,async close(){closed=true;clearInterval(timer);detach();histogram.disable();await pending;}};
}
