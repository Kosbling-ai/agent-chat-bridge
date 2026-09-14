import { publicText } from '../../shared/public-progress.mjs';

const statuses = { running: '执行中', completed: '已完成', failed: '执行失败', interrupted: '已中断', retrying: '连接恢复中', deferred: '补充已转达' };
const panel = (id, title, elements) => ({ tag: 'collapsible_panel', element_id: id, expanded: false, header: { title: { tag: 'plain_text', content: title }, icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' }, icon_position: 'follow_text', icon_expanded_angle: -180 }, elements });
const md = (content) => ({ tag: 'markdown', content });
export function renderExecutionCard(state, answer = '', displayName = 'agent-chat-bridge') {
  const entries = (state.entries || []).slice(-24);
  const elements = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const running = group.filter((x) => x.status === 'running').length;
    elements.push(panel(`group_${elements.length}`, `${group.length} 个工具调用 · ${running ? `${running} 个执行中` : '已结束'}`, group.map((x, i) => panel(`tool_${elements.length}_${i}`, `${x.title} · ${statuses[x.status] || '已结束'}`, [md(x.summary || statuses[x.status] || '已结束')]))));
    group = [];
  };
  for (const entry of entries) {
    if (entry.kind === 'tool') group.push(entry);
    else { flush(); elements.push(md(publicText(entry.text, 800))); }
  }
  flush();
  if (state.omitted) elements.unshift(md('较早的执行过程已收起，仅展示最近进度。'));
  if (answer) elements.push(md(answer));
  if (!elements.length) elements.push(md('已收到，正在处理你的请求。'));
  elements.push(md(`**${statuses[state.status] || '执行中'}**${state.delivery === 'fallback' ? ' · 结果将通过普通消息送达' : ''}`));
  if (state.status === 'running' && state.turnId && state.jobId) elements.push({ tag: 'button', text: { tag: 'plain_text', content: '停止执行' }, type: 'danger', behaviors: [{ type: 'callback', value: { action: 'stop_execution', jobId: state.jobId, expectedTurnId: state.turnId } }] });
  let card = { schema: '2.0', config: { update_multi: true, summary: { content: `${displayName} · ${statuses[state.status] || '执行中'}` } }, header: { template: state.status === 'failed' ? 'red' : state.status === 'completed' ? 'green' : 'blue', title: { tag: 'plain_text', content: displayName } }, body: { elements } };
  // IM cards are limited to 30 KB, including UTF-8 and JSON scaffolding.
  while (Buffer.byteLength(JSON.stringify(card)) > 28000 && card.body.elements.length > (answer ? 2 : 1)) card.body.elements.shift();
  if (Buffer.byteLength(JSON.stringify(card)) > 28000) throw new Error('card final answer exceeds budget');
  return card;
}
export class ExecutionCard {
  constructor({ client, chatId, uuid, saved, persist = async () => {}, audit = async () => {}, intervalMs = 1000, logger = console, jobId = '', messageId = '', displayName = 'agent-chat-bridge' }) {
    this.client = client; this.chatId = chatId; this.uuid = uuid; this.persist = persist; this.audit = audit; this.logger = logger; this.jobId = String(jobId).slice(0, 64); this.messageId = String(messageId).slice(0, 80);
    this.intervalMs = Math.max(1000, Number(intervalMs) || 1000); this.displayName = displayName;
    this.state = { status: 'running', entries: [], jobId: this.jobId, ...saved };
    this.chain = Promise.resolve(); this.timer = null; this.closed = false; this.dirty = false;
    this.startedAt = Date.now(); this.failures = 0; this.inFlight = false;
  }
  log(status, level = 'info', extra = {}) {
    const event = { module: 'agent-chat-bridge', component: 'execution-card', operation: 'update', status, job_id: this.jobId, message_id: this.messageId, card_message_id: this.state.messageId || '', duration_ms: Date.now() - this.startedAt, ...extra };
    this.logger[level]?.(JSON.stringify(event));
    return Promise.resolve().then(() => this.audit(event)).catch(() => {
      this.logger.warn?.(JSON.stringify({ module: 'agent-chat-bridge', component: 'execution-card', operation: 'audit', status: 'fallback' }));
    });
  }
  snapshot() { return structuredClone(this.state); }
  push(event) {
    if (this.closed || this.state.delivery === 'fallback' || !event) return;
    if (event.kind === 'started') { this.state.status = 'running'; if (event.turnId) this.state.turnId = event.turnId; }
    if (event.kind === 'commentary' || event.kind === 'tool') {
      const entries = this.state.entries;
      const existing = entries.findIndex((x) => x.id === event.id);
      const value = event.kind === 'commentary' ? { kind: event.kind, id: event.id, text: publicText(event.text, 800), at: event.at } : { kind: 'tool', id: event.id, title: publicText(event.title, 100), summary: publicText(event.summary || statuses[event.status], 500), status: event.status, at: event.at };
      if (existing >= 0 && entries[existing].kind === 'tool' && entries[existing].status !== 'running' && value.status === 'running') return;
      if (existing >= 0) { value.at = Math.min(entries[existing].at || value.at || 0, value.at || entries[existing].at || 0); entries[existing] = value; }
      else entries.push(value);
      entries.sort((a, b) => (a.at || 0) - (b.at || 0));
      if (entries.length > 24) { entries.shift(); this.state.omitted = true; }
    }
    this.dirty = true;
    if (!this.timer) {
      // The first running card appears without waiting for the throttle window.
      if (!this.state.messageId) this.enqueue();
      this.timer = setInterval(() => { if (this.dirty) this.enqueue(); }, this.intervalMs);
      this.timer.unref?.();
    }
  }
  enqueue() {
    if (this.inFlight || this.closed || this.state.delivery === 'fallback') return this.chain;
    this.dirty = false;
    this.inFlight = true;
    this.chain = this.update().catch(async (error) => {
      this.failures++;
      await this.log('fallback', 'warn', { failure_count: this.failures, error_code: errorCode(error) }).catch(() => {});
      if (this.failures >= 3 || !this.state.messageId) this.state.delivery = 'fallback';
    }).finally(() => { this.inFlight = false; });
    return this.chain;
  }
  async update(answer = '') {
    const snapshot = this.snapshot();
    const card = renderExecutionCard(snapshot, answer, this.displayName);
    if (!this.state.messageId) {
      // Deterministic UUID handles an ambiguous create response or a crash before persistence.
      const response = await this.client.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: this.chatId, msg_type: 'interactive', content: JSON.stringify(card), uuid: this.uuid } });
      checkResponse(response);
      this.state.messageId = response?.data?.message_id;
      if (!this.state.messageId) throw new Error('card message id missing');
      snapshot.messageId = this.state.messageId;
      await this.persist(snapshot).catch(() => this.log('fallback', 'warn', { operation: 'persist_card' }));
      await this.log('started');
    } else {
      checkResponse(await this.client.im.v1.message.patch({ path: { message_id: this.state.messageId }, data: { content: JSON.stringify(card) } }));
      await this.persist(snapshot).catch(() => this.log('fallback', 'warn', { operation: 'persist_card' }));
    }
  }
  async pause() {
    this.stop(); await this.chain;
    this.state.status = 'retrying';
    if (this.state.messageId) await this.update().catch((error) => this.log('fallback', 'warn', { operation: 'pause_card', error_code: errorCode(error) }));
    await this.persist(this.snapshot());
    return this.snapshot();
  }
  stop() { this.closed = true; clearInterval(this.timer); this.timer = null; }
  async finish(answer, status = 'completed') {
    this.stop(); await this.chain;
    this.state.status = status;
    this.state.entries = this.state.entries.map((x) => x.kind === 'tool' && x.status === 'running' ? { ...x, status: status === 'completed' ? 'completed' : 'interrupted' } : x);
    if (this.state.delivery !== 'fallback') {
      try {
        await this.update(answer);
        await this.log('succeeded');
        return true;
      } catch (error) {
        this.state.delivery = 'fallback';
        await this.log('fallback', 'warn', { error_code: errorCode(error) }).catch(() => {});
      }
    }
    // Persist choice before normal-message delivery so recovery uses the same path.
    await this.persist(this.snapshot());
    if (this.state.messageId) await this.update('').catch((error) => this.log('fallback', 'warn', { operation: 'close_fallback_card', error_code: errorCode(error) }));
    return false;
  }
}
function errorCode(error) { return String(error?.code || error?.name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64); }
function checkResponse(response) {
  if (response?.code != null && response.code !== 0) {
    const error = new Error('Feishu card request rejected'); error.code = String(response.code); throw error;
  }
}

