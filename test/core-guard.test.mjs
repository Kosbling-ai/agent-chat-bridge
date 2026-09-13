import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationGuard } from '../src/core/conversation-guard.mjs';
const gate = () => { let release; const wait = new Promise(resolve => { release = resolve; }); return { wait, release }; };
test('native turn and guidance share occupancy while cleanup cannot enter', async () => {
  const guard = createConversationGuard(), hold = gate(), entered = gate(); let guidance = false, cleaned = false;
  const native = guard.native('chat', async () => { entered.release(); await hold.wait; }); await entered.wait;
  await guard.native('chat', async () => { guidance = true; }); assert(guidance);
  assert.equal(await guard.cleanup('chat', async () => { cleaned = true; }), false); assert(!cleaned);
  assert.equal(await guard.cleanup('other', async () => {}), true);
  hold.release(); await native; assert.equal(await guard.cleanup('chat', async () => { cleaned = true; }), true); assert(cleaned);
});
test('cleanup occupancy queues new native work and releases after failures', async () => {
  const guard = createConversationGuard(), hold = gate(), entered = gate(); let nativeEntered = false;
  const cleanup = guard.cleanup('chat', async () => { entered.release(); await hold.wait; throw new Error('synthetic cleanup'); });
  const rejected = assert.rejects(cleanup, /synthetic cleanup/); await entered.wait;
  const native = guard.native('chat', async () => { nativeEntered = true; });
  assert(!nativeEntered); assert.equal(await guard.cleanup('chat', async () => {}), false);
  hold.release(); await rejected; await native; assert(nativeEntered);
});
