// Only fixed lifecycle fields are accepted; never serialize config, requests,
// arbitrary Error objects, headers, environment values, or message content.
export function createLogger(stream = process.stdout, { component = 'service', reportError } = {}) {
  return (level, operation, status, { code, durationMs, port } = {}) => {
    const event = {
      timestamp: new Date().toISOString(), level, module: 'bridge',
      component, operation, status,
      ...(code !== undefined ? { code } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(port !== undefined ? { port } : {}),
    };
    stream.write(`${JSON.stringify(event)}\n`);
    if (level === 'error' && reportError) {
      try { Promise.resolve(reportError(event)).catch(() => {}); } catch { /* reporting cannot change the operation outcome */ }
    }
  };
}

export function createErrorReporter({ url, token, warn, fetchImpl = fetch }) {
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
