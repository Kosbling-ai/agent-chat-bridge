import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectOutboxAttachments } from '../src/agents/codex/outbound-files.mjs';
import { outboxRelativeDirectory } from '../src/agents/codex/prompt.mjs';
import { deriveExecutionScope } from '../src/agents/codex/thread-scope.mjs';
import { buildCodexForwardPrompt, createRecentMentionPrompts,
  mergeMentionPrompts, normalizeFeishuInput, stripBotMention } from '../src/channels/feishu/input.mjs';

test('authorized human and system group bindings scan their separate result directories', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'bridge-forward-outbox-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const chatId = 'chat';
  const human = { feishuOpenId: 'group:chat', chatId, chatType: 'group' };
  const system = { feishuOpenId: deriveExecutionScope('caller', 'daily'), chatId, chatType: 'group' };
  for (const [binding, name] of [[human, 'human.txt'], [system, 'system.txt']]) {
    const directory = join(workspace, outboxRelativeDirectory({ chatId, bindingOpenId: binding.feishuOpenId }));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, name), name);
  }
  const options = { workspace, allowedGroupChatIds: new Set([chatId]) };
  assert.deepEqual(collectOutboxAttachments(human, 0, options).map(path => path.split('/').at(-1)), ['human.txt']);
  assert.deepEqual(collectOutboxAttachments(system, 0, options).map(path => path.split('/').at(-1)), ['system.txt']);
  assert.deepEqual(collectOutboxAttachments(human, 0, { ...options, allowedGroupChatIds: new Set() }), []);
});

test('Feishu text normalization restores post extraction and bot mention removal', () => {
  const event = { messageId: 'message', conversationId: 'chat', conversationType: 'group', occurredAt: 1700000000,
    actor: { type: 'user', openId: 'sender', unionId: 'union-sender', name: 'Sender' }, message: { kind: 'post',
      content: JSON.stringify({ title: 'Title', content: [[{ tag: 'text', text: 'body' }, { tag: 'a', text: 'link', href: 'https://example.invalid' }]] }),
      mentions: [{ openId: 'bot', key: '<at>bot</at>', name: 'Agent' }] } };
  assert.equal(stripBotMention('<at>bot</at> @Agent hello', event.message.mentions, 'bot'), 'hello');
  const normalized = normalizeFeishuInput(event, { botOpenId: 'bot' });
  assert.equal(normalized.rawText, 'Title\nbodylink (https://example.invalid)');
  assert.equal(normalized.createdAt, 1700000000000);
  assert.equal(normalized.senderName, 'Sender');
  assert.equal(normalized.senderUnionId, 'union-sender');
});

test('recent group prompts use chat scope across senders and expire after two minutes', () => {
  let clock = 1000;
  const recent = createRecentMentionPrompts({ now: () => clock });
  recent.remember({ chatId: 'chat', messageId: 'first', prompt: 'first prompt', senderOpenId: 'one', senderName: 'One' });
  recent.remember({ chatId: 'chat', messageId: 'second', prompt: 'second prompt', senderOpenId: 'two', senderName: 'Two' });
  assert.deepEqual(recent.take('chat').map(item => item.senderOpenId), ['one', 'two']);
  clock += 2 * 60 * 1000 + 1;
  assert.deepEqual(recent.take('chat'), []);
});

test('group prompt keeps prior identities while current sender remains the tool identity', () => {
  const recent = [
    { inboundId: 7, messageId: 'first', prompt: 'look up order', senderName: 'One', senderOpenId: 'ou_one', senderUnionId: 'union_one', createdAt: 1 },
    { messageId: 'second', prompt: 'and summarize it', senderName: 'Two', senderOpenId: 'ou_two', createdAt: 2 },
  ];
  const merged = mergeMentionPrompts(recent, 'please do that');
  assert.match(merged, /look up order/);
  assert.match(merged, /please do that/);
  const prompt = buildCodexForwardPrompt({ chatType: 'group', currentPrompt: 'please do that', mergedPrompt: merged,
    recentPrompts: recent, senderName: 'Current', senderOpenId: 'ou_current', senderUnionId: 'union_current' });
  assert.match(prompt, /群消息 来自 One（open_id=ou_one，union_id=union_one）/);
  assert.match(prompt, /群消息 来自 Two（open_id=ou_two）/);
  assert.match(prompt, /提到你的消息 来自 Current（open_id=ou_current，union_id=union_current）/);
  assert.doesNotMatch(prompt, /union_id=undefined/);
});
