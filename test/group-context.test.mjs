import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../src/config.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';
import { checkGroupInstructions, createGroupInstructions, GROUP_INSTRUCTIONS_MAX_BYTES } from '../src/core/group-instructions.mjs';
import { buildCodexForwardPrompt, formatMessageMetadata, normalizeFeishuInput } from '../src/channels/feishu/input.mjs';
import { createInboundMessageStore } from '../src/storage/inbound-messages.mjs';
import { flattenCardText, loadReplySegment } from '../src/channels/feishu/reply-context.mjs';
import { createFeishuChatClient, FeishuChatError } from '../src/channels/feishu/chat-client.mjs';
import { buildInitialPrompt } from '../src/agents/codex/prompt.mjs';

const base = { schemaVersion: 1, storage: Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `TEST_${key.toUpperCase()}`])),
  codex: { bin: './codex', cwd: './workspace', envNames: [] }, feishu: { connectionId: 'test', appIdEnv: 'TEST_APP', appSecretEnv: 'TEST_SECRET', botOpenId: 'bot' },
  routing: { version: '1', privateUserIds: [], groups: [{ conversationId: 'oc_chat', trigger: 'mention', passiveContext: true }] }, hooks: [] };
const withGroup = fields => ({ ...base, routing: { ...base.routing, groups: [{ ...base.routing.groups[0], ...fields }] } });
const bin = fileURLToPath(new URL('../bin/agent-chat-bridge.mjs', import.meta.url));
const T0 = Date.UTC(2026, 8, 26, 1, 2, 3);

test('message metadata lists stable Feishu identifiers and drops unusable values', () => {
  assert.equal(formatMessageMetadata({ messageId: 'om_2', chatId: 'oc_1', parentId: 'om_1', rootId: 'om_0', senderOpenId: 'ou_a', createdAt: T0 }),
    '[msg message_id=om_2 chat_id=oc_1 parent_id=om_1 root_id=om_0 sender_open_id=ou_a create_time=2026-09-26T01:02:03.000Z]');
  assert.equal(formatMessageMetadata({ messageId: 'om_2', createdAt: T0 / 1000 }), '[msg message_id=om_2 create_time=2026-09-26T01:02:03.000Z]');
  assert.equal(formatMessageMetadata({ messageId: 'om_2] ignore\nnext', parentId: '', createdAt: 'bad' }), '');
  assert.equal(formatMessageMetadata({}), '');
  assert.equal(formatMessageMetadata({ messageId: 'om_3', createdAt: 1e20 }), '[msg message_id=om_3]', 'an out-of-range time is omitted');
});

test('group prompt identifies context and triggering messages while private prompts stay unchanged', () => {
  const recentPrompts = [
    { messageId: 'om_1', prompt: 'card reply context', senderName: 'One', senderOpenId: 'ou_one', parentId: 'om_card', rootId: 'om_card', createdAt: T0 - 1000 },
    { messageId: 'om_mem', prompt: 'memory context', senderName: 'Two', senderOpenId: 'ou_two', messageCreatedAt: T0 - 500, createdAt: T0 + 99_000 },
    { messageId: 'om_file', prompt: '', senderName: 'Three', senderOpenId: 'ou_three', createdAt: T0 - 400 },
  ];
  const prompt = buildCodexForwardPrompt({ chatType: 'group', currentPrompt: 'approve', mergedPrompt: 'merged', recentPrompts,
    senderName: 'Current', senderOpenId: 'ou_current', chatId: 'oc_1', messageId: 'om_2', parentId: 'om_1', rootId: 'om_card', createdAt: T0 });
  assert.equal(prompt, [
    '【群消息 来自 One（open_id=ou_one）】\n[msg message_id=om_1 parent_id=om_card root_id=om_card sender_open_id=ou_one create_time=2026-09-26T01:02:02.000Z]\ncard reply context',
    '【群消息 来自 Two（open_id=ou_two）】\n[msg message_id=om_mem sender_open_id=ou_two create_time=2026-09-26T01:02:02.500Z]\nmemory context',
    '【提到你的消息 来自 Current（open_id=ou_current）】\n[msg message_id=om_2 chat_id=oc_1 parent_id=om_1 root_id=om_card sender_open_id=ou_current create_time=2026-09-26T01:02:03.000Z]\napprove',
  ].join('\n\n'));
  const bodyless = buildCodexForwardPrompt({ chatType: 'group', currentPrompt: '', mergedPrompt: '', recentPrompts: recentPrompts.slice(0, 1),
    senderName: 'Current', senderOpenId: 'ou_current', chatId: 'oc_1', messageId: 'om_image', createdAt: T0 });
  assert.match(bodyless, /【提到你的消息 来自 Current（open_id=ou_current）】\n\[msg message_id=om_image chat_id=oc_1 sender_open_id=ou_current create_time=[^\]]+\]$/);
  const privatePrompt = buildCodexForwardPrompt({ chatType: 'p2p', currentPrompt: 'hello', mergedPrompt: 'hello', senderName: 'Human',
    senderOpenId: 'ou_human', chatId: 'oc_p2p', messageId: 'om_p2p', parentId: 'om_parent', createdAt: T0 });
  assert.equal(privatePrompt, '【发给你的飞书消息 来自 Human】\n\nhello');
});

