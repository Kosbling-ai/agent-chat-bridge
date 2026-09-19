// Only fixed lifecycle fields are accepted; never serialize config, requests,
// arbitrary Error objects, headers, environment values, or message content.
export function safeObserver(callback = () => {}) {
  return (...args) => {
    try { Promise.resolve(callback(...args)).catch(() => {}); } catch { /* observability never alters control flow */ }
  };
}
export function createLogger(stream = process.stdout, { component = 'service', reportError } = {}) {
  return (level, operation, status, { code, reason, consecutiveMisses, durationMs, port, rpcMethod, stage, runId, operationId, attempt, maxAttempts, nextRetryAt,
    hookId, eventId, eventType, scopePrefix, statusCode, jobId, errorClass } = {}) => {
    const identifier = (value, max = 96) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9_:/.-]+$/.test(value) ? value : undefined;
    const boundedInteger = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
    const event = {
      timestamp: new Date().toISOString(), level, module: 'bridge',
      component, operation, status,
      ...(identifier(code, 64) !== undefined ? { code } : {}),
      ...(identifier(reason, 64) !== undefined ? { reason } : {}),
      ...(boundedInteger(consecutiveMisses, 0, Number.MAX_SAFE_INTEGER) !== undefined ? { consecutive_misses: consecutiveMisses } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(identifier(rpcMethod, 64) !== undefined ? { rpc_method: rpcMethod } : {}),
      ...(identifier(stage, 64) !== undefined ? { stage } : {}),
      ...(identifier(runId, 64) !== undefined ? { run_id: runId } : {}),
      ...(identifier(operationId, 64) !== undefined ? { operation_id: operationId } : {}),
      ...(boundedInteger(attempt, 0, 10_000) !== undefined ? { attempt } : {}),
      ...(boundedInteger(maxAttempts, 1, 10) !== undefined ? { max_attempts: maxAttempts } : {}),
      ...(boundedInteger(nextRetryAt, 0, Number.MAX_SAFE_INTEGER) !== undefined ? { next_retry_at: nextRetryAt } : {}),
      ...(identifier(hookId, 128) !== undefined ? { hook_id: hookId } : {}),
      ...(identifier(eventId, 128) !== undefined ? { event_id: eventId } : {}),
      ...(identifier(eventType, 64) !== undefined ? { type: eventType } : {}),
      ...(identifier(scopePrefix, 64) !== undefined ? { scope_prefix: scopePrefix } : {}),
      ...(boundedInteger(statusCode, 100, 599) !== undefined ? { status_code: statusCode } : {}),
      ...(identifier(jobId, 64) !== undefined ? { job_id: jobId } : {}),
      ...(identifier(errorClass, 64) !== undefined ? { error_class: errorClass } : {}),
    };
    stream.write(`${JSON.stringify(event)}\n`);
    if (level === 'error' && reportError) {
      try { Promise.resolve(reportError(event)).catch(() => {}); } catch { /* reporting cannot change the operation outcome */ }
    }
  };
}

export function createErrorReporter({ url, token, warn, fetchImpl = fetch }) {
  warn = safeObserver(warn);
  const pending = new Set();
  return {
    report(event) {
      if (pending.size >= 4) { warn('warning', 'error_reporting', 'dropped', { code: 'report_capacity' }); return; }
      const task = Promise.resolve().then(async () => {
        // event is built by createLogger's fixed whitelist, never a raw Error.
        const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(event) });
        await response.body?.cancel();
        if (!response.ok) throw new Error('report_failed');
      }).catch(() => warn('warning', 'error_reporting', 'failed', { code: 'report_failed' })).finally(() => pending.delete(task));
      pending.add(task);
    },
    async close() { await Promise.allSettled(pending); },
  };
}
