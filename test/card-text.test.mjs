import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CARD_TEXT, createCardTextProvider } from '../src/channels/feishu/card-text.mjs';
import { ExecutionCard, renderExecutionCard } from '../src/channels/feishu/execution-card.mjs';

const quiet = () => {};
const cardFile = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-chat-bridge-card-text-'));
  return { directory, file: join(directory, 'card-text.json') };
};
const writeJson = (file, value) => writeFile(file, JSON.stringify(value), 'utf8');

test('default card text is a frozen plain object and providers fall back to it', async (t) => {
  const { directory, file } = await cardFile();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const getText = createCardTextProvider({ file, log: quiet });

  assert.equal(Object.getPrototypeOf(DEFAULT_CARD_TEXT), Object.prototype);
  assert.equal(Object.isFrozen(DEFAULT_CARD_TEXT), true);
  assert.deepEqual(await createCardTextProvider()(), DEFAULT_CARD_TEXT);
  assert.deepEqual(await getText(), DEFAULT_CARD_TEXT);
});

test('card text providers keep their files and valid values isolated', async (t) => {
  const first = await cardFile();
  const second = await cardFile();
  t.after(() => Promise.all([rm(first.directory, { recursive: true, force: true }), rm(second.directory, { recursive: true, force: true })]));
  await writeJson(first.file, { title: '甲机器人', running: '甲正在执行' });
  await writeJson(second.file, { title: '乙机器人', completed: '乙已完成' });
  const firstText = createCardTextProvider({ file: first.file, log: quiet });
  const secondText = createCardTextProvider({ file: second.file, log: quiet });

  assert.deepEqual(await firstText(), { ...DEFAULT_CARD_TEXT, title: '甲机器人', running: '甲正在执行' });
  assert.deepEqual(await secondText(), { ...DEFAULT_CARD_TEXT, title: '乙机器人', completed: '乙已完成' });
});

test('card text is reread after a valid hot update', async (t) => {
  const { directory, file } = await cardFile();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const getText = createCardTextProvider({ file, log: quiet });
  await writeJson(file, { received: '已接收 A' });
  assert.equal((await getText()).received, '已接收 A');
  await writeJson(file, { received: '已接收 B', stopButton: '结束任务' });

  assert.deepEqual(await getText(), { ...DEFAULT_CARD_TEXT, received: '已接收 B', stopButton: '结束任务' });
});

test('malformed or invalid card text preserves the previous valid document', async (t) => {
  const { directory, file } = await cardFile();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const getText = createCardTextProvider({ file, log: quiet });
  const valid = { ...DEFAULT_CARD_TEXT, title: '自定义标题', completed: '任务完成' };
  await writeJson(file, { title: valid.title, completed: valid.completed });
  assert.deepEqual(await getText(), valid);

  for (const invalid of [
    '{ not json',
    JSON.stringify(['不是对象']),
    JSON.stringify({ completed: '有效', unexpected: '未知键' }),
    JSON.stringify({ completed: '' }),
    JSON.stringify({ running: '包含\u0001控制字符' }),
    JSON.stringify({ running: '包含\u0085控制字符' }),
    JSON.stringify({ running: '😀'.repeat(81) }),
    JSON.stringify({ received: '😀'.repeat(201) }),
  ]) {
    await writeFile(file, invalid, 'utf8');
    assert.deepEqual(await getText(), valid);
  }
});

test('an empty title is invalid in a file but absence restores the default title', async (t) => {
  const { directory, file } = await cardFile();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const getText = createCardTextProvider({ file, log: quiet });
  await writeJson(file, { title: '自定义标题' });
  const valid = await getText();
  await writeJson(file, { title: '' });
  assert.deepEqual(await getText(), valid);
  await rm(file);

  assert.deepEqual(await getText(), DEFAULT_CARD_TEXT);
  assert.equal(DEFAULT_CARD_TEXT.title, '');
});

test('card text refuses symbolic links and files beyond the 16 KiB limit', async (t) => {
  const { directory, file } = await cardFile();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, 'target.json');
  await writeJson(target, { completed: '链接目标' });
  await symlink(target, file);
  const getText = createCardTextProvider({ file, log: quiet });
  assert.deepEqual(await getText(), DEFAULT_CARD_TEXT);
  await rm(file);
  await writeFile(file, '{"completed":"' + 'a'.repeat(16 * 1024) + '"}', 'utf8');

  assert.deepEqual(await getText(), DEFAULT_CARD_TEXT);
});

test('a configured root refuses a card text file outside that workspace', async (t) => {
  const workspace = await cardFile();
  const outside = await cardFile();
  t.after(() => Promise.all([rm(workspace.directory, { recursive: true, force: true }), rm(outside.directory, { recursive: true, force: true })]));
  await writeJson(outside.file, { completed: '不应读取' });
  const getText = createCardTextProvider({ file: outside.file, root: workspace.directory, log: quiet });

  assert.deepEqual(await getText(), DEFAULT_CARD_TEXT);
});