test('normalized Feishu input keeps parent and root message identifiers', () => {
  const normalized = normalizeFeishuInput({ messageId: 'om_2', conversationId: 'oc_1', conversationType: 'group', occurredAt: T0,
    actor: { type: 'user', openId: 'ou_a' }, message: { kind: 'text', content: '{"text":"hi"}', parentId: 'om_1', rootId: 'om_0', mentions: [] } });
  assert.equal(normalized.parentId, 'om_1');
  assert.equal(normalized.rootId, 'om_0');
  assert.equal(normalizeFeishuInput({ message: { message_id: 'om', parent_id: 'om_p', root_id: 'om_r', content: '{"text":""}' } }).parentId, 'om_p');
});

test('passive context stores reply identifiers and each forwarded context entry carries its message_id', async () => {
  const accepted = []; const forwarded = [];
  const config = validateConfig(base);
  let persisted = [];
  const runtime = createCommunicationRuntime({ config, store: { acceptInbound: async input => { accepted.push(input); return { duplicate: false }; } },
    inbound: { async loadRecentGroupContext() { return persisted; } },
    forward: { handleMessage: async input => { forwarded.push(input); return { execution: { terminal: 'completed' } }; } }, chat: {}, now: () => T0 + 1000 });
  const event = (id, text, message = {}) => ({ connectionId: 'test', source: 'live', eventKey: id, type: 'message.received', conversationId: 'oc_chat',
    conversationType: 'group', messageId: id, occurredAt: T0, actor: { type: 'user', openId: 'ou_alice', name: 'Alice' },
    message: { kind: 'text', content: JSON.stringify({ text }), mentions: [], ...message } });
  await runtime.ingest(event('om_passive', 'looks good', { parentId: 'om_card', rootId: 'om_card' }));
  assert.equal(accepted[0].passiveContext, true);
  assert.equal(accepted[0].inboundMessage.content.parentId, 'om_card');
  assert.equal(accepted[0].inboundMessage.content.rootId, 'om_card');
  persisted = [{ inboundId: 1, messageId: 'om_db', senderOpenId: 'ou_bob', senderName: 'Bob', prompt: 'database context', createdAt: T0 - 60_000, attachments: [], source: 'persisted_group_context' }];
  await runtime.ingest(event('om_mention', '<at>bot</at> approve', { parentId: 'om_passive', rootId: 'om_card', mentions: [{ openId: 'bot', key: '<at>bot</at>' }] }));
  await new Promise(setImmediate);
  assert.equal(forwarded.length, 1);
  const { prompt } = forwarded[0];
  assert.match(prompt, /【群消息 来自 Bob（open_id=ou_bob）】\n\[msg message_id=om_db sender_open_id=ou_bob create_time=2026-09-26T01:01:03.000Z\]\ndatabase context/);
  assert.match(prompt, /【群消息 来自 Alice（open_id=ou_alice）】\n\[msg message_id=om_passive parent_id=om_card root_id=om_card sender_open_id=ou_alice create_time=2026-09-26T01:02:03.000Z\]\nlooks good/);
  assert.match(prompt, /【提到你的消息 来自 Alice（open_id=ou_alice）】\n\[msg message_id=om_mention chat_id=oc_chat parent_id=om_passive root_id=om_card sender_open_id=ou_alice create_time=2026-09-26T01:02:03.000Z\]\n【被回复消息】\n\[msg message_id=om_passive parent_id=om_card root_id=om_card sender_open_id=ou_alice create_time=2026-09-26T01:02:03.000Z\]\n> 内容见上方同 message_id 的群消息\napprove$/);
  assert.doesNotMatch(accepted[0].inboundMessage.content.text, /msg/);
});

