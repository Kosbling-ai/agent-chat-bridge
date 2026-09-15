import assert from 'node:assert/strict';
import test from 'node:test';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';
import { createApi } from '../src/core/api.mjs';

const enabled = Boolean(process.env.BRIDGE_TEST_PASSWORD);
const refs = Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]));
async function until(read, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('delivery_timeout');
}

test('communication delivery publishes definite rejection without changing transport uncertainty',
  { skip: !enabled, timeout: 20_000 }, async () => {
    const pool = createPoolFromEnvironment(refs);
    let store;
    let runtime;
    const connectionId = 'delivery-reasons';
    const config = { feishu: { connectionId }, codex: {}, routing: { privateUserIds: [], groups: [] }, hooks: [],
      auth: { clients: [{ id: 'business', conversationIds: ['chat'], admin: false }] } };
    const token = 'offline-test-token-1234567890';
    try {
      await migrate(pool);
      store = await createMysqlStore({ pool, connectionId });
      const rejected = await store.recordOutbox({ connectionId, conversationId: 'chat', idempotencyKey: 'rejected',
        kind: 'create', payload: { kind: 'interactive', content: { result: 'rejected' } } });
      const unknown = await store.recordOutbox({ connectionId, conversationId: 'chat', idempotencyKey: 'unknown',
        kind: 'create', payload: { kind: 'interactive', content: { result: 'unknown' } } });
      runtime = createCommunicationRuntime({ config, store, chat: { async sendMessage(input) {
        const result = input.content.result;
        throw Object.assign(new Error('provider detail must not persist'), result === 'rejected'
          ? { code: 'feishu_api_rejected', outcome: 'failed' }
          : { code: 'feishu_transport_error', outcome: 'unknown' });
      } } });
      runtime.start();
      await until(() => store.getOutbox({ id: rejected.id }), row => row.status === 'failed');
      await until(() => store.getOutbox({ id: unknown.id }), row => row.status === 'unknown');
      const api = createApi({ config, store, forwardRuntime: {}, chat: {}, tokens: { business: token } });
      const read = id => api({ method: 'GET', url: `/v1/deliveries/${id}`, headers: { authorization: `Bearer ${token}` } });
      const rejectedPublic = await read(rejected.id);
      const unknownPublic = await read(unknown.id);
      assert.deepEqual([rejectedPublic.body.status, rejectedPublic.body.errorCode], ['failed', 'feishu_api_rejected']);
      assert.deepEqual([unknownPublic.body.status, unknownPublic.body.errorCode], ['unknown', 'chat_delivery_unconfirmed']);
      assert.equal(JSON.stringify([rejectedPublic, unknownPublic]).includes('provider detail'), false);
    } finally {
      await runtime?.stop();
      if (store) await store.close(); else await pool.end();
    }
  });
