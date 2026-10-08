import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../src/config.mjs';
import { startService } from '../src/service.mjs';
import { checkCodexWorkspace, checkGroupCodexWorkspaces } from '../src/agents/codex/workspace.mjs';

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
  for (const value of [null, [], 'never', {}, { workingDirectory: '/tmp' }, { approvalPolicy: 'never', model: 'gpt-test' }, { sandboxPolicy: { type: 'dangerFullAccess' } }]) {
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

const bin = fileURLToPath(new URL('../bin/agent-chat-bridge.mjs', import.meta.url));

test('a bridge group may set its own absolute Codex cwd, alone or with permissions', () => {
  assert.deepEqual(groupCodexOf({ cwd: '/srv/agent/workspace' }), { cwd: '/srv/agent/workspace' });
  assert.deepEqual(groupCodexOf({ cwd: '/srv/agent/workspace', approvalPolicy: 'never', sandbox: 'danger-full-access' }),
    { cwd: '/srv/agent/workspace', approvalPolicy: 'never', sandbox: 'danger-full-access' });
  assert.equal(validateConfig(withGroup({ codex: { cwd: '/srv/agent/workspace' } })).codex.cwd, './workspace', 'the global cwd is unchanged');
  assert.deepEqual(groupCodexOf({ cwd: '/srv/agent/../agent/workspace/' }), { cwd: '/srv/agent/workspace' }, 'the stored cwd is normalized');
});

test('a group Codex cwd must be a non-empty absolute path string', () => {
  for (const value of ['', ' ', './workspace', 'workspace', '~/workspace', ' /srv/workspace', '/srv/workspace ', '/srv/work\nspace', '/srv/\u0000x', `/${'a'.repeat(1024)}`, 5, true, null, [], {}]) {
    assert.throws(() => validateConfig(withGroup({ codex: { cwd: value } })), { code: 'invalid_group_codex_cwd' }, JSON.stringify(value));
  }
  assert.throws(() => validateConfig(withGroup({ capabilities: ['hook'], codex: { cwd: '/srv/agent/workspace' } })), { code: 'group_context_requires_bridge' });
});

test('group cwd preflight applies the global workspace rules and never reports the path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-group-cwd-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owned = join(root, 'owned'); await mkdir(owned, { mode: 0o700 });
  const open = join(root, 'open'); await mkdir(open); await chmod(open, 0o777);
  const file = join(root, 'file'); await writeFile(file, 'x');
  assert.equal(await checkCodexWorkspace(owned), '');
  assert.equal(await checkCodexWorkspace(join(root, 'missing')), 'missing');
  assert.equal(await checkCodexWorkspace(join(file, 'child')), 'missing');
  assert.equal(await checkCodexWorkspace(file), 'not_directory');
  assert.equal(await checkCodexWorkspace(open), 'world_writable');
  const groups = [
    { conversationId: 'oc_ok', codex: { cwd: owned } },
    { conversationId: 'oc_plain', codex: { approvalPolicy: 'never' } },
    { conversationId: 'oc_none' },
    { conversationId: 'oc_missing', codex: { cwd: join(root, 'missing') } },
    { conversationId: 'oc_open', codex: { cwd: open } },
  ];
  assert.deepEqual(await checkGroupCodexWorkspaces(groups), [{ chatId: 'oc_missing', reason: 'missing' }, { chatId: 'oc_open', reason: 'world_writable' }]);
});

test('check-config and startup reject an unusable group cwd before any component starts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-group-cwd-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const groupCwd = join(root, 'group-workspace');
  const configPath = join(root, 'bridge.json');
  const raw = withGroup({ capabilities: ['bridge'], codex: { cwd: groupCwd, approvalPolicy: 'never' } });
  await writeFile(configPath, JSON.stringify(raw));
  const run = () => spawnSync(process.execPath, [bin, 'check-config', '--config', configPath], { encoding: 'utf8', timeout: 20000 });
  const missing = run();
  assert.equal(missing.status, 1, missing.stdout);
  assert.match(missing.stdout, /"operation":"check_config","status":"failed","code":"invalid_group_codex_workspace","reason":"missing".*"chat_id":"chat"/);
  assert.match(missing.stdout, /"operation":"startup","status":"failed","code":"invalid_group_codex_workspace"/);
  assert.doesNotMatch(missing.stdout, /group-workspace/);
  const runtime = validateConfig({ ...raw, listen: { host: '127.0.0.1', port: 0 }, codex: { bin: process.execPath, cwd: root, envNames: [] } });
  const logs = [];
  await assert.rejects(startService({ config: runtime, configPath, env: {}, log: (...entry) => logs.push(entry),
    dependencies: { pool() { throw new Error('pool must not be reached'); } } }), { code: 'invalid_group_codex_workspace' });
  assert.deepEqual(logs, [['warning', 'codex_workspace', 'failed', { code: 'invalid_group_codex_workspace', chatId: 'chat', reason: 'missing' }]]);
  await mkdir(groupCwd, { mode: 0o700 });
  const passed = run();
  assert.equal(passed.status, 0, passed.stdout);
  assert.match(passed.stdout, /"operation":"check_config","status":"succeeded"/);
});