test('persisted group context maps stored reply identifiers and tolerates older rows', async () => {
  const rows = [
    { id: 1, message_id: 'om_old', chat_id: 'oc', chat_type: 'group', message_type: 'text', sender_open_id: 'ou', sender_name: 'Old', content_text: 'old', content_json: '{"text":"old"}', message_created_at: 1000 },
    { id: 2, message_id: 'om_new', chat_id: 'oc', chat_type: 'group', message_type: 'text', sender_open_id: 'ou', sender_name: 'New', content_text: 'new', content_json: '{"text":"new","parentId":"om_p","rootId":"om_r"}', message_created_at: 1500 },
  ];
  const connection = { async query() {}, async execute() { return [[...rows].reverse()]; }, release() {}, destroy() {} };
  const inbound = createInboundMessageStore({ pool: { async getConnection() { return connection; } }, connectionId: 'test' });
  const entries = await inbound.loadRecentGroupContext({ connectionId: 'test', chatId: 'oc', beforeMs: 2000 });
  assert.deepEqual(entries.map(entry => [entry.messageId, entry.parentId, entry.rootId]), [['om_old', '', ''], ['om_new', 'om_p', 'om_r']]);
});

test('group instruction fields are optional, trimmed, bounded and strictly typed', () => {
  const group = validateConfig(withGroup({ instructionFiles: ['/abs/rules.md', 'relative/rules.md'], instructionText: '  follow the rules  ' })).routing.groups[0];
  assert.deepEqual(group.instructionFiles, ['/abs/rules.md', 'relative/rules.md']);
  assert.equal(group.instructionText, 'follow the rules');
  assert.equal(validateConfig(base).routing.groups[0].instructionFiles, undefined);
  for (const instructionFiles of [[], 'rules.md', [''], [' rules.md'], ['a.md', 'a.md'], ['bad\u0000.md'], [7], Array.from({ length: 21 }, (_, index) => `${index}.md`)]) {
    assert.throws(() => validateConfig(withGroup({ instructionFiles })), { code: 'invalid_group_instruction_files' });
  }
  for (const instructionText of ['', '   ', 7, 'x'.repeat(8001), 'bad\u0007bell']) {
    assert.throws(() => validateConfig(withGroup({ instructionText })), { code: 'invalid_group_instruction_text' });
  }
});

