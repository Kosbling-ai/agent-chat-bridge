import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectOutboxAttachments } from '../src/agents/codex/outbound-files.mjs';
import { outboxRelativeDirectory } from '../src/agents/codex/prompt.mjs';
import { deriveExecutionScope } from '../src/agents/codex/thread-scope.mjs';

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