test('an execution card rereads text through its provider for later patches', async (t) => {
  const { directory, file } = await cardFile();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const message = {
    async create(payload) {
      calls.push({ method: 'create', payload });
      return { code: 0, data: { message_id: 'om_card' } };
    },
    async patch(payload) {
      calls.push({ method: 'patch', payload });
      return { code: 0 };
    },
  };
  await writeJson(file, { title: '第一版', running: '第一版执行中' });
  const card = new ExecutionCard({
    client: { im: { v1: { message } } },
    chatId: 'chat',
    uuid: 'card-text-hot-update',
    logger: quiet,
    cardTextProvider: createCardTextProvider({ file, log: quiet }),
  });
  card.push({ kind: 'started' });
  await card.chain;
  assert.equal(JSON.parse(calls[0].payload.data.content).header.title.content, '第一版');
  await writeJson(file, { title: '第二版', running: '第二版执行中' });
  card.push({ kind: 'commentary', id: 'progress-1', text: '继续处理' });
  await card.enqueue();
  card.stop();

  const patched = JSON.parse(calls[1].payload.data.content);
  assert.equal(patched.header.title.content, '第二版');
  assert.equal(patched.config.summary.content, '第二版 · 第二版执行中');
});

test('custom card text changes visible strings while preserving answer, colors and callbacks', () => {
  const text = {
    ...DEFAULT_CARD_TEXT,
    title: '我的执行助手',
    received: '已接单',
    running: '忙碌中',
    completed: '顺利完成',
    failed: '执行遇到问题',
    interrupted: '已停止',
    retrying: '尝试恢复',
    deferred: '补充已记录',
    stopButton: '立即停止',
    forkButton: '从历史继续',
    omitted: '更早记录已隐藏',
    fallback: '将通过普通消息发送',
  };
  const running = renderExecutionCard({ status: 'running', jobId: 'job-1', turnId: 'turn-1', omitted: true, entries: [] }, '# 原样答案', '默认名称', text);
  assert.equal(running.header.title.content, '我的执行助手');
  assert.equal(running.config.summary.content, '我的执行助手 · 忙碌中');
  assert.equal(running.header.template, 'blue');
  assert.equal(running.body.elements[0].text.content, '更早记录已隐藏');
  assert.deepEqual(running.body.elements.find((element) => element.content === '# 原样答案'), { tag: 'markdown', content: '# 原样答案', text_size: 'heading' });
  assert.equal(running.body.elements.find((element) => element.tag === 'button').text.content, '立即停止');
  assert.deepEqual(running.body.elements.find((element) => element.tag === 'button').behaviors, [{ type: 'callback', value: { action: 'stop_execution', jobId: 'job-1', expectedTurnId: 'turn-1' } }]);
  const toolCard = renderExecutionCard({ status: 'running', entries: [{ kind: 'tool', id: 'tool-1', title: '读取配置', status: 'running', summary: '' }] }, '', '默认名称', text);
  assert.equal(toolCard.body.elements[0].header.title.content, '1 个工具调用 · 1 个执行中');
  assert.equal(toolCard.body.elements[0].elements[0].header.title.content, '读取配置 · 忙碌中');
  assert.equal(toolCard.body.elements[0].elements[0].elements[0].text.content, '忙碌中');
  const escaped = renderExecutionCard({ status: 'running', entries: [] }, '', '默认名称', { ...text, running: '忙*碌_#' });
  assert.ok(escaped.body.elements.some((element) => element.content === '**忙\\*碌\\_\\#**'));

  const failed = renderExecutionCard({ status: 'failed', jobId: 'job-2', forkSourceThreadId: 'source-1', delivery: 'fallback', entries: [] }, '', '默认名称', text);
  assert.equal(failed.header.template, 'red');
  assert.ok(failed.body.elements.some((element) => element.content === '**执行遇到问题** · 将通过普通消息发送'));
  const fork = failed.body.elements.find((element) => element.tag === 'button');
  assert.equal(fork.text.content, '从历史继续');
  assert.deepEqual(fork.behaviors, [{ type: 'callback', value: { action: 'fork_busy_session', jobId: 'job-2', expectedSourceThreadId: 'source-1' } }]);

  const fallbackTitle = renderExecutionCard({ status: 'completed', entries: [] }, '', '显示名称', { ...text, title: '' });
  assert.equal(fallbackTitle.header.title.content, '显示名称');
  assert.equal(fallbackTitle.header.template, 'green');

  const visibleText = {
    running: '忙碌中',
    completed: '顺利完成',
    interrupted: '已停止',
    retrying: '尝试恢复',
    deferred: '补充已记录',
  };
  for (const [status, expected] of Object.entries(visibleText)) {
    const card = renderExecutionCard({ status, entries: [] }, '', '默认名称', text);
    assert.ok(card.body.elements.some((element) => element.content === '**' + expected + '**'));
  }
  assert.equal(renderExecutionCard({ status: 'running', entries: [] }, '', '默认名称', text).body.elements[0].text.content, '已接单');
});
