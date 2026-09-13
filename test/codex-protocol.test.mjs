import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCodexRpcError } from '../src/agents/codex/protocol-errors.mjs';
import * as rollover from '../src/agents/codex/rollover.mjs';
import * as legacy from './fixtures/legacy-turn-recovery.mjs';
import * as legacyRollover from './fixtures/legacy-rollover.mjs';

test('safe mismatch/no-active classification preserves production parser decisions', () => {
  for (const message of ['expected active turn id `queued-turn` but found `older-turn`', "rpc: expected active turn id 'queued-turn' but found 'newer-turn'", 'no active turn to steer', 'rpc: no active turn to interrupt', 'unrecognized provider failure']) {
    const mismatch = legacy.parseActiveTurnMismatch(new Error(message), 'queued-turn');
    const result = classifyCodexRpcError({ message }, { method: 'turn/steer', expectedTurnId: 'queued-turn' });
    if (mismatch) assert.deepEqual(result, { kind: 'active_turn_mismatch', expectedTurnId: mismatch.expectedTurnId, actualTurnId: mismatch.actualTurnId });
    else if (legacy.isNoActiveTurnError(new Error(message))) assert.deepEqual(result, { kind: 'no_active_turn' });
    else assert.equal(result, undefined);
  }
});
test('archived classification is scoped and never exposes provider text', () => {
  const provider = { message: 'SYNTHETIC_SECRET session thread-1 is archived' };
  assert.deepEqual(classifyCodexRpcError(provider, { method: 'thread/resume', threadId: 'thread-1' }), { kind: 'thread_archived', threadId: 'thread-1' });
  assert.equal(classifyCodexRpcError(provider, { method: 'thread/resume', threadId: 'other' }), undefined);
  assert.equal(classifyCodexRpcError(provider, { method: 'turn/interrupt', threadId: 'thread-1' }), undefined);
  assert.equal(classifyCodexRpcError({ message: 'expected active turn id `expected` but found `secret/path`' }, { method: 'turn/steer', expectedTurnId: 'expected' }), undefined);
  assert.equal(classifyCodexRpcError({ message: 'x'.repeat(9000) }, { method: 'thread/read', threadId: 'thread-1' }), undefined);
});
test('rules rollover retains production timestamp normalization and one-second margin', () => {
  for (const value of [null, '', 0, -1, 'bad', 1726000000, 1726000000000, Infinity]) assert.equal(rollover.codexThreadCreatedAtMs(value), legacyRollover.codexThreadCreatedAtMs(value));
  for (const delta of [-1, 0, 999, 1000, 1001, 5000]) {
    const input = { threadCreatedAtMs: 1726000000000, rulesMtimeMs: 1726000000000 + delta };
    assert.equal(rollover.shouldRolloverForRules(input), legacyRollover.shouldRolloverForRules(input));
  }
});
