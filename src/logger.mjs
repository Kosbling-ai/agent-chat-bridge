// Only fixed lifecycle fields are accepted; never serialize config, requests,
// arbitrary Error objects, headers, environment values, or message content.
export function createLogger(stream = process.stdout) {
  return (level, operation, status, { code, durationMs, port } = {}) => {
    stream.write(`${JSON.stringify({
      timestamp: new Date().toISOString(), level, module: 'bridge',
      component: 'foundation', operation, status,
      ...(code !== undefined ? { code } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(port !== undefined ? { port } : {}),
    })}\n`);
  };
}
