import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createForwardJobStore } from '../src/storage/forward-jobs.mjs';
import { createForwardRuntime } from '../src/core/forward-runtime.mjs';
import { createExecutionFeedback } from '../src/channels/feishu/execution-feedback.mjs';
import { createFeishuReplies } from '../src/channels/feishu/replies.mjs';

const enabled = Boolean(process.env.BRIDGE_TEST_PASSWORD);
const refs = Object.fromEntries(
  ['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `BRIDGE_TEST_${key.toUpperCase()}`]),
);

test('terminal feedback survives the production reply merge before its first card create', {
  skip: !enabled,
  timeout: 20_000,
}, async () => {
  const pool = createPoolFromEnvironment(refs);
  try {
    await migrate(pool);
    const jobs = createForwardJobStore({ connectionId: 'feedback-fixture', pool });
    const cards = [];
    const texts = [];
    const sessions = {
      async loadBinding() { return { codexSessionId: 'occupied-thread' }; },
      async readPublicProgress() { return []; },
    };
    const chat = { async sendMessage(input) { texts.push(input); return { message_id: 'text-message' }; } };
    const feedback = createExecutionFeedback({
      jobs, sessions,
      cardClient: { im: { v1: { message: {
        async create(input) {
          cards.push(JSON.parse(input.data.content));
          return { code: 0, data: { message_id: `card-${cards.length}` } };
        },
      } } } },
    });
    const replies = createFeishuReplies({ chat, jobs, connectionId: 'feedback-fixture' });
    const runtime = createForwardRuntime({
      config: { owner: 'feedback-worker', pollMs: 1 }, jobs, sessions, feedback, replies,
      executor: { async execute(input) {
        if (input.messageId === 'busy-source') throw Object.assign(new Error('busy'), { code: 'CODEX_THREAD_BUSY' });
        return { threadId: 'new-thread', turnId: 'new-turn', answer: 'done', rawAnswer: 'done', attachments: [] };
      } },
      authorize: async () => true,
    });
    const run = (messageId, prompt) => runtime.handleMessage({
      source: 'live', callerId: 'live', idempotencyKey: messageId,
      message: { messageId, conversationId: 'chat', conversationType: 'p2p', type: 'text', text: prompt },
      actor: { openId: 'human', name: 'Human' }, prompt,
    });

    await run('busy-source', 'busy');
    await run('complete-source', 'complete');
    await runtime.stop();

    assert.equal(cards.length, 2);
    assert.equal(texts.length, 0);
    assert.equal(cards[0].header.template, 'red');
    assert.match(JSON.stringify(cards[0]), /fork_busy_session/);
    assert.equal(cards[1].header.template, 'green');
    assert.match(JSON.stringify(cards[1]), /done/);

    const busy = await jobs.getByMessageId({ messageId: 'busy-source' });
    const completed = await jobs.getByMessageId({ messageId: 'complete-source' });
    assert.equal(busy.status, 'failed');
    assert.equal(busy.result.executionCard.messageId, 'card-1');
    assert.equal(busy.result.busyFork.sourceThreadId, 'occupied-thread');
    assert.equal(completed.status, 'completed');
    assert.equal(completed.result.executionCard.messageId, 'card-2');
  } finally {
    await pool.end();
  }
});
