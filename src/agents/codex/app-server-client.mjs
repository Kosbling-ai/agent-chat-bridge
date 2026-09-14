import { spawn } from 'node:child_process';
import { IdleLifecycle, closeOwnedChild, classifyCodexRpcError } from './idle-lifecycle.mjs';

function emitLog(log, level, operation, status, detail = {}) {
  try { log?.(level, { module: 'agent-chat-bridge', component: 'codex-app-server', operation, status, ...detail }); } catch { /* logging is observational */ }
}

export function codexAppServerArgs(config = {}) {
  return [
    'app-server', '--listen', 'stdio://',
    '-c', `sandbox_workspace_write.network_access=${config.networkAccess === false ? 'false' : 'true'}`,
    '-c', 'shell_environment_policy.inherit=none',
  ];
}

export class CodexAppServerClient {
  constructor({ config, childEnv = {}, spawnImpl = spawn, eventSink = async () => {}, onDisconnect = () => {}, log = () => {}, now = Date.now } = {}) {
    if (!config?.bin || !config?.cwd || !config?.sharedHome) throw new Error('Codex app-server requires bin, cwd and sharedHome');
    if (!childEnv || typeof childEnv !== 'object' || Array.isArray(childEnv)) throw new Error('childEnv must be an object');
    this.config = config;
    this.spawnImpl = spawnImpl;
    this.eventSink = eventSink;
    this.onDisconnect = onDisconnect;
    this.log = log;
    this.now = now;
    this.childEnv = Object.freeze({ ...childEnv, CODEX_HOME: config.sharedHome });
    this.child = null;
    this.ready = false;
    this.starting = null;
    this.closing = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.notificationChain = Promise.resolve();
    this.fault = null;
    this.disconnectedChildren = new WeakSet();
    this.lifecycle = new IdleLifecycle({
      idleMs: config.idleCloseMs ?? 0,
      close: () => this.close('idle'),
      onError: () => emitLog(this.log, 'error', 'app_server_close', 'failed'),
    });
  }

  async ensureStarted() {
    this.lifecycle.assertRunning();
    if (this.closing) await this.closing;
    this.lifecycle.assertRunning();
    if (this.ready && this.child) return;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try { await this.starting; }
    catch (error) { await this.close('initialize_failure').catch(() => {}); throw error; }
    finally { this.starting = null; }
  }