test('instruction preflight reports missing, oversized, invalid and combined-limit files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-instructions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'ok.md'), '# Rules\nreply briefly\n');
  await writeFile(join(root, 'big.md'), 'x'.repeat(GROUP_INSTRUCTIONS_MAX_BYTES + 1));
  await writeFile(join(root, 'half.md'), 'y'.repeat(GROUP_INSTRUCTIONS_MAX_BYTES / 2 + 1));
  await writeFile(join(root, 'bad.md'), Buffer.from([0xff, 0xfe, 0xfd]));
  await writeFile(join(root, 'empty.md'), ' \n');
  assert.deepEqual(await checkGroupInstructions([{ conversationId: 'oc_ok', instructionFiles: ['docs/ok.md', join(root, 'docs', 'ok.md')] }], { configDir: root }), []);
  const problems = await checkGroupInstructions([
    { conversationId: 'oc_plain' },
    { conversationId: 'oc_bad', instructionFiles: ['missing.md', 'big.md', 'docs', 'bad.md', 'empty.md'] },
    { conversationId: 'oc_total', instructionFiles: ['half.md', 'half.md'.replace('half', './half')] },
  ], { configDir: root });
  assert.deepEqual(problems, [
    { chatId: 'oc_bad', stage: 'file_0', reason: 'missing' },
    { chatId: 'oc_bad', stage: 'file_1', reason: 'too_large' },
    { chatId: 'oc_bad', stage: 'file_2', reason: 'not_file' },
    { chatId: 'oc_bad', stage: 'file_3', reason: 'invalid_utf8' },
    { chatId: 'oc_bad', stage: 'file_4', reason: 'empty' },
    { chatId: 'oc_total', stage: 'file_1', reason: 'total_too_large' },
  ]);
});

test('instruction provider hot-reloads changed files and skips unreadable files with one warning', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-instructions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'rules.md'), 'version one');
  const logs = [];
  const provider = createGroupInstructions({ groups: [{ conversationId: 'oc_1', instructionText: 'short text', instructionFiles: ['rules.md', 'missing.md'] }, { conversationId: 'oc_plain' }],
    configDir: root, log: (...entry) => logs.push(entry) });
  assert.equal(provider.configured('oc_1'), true);
  assert.equal(provider.configured('oc_plain'), false);
  assert.equal(await provider.forChat('oc_plain'), null);
  const first = await provider.forChat('oc_1');
  assert.match(first.text, /^【飞书群指令】\nchat_id：oc_1\n/);
  assert.match(first.text, /short text\n\n【指令文件 1】\nversion one$/);
  assert.doesNotMatch(first.text, /\/Users\//);
  assert.equal(first.sources, 2);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.equal((await provider.forChat('oc_1')).hash, first.hash);
  assert.deepEqual(logs.map(([level, operation, status, fields]) => [level, operation, status, fields.reason, fields.stage, fields.chatId]),
    [['warning', 'group_instructions', 'skipped', 'missing', 'file_1', 'oc_1']], 'repeated failures warn once');
  await writeFile(join(root, 'rules.md'), 'version two');
  await utimes(join(root, 'rules.md'), new Date(), new Date(Date.now() + 5000));
  const changed = await provider.forChat('oc_1');
  assert.notEqual(changed.hash, first.hash);
  assert.match(changed.text, /version two$/);
  await writeFile(join(root, 'missing.md'), 'now present');
  assert.match((await provider.forChat('oc_1')).text, /now present$/);
  assert.equal(logs.at(-1)[2], 'recovered');
  assert.doesNotMatch(JSON.stringify(logs), /version|present|short text/);
  await rm(join(root, 'rules.md'));
  await rm(join(root, 'missing.md'));
  assert.equal((await provider.forChat('oc_1')).sources, 1, 'configured text survives when every file is unavailable');
  const fileOnly = createGroupInstructions({ groups: [{ conversationId: 'oc_2', instructionFiles: ['gone.md'] }], configDir: root });
  assert.equal(await fileOnly.forChat('oc_2'), null);
});

test('check-config validates configured instruction files relative to the config file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-check-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'bridge.json');
  const run = () => spawnSync(process.execPath, [bin, 'check-config', '--config', configPath], { encoding: 'utf8', timeout: 20000 });
  await writeFile(configPath, JSON.stringify(withGroup({ instructionFiles: ['rules/group.md'] })));
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /"code":"invalid_group_instruction_file".*"reason":"missing".*"stage":"file_0".*"chat_id":"oc_chat"/);
  assert.doesNotMatch(missing.stdout, /group\.md/);
  await mkdir(join(root, 'rules'));
  await writeFile(join(root, 'rules', 'group.md'), 'rules');
  const passed = run();
  assert.equal(passed.status, 0, passed.stdout);
  assert.match(passed.stdout, /"operation":"check_config","status":"succeeded"/);
  for (const fields of [{ instructionFiles: ['rules/group.md'] }, { instructionText: 'rules' }, { instructionMode: 'append' }, { replyContext: {} }]) {
    await writeFile(configPath, JSON.stringify(withGroup({ capabilities: ['hook'], ...fields })));
    const rejected = run();
    assert.equal(rejected.status, 1, rejected.stdout);
  }
});

