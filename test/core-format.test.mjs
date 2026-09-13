import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFinalAnswer, buildCodexForwardPrompt, buildConversationPrompt } from '../src/core/format.mjs';
import * as legacy from './fixtures/legacy-format.mjs';

test('final selection matches frozen production functions on identical native items', () => {
  const cases = [undefined, {}, { items: [] },
    { items: [{ type: 'agentMessage', text: 'commentary' }, { type: 'agentMessage', phase: 'final_answer', text: ' final ' }, { type: 'agentMessage', text: 'later activity' }] },
    { items: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ output_text: 'first' }, 'second'] }] },
    { items: [{ type: 'agentMessage', text: 'first' }, { type: 'agentMessage', text: 'last' }] },
    { items: [{ type: 'agentMessage', phase: 'final_answer', text: ' ' }, { type: 'message', role: 'user', phase: 'final_answer', text: 'ignore user' }] },
  ];
  for (const input of cases) assert.equal(extractFinalAnswer(input), legacy.extractFinalAnswer(input));
  assert.equal(extractFinalAnswer(cases[3]), 'final');
});
test('source labels match frozen production functions on identical private/group input', () => {
  for (const message of [{ chat_type: 'group' }, { chat_type: 'p2p' }]) {
    for (const options of [
      { currentPrompt: 'current', mergedPrompt: 'merged', senderOpenId: 'synthetic-open-id' },
      { currentPrompt: 'current', mergedPrompt: 'merged', senderName: 'Fixture', senderOpenId: 'synthetic-open-id', recentPrompts: [{ prompt: 'previous', senderName: 'Other', senderOpenId: 'previous-id' }] },
      { currentPrompt: '', mergedPrompt: 'fallback', recentPrompts: [] },
    ]) assert.equal(buildCodexForwardPrompt(message, options), legacy.buildCodexForwardPrompt(message, options));
  }
});
test('prompt integration preserves private cloud permission identity and separates group speakers', () => {
  const event = { conversationType: 'p2p', conversationId: 'chat', actor: { openId: 'human' } };
  const prompt = buildConversationPrompt({ event, text: 'current', newThread: true });
  assert.match(prompt, /对方 open_id：human/);
  assert(!prompt.includes('回发文件目录'), 'do not advertise an unwired output directory');
  const group = buildConversationPrompt({ event: { ...event, conversationType: 'group' }, text: 'current', context: [{ event: { actor: { openId: 'other' } }, text: 'background' }], newThread: true, group: { name: 'Fixture group' } });
  assert.match(group, /群名称：Fixture group/);
  assert.match(group, /群消息 来自 other（open_id=other）/);
  assert.match(group, /提到你的消息 来自 human（open_id=human）/);
  assert.equal(buildConversationPrompt({ text: 'unchanged cron' }), 'unchanged cron');
});
