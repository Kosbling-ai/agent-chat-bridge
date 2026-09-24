import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireWriter } from '../src/storage/writer.mjs';

test('writer compatibility facade never creates a dedicated database connection', async () => {
  let calls = 0;
  const writer = await acquireWriter({ getConnection: async () => { calls += 1; } });
  await writer.verify(); writer.assert(); await writer.close();
  assert.equal(calls, 0);
});

test('writer options are ignored because pool operations own their deadlines', async () => {
  const writer = await acquireWriter({}, () => {}, { probeTimeoutMs: 1, probeMaxMisses: 1 });
  await writer.verify();
});
