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

// onEvent must commit inbox + routing atomically, enforce signal/deadline in
// its storage operations, and deduplicate late/uncertain commits on redelivery.
export function createFeishuAdapter({ sdk, wsClient, connectionId, botOpenId = '', onEvent,
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
  // Observability callbacks must never change ACK semantics or leak raw errors.
  function observe(level, status, code, durationMs) {
    try { log(level, 'feishu_ingress', status, { code, durationMs }); } catch {}
    if (level === 'error') {
      const reportingFailed = () => {
        try { log('warning', 'feishu_error_reporting', 'failed', { code: 'feishu_reporting_failed' }); } catch {}
      };
      try {
        Promise.resolve(reportError(new FeishuIngressError(code), { module: 'bridge', component: 'feishu', operation: 'ingress', status })).catch(reportingFailed);
      } catch { reportingFailed(); }
    }
  }
  async function receive(type, payload) {
    const started = Date.now();
    const controller = new AbortController();
    let timer;
    let rejectDeadline;
    const cancellation = new Promise((_, reject) => { rejectDeadline = reject; });
    const cancel = (code) => { controller.abort(); rejectDeadline(new FeishuIngressError(code)); };
    active.add(cancel);
    try {
      if (state === 'stopped') throw new FeishuIngressError('feishu_stopped');
      const event = normalizeFeishuEvent(type, payload, { connectionId, botOpenId, receivedAt: started });
      timer = setTimeout(() => cancel('feishu_ingress_timeout'), deadlineMs);
      await Promise.race([cancellation, Promise.resolve().then(() => onEvent(event, {
        signal: controller.signal, deadlineAt: started + deadlineMs,
      }))]);
      // Guard event-loop stalls and a commit that resolves after the budget.
      if (Date.now() - started >= deadlineMs || controller.signal.aborted) throw new FeishuIngressError('feishu_ingress_timeout');
      return undefined;
    } catch (error) {
      const code = error instanceof FeishuIngressError ? error.code : 'feishu_ingress_failed';
      // A rejected ingress remains eligible for platform redelivery; terminal
      // retry exhaustion is owned by core, not this per-attempt adapter.
      observe('warning', 'retryable_failure', code, Date.now() - started);
      throw new FeishuIngressError(code);
    } finally {
      clearTimeout(timer);
      active.delete(cancel);
    }
  }
  const dispatcher = new sdk.EventDispatcher({}).register({
    [RECEIVE]: (data) => receive(RECEIVE, data),
    [RECALL]: (data) => receive(RECALL, data),
  });
  return {
    dispatcher,
    async start() {
      if (state !== 'idle') throw new Error('feishu_adapter_already_started');
      state = 'starting';
      try { await wsClient.start({ eventDispatcher: dispatcher }); if (state !== 'stopped') state = 'started'; }
      catch { state = 'stopped'; wsClient.close({ force: true }); throw new Error('feishu_start_failed'); }
    },
    stop() {
      state = 'stopped';
      for (const cancel of active) cancel('feishu_stopped');
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
