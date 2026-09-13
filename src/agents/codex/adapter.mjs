import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export class CodexAdapterError extends Error {
  constructor(code, { outcome = 'not_started', rpcCode } = {}) {
    super(code);
    this.name = 'CodexAdapterError';
    this.code = code;
    this.outcome = outcome;
    if (Number.isInteger(rpcCode)) this.rpcCode = rpcCode;
  }
}

const error = (code, options) => new CodexAdapterError(code, options);
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 512;
function positive(value, fallback, max) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > max) throw error('invalid_codex_options');
  return result;
}
function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }

/** Store-independent, single-lifetime stdio client. Reconnect with a new instance. */
export function createCodexAdapter(options, dependencies = {}) {
  const { bin, cwd, env } = options || {};
  const { spawnProcess = spawn, onNotification, onFault, log = () => {} } = dependencies;
  if (typeof bin !== 'string' || !bin || typeof cwd !== 'string' || !isAbsolute(cwd)
      || !record(env) || Object.values(env).some((value) => typeof value !== 'string')
      || typeof onNotification !== 'function' || typeof onFault !== 'function') {
    throw error('invalid_codex_options');
  }
  const rpcTimeoutMs = positive(options.rpcTimeoutMs, 10000, 300000);
  const shutdownGraceMs = positive(options.shutdownGraceMs, 1000, 30000);
  const maxFrameBytes = positive(options.maxFrameBytes, 8 * 1024 * 1024, 64 * 1024 * 1024);
  const maxPendingRequests = positive(options.maxPendingRequests, 128, 10000);
  const maxQueuedNotifications = positive(options.maxQueuedNotifications, 256, 10000);
  const childEnv = { ...env };
  const threadDefaults = { ...(options.threadDefaults ?? {}) };
  const trustedThreadKeys = ['model', 'approvalPolicy', 'sandbox', 'developerInstructions', 'baseInstructions'];
  if ((options.threadDefaults !== undefined && !record(options.threadDefaults)) || Object.keys(threadDefaults).some((key) => !trustedThreadKeys.includes(key))
      || Object.values(threadDefaults).some((value) => typeof value !== 'string')) throw error('invalid_codex_options');
  let state = 'idle';
  let child;
  let nextId = 1;
  let startPromise;
  let closePromise;
  let shutdownPromise;
  let resolveClosed;
  let childClosed;
  let faultReported = false;
  let buffered = '';
  let queued = 0;
  let notificationFailure;
  let notificationChain = Promise.resolve();
  const decoder = new StringDecoder('utf8');
  const pending = new Map();

  function lifecycle(level, operation, status, code) {
    // Fixed fields only. Provider stderr, messages, paths and env are never logged.
    try { Promise.resolve(log(level, operation, status, code ? { code } : {})).catch(() => {}); } catch { /* logger must not crash cleanup */ }
  }
  function bounded(promise, milliseconds, code) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(error(code, { outcome: 'unknown' })), milliseconds);
      Promise.resolve(promise).then(
        (value) => { clearTimeout(timer); resolve(value); },
        (reason) => { clearTimeout(timer); reject(reason); },
      );
    });
  }
  function rejectPending(reason) {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(reason); }
    pending.clear();
  }
  function fail(code) {
    if (state === 'stopped' || state === 'failed' || faultReported) return;
    if (state !== 'stopping') state = 'failed';
    const reason = error(code, { outcome: 'unknown' });
    rejectPending(reason);
    lifecycle('error', 'codex_connection', 'failed', code);
    if (!faultReported) {
      faultReported = true;
      bounded(Promise.resolve().then(() => onFault({ code, outcome: 'unknown' })), rpcTimeoutMs, 'codex_fault_sink_timeout')
        .catch(() => lifecycle('error', 'codex_fault_sink', 'failed', 'codex_fault_sink_failed'));
    }
    terminate().catch(() => lifecycle('error', 'codex_shutdown', 'failed', 'codex_shutdown_timeout'));
  }
  function send(message) {
    let serialized;
    try { serialized = JSON.stringify(message) + '\n'; } catch { throw error('invalid_codex_payload'); }
    if (Buffer.byteLength(serialized) > maxFrameBytes) throw error('codex_frame_too_large');
    if (!child?.stdin?.writable) throw error('codex_connection_unavailable');
    // A slow/broken pipe must not grow the write queue without bound.
    if (child.stdin.writableLength + Buffer.byteLength(serialized) > maxFrameBytes * 2) {
      fail('codex_write_backpressure');
      throw error('codex_write_backpressure', { outcome: 'unknown' });
    }
    child.stdin.write(serialized, (reason) => { if (reason) fail('codex_write_failed'); });
  }
  function rpc(method, params, initializing = false) {
    if (state !== 'ready' && !(initializing && state === 'starting')) return Promise.reject(error('codex_not_ready'));
    if (pending.size >= maxPendingRequests) return Promise.reject(error('codex_request_capacity'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail('codex_rpc_timeout'), rpcTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); } catch (reason) {
        clearTimeout(timer);
        pending.delete(id);
        reject(reason instanceof CodexAdapterError ? reason : error('codex_write_failed', { outcome: 'unknown' }));
      }
    });
  }
  function notify(message) {
    if (++queued > maxQueuedNotifications) { queued--; fail('codex_notification_capacity'); return; }
    notificationChain = notificationChain.then(async () => {
      if (faultReported || state === 'stopped') return;
      await bounded(Promise.resolve().then(() => onNotification(message)), rpcTimeoutMs, 'codex_notification_timeout');
    }).catch(() => {
      notificationFailure = error('codex_notification_delivery_failed', { outcome: 'unknown' });
      fail(notificationFailure.code);
    }).finally(() => { queued--; });
  }
  function receive(message) {
    if (!record(message)) { fail('codex_invalid_frame'); return; }
    const hasId = Object.hasOwn(message, 'id');
    if (typeof message.method === 'string') {
      if (hasId) {
        if (!(typeof message.id === 'string' || Number.isSafeInteger(message.id))) { fail('codex_invalid_frame'); return; }
        // B2 has no approval UI or dynamic-tool executor: always reject, never approve.
        send({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } });
        lifecycle('warning', 'codex_server_request', 'rejected', 'codex_server_request_unsupported');
        notify({ method: 'bridge/serverRequestRejected', params: {
          requestId: message.id, method: message.method,
          threadId: message.params?.threadId, turnId: message.params?.turnId,
        } });
      } else {
        notify({ method: message.method, params: message.params ?? {} });
      }
      return;
    }
    if (!hasId || (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error'))) {
      fail('codex_invalid_frame'); return;
    }
    const entry = pending.get(message.id);
    if (!entry) { lifecycle('warning', 'codex_rpc', 'ignored', 'codex_unmatched_response'); return; }
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (Object.hasOwn(message, 'error')) {
      // Do not propagate untrusted provider error messages into logs/API errors.
      entry.reject(error('codex_rpc_rejected', { outcome: 'rejected', rpcCode: message.error?.code }));
    } else entry.resolve(message.result);
  }
  function data(chunk) {
    if (state === 'failed' || state === 'stopping' || state === 'stopped') return;
    buffered += decoder.write(chunk);
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (Buffer.byteLength(line) > maxFrameBytes) { fail('codex_frame_too_large'); return; }
      if (!line.trim()) continue;
      try { receive(JSON.parse(line)); } catch { fail('codex_invalid_frame'); }
      if (state === 'failed') return;
    }
    if (Buffer.byteLength(buffered) > maxFrameBytes) fail('codex_frame_too_large');
  }
  function terminate() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (!child) return;
      child.kill('SIGTERM');
      try { await bounded(childClosed, shutdownGraceMs, 'codex_shutdown_timeout'); }
      catch {
        child.kill('SIGKILL');
        await bounded(childClosed, shutdownGraceMs, 'codex_shutdown_timeout');
      }
    })();
    return closePromise;
  }
  async function start() {
    if (startPromise && (state === 'starting' || state === 'ready')) return startPromise;
    if (state !== 'idle') throw error('codex_lifecycle_closed');
    state = 'starting';
    lifecycle('info', 'codex_start', 'started');
    startPromise = (async () => {
      try {
        childClosed = new Promise((resolve) => { resolveClosed = resolve; });
        child = spawnProcess(bin, ['app-server', '--listen', 'stdio://'], { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
        child.once('error', () => fail('codex_spawn_failed'));
        child.once('exit', () => { if (state !== 'stopping') fail('codex_process_exited'); });
        child.once('close', () => {
          resolveClosed();
          if (state !== 'stopping' && state !== 'failed') fail('codex_process_closed');
          buffered = '';
          child.stdout.removeAllListeners();
          child.stdin.removeAllListeners();
          child.removeAllListeners();
        });
        child.stdin.on('error', () => fail('codex_write_failed'));
        child.stdout.on('data', data);
        child.stdout.on('error', () => fail('codex_read_failed'));
        child.stderr.resume(); // Drain without storing or echoing potentially sensitive tool output.
        await rpc('initialize', { clientInfo: { name: 'agent-chat-bridge', version: '0.0.0' }, capabilities: {} }, true);
        if (state !== 'starting') throw error('codex_start_interrupted', { outcome: 'unknown' });
        send({ method: 'initialized' });
        state = 'ready';
        lifecycle('info', 'codex_start', 'succeeded');
      } catch (reason) {
        fail('codex_initialize_failed');
        throw reason instanceof CodexAdapterError ? reason : error('codex_initialize_failed');
      }
    })();
    return startPromise;
  }
  function checkedParams(params, allowed, required = []) {
    if (!record(params) || Object.keys(params).some((key) => !allowed.includes(key))
        || required.some((key) => !validId(params[key]))) throw error('invalid_codex_params');
    if (Object.hasOwn(params, 'input') && (!Array.isArray(params.input) || !params.input.length)) throw error('invalid_codex_input');
    return params;
  }
  return Object.freeze({
    start,
    status: () => ({ state, pendingRequests: pending.size, queuedNotifications: queued }),
    close() {
      if (shutdownPromise) return shutdownPromise;
      state = 'stopping';
      lifecycle('info', 'codex_shutdown', 'started');
      rejectPending(error('codex_closed', { outcome: 'unknown' }));
      shutdownPromise = (async () => {
        try {
          await terminate();
          await bounded(notificationChain, rpcTimeoutMs, 'codex_notification_timeout');
          if (notificationFailure) throw notificationFailure;
        } catch (reason) {
          fail(reason instanceof CodexAdapterError ? reason.code : 'codex_shutdown_failed');
          throw reason;
        }
        finally { state = 'stopped'; lifecycle('info', 'codex_shutdown', 'finished'); }
      })();
      return shutdownPromise;
    },
    startThread(params = {}) { checkedParams(params, []); return rpc('thread/start', { ...threadDefaults, cwd }); },
    resumeThread(params) { return rpc('thread/resume', { ...checkedParams(params, ['threadId'], ['threadId']), ...threadDefaults, cwd }); },
    readThread(params) { return rpc('thread/read', checkedParams(params, ['threadId', 'includeTurns'], ['threadId'])); },
    startTurn(params) { if (!Array.isArray(params?.input) || !params.input.length) throw error('invalid_codex_input'); return rpc('turn/start', checkedParams(params, ['threadId', 'input', 'model', 'effort', 'clientUserMessageId'], ['threadId'])); },
    steerTurn(params) { if (!Array.isArray(params?.input) || !params.input.length) throw error('invalid_codex_input'); return rpc('turn/steer', checkedParams(params, ['threadId', 'expectedTurnId', 'input', 'clientUserMessageId'], ['threadId', 'expectedTurnId'])); },
    interruptTurn(params) { return rpc('turn/interrupt', checkedParams(params, ['threadId', 'turnId'], ['threadId', 'turnId'])); },
  });
}
