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
  assert.deepEqual(effects, ['seal:input', 'input', 'complete:input', 'seal:output', 'output']);
  assert(logs.some(entry => entry[3]?.code === 'input_retirement_pending'));
  effects.length = 0; retired = true;
  await retire();
  assert.deepEqual(effects, ['seal:input', 'input', 'complete:input', 'seal:output', 'output', 'complete:output']);
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
  const retire = createResourceRetirement({ store: { listRetirableResources: async input => { cursors.push(input.afterRunId); assert.equal(input.limit, 10); return { items: [row], nextCursor: cursors.length === 1 ? 'next' : null }; }, sealResourceRetirement: async () => ({ state: 'complete' }) }, guard: guard(), connectionId: 'fixture', media: {} });
  await retire(); await retire(); await retire();
  assert.deepEqual(cursors, [undefined, 'next', undefined]);
});
