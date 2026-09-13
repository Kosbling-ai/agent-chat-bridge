import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceRetirement } from '../src/core/resource-retirement.mjs';
import { createConversationGuard } from '../src/core/conversation-guard.mjs';
const row = { runId: 'run', conversationId: 'chat', inputRetirable: true, outputRetirable: true };
const guard = () => createConversationGuard();
test('retirement seals before files, retains source claims and resumes a failed acknowledgement', async () => {
  const effects = [], logs = []; let retired = false, failAck = true;
  const store = { listRetirableResources: async () => ({ items: [row] }), sealResourceRetirement: async ({ kind }) => { effects.push(`seal:${kind}`); return { state: 'sealed' }; }, completeResourceRetirement: async ({ kind }) => { effects.push(`complete:${kind}`); if (kind === 'input' && failAck) { failAck = false; throw new Error('synthetic lost commit'); } } };
  const retire = createResourceRetirement({ store, guard: guard(), connectionId: 'fixture', media: { release: async () => effects.push('input') }, outbound: { releaseRun: async scope => { assert.equal(scope.runId, 'run'); effects.push('output'); return { retired }; } }, log: (...entry) => logs.push(entry) });
  await retire();
  assert.deepEqual(effects, ['seal:output', 'output', 'seal:input', 'input', 'complete:input']);
  assert(logs.some(entry => entry[3]?.code === 'input_retirement_pending'));
  effects.length = 0; retired = true;
  await retire();
  assert.deepEqual(effects, ['seal:output', 'output', 'complete:output', 'seal:input', 'input', 'complete:input']);
});
test('active local execution and a refused persistent seal both prevent filesystem access', async () => {
  let sealed = 0, files = 0;
  const ownership = guard();
  const retire = createResourceRetirement({ store: { listRetirableResources: async () => ({ items: [row] }), sealResourceRetirement: async () => { sealed++; throw Object.assign(new Error('synthetic'), { code: 'retirement_conflict' }); } }, guard: ownership, connectionId: 'fixture', media: { release: async () => { files++; } } });
  await ownership.native(JSON.stringify(['fixture', 'chat']), retire);
  assert.equal(sealed, 0);
  await retire(); assert.equal(sealed, 1); assert.equal(files, 0);
});
test('sealed completion skips files and bounded pages use returned cursor', async () => {
  const cursors = [];
  const retire = createResourceRetirement({ store: { listRetirableResources: async input => { cursors.push([input.kind, input.afterRunId]); assert.equal(input.limit, 25); return { items: [row], nextCursor: cursors.length === 1 ? 'next' : null }; }, sealResourceRetirement: async () => ({ state: 'complete' }) }, guard: guard(), connectionId: 'fixture', media: {} });
  await retire(); await retire(); await retire();
  assert.deepEqual(cursors, [['output', undefined], ['input', undefined], ['output', 'next'], ['input', undefined], ['output', undefined], ['input', undefined]]);
});

test('unretirable input history never delays the independent output page', async () => {
  const calls = [], completed = [];
  const retire = createResourceRetirement({ store: {
    listRetirableResources: async ({ kind, afterRunId, limit }) => {
      calls.push({ kind, afterRunId, limit });
      if (kind === 'input') return { items: Array.from({ length: limit }, (_, i) => ({ runId: `old-${i}`, conversationId: 'old', inputRetirable: false })), nextCursor: 'remaining-of-2048-inputs' };
      return { items: calls.length === 1 ? [{ ...row, inputRetirable: false }] : [], nextCursor: null };
    }, sealResourceRetirement: async () => ({ state: 'sealed' }), completeResourceRetirement: async input => completed.push(input),
  }, guard: guard(), connectionId: 'fixture', outbound: { releaseRun: async () => ({ retired: true }) } });
  assert.deepEqual(await retire(), { hasMore: true });
  assert.deepEqual(completed, [{ runId: 'run', kind: 'output' }]);
  await retire();
  assert.equal(calls[0].kind, 'output'); assert.equal(calls[2].afterRunId, undefined);
  assert.equal(calls[3].afterRunId, 'remaining-of-2048-inputs');
  assert(calls.every(call => call.limit === 25));
});