const cardItem = (content, extra = {}) => ({ message_id: 'om_card', msg_type: 'interactive', body: { content: JSON.stringify(content) },
  sender: { id: 'cli_bot', id_type: 'app_id', sender_type: 'app' }, create_time: String(T0 - 5000), ...extra });
const receivedCard = { title: '邮件回复草稿 v3', elements: [
  [{ tag: 'text', text: '收件人：客户 A' }, { tag: 'at', user_id: '@_user_1', user_name: 'Alice' }],
  [{ tag: 'a', text: '查看详情', href: 'https://example.invalid/internal?token=hidden' }],
  [{ tag: 'button', text: '批准', type: 'primary' }, { tag: 'button', text: '驳回', type: 'danger' }],
  [{ tag: 'img', image_key: 'img_hidden' }, { tag: 'hr' }],
] };
const originalCard = { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: '审批卡' }, template: 'blue' },
  body: { elements: [
    { tag: 'markdown', content: '**正文** 第一段' },
    { tag: 'div', text: { tag: 'lark_md', content: '字段说明' }, fields: [{ is_short: true, text: { tag: 'lark_md', content: '版本：3' } }] },
    { tag: 'column_set', columns: [{ tag: 'column', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '批准发送' },
      behaviors: [{ type: 'callback', value: { action: 'business', hook_id: 'hidden-hook', action_id: 'act_hidden', body_hash: 'hash_hidden' } }] }] }] },
    { tag: 'select_static', placeholder: { tag: 'plain_text', content: '选择原因' }, options: [{ text: { tag: 'plain_text', content: 'hidden option' }, value: 'x' }] },
  ] } };

test('card flattening keeps visible text in order and drops callback values, links and keys', () => {
  assert.equal(flattenCardText(receivedCard), '邮件回复草稿 v3\n收件人：客户 A\n@Alice\n查看详情\n[按钮] 批准\n[按钮] 驳回\n[图片]');
  const flattened = flattenCardText(originalCard);
  assert.equal(flattened, '审批卡\n**正文** 第一段\n字段说明\n版本：3\n[按钮] 批准发送\n[控件] 选择原因');
  assert.doesNotMatch(flattened, /hidden|act_|hash_|business/);
  const callbackCards = [
    { elements: [[{ tag: 'button', text: '批准', value: { text: 'hidden-value-text', content: 'hidden-value-content' } }]] },
    { schema: '2.0', value: { text: 'hidden-value-text', content: 'hidden-value-content' },
      behaviors: [{ type: 'callback', value: { text: 'hidden' } }],
      body: { elements: [{ tag: 'button', text: '批准', behaviors: [{ type: 'callback', value: { text: 'hidden' } }] }] } },
  ];
  for (const card of callbackCards) {
    const text = flattenCardText(card);
    assert.match(text, /\[按钮\] 批准/);
    assert.doesNotMatch(text, /hidden(?:-value-(?:text|content))?/);
  }
});

test('reply segment reads a text parent through the chat client and resolves mention names', async () => {
  const calls = [];
  const chat = { async getMessage(input) { calls.push(input); return { items: [{ message_id: 'om_1', msg_type: 'text', parent_id: 'om_0', root_id: 'om_0',
    body: { content: JSON.stringify({ text: '@_user_1 请确认报价' }) }, mentions: [{ key: '@_user_1', name: 'Alice' }],
    sender: { id: 'ou_a', id_type: 'open_id', sender_type: 'user' }, create_time: String(T0) }] }; } };
  const segment = await loadReplySegment({ chat, parentId: 'om_1', chatId: 'oc_1' });
  assert.equal(segment, '【被回复消息】\n[msg message_id=om_1 msg_type=text parent_id=om_0 root_id=om_0 sender_type=user sender_open_id=ou_a create_time=2026-09-26T01:02:03.000Z]\n> @Alice 请确认报价');
  assert.deepEqual(calls, [{ messageId: 'om_1', timeoutMs: 5000 }]);
});

