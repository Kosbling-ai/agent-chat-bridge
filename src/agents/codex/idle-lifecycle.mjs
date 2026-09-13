import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { classifyCodexRpcError as classifyProtocolError } from './protocol-errors.mjs';

export const DEFAULT_IDLE_CLOSE_MS = 60_000;
export const DEFAULT_CLOSE_GRACE_MS = 5_000;

export function resolveSharedHome({ configuredHome = '', inheritedHome = process.env.CODEX_HOME, home = homedir() } = {}) {
  const normalize = (value) => {
    const expanded = value === '~' ? home : value.startsWith('~/') ? resolve(home, value.slice(2)) : value;
    if (!isAbsolute(expanded)) throw new Error('Codex shared_home / CODEX_HOME must be absolute or start with ~/');
    try { return realpathSync(expanded); } catch { return resolve(expanded); }
  };
  const selected = normalize(configuredHome || resolve(home, '.codex'));
  if (inheritedHome && normalize(inheritedHome) !== selected) {
    const error = new Error('CODEX_HOME conflicts with configured shared home; existing bindings remain unchanged');
    error.code = 'CODEX_HOME_CONFLICT';
    throw error;
  }
  return selected;
}
export function classifyCodexRpcError(value, request = {}) {
  const providerText = typeof value === 'string' ? value : value?.message || value?.description || '';
  const reason = classifyProtocolError(value, request);
  const error = new Error('Codex RPC was rejected');
  error.code = reason?.kind === 'thread_archived' ? 'CODEX_THREAD_ARCHIVED'
    : request.method === 'turn/start' ? 'CODEX_TURN_START_UNCONFIRMED' : 'CODEX_RPC_REJECTED';
  error.outcome = request.method === 'turn/start' && !reason ? 'unknown' : 'rejected';
  error.rpcMethod = /^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/i.test(request.method || '') ? request.method : 'unknown';
  if (reason) error.reason = reason;
  if (/\bactive writer\b/i.test(providerText)) {
    error.message = 'Codex thread is active in another client';
    error.code = 'CODEX_THREAD_BUSY';
    error.retryable = true;
  }
  return error;
}

export function positiveDuration(value, fallback, name) {
  const result = Number(value || fallback);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${name} must be a positive number`);
  return result;
}

export class IdleLifecycle {
  constructor({ close, idleMs = DEFAULT_IDLE_CLOSE_MS, onError = () => {}, onIdle = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { close, idleMs, onError, onIdle, setTimer, clearTimer });
    this.active = 0;
    this.timer = null;
    this.closing = null;
    this.stopped = false;
  }
  stop() { this.stopped = true; this.clearTimer(this.timer); this.timer = null; }
  assertRunning() { if (this.stopped) throw new Error('Codex bridge is shutting down; new app-server work is blocked'); }
  hold() {
    this.clearTimer(this.timer); this.timer = null; this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.active === 0 && !this.stopped) {
        this.onIdle();
        this.timer = this.setTimer(() => this.closeIfIdle().catch(this.onError), this.idleMs);
        this.timer?.unref?.();
      }
    };
  }
  async run(operation) {
    this.assertRunning();
    while (this.closing) await this.closing;
    this.assertRunning();
    const release = this.hold();
    try { return await operation(); } finally { release(); }
  }
  async closeIfIdle() {
    if (this.active) return false;
    if (this.closing) return this.closing;
    this.clearTimer(this.timer);
    this.closing = Promise.resolve().then(this.close);
    try { await this.closing; return true; } finally { this.closing = null; }
  }
}

export async function closeOwnedChild(child, { graceMs = DEFAULT_CLOSE_GRACE_MS, onEscalate = () => {} } = {}) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  let exited = false;
  let markExited;
  const exit = new Promise((done) => { markExited = () => { exited = true; done(); }; child.once('exit', markExited); });
  const wait = async () => {
    let timer;
    await Promise.race([exit, new Promise((done) => { timer = setTimeout(done, graceMs); })]);
    clearTimeout(timer);
  };
  try {
    child.stdin?.end();
    await wait();
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      if (exited) return;
      onEscalate(signal);
      child.kill(signal);
      await wait();
    }
    if (!exited) throw new Error('Owned Codex app-server did not exit after bounded shutdown; restart is blocked');
  } finally { child.removeListener('exit', markExited); }
}
