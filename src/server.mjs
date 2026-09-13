import http from 'node:http';
import { ApiError } from './core/api.mjs';
import { safeObserver } from './logger.mjs';
export async function startServer({ config, log, api, readiness }) {
  log = safeObserver(log);
  let stopping = false;
  function reply(response, status, body) {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(JSON.stringify(body));
  }
  const server = http.createServer({ requestTimeout: 5000, headersTimeout: 5000 }, async (request, response) => {
    try {
    if (request.url.startsWith('/v1/') && api && !stopping) {
      const result = await api(request);
      reply(response, result.status, result.body);
    } else if (request.method !== 'GET') {
      reply(response, 405, { error: 'method_not_allowed' });
    } else if (request.url === '/health/live') {
      reply(response, stopping ? 503 : 200, { live: !stopping });
    } else if (request.url === '/health/ready') {
      const state = readiness ? await readiness() : {
        ready: false, reason: 'components_unconfigured',
        missing: ['feishu', 'codex', 'store'],
      };
      reply(response, !stopping && state.ready ? 200 : 503, { ...state, ready: !stopping && state.ready });
    } else {
      reply(response, 404, { error: 'not_found' });
    }
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      const conflict = ['session_busy_or_conflict', 'session_conflict', 'job_conflict', 'outbox_conflict', 'recovery_conflict', 'thread_scope_conflict'].includes(error.code);
      const invalid = ['invalid_store_input', 'invalid_store_limit', 'invalid_chat_argument', 'invalid_page_size', 'invalid_history_time', 'invalid_resource_type', 'invalid_message_content', 'invalid_file_name', 'invalid_recovery'].includes(error.code);
      const status = error instanceof ApiError ? error.status : conflict ? 409 : invalid ? 400 : 503;
      if (status === 503) log('error', 'http_api', 'failed', { code: 'service_unavailable' });
      reply(response, status, { error: error instanceof ApiError ? error.code : conflict ? 'conflict' : invalid ? 'invalid_payload' : 'service_unavailable' });
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