test('reply segment flattens a card parent and adds truncated original JSON only when enabled', async () => {
  const calls = [];
  const chat = { async getMessage(input) { calls.push(input);
    return { items: [cardItem(input.cardContentType ? originalCard : receivedCard)] }; } };
  const plain = await loadReplySegment({ chat, parentId: 'om_card', chatId: 'oc_1' });
  assert.equal(plain, '【被回复消息】\n[msg message_id=om_card msg_type=interactive sender_type=app sender_app_id=cli_bot create_time=2026-09-26T01:01:58.000Z]\n'
    + '> 邮件回复草稿 v3\n> 收件人：客户 A\n> @Alice\n> 查看详情\n> [按钮] 批准\n> [按钮] 驳回\n> [图片]');
  assert.equal(calls.length, 1, 'card JSON is not requested by default');
  const withJson = await loadReplySegment({ chat, parentId: 'om_card', chatId: 'oc_1', cardJson: true, maxChars: 200 });
  assert.deepEqual(calls.slice(1), [{ messageId: 'om_card', timeoutMs: 5000 }, { messageId: 'om_card', cardContentType: 'user_card_content', timeoutMs: 5000 }]);
  const [, json] = withJson.split('【被回复卡片 JSON】\n');
  assert.match(json, /^> \{"schema":"2\.0"/);
  assert.match(json, /…（已截断）$/);
  assert.equal(Array.from(json.slice(2).replace('…（已截断）', '')).length, 200);
  assert.match(withJson, /> \[按钮\] 驳回\n> \[图片\]\n【被回复卡片 JSON】/);
  const long = await loadReplySegment({ chat: { async getMessage() { return { items: [{ message_id: 'om_long', msg_type: 'text', body: { content: JSON.stringify({ text: 'x'.repeat(500) }) }, sender: {} }] }; } },
    parentId: 'om_long', maxChars: 200 });
  assert.match(long, /\n> x{200}…（已截断）$/);
});

test('an unavailable parent is marked in the prompt and logged as a warning without content', async () => {
  const logs = [];
  const failing = { async getMessage() { throw new FeishuChatError('feishu_api_rejected', 'failed', 230002); } };
  assert.equal(await loadReplySegment({ chat: failing, parentId: 'om_gone', chatId: 'oc_1', log: (...entry) => logs.push(entry) }),
    '【被回复消息】\n[msg message_id=om_gone]\n> 被回复内容不可得');
  assert.deepEqual(logs, [['warning', 'reply_context', 'unavailable', { code: 'feishu_api_rejected', stage: 'message', chatId: 'oc_1', messageId: 'om_gone' }]]);
  assert.match(await loadReplySegment({ chat: { async getMessage() { return { items: [{ message_id: 'om_d', deleted: true }] }; } }, parentId: 'om_d' }), /被回复内容不可得$/);
  assert.match(await loadReplySegment({ chat: {}, parentId: 'om_x' }), /被回复内容不可得$/);
  const jsonLogs = [];
  const jsonFailure = { async getMessage(input) { if (input.cardContentType) throw new FeishuChatError('feishu_transport_error', 'failed'); return { items: [cardItem(receivedCard)] }; } };
  assert.match(await loadReplySegment({ chat: jsonFailure, parentId: 'om_card', cardJson: true, log: (...entry) => jsonLogs.push(entry) }), /【被回复卡片 JSON】\n> 卡片 JSON 不可得$/);
  assert.equal(jsonLogs[0][3].stage, 'card_json');
});

test('group triggers fetch only the replied-to message while passive replies keep only their parent id', async () => {
  const forwarded = []; const fetched = [];
  const config = validateConfig(withGroup({ replyContext: { cardJson: false, maxChars: 1000 } }));
  const chat = { async getMessage(input) { fetched.push(input.messageId); return { items: [cardItem(receivedCard)] }; } };
  const runtime = createCommunicationRuntime({ config, store: { acceptInbound: async () => ({ duplicate: false }) },
    forward: { handleMessage: async input => { forwarded.push(input); return { execution: { terminal: 'completed' } }; } }, chat, now: () => T0 + 1000 });
  const event = (id, text, message = {}) => ({ connectionId: 'test', source: 'live', eventKey: id, type: 'message.received', conversationId: 'oc_chat',
    conversationType: 'group', messageId: id, occurredAt: T0, actor: { type: 'user', openId: 'ou_alice', name: 'Alice' },
    message: { kind: 'text', content: JSON.stringify({ text }), mentions: [], ...message } });
  await runtime.ingest(event('om_passive', '先等等', { parentId: 'om_other_card', rootId: 'om_other_card' }));
  await runtime.ingest(event('om_mention', '<at>bot</at> 批准', { parentId: 'om_card', rootId: 'om_card', mentions: [{ openId: 'bot', key: '<at>bot</at>' }] }));
  for (let attempt = 0; attempt < 50 && !forwarded.length; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  assert.deepEqual(fetched, ['om_card']);
  const { prompt } = forwarded[0];
  assert.match(prompt, /\[msg message_id=om_passive parent_id=om_other_card root_id=om_other_card sender_open_id=ou_alice [^\]]+\]\n先等等/);
  assert.match(prompt, /\[msg message_id=om_mention chat_id=oc_chat parent_id=om_card root_id=om_card [^\]]+\]\n【被回复消息】\n\[msg message_id=om_card msg_type=interactive [^\]]+\]\n> 邮件回复草稿 v3\n[\s\S]*> \[按钮\] 批准\n[\s\S]*\n批准$/);
  const privateRuntime = createCommunicationRuntime({ config: validateConfig({ ...base, routing: { ...base.routing, privateUserIds: ['ou_alice'] } }),
    store: { acceptInbound: async () => ({ duplicate: false }) }, forward: { handleMessage: async input => { forwarded.push(input); return { execution: { terminal: 'completed' } }; } }, chat, now: () => T0 + 1000 });
  await privateRuntime.ingest({ ...event('om_private', 'hello', { parentId: 'om_card' }), conversationId: 'oc_p2p', conversationType: 'p2p' });
  for (let attempt = 0; attempt < 50 && forwarded.length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(forwarded[1].prompt, '【发给你的飞书消息 来自 Alice】\n\nhello');
  assert.deepEqual(fetched, ['om_card'], 'private chats do not fetch replied-to messages');
});

