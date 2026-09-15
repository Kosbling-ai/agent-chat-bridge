import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopCardTurn } from '../src/agents/codex/card-stop.mjs';
import { codexThreadCreatedAtMs, shouldRolloverForRules } from '../src/agents/codex/codex-rules-rollover.mjs';
import { inProgressTurnIds, isCodexTurnPredecessor, isCodexTurnSuccessor, isNoActiveTurnError, parseActiveTurnMismatch, steerTurnWithMismatchRecovery, TurnRecoverySupersededError } from '../src/agents/codex/codex-turn-recovery.mjs';
import { closeOwnedChild, resolveSharedHome } from '../src/agents/codex/idle-lifecycle.mjs';
import { canDeliverOutboxAttachments, parseOutboundGroupChatIds } from '../src/agents/codex/outbox-policy.mjs';
import { codexBindingOpenId } from '../src/agents/codex/thread-scope.mjs';
import { buildInitialPrompt } from '../src/agents/codex/prompt.mjs';
import { collectOutboxAttachments } from '../src/agents/codex/outbound-files.mjs';

const OLD = '01a00f75-2d21-7163-912d-bdfb80d328b4';
const EXPECTED = '01a0130b-c44b-7923-bd40-aecef0e86ff8';
const NEWER = '01a01339-f7dc-76a2-becf-d9188b65870d';

test('thread scope keeps synthetic senders and derives stable group identities', () => {
  assert.equal(codexBindingOpenId({ feishuOpenId: 'system:x', chatId: 'chat', chatType: 'group' }), 'system:x');
  assert.equal(codexBindingOpenId({ feishuOpenId: 'ou-a', chatId: 'chat', chatType: 'p2p' }), 'ou-a');
  assert.equal(codexBindingOpenId({ feishuOpenId: 'ou-a', chatId: 'chat', chatType: 'group' }), codexBindingOpenId({ feishuOpenId: 'ou-b', chatId: 'chat', chatType: 'group' }));
});

test('old card cannot stop a newer turn and repeated clicks are idempotent', async () => {
  const active = { turnId: 't', messageId: 'm', threadId: 'thread' }; let calls = 0;
  const interrupt = async () => { calls++; };
  assert.equal((await stopCardTurn(active, { turnId: 'old', messageId: 'm' }, interrupt)).status, 'stale');
  await Promise.all([stopCardTurn(active, { turnId: 't', messageId: 'm' }, interrupt), stopCardTurn(active, { turnId: 't', messageId: 'm' }, interrupt)]);
  await stopCardTurn(active, { turnId: 't', messageId: 'm' }, interrupt);
  assert.equal(calls, 1);
});

test('rules rollover preserves native seconds and the one-second margin', () => {
  assert.equal(codexThreadCreatedAtMs(123), 123000);
  assert.equal(codexThreadCreatedAtMs(1_800_000_000_000), 1_800_000_000_000);
  assert.equal(shouldRolloverForRules({ rulesMtimeMs: 3001, threadCreatedAtMs: 2000 }), true);
  assert.equal(shouldRolloverForRules({ rulesMtimeMs: 3000, threadCreatedAtMs: 2000 }), false);
});

test('turn recovery parses mismatch and interrupts only a native-proven predecessor', async () => {
  assert.deepEqual(parseActiveTurnMismatch(new Error(`expected active turn id \`${EXPECTED}\` but found \`${OLD}\``), EXPECTED)?.actualTurnId, OLD);
  assert.equal(isNoActiveTurnError(new Error('no active turn to steer')), true);
  assert.deepEqual(inProgressTurnIds({ turns: [{ id: 'a', status: 'inProgress' }, { id: 'a', status: 'inProgress' }, { id: 'b', status: 'completed' }] }), ['a']);
  assert.equal(isCodexTurnPredecessor(OLD, EXPECTED), true);
  assert.equal(isCodexTurnSuccessor(NEWER, EXPECTED), true);
  const calls = [];
  const result = await steerTurnWithMismatchRecovery({
    threadId: 'thread', expectedTurnId: EXPECTED, input: [{ type: 'text', text: 'hello' }], wait: async () => {},
    request: async (method, params) => {
      calls.push([method, params]);
      if (calls.length === 1) throw new Error(`expected active turn id \`${EXPECTED}\` but found \`${OLD}\``);
      return method === 'turn/steer' ? { turnId: EXPECTED } : {};
    },
  });
  assert.equal(result.turnId, EXPECTED);
  assert.deepEqual(calls.map(([method]) => method), ['turn/steer', 'turn/interrupt', 'turn/steer']);
});

