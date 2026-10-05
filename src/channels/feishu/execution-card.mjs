import { DEFAULT_CARD_TEXT } from './card-text.mjs';
import { escapeMarkdown, formatText } from '../../shared/text-template.mjs';
import { publicText, renderPublicToolEntry } from '../../shared/public-progress.mjs';

const panel = (id, title, elements) => ({ tag: 'collapsible_panel', element_id: id, expanded: false, header: { title: { tag: 'plain_text', content: title }, icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' }, icon_position: 'follow_text', icon_expanded_angle: -180 }, elements });
const md = (content, textSize) => ({ tag: 'markdown', content, ...(textSize ? { text_size: textSize } : {}) });
const progressText = (content) => ({ tag: 'div', text: { tag: 'plain_text', content, text_size: 'normal', text_color: 'grey' } });
const answerMd = (content) => md(content, 'heading');
const TERMINAL = new Set(['completed', 'failed', 'interrupted', 'deferred']);
const CARD_BUDGET = 28000;
const oneLine = (text) => publicText(text, 800).replace(/\s+/g, ' ').trim();
// A plain line right after a list item would be read as that item's continuation.
const joinLines = (lines) => lines.map((x, i) => `${i && x.kind === 'commentary' && lines[i - 1].kind === 'tool' ? '\n' : ''}${x.text}`).join('\n');
// Visible area: answer (or latest progress while live) and status; the process
// is one collapsed plain list, never nested panels.
export function renderExecutionCard(state, answer = '', displayName = 'agent-chat-bridge', cardText = DEFAULT_CARD_TEXT) {
  const copy = { ...DEFAULT_CARD_TEXT, ...cardText };
  const title = copy.title || displayName;
  const statusText = copy[state.status] || copy.running;
  const live = !TERMINAL.has(state.status);
  const entries = (state.entries || []).slice(-24);
  const tools = entries.filter((x) => x.kind === 'tool');
  const running = live ? tools.filter((x) => x.status === 'running').length : 0;
  // One line per tool: durations, exit codes and tool names stay out of the card.
  const toolLine = (x) => `- ${escapeMarkdown(formatText(copy.toolItem, { title: renderPublicToolEntry(x, copy).title, status: copy[x.status] || copy.toolUnknownStatus }))}`;
  // Live cards list tools only; terminal cards keep commentary and tools in time order.
  const lines = state.silent ? [] : (live ? tools : entries).map((x) => x.kind === 'tool' ? { kind: 'tool', text: toolLine(x) }
    : oneLine(x.text) ? { kind: 'commentary', text: `· ${escapeMarkdown(oneLine(x.text))}` } : null).filter(Boolean);
  const groupTitle = tools.length ? formatText(copy.toolGroup, { count: tools.length, running, activity: running ? formatText(copy.toolGroupRunning, { running }) : copy.toolGroupFinished }) : copy.processGroup;
  const head = [];
  // A silent completion never renders the Agent's answer, only neutral card copy.
  if (state.silent) head.push(md(escapeMarkdown(copy.silentReply)));
  else if (answer) head.push(answerMd(answer));
  else if (live) {
    const latest = entries.findLast((x) => x.kind === 'commentary' && String(x.text || '').trim());
    head.push(progressText(latest ? publicText(latest.text, 800) : copy.received));
  }
  if (state.status === 'running' && state.progressUnavailable) head.push(progressText(copy.progressUnavailable));
  head.push(md(`**${escapeMarkdown(formatText(copy.statusFooter, { status: statusText }))}**${state.delivery === 'fallback' ? escapeMarkdown(formatText(copy.fallbackSuffix, { fallback: copy.fallback })) : ''}`));
  const tail = [];
  if (state.status === 'running' && state.turnId && state.jobId) tail.push({ tag: 'button', text: { tag: 'plain_text', content: copy.stopButton }, type: 'danger', behaviors: [{ type: 'callback', value: { action: 'stop_execution', jobId: state.jobId, expectedTurnId: state.turnId } }] });
  if (state.status === 'failed' && state.forkSourceThreadId && state.jobId) tail.push({ tag: 'button', text: { tag: 'plain_text', content: copy.forkButton }, type: 'primary', behaviors: [{ type: 'callback', value: { action: 'fork_busy_session', jobId: state.jobId, expectedSourceThreadId: state.forkSourceThreadId } }] });
  const build = (kept, omitted, withPanel) => {
    const body = joinLines([...(omitted ? [{ kind: 'note', text: escapeMarkdown(copy.omitted) }] : []), ...kept]);
    return { schema: '2.0', config: { update_multi: true, summary: { content: formatText(copy.cardSummary, { title, status: statusText }) } }, header: { template: state.status === 'failed' ? 'red' : state.status === 'completed' ? 'green' : 'blue', title: { tag: 'plain_text', content: title } }, body: { elements: [...head, ...(withPanel ? [panel('process', groupTitle, [md(body)])] : []), ...tail] } };
  };
  // IM cards are limited to 30 KB, including UTF-8 and JSON scaffolding. The
  // oldest process lines go first, then the panel; the answer is never cut.
  const fits = (value) => Buffer.byteLength(JSON.stringify(value)) <= CARD_BUDGET;
  let kept = lines, omitted = Boolean(state.omitted), card = build(kept, omitted, lines.length > 0);
  while (!fits(card) && kept.length) { kept = kept.slice(1); omitted = true; card = build(kept, omitted, true); }
  if (!fits(card)) card = build([], false, false);
  if (!fits(card)) throw new Error('card final answer exceeds budget');
  return card;
}
export class ExecutionCard {
  constructor({ client, chatId, uuid, saved, persist = async () => {}, audit = async () => {}, intervalMs = 1000, logger = console, jobId = '', messageId = '', displayName = 'agent-chat-bridge', cardTextProvider = async () => DEFAULT_CARD_TEXT }) {
    this.client = client; this.chatId = chatId; this.uuid = uuid; this.persist = persist; this.audit = audit; this.logger = logger; this.jobId = String(jobId).slice(0, 64); this.messageId = String(messageId).slice(0, 80);
    this.cardTextProvider = cardTextProvider;
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
  setForkSource(threadId) { this.state.forkSourceThreadId = String(threadId || ''); }
  setProgressUnavailable(value) {
    if (this.closed || this.state.delivery === 'fallback') return;
    const next = value === true;
    if (Boolean(this.state.progressUnavailable) === next) return;
    if (next) this.state.progressUnavailable = true;
    else delete this.state.progressUnavailable;
    this.dirty = true;
    this.enqueue();
  }
  push(event) {
    if (this.closed || this.state.delivery === 'fallback' || !event) return;
    if (event.kind === 'started') { this.state.status = 'running'; if (event.turnId) this.state.turnId = event.turnId; }
    if (event.kind === 'commentary' || event.kind === 'tool') {
      const entries = this.state.entries;
      const existing = entries.findIndex((x) => x.id === event.id);
      const value = event.kind === 'commentary' ? { kind: event.kind, id: event.id, text: publicText(event.text, 800), at: event.at } : { kind: 'tool', id: event.id, title: publicText(event.title, 100), summary: publicText(event.summary || '', 500), ...(event.presentation ? { presentation: structuredClone(event.presentation) } : {}), status: event.status, at: event.at };
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
    const card = renderExecutionCard(snapshot, answer, this.displayName, await this.cardTextProvider());
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
  // Closes an existing card as completed with neutral copy instead of the answer.
  // It never creates a card and never switches to ordinary-message fallback.
  async finishSilently() {
    this.stop(); await this.chain;
    if (!this.state.messageId) return false;
    this.state.status = 'completed';
    this.state.silent = 'completed';
    delete this.state.delivery;
    this.state.entries = this.state.entries.map((x) => x.kind === 'tool' && x.status === 'running' ? { ...x, status: 'completed' } : x);
    try {
      await this.update('');
      await this.log('succeeded', 'info', { operation: 'silent_complete' });
      return true;
    } catch (error) {
      await this.log('fallback', 'warn', { operation: 'silent_complete', error_code: errorCode(error) }).catch(() => {});
      return false;
    }
  }
}
function errorCode(error) { return String(error?.code || error?.name || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64); }
function checkResponse(response) {
  if (response?.code != null && response.code !== 0) {
    const error = new Error('Feishu card request rejected'); error.code = String(response.code); throw error;
  }
}

// A bounded, read-only sidecar. It cannot cancel/steer or retry a Codex turn.
export function observeExecutionCard({ card, load, since, intervalMs = 1000, setIntervalFn = setInterval, clearIntervalFn = clearInterval, now = Date.now }) {
  const baseDelayMs = Math.max(1000, Number(intervalMs) || 1000);
  const terminalCodes = new Set(['forward_lease_lost', 'forward_runtime_stopping']);
  let cursor = { at: since, id: 0 };
  let highWater = since;
  const seen = new Set();
  let cancelled = false;
  let stopping = false;
  let terminal = false;
  let pending = null;
  let consecutiveFailures = 0;
  let retryAt = 0;
  let degraded = card.snapshot?.().progressUnavailable === true;
  let timer;
  const inactive = () => cancelled || terminal;
  const clearTimer = () => { if (timer) clearIntervalFn(timer); timer = null; };
  const safeLog = (status, level, extra) => Promise.resolve().then(() => card.log(status, level, extra)).catch(() => {});
  const setDegraded = (value) => {
    if (degraded === value || inactive()) return;
    degraded = value;
    try { card.setProgressUnavailable?.(value); } catch (error) {
      safeLog('skipped', 'warn', { operation: 'read_progress', stage: 'card_state', error_code: errorCode(error), consecutive_failures: consecutiveFailures });
    }
  };
  const stopForError = async (error, stage) => {
    terminal = true;
    clearTimer();
    await safeLog('stopped', 'warn', { operation: 'read_progress', stage, error_code: errorCode(error), consecutive_failures: consecutiveFailures });
  };
  const failLoad = async (error, force) => {
    if (inactive()) return;
    const code = errorCode(error);
    if (terminalCodes.has(code)) {
      await stopForError(error, 'load');
      return;
    }
    if (stopping) {
      if (force) await safeLog('stopped', 'warn', { operation: 'read_progress', stage: 'load', error_code: code, consecutive_failures: consecutiveFailures });
      return;
    }
    consecutiveFailures += 1;
    const retryDelayMs = baseDelayMs * Math.min(8, 2 ** (consecutiveFailures - 1));
    retryAt = now() + retryDelayMs;
    if (consecutiveFailures >= 3) setDegraded(true);
    await safeLog('retrying', 'warn', { operation: 'read_progress', stage: 'load', error_code: code, consecutive_failures: consecutiveFailures, retry_delay_ms: retryDelayMs });
  };
  const recover = async () => {
    if ((!consecutiveFailures && !degraded) || inactive()) return;
    const recoveredFailures = consecutiveFailures;
    consecutiveFailures = 0;
    retryAt = 0;
    setDegraded(false);
    await safeLog('recovered', 'info', { operation: 'read_progress', stage: 'load', consecutive_failures: recoveredFailures });
  };
  const poll = ({ force = false } = {}) => {
    if (inactive() || pending || (stopping && !force) || (!force && now() < retryAt)) return pending;
    pending = (async () => {
      let rows;
      try { rows = await load(cursor); } catch (error) { await failLoad(error, force); return; }
      if (inactive() || (stopping && !force)) return;
      await recover();
      for (const row of rows) {
        if (inactive() || (stopping && !force)) return;
        try {
          cursor = { at: Number(row.created_at), id: Number(row.id) };
          highWater = Math.max(highWater, cursor.at);
          if (!row.progress_json || seen.has(String(row.id))) continue;
          seen.add(String(row.id));
          if (seen.size > 500) seen.delete(seen.values().next().value);
          let event;
          try { event = typeof row.progress_json === 'string' ? JSON.parse(row.progress_json) : row.progress_json; } catch { continue; }
          if (['started', 'commentary', 'tool'].includes(event?.kind)) card.push(event);
        } catch (error) {
          if (terminalCodes.has(errorCode(error))) { await stopForError(error, 'event'); return; }
          await safeLog('skipped', 'warn', { operation: 'read_progress', stage: 'event', error_code: errorCode(error), consecutive_failures: 0 });
        }
      }
      // Replay a bounded overlap for asynchronously committed events. Full pages
      // continue keyset paging first, so a busy chat cannot starve later rows.
      if (rows.length < 100) cursor = { at: Math.max(since, highWater - 10000), id: 0 };
    })().finally(() => { pending = null; });
    return pending;
  };
  timer = setIntervalFn(poll, baseDelayMs); timer.unref?.();
  poll();
  return { card, async stop() {
    stopping = true;
    const active = pending;
    clearTimer();
    if (!inactive()) {
      if (active) await active;
      else await poll({ force: true });
      terminal = true;
    } else await active;
    card.stop(); await card.chain;
    return card.snapshot();
  }, cancel() {
    cancelled = true;
    clearTimer();
    card.stop();
  } };
}