test('reply context and instruction mode settings are validated', () => {
  assert.deepEqual(validateConfig(withGroup({ replyContext: {} })).routing.groups[0].replyContext, { cardJson: false, maxChars: 4000 });
  assert.deepEqual(validateConfig(withGroup({ replyContext: { cardJson: true, maxChars: 8000 } })).routing.groups[0].replyContext, { cardJson: true, maxChars: 8000 });
  for (const replyContext of [null, [], { cardJson: 'yes' }, { maxChars: 100 }, { maxChars: 30001 }, { extraFields: [] }]) {
    assert.throws(() => validateConfig(withGroup({ replyContext })), { code: /^invalid_group_(reply_context|fields)$/ });
  }
  assert.equal(validateConfig(withGroup({ instructionText: 'rules' })).routing.groups[0].instructionMode, 'append');
  assert.equal(validateConfig(withGroup({ instructionText: 'rules', instructionMode: 'replace' })).routing.groups[0].instructionMode, 'replace');
  assert.equal(validateConfig(base).routing.groups[0].instructionMode, undefined);
  for (const fields of [{ instructionText: 'rules', instructionMode: 'prepend' }, { instructionMode: 'append' }]) {
    assert.throws(() => validateConfig(withGroup(fields)), { code: 'invalid_group_instruction_mode' });
  }
  for (const fields of [{ instructionFiles: ['rules.md'] }, { instructionText: 'rules' }, { instructionMode: 'append' }, { replyContext: {} }]) {
    assert.throws(() => validateConfig(withGroup({ capabilities: ['hook'], ...fields })), { code: /^(?:group_context_requires_bridge|invalid_group_instruction_mode)$/ });
  }
});