// A bounded, read-only sidecar. It cannot cancel/steer or retry a Codex turn.
export function observeExecutionCard({ card, load, since, intervalMs = 1000, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let cursor = { at: since, id: 0 };
  let highWater = since;
  const seen = new Set();
  let stopped = false;
  let pending = null;
  let failed = false;
  const poll = () => {
    if (stopped || pending || failed) return pending;
    pending = (async () => {
      const rows = await load(cursor);
      for (const row of rows) {
        cursor = { at: Number(row.created_at), id: Number(row.id) };
        highWater = Math.max(highWater, cursor.at);
        if (!row.progress_json || seen.has(String(row.id))) continue;
        seen.add(String(row.id));
        if (seen.size > 500) seen.delete(seen.values().next().value);
        let event;
        try { event = typeof row.progress_json === 'string' ? JSON.parse(row.progress_json) : row.progress_json; } catch { continue; }
        if (['started', 'commentary', 'tool'].includes(event?.kind)) card.push(event);
      }
      // Replay a bounded overlap for asynchronously committed events. Full pages
      // continue keyset paging first, so a busy chat cannot starve later rows.
      if (rows.length < 100) cursor = { at: Math.max(since, highWater - 10000), id: 0 };
    })().catch(async () => { failed = true; await card.log('fallback', 'warn', { operation: 'read_progress' }).catch(() => {}); }).finally(() => { pending = null; });
    return pending;
  };
  const timer = setIntervalFn(poll, Math.max(1000, intervalMs)); timer.unref?.();
  poll();
  return { card, async stop() {
    clearIntervalFn(timer);
    if (!stopped) { await pending; await poll(); stopped = true; }
    card.stop(); await card.chain;
    return card.snapshot();
  }, cancel() {
    stopped = true;
    clearIntervalFn(timer);
    card.stop();
  } };
}
