import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeComputerUseApproval, computerUseApprovalDecision, computerUseApprovalResult } from '../src/agents/codex/computer-use-approval.mjs';
import { renderUserInputCard, answersFromForm } from '../src/channels/feishu/user-input-card.mjs';

const request = () => ({ requestId: 0, generation: 1, params: {
  threadId: 'thread', turnId: 'turn', serverName: 'cua_repl', mode: 'openai/form',
  requestedSchema: { type: 'object', properties: {} },
  _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use',
    tool_name: 'get_app_state', tool_params: { app: 'com.google.Chrome' },
    tool_params_display: [{ name: 'app', value: 'Google Chrome' }], persist: ['session', 'always'], riskLevel: 'medium' },
} });

test('native app approval becomes an explicit card choice and a one-shot MCP result', () => {
  const normalized = normalizeComputerUseApproval(request());
  assert.equal(normalized.requestId, 0);
  assert.match(normalized.questions[0].question, /Google Chrome/);
  assert.match(normalized.questions[0].question, /com.google.Chrome/);
  const card = renderUserInputCard({ ...normalized, jobId: 'job', requestKey: 'key' });
  const field = card.body.elements[0].elements.find(x => x.tag === 'select_static');
  assert.equal(field.required, true);
  assert.equal(field.initial_option, undefined);
  assert.deepEqual(normalized.questions[0].options.map(option => option.label), ['拒绝', '允许本次请求', '本轮任务内允许该应用']);
  assert.throws(() => answersFromForm(normalized, {}));
  const accepted = answersFromForm(normalized, { q_0_choice: 'o_1' });
  assert.deepEqual(computerUseApprovalResult(normalized.questions, accepted), { action: 'accept', content: null, _meta: null });
  const declined = answersFromForm(normalized, { q_0_choice: 'o_0' });
  assert.deepEqual(computerUseApprovalResult(normalized.questions, declined), { action: 'decline', content: null, _meta: null });
  assert.deepEqual(computerUseApprovalDecision(normalized.questions, { computer_use: { answers: ['本轮任务内允许该应用'] } }), {
    result: { action: 'accept', content: null, _meta: null }, grantForTurn: true,
  });
  assert.throws(() => computerUseApprovalResult(normalized.questions, { computer_use: { answers: ['always'] } }));
});

test('unsupported modes, servers, schemas, audio and uncorrelated requests fail closed', () => {
  assert.throws(() => normalizeComputerUseApproval({ ...request(), generation: undefined }), { code: 'CODEX_COMPUTER_USE_UNSUPPORTED' });
  assert.throws(() => normalizeComputerUseApproval({ ...request(), generation: 0 }), { code: 'CODEX_COMPUTER_USE_UNSUPPORTED' });
  const mutations = [
    p => p.mode = 'url', p => p.mode = 'openai/userVerification', p => p.serverName = 'untrusted',
    p => p.threadId = '', p => p.turnId = null, p => p._meta = null,
    p => p._meta.connector_id = 'other', p => p._meta.codex_approval_kind = 'other',
    p => p._meta.persist = ['always'], p => p._meta.tool_name = 'start_audio_recording',
    p => p._meta.tool_name = 'execute_script', p => p._meta.tool_name = 'delete_app',
    p => p._meta.tool_params.secret = 'unrendered', p => p._meta.tool_params.app = 'computer-audio', p => p._meta.tool_params.app = '',
    p => p._meta.tool_params.app = 'app\nforged', p => p.requestedSchema = {},
    p => p._meta.riskLevel = 'low\nforged', p => p._meta.riskLevel = 'x'.repeat(41),
    p => p._meta.subtitle = 'warning\nforged', p => p._meta.subtitle = 'x'.repeat(701),
    p => p.requestedSchema.properties = { password: { type: 'string' } },
    p => p.requestedSchema.required = ['secret'], p => p.requestedSchema.oneOf = [],
    p => p.requestedSchema.additionalProperties = true,
  ];
  for (const mutate of mutations) { const r = request(); mutate(r.params); assert.throws(() => normalizeComputerUseApproval(r), { code: 'CODEX_COMPUTER_USE_UNSUPPORTED' }); }
});

test('approval identity includes generation and typed request ID; untrusted display text is escaped', () => {
  const r = request(); const original = normalizeComputerUseApproval(r);
  r.generation++; assert.notEqual(normalizeComputerUseApproval(r).itemId, original.itemId);
  r.generation--; r.requestId = '0'; assert.notEqual(normalizeComputerUseApproval(r).itemId, original.itemId);
  r.params._meta.tool_params_display[0].value = '[Fake](https://example.com)';
  assert.match(normalizeComputerUseApproval(r).questions[0].question, /\\\[Fake\\\]/);
});

test('captured cua_repl standard-form request preserves the actual native metadata shape', () => {
  // Captured from bundled runtime 26.915.31945 with an isolated synthetic Sky
  // service; no native app was accessed and the request was answered decline.
  const params = {
    _meta: { codex_approval_kind: 'mcp_tool_call', connector_id: 'computer-use', connector_name: 'Computer Use',
      persist: ['session', 'always'], progressToken: 0, riskLevel: 'low', tool_name: 'get_app_state',
      tool_params: { app: 'com.example.fixture' }, tool_params_display: [{ display_name: 'App', name: 'app', value: 'Synthetic Fixture' }] },
    message: 'Allow Computer Use to use "Synthetic Fixture"?', mode: 'form', requestedSchema: { properties: {}, type: 'object' },
    // Correlation is added by Codex app-server, not the MCP server.
    threadId: 'thread', turnId: 'turn', serverName: 'cua_repl',
  };
  const normalized = normalizeComputerUseApproval({ requestId: 0, generation: 1, params });
  assert.match(normalized.questions[0].question, /com.example.fixture/);
  assert.deepEqual(computerUseApprovalResult(normalized.questions, { computer_use: { answers: ['拒绝'] } }),
    { action: 'decline', content: null, _meta: null });
});
