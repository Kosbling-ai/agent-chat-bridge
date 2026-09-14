import assert from 'node:assert/strict';
import test from 'node:test';
import { importBindingSnapshot, normalizeBindingSnapshot } from '../src/storage/binding-import.mjs';
import { codexBindingOpenId, deriveExecutionScope } from '../src/agents/codex/thread-scope.mjs';
import { StoreError } from '../src/storage/errors.mjs';

const queue = { pending: 0, running: 0, replyPending: 0, unknown: 2, held: 1 };
const row = (values = {}) => ({
  feishu_open_id: 'ou-person', chat_id: 'chat-p2p', chat_type: 'p2p', codex_session_id: 'thread-p2p',
  thread_name: 'legacy-p2p', created_at: 100, updated_at: 200, last_message_id: 'message-1',
  last_message_at: 190, last_error: '', ...values,
});
const manifest = (values = {}) => ({
  version: 1, connectionId: 'business', exportedAt: 300, sourceQueue: queue,
  systemMappings: [], bindings: [row()], ...values,
});

test('normalizes p2p, group and audited system bindings without changing native thread metadata', () => {
  const groupId = 'oc_group';
  const groupBinding = codexBindingOpenId({ feishuOpenId: 'ignored', chatId: groupId, chatType: 'group' });
  const input = manifest({
    systemMappings: [{ legacyBindingOpenId: 'system:daily', callerId: 'kosbling-automation', executionNamespace: 'daily' }],
    bindings: [row(), row({ feishu_open_id: groupBinding, chat_id: groupId, chat_type: 'group', codex_session_id: 'thread-group' }),
      row({ feishu_open_id: 'system:daily', chat_id: 'oc_daily', chat_type: 'group', codex_session_id: 'thread-daily' })],
  });
  const normalized = normalizeBindingSnapshot(input, 'business');
  assert.equal(normalized.bindings[0].codexSessionId, 'thread-p2p');
  assert.equal(normalized.bindings[0].createdAt, 100);
  assert.equal(normalized.bindings[1].bindingOpenId, groupBinding);
  assert.equal(normalized.bindings[2].bindingOpenId, deriveExecutionScope('kosbling-automation', 'daily'));
  assert.deepEqual(normalized.sourceQueue, queue);
});

test('rejects undrained source queues, unchecked identities and extra schema fields', () => {
  assert.throws(() => normalizeBindingSnapshot(manifest({ sourceQueue: { ...queue, running: 1 } }), 'business'), { code: 'binding_import_source_not_drained' });
  assert.throws(() => normalizeBindingSnapshot(manifest({ bindings: [row({ feishu_open_id: 'group:wrong', chat_type: 'group' })] }), 'business'), { code: 'binding_import_identity_mismatch' });
  assert.throws(() => normalizeBindingSnapshot({ ...manifest(), extra: true }, 'business'), { code: 'invalid_binding_snapshot' });
  assert.throws(() => normalizeBindingSnapshot(manifest(), 'other'), { code: 'binding_import_connection_mismatch' });
});

test('rejects missing or unused system maps and a native thread shared by different chats', () => {
  assert.throws(() => normalizeBindingSnapshot(manifest({ bindings: [row({ feishu_open_id: 'system:daily', chat_type: 'group' })] }), 'business'), { code: 'binding_import_mapping_missing' });
  assert.throws(() => normalizeBindingSnapshot(manifest({ systemMappings: [{ legacyBindingOpenId: 'system:unused', callerId: 'caller', executionNamespace: 'unused' }] }), 'business'), { code: 'binding_import_mapping_unused' });
  assert.throws(() => normalizeBindingSnapshot(manifest({ bindings: [row(), row({ feishu_open_id: 'ou-other', chat_id: 'chat-other' })] }), 'business'), { code: 'binding_import_duplicate_thread' });
});

test('writer loss destroys the in-flight transaction and preserves commit-unknown', async () => {
  let loseWriter;
  let destroyed = false;
  const connection = {
    destroy() { destroyed = true; },
    async execute(sql) {
      if (sql.includes('SELECT connection_id')) return [[]];
      if (sql.includes('SELECT status')) return [[]];
      if (sql.includes('INSERT INTO assistant_codex_sessions')) return [{ affectedRows: 1 }];
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const dependencies = {
    async assertSchemaCurrent() {},
    async acquireWriter(_pool, onLost) {
      loseWriter = onLost;
      return { async verify() {}, async close() {} };
    },
    async withConnection(_pool, operation) {
      await operation(connection);
      loseWriter(new StoreError('writer_lock_lost'));
      assert.equal(destroyed, true);
      throw new StoreError('commit_unknown');
    },
  };
  await assert.rejects(importBindingSnapshot({ pool: {}, connectionId: 'business', rolloverOnRulesUpdate: false,
    snapshot: manifest(), apply: true, dependencies }), { code: 'commit_unknown' });
});
