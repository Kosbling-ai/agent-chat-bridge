import http from 'node:http';
export async function startServer({ config, log }) {
  let stopping = false;
  function reply(response, status, body) {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(JSON.stringify(body));
  }
  const server = http.createServer({ requestTimeout: 5000, headersTimeout: 5000 }, (request, response) => {
    if (request.method !== 'GET') {
      reply(response, 405, { error: 'method_not_allowed' });
    } else if (request.url === '/health/live') {
      reply(response, stopping ? 503 : 200, { live: !stopping });
    } else if (request.url === '/health/ready') {
      reply(response, 503, {
        ready: false, reason: 'components_unconfigured',
        missing: ['feishu', 'codex', 'store'],
      });
    } else {
      reply(response, 404, { error: 'not_found' });
    }
  });
  const startedAt = Date.now();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.listen.port, config.listen.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  log('info', 'listen', 'succeeded', { port: address.port, durationMs: Date.now() - startedAt });
  let closePromise;
  return {
    server,
    close() {
      if (closePromise) return closePromise;
      stopping = true;
      const closingAt = Date.now();
      log('info', 'shutdown', 'started');
      closePromise = new Promise((resolve) => {
        const timer = setTimeout(() => server.closeAllConnections(), 2000);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          log('info', 'shutdown', 'succeeded', { durationMs: Date.now() - closingAt });
          resolve();
        });
        server.closeIdleConnections();
      });
      return closePromise;
    },
  };
}