  async start() {
    this.lifecycle.assertRunning();
    const child = this.spawnImpl(this.config.bin, codexAppServerArgs(this.config), {
      cwd: this.config.cwd,
      env: { ...this.childEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.child = child;
    this.ready = false;
    this.stdoutBuffer = '';
    child.stdout.setEncoding?.('utf8');
    child.stderr.setEncoding?.('utf8');
    child.stdin.on('error', (error) => { if (this.child === child && !this.closing) this.fail(error, child); });
    child.stdout.on('data', (chunk) => this.handleStdout(chunk, child));
    child.stderr.on('data', () => {}); // drain without retaining possibly sensitive output
    child.on('error', (error) => { if (this.child === child) this.fail(error, child); });
    child.once('exit', (code, signal) => this.handleExit(new Error(`codex app-server exited${code == null ? '' : ` code=${code}`}${signal ? ` signal=${signal}` : ''}`), child));
    await this.request('initialize', {
      clientInfo: { name: 'agent-chat-bridge', version: this.config.clientVersion || '0.2.3' },
      capabilities: { experimentalApi: true },
    }, { skipStart: true });
    if (this.child !== child) throw new Error('codex app-server child changed during initialize');
    this.ready = true;
    this.fault = null;
    emitLog(this.log, 'info', 'app_server_start', 'succeeded');
  }

  async request(method, params = {}, { skipStart = false, timeoutMs } = {}) {
    if (!skipStart) await this.ensureStarted();
    const child = this.child;
    if (!child?.stdin?.writable) throw new Error(`codex app-server unavailable before ${method}`);
    const id = this.nextId++;
    const duration = Number(timeoutMs || this.config.rpcTimeoutMs || 120_000);
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        const error = new Error(`codex app-server ${method} timed out after ${duration}ms`);
        error.code = 'CODEX_RPC_TIMEOUT'; error.outcome = 'unknown'; reject(error); this.fail(error, child);
      }, duration);
      timer.unref?.();
      this.pending.set(id, {
        method, child, timer, resolve, reject,
        threadId: typeof params?.threadId === 'string' ? params.threadId : undefined,
        expectedTurnId: typeof params?.expectedTurnId === 'string' ? params.expectedTurnId
          : method === 'turn/interrupt' && typeof params?.turnId === 'string' ? params.turnId : undefined,
      });
    });
    try { child.stdin.write(`${JSON.stringify({ id, method, params })}\n`); }
    catch (error) { this.rejectPending(id, error); this.fail(error, child); }
    return promise;
  }

  rejectPending(id, error) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id); clearTimeout(pending.timer); pending.reject(error);
  }

  handleStdout(chunk, child) {
    if (this.child !== child) return;
    this.stdoutBuffer += String(chunk || '');
    let newline;
    while ((newline = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { emitLog(this.log, 'warning', 'rpc_frame', 'invalid'); continue; }
      if (Object.hasOwn(message, 'id') && !message.method) this.handleResponse(message, child);
      else if (message.method && Object.hasOwn(message, 'id')) {
        child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } })}\n`);
      } else if (message.method) {
        const release = this.lifecycle.hold();
        this.notificationChain = this.notificationChain
          .then(() => (this.child === child
            ? this.eventSink({ method: message.method, params: message.params || {}, receivedAt: this.now() })
            : undefined))
          .catch(() => emitLog(this.log, 'warning', 'notification', 'failed'))
          .finally(release);
      }
    }
  }

  handleResponse(message, child) {
    const pending = this.pending.get(message.id);
    if (!pending || pending.child !== child) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.error) {
      const error = classifyCodexRpcError(message.error, pending);
      emitLog(this.log, 'warning', 'rpc_request', 'rejected', { rpc_method: error.rpcMethod, error_code: error.code });
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  close(reason = 'shutdown') {
    if (this.closing) return this.closing;
    const child = this.child;
    if (!child) return Promise.resolve();
    this.ready = false;
    const startedAt = this.now();
    emitLog(this.log, 'info', 'app_server_close', 'started', { reason });
    this.closing = closeOwnedChild(child, {
      graceMs: this.config.closeGraceMs ?? 5_000,
      onEscalate: (signal) => emitLog(this.log, 'warning', 'app_server_close', 'escalating', { reason, signal }),
    }).then(async () => {
      await this.notificationChain;
      if (this.child === child) this.handleExit(new Error('codex app-server closed'), child);
      this.closing = null;
      emitLog(this.log, 'info', 'app_server_close', 'succeeded', { reason, durationMs: this.now() - startedAt });
    });
    return this.closing;
  }

  fail(error, child) {
    if (this.child !== child) return;
    this.ready = false;
    this.fault = 'rpc_failure';
    this.rejectAll(error);
    this.notifyDisconnect(error, child);
    this.close('rpc_failure').catch(() => emitLog(this.log, 'error', 'app_server_close', 'failed'));
  }

  rejectAll(error) {
    const reason = error instanceof Error ? error : new Error(String(error || 'codex app-server exited'));
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    this.pending.clear();
  }

  handleExit(error, child) {
    if (this.child !== child) return;
    if (!this.closing) this.fault = 'unexpected_exit';
    this.ready = false; this.child = null; this.rejectAll(error); this.notifyDisconnect(error, child);
  }

  notifyDisconnect(error, child) {
    if (!child || this.disconnectedChildren.has(child)) return;
    this.disconnectedChildren.add(child);
    try { this.onDisconnect(error instanceof Error ? error : new Error(String(error || 'codex app-server exited')), child); }
    catch { emitLog(this.log, 'error', 'disconnect_callback', 'failed'); }
  }

  status() {
    return { ready: this.ready, starting: Boolean(this.starting), closing: Boolean(this.closing), active: this.lifecycle.active, pending: this.pending.size, fault: this.fault };
  }
}