test('turn recovery never interrupts a successor or an unproven id', async () => {
  const calls = [];
  await assert.rejects(steerTurnWithMismatchRecovery({
    threadId: 'thread', expectedTurnId: EXPECTED, input: [{ type: 'text', text: 'hello' }], wait: async () => {},
    request: async (method) => { calls.push(method); throw new Error(`expected active turn id \`${EXPECTED}\` but found \`${NEWER}\``); },
  }), TurnRecoverySupersededError);
  assert.deepEqual(calls, ['turn/steer']);
  assert.equal(isCodexTurnPredecessor('not-a-turn-id', EXPECTED), false);
});

test('outbox policy remains p2p-on and group allowlist-only', () => {
  const groups = parseOutboundGroupChatIds('allowed, second');
  assert.equal(canDeliverOutboxAttachments({ chatType: 'p2p', chatId: 'private' }), true);
  assert.equal(canDeliverOutboxAttachments({ chatType: 'group', chatId: 'allowed', allowedGroupChatIds: groups }), true);
  assert.equal(canDeliverOutboxAttachments({ chatType: 'group', chatId: 'denied', allowedGroupChatIds: groups }), false);
});

test('continued p2p turns repeat the current outbox without repeating identity', () => {
  const prompt = buildInitialPrompt({ binding: { feishuOpenId: 'human', chatId: 'private', chatType: 'p2p', created: false }, prompt: 'work' });
  assert.match(prompt, /【飞书私聊文件回传】/);
  assert.match(prompt, /回发文件目录：data\/feishu-outbox\/private/);
  assert.match(prompt, /Markdown 中引用本机路径不会上传/);
  assert.doesNotMatch(prompt, /chat_id：|对方 open_id：/);
});

test('prompt and attachment scan isolate system directories and enforce file/byte budgets', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-outbox-'));
  try {
    const binding = { feishuOpenId: 'system:fixture', chatId: 'same-chat', chatType: 'group', created: true };
    const prompt = buildInitialPrompt({ binding, prompt: 'work' });
    assert.match(prompt, /【独立系统任务】/);
    const relative = prompt.match(/回发文件目录：([^\n]+)/)[1];
    const directory = join(root, relative); mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 4; index++) writeFileSync(join(directory, `${index}.txt`), '1234');
    const files = collectOutboxAttachments(binding, 0, { workspace: root, allowedGroupChatIds: new Set(['same-chat']), maxFiles: 3, maxBytes: 8 });
    assert.equal(files.length, 2);
    assert.ok(files.every((path) => path.startsWith(directory)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('shared home rejects conflicting inherited state and owned close escalates exactly its child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-home-'));
  try {
    mkdirSync(join(root, '.codex'));
    assert.equal(resolveSharedHome({ home: root, inheritedHome: '' }), realpathSync(join(root, '.codex')));
    mkdirSync(join(root, 'shared'));
    assert.equal(resolveSharedHome({ configuredHome: '~/shared', inheritedHome: join(root, 'shared'), home: root }), realpathSync(join(root, 'shared')));
    assert.throws(() => resolveSharedHome({ home: root, inheritedHome: join(root, 'other') }), { code: 'CODEX_HOME_CONFLICT' });
    const child = new EventEmitter(); child.exitCode = null; child.signalCode = null; child.signals = [];
    child.stdin = { end() {} };
    child.kill = (signal) => { child.signals.push(signal); if (signal === 'SIGKILL') setImmediate(() => { child.signalCode = signal; child.emit('exit', null, signal); }); };
    await closeOwnedChild(child, { graceMs: 2 });
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