test('chat client requests original card JSON and a bounded read timeout only when asked', async () => {
  const requests = [];
  const client = { im: { v1: { message: { async get(request) { requests.push(request); return { code: 0, data: { items: [] } }; } } } } };
  const chat = createFeishuChatClient({ client });
  await chat.getMessage({ messageId: 'om_1' });
  await chat.getMessage({ messageId: 'om_1', cardContentType: 'user_card_content', timeoutMs: 5000 });
  assert.deepEqual(requests.map(request => request.params), [{ user_id_type: 'open_id' }, { user_id_type: 'open_id', card_msg_content_type: 'user_card_content' }]);
  assert.throws(() => chat.getMessage({ messageId: 'om_1', cardContentType: 'raw' }), { code: 'invalid_card_content_type' });
  assert.throws(() => chat.getMessage({ messageId: 'om_1', timeoutMs: 60000 }), { code: 'invalid_chat_argument' });
});

test('instruction modes differ only in the injected note and replace mode drops only default group wording', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-instruction-mode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = createGroupInstructions({ groups: [{ conversationId: 'oc_a', instructionText: 'rules', instructionMode: 'append' },
    { conversationId: 'oc_r', instructionText: 'rules', instructionMode: 'replace' }], configDir: root });
  const append = await provider.forChat('oc_a'); const replace = await provider.forChat('oc_r');
  assert.equal(append.mode, 'append'); assert.equal(replace.mode, 'replace');
  assert.match(append.text, /是对 bridge 默认群聊上下文的补充/);
  assert.match(replace.text, /取代 bridge 默认的群名称、群介绍和会话说明[\s\S]*chat_id、回发文件目录、附件和消息标识等运行时说明仍然有效/);
  const binding = { feishuOpenId: 'group:oc_r', chatId: 'oc_r', chatType: 'group', created: true };
  const options = { binding, prompt: '【提到你的消息 来自 Bob（open_id=ou_b）】\n[msg message_id=om_2 chat_id=oc_r]\nhi',
    groupChatContext: { chatId: 'oc_r', name: '默认群名', description: '默认介绍' }, allowedGroupChatIds: new Set(['oc_r']) };
  const appended = buildInitialPrompt(options);
  const replaced = buildInitialPrompt({ ...options, groupOpening: false });
  for (const prompt of [appended, replaced]) {
    assert.match(prompt, /^【飞书群聊上下文】\n/);
    assert.match(prompt, /\nchat_id：oc_r\n/);
    assert.match(prompt, /\n回发文件目录：data\/feishu-outbox\/oc_r\n说明：需要给当前群回发文件时/);
    assert.match(prompt, /\n\n【提到你的消息 来自 Bob（open_id=ou_b）】\n\[msg message_id=om_2 chat_id=oc_r\]\nhi$/);
  }
  assert.match(appended, /群名称：默认群名\n群介绍：默认介绍\nchat_id：oc_r\n说明：这是本 Codex 会话绑定的飞书群/);
  assert.doesNotMatch(replaced, /默认群名|默认介绍|这是本 Codex 会话绑定的飞书群/);
  assert.equal(buildInitialPrompt({ ...options, binding: { ...binding, created: false }, groupOpening: false }),
    `【飞书群聊文件回传】\n回发文件目录：data/feishu-outbox/oc_r\n说明：需要给当前群回发文件时，将文件写入该目录；运行时会通过飞书 SDK 发送。\n\n${options.prompt}`);
  const system = { feishuOpenId: 'system:x', chatId: 'oc_r', chatType: 'group', created: true };
  assert.match(buildInitialPrompt({ ...options, binding: system, groupOpening: false }), /^【独立系统任务】/);
});
