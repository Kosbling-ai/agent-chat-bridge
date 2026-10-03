import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';

const base = { schemaVersion: 1,
  storage: Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `TEST_${key.toUpperCase()}`])),
  codex: { bin: './codex', cwd: './workspace', envNames: [] },
  feishu: { connectionId: 'test', appIdEnv: 'TEST_APP', appSecretEnv: 'TEST_SECRET', botOpenId: 'bot' },
  routing: { version: '1', privateUserIds: ['human'], groups: [{ conversationId: 'chat', trigger: 'mention', passiveContext: true }] }, hooks: [] };
const withGroup = fields => ({ ...base, routing: { ...base.routing, groups: [{ ...base.routing.groups[0], ...fields }] } });
const groupCodexOf = codex => validateConfig(withGroup({ codex })).routing.groups[0].codex;

test('a bridge group may switch the Codex approval policy, reviewer and sandbox; the global settings stay unchanged', () => {
  const config = validateConfig(withGroup({ codex: { approvalPolicy: 'never', sandbox: 'danger-full-access' } }));
  assert.deepEqual(config.routing.groups[0].codex, { approvalPolicy: 'never', sandbox: 'danger-full-access' });
  assert.equal(config.codex.approvalPolicy, 'on-request');
  assert.equal(config.codex.approvalsReviewer, 'auto_review');
  assert.equal(config.codex.sandbox, 'workspace-write');
  assert.equal(validateConfig(base).routing.groups[0].codex, undefined);
  for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access']) assert.deepEqual(groupCodexOf({ sandbox }), { sandbox });
  for (const approvalsReviewer of ['user', 'auto_review', 'guardian_subagent']) assert.deepEqual(groupCodexOf({ approvalsReviewer }), { approvalsReviewer });
  for (const approvalPolicy of ['untrusted', 'on-request', 'never']) assert.deepEqual(groupCodexOf({ approvalPolicy }), { approvalPolicy });
  assert.deepEqual(groupCodexOf({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' }),
    { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' });
});

test('group codex overrides reject unknown fields, values outside the protocol enums and hook-only groups', () => {
  for (const value of [null, [], 'never', {}, { cwd: '/tmp' }, { approvalPolicy: 'never', model: 'gpt-test' }, { sandboxPolicy: { type: 'dangerFullAccess' } }]) {
    assert.throws(() => validateConfig(withGroup({ codex: value })), { code: 'invalid_group_codex_fields' }, JSON.stringify(value));
  }
  for (const value of ['auto', 'always', 'on-failure', '', 'NEVER', ' never', 5, null]) {
    assert.throws(() => validateConfig(withGroup({ codex: { approvalPolicy: value } })), { code: 'invalid_group_codex_approval_policy' }, JSON.stringify(value));
  }
  for (const value of ['', '   ', ' auto_review ', 'auto_review\n', 'auto', 'AUTO_REVIEW', 'guardian', 'auto review', 7, null]) {
    assert.throws(() => validateConfig(withGroup({ codex: { approvalsReviewer: value } })), { code: 'invalid_group_codex_approvals_reviewer' }, JSON.stringify(value));
  }
  for (const value of ['', 'full', 'danger_full_access', 'dangerFullAccess', ' danger-full-access', 'DANGER-FULL-ACCESS', { type: 'dangerFullAccess' }, true, null]) {
    assert.throws(() => validateConfig(withGroup({ codex: { sandbox: value } })), { code: 'invalid_group_codex_sandbox' }, JSON.stringify(value));
  }
  assert.throws(() => validateConfig(withGroup({ capabilities: ['hook'], codex: { approvalPolicy: 'never' } })), { code: 'group_context_requires_bridge' });
  assert.throws(() => validateConfig(withGroup({ capabilities: ['hook'], codex: { sandbox: 'danger-full-access' } })), { code: 'group_context_requires_bridge' });
});
