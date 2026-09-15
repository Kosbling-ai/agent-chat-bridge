import { normalizeFeishuEvent, RECEIVE, RECALL } from './normalize.mjs';

export class FeishuIngressError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// SDK 1.60.0 has no public connected-state API. Keep this read-only dependency
// in one version-tested probe; missing internals fail closed on SDK upgrades.
export function probeFeishuConnection(wsClient) {
  try {
    if (typeof wsClient?.wsConfig?.getWSInstance !== 'function') return { connected: false, supported: false };
    const socket = wsClient.wsConfig.getWSInstance();
    return { connected: socket?.readyState === 1, supported: true };
  } catch { return { connected: false, supported: false }; }
}

// Feishu requires the SDK handler to acknowledge promptly. The ingress task is
// tracked for shutdown, but the platform's short ACK budget never owns a model
// waiter or interrupts a Codex turn.
export function createFeishuAdapter({ sdk, wsClient, connectionId, botOpenId = '', onEvent, onCardAction,
  deadlineMs = 2000, log = () => {}, reportError = () => {} }) {
  if (!sdk?.EventDispatcher || !wsClient || typeof onEvent !== 'function' || !connectionId) {
    throw new Error('invalid_feishu_adapter_dependencies');
  }
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs >= 3000) {
    throw new Error('invalid_feishu_ingress_deadline');
  }
  let state = 'idle';
  let probeWarningReported = false;
  const active = new Set();
  function safeLog(...args) {
    try { Promise.resolve(log(...args)).catch(() => {}); } catch {}
  }
  // Observability callbacks must never change ACK semantics or leak raw errors.
  function observe(level, status, code, durationMs) {
    safeLog(level, 'feishu_ingress', status, { code, durationMs });
    if (level === 'error') {
      const reportingFailed = () => {
        safeLog('warning', 'feishu_error_reporting', 'failed', { code: 'feishu_reporting_failed' });
      };
      try {
        Promise.resolve(reportError(new FeishuIngressError(code), { module: 'bridge', component: 'feishu', operation: 'ingress', status })).catch(reportingFailed);
      } catch { reportingFailed(); }
    }
  }
  async function runEvent(type, payload) {
    const started = Date.now();
    const controller = new AbortController();
    let timer;
    const cancellation = new Promise((_, reject) => controller.signal.addEventListener('abort', () => {
      reject(new FeishuIngressError(state === 'stopped' ? 'feishu_stopped' : 'feishu_ingress_timeout'));
    }, { once: true }));
    const cancel = () => controller.abort();
    active.add(cancel);
    try {
      if (state === 'stopped') throw new FeishuIngressError('feishu_stopped');
      const event = normalizeFeishuEvent(type, payload, { connectionId, botOpenId, receivedAt: started });
      timer = setTimeout(() => controller.abort(), deadlineMs);
      await Promise.race([cancellation, Promise.resolve().then(() => onEvent(event, {
        signal: controller.signal, deadlineAt: started + deadlineMs,
      }))]);
      if (controller.signal.aborted) throw new FeishuIngressError('feishu_ingress_timeout');
    } catch (error) {
      const code = error instanceof FeishuIngressError ? error.code : 'feishu_ingress_failed';
      observe('warning', 'retryable_failure', code, Date.now() - started);
    } finally {
      clearTimeout(timer);
      active.delete(cancel);
    }
  }
  function receive(type, payload) {
    void runEvent(type, payload);
    return Promise.resolve({});
  }
  async function receiveCardAction(payload) {
    if (state === 'stopped') throw new FeishuIngressError('feishu_stopped');
    if (typeof onCardAction !== 'function') return {};
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => onCardAction(payload)),
        new Promise(resolve => { timer = setTimeout(() => resolve({ toast: { type: 'info', content: '正在确认停止请求，请稍后查看卡片' } }), 2500); }),
      ]);
    } catch {
      return { toast: { type: 'error', content: '暂未确认停止，请稍后重试' } };
    } finally { clearTimeout(timer); }
  }
  const dispatcher = new sdk.EventDispatcher({}).register({
    [RECEIVE]: (data) => receive(RECEIVE, data),
    [RECALL]: (data) => receive(RECALL, data),
    'card.action.trigger': receiveCardAction,
  });
  return {
    dispatcher,
    async start() {
      if (state !== 'idle') throw new Error('feishu_adapter_already_started');
      state = 'starting';
      try { await wsClient.start({ eventDispatcher: dispatcher }); if (state !== 'stopped') state = 'started'; }
      catch { state = 'stopped'; wsClient.close({ force: true }); throw new Error('feishu_start_failed'); }
    },
    async stop() {
      state = 'stopped';
      for (const cancel of active) cancel();
      wsClient.close({ force: true });
    },
    status() {
      const probe = probeFeishuConnection(wsClient);
      if (!probe.supported && !probeWarningReported) {
        probeWarningReported = true;
        observe('error', 'failed', 'feishu_connection_probe_unavailable', 0);
      }
      return { state, activeReceives: active.size, connected: state === 'started' && probe.connected,
        connectionProbeSupported: probe.supported };
    },
  };
}
