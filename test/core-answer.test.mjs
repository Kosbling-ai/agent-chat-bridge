import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnswerProjection } from '../src/core/answer-projection.mjs';
import { projectCodexItem, extractFinalAnswer, appendLimitedText } from './fixtures/legacy-answer-projection.mjs';

// Replay the old handleNotification -> persistCompletedItem -> waiter chain
// against the frozen production projection/extraction functions.
function legacy(events, turn) {
  let last = '';
  const text = new Map();
  const completed = item => { const projected = projectCodexItem(item); if (projected?.role === 'assistant' && projected.text) last = projected.text; };
  for (const { method, params = {} } of events) {
    if (['agentMessage/delta', 'item/agentMessage/delta'].includes(method)) {
      const id = params.itemId || 'agent-delta';
      last = appendLimitedText(text.get(id) || '', params.delta || '', 12000); text.set(id, last);
    } else if (method === 'item/completed') completed(params.item);
    else if (method === 'turn/completed') for (const item of params.turn?.items || []) completed(item);
  }
  return extractFinalAnswer(turn) || last;
}
const item = value => ({ method: 'item/completed', params: { item: value } });
const terminal = items => ({ id: 'turn', status: 'completed', items });
function current(events, turn) { const projection = createAnswerProjection(); for (const event of events) projection.observe(event); return projection.answer(turn); }

test('full old reply projection sequence is preserved across supported item/content and terminal shapes', () => {
  const bodies = [{ text: 'text body' }, { content: ['string body'] }, { content: [{ text: 'text part' }] }, { content: [{ input_text: 'input part' }] }, { content: [{ output_text: 'output part' }] }, { content: [null, 'first', { output_text: 'second' }] }];
  const sequences = bodies.map(body => [item({ type: 'message', role: 'assistant', phase: 'final_answer', ...body })]);
  sequences.push(
    [item({ type: 'agentMessage', text: 'agent body' })],
    [item({ type: 'message', role: 'assistant', content: [{ text: 'commentary body' }] })],
    [{ method: 'agentMessage/delta', params: { delta: 'first ' } }, { method: 'item/agentMessage/delta', params: { delta: 'second' } }],
    [item({ type: 'agentMessage', text: 'answer' }), item({ type: 'message', role: 'user', content: ['USER_SECRET'] }), item({ type: 'commandExecution', command: 'TOOL_SECRET' }), { method: 'item/commandExecution/outputDelta', params: { delta: 'TOOL_SECRET' } }],
    [{ method: 'agentMessage/delta', params: { delta: 'A'.repeat(13000) } }, { method: 'item/agentMessage/delta', params: { delta: 'TAIL' } }],
  );
  for (const events of sequences) {
    for (const items of [[], [{ type: 'commandExecution', command: 'activity' }]]) {
      const turn = terminal(items);
      const sequence = [...events, { method: 'turn/completed', params: { turn } }];
      assert.equal(current(sequence, turn), legacy(sequence, turn));
      assert.equal(current(sequence, turn), current(structuredClone(sequence), structuredClone(turn)), 'restart uses identical durable sequence');
    }
  }
  const turn = terminal([{ type: 'agentMessage', text: 'commentary' }, { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ output_text: 'final' }] }]);
  const sequence = [{ method: 'turn/completed', params: { turn } }];
  assert.equal(current(sequence, turn), legacy(sequence, turn));
});
test('intentional corrections: persisted final survives later commentary and unknown roles never become answers', () => {
  const turn = terminal([]);
  const sequence = [item({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ output_text: 'FINAL' }] }), item({ type: 'agentMessage', phase: 'commentary', text: 'later commentary' })];
  assert.equal(legacy(sequence, turn), 'later commentary');
  assert.equal(current(sequence, turn), 'FINAL');
  const unknown = [item({ type: 'message', role: 'system', content: ['SYSTEM_SECRET'] })];
  assert.equal(legacy(unknown, turn), 'SYSTEM_SECRET');
  assert.equal(current(unknown, turn), '');
  assert.equal(current([item({ type: 'message', role: 'user', content: ['USER_SECRET'] })], turn), '');
});
