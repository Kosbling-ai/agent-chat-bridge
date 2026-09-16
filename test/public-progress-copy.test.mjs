import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicProgressProjector, renderPublicToolEntry } from '../src/shared/public-progress.mjs';

test('presentation metadata preserves the default public tool copy', () => {
  const project = createPublicProgressProjector();
  const start = project('item/started', { item: {
    id: 'read', type: 'commandExecution', command: 'cat /work/README.md', cwd: '/work',
    commandActions: [{ type: 'read', command: 'cat /work/README.md', path: '/work/README.md', name: 'README.md' }],
  } });
  assert.deepEqual(renderPublicToolEntry(start), { title: '读取 README.md', summary: '命令：cat\n读取 README.md' });
  const end = project('item/completed', { item: { id: 'read', type: 'commandExecution', durationMs: 1250, exitCode: 0 } });
  assert.deepEqual(renderPublicToolEntry(end), { title: '读取 README.md', summary: '耗时：1.3 秒\n退出码：0\n命令：cat\n读取 README.md' });
});

test('saved metadata is reformatted with current copy', () => {
  const project = createPublicProgressProjector();
  project('item/started', { item: { id: 'tool', type: 'mcpToolCall', tool: 'cancel_order' } });
  const end = project('item/completed', { item: { id: 'tool', type: 'mcpToolCall', tool: 'cancel_order', durationMs: 2100, exitCode: 7 } });
  const rendered = renderPublicToolEntry(end, {
    toolOrderLabel: 'Orders', toolLabel: 'Tool', durationLabel: 'Time', secondsLabel: 'sec', exitCodeLabel: 'Code',
    toolTitleTemplate: '{label} / {name}', fieldTemplate: '{label}={value}', durationTemplate: '{label}={seconds}{unit}',
  });
  assert.deepEqual(rendered, { title: 'Orders / cancel_order', summary: 'Time=2.1sec\nCode=7\nTool=cancel_order' });
});

test('legacy entries without metadata retain their saved public text', () => {
  const entry = { title: '旧标题', summary: '旧摘要' };
  assert.deepEqual(renderPublicToolEntry(entry, { toolLabel: 'Changed' }), { title: '旧标题', summary: '旧摘要' });
});

test('presentation metadata contains no command arguments, output or sensitive paths', () => {
  const project = createPublicProgressProjector();
  const event = project('item/started', { item: {
    id: 'safe', type: 'commandExecution', cwd: '/work', command: 'git build token=SECRET',
    arguments: { password: 'SECRET' }, aggregatedOutput: 'SECRET',
    commandActions: [{ type: 'search', command: 'git build token=SECRET', path: '/outside/PRIVATE', query: 'SECRET' }],
  } });
  assert.deepEqual(event.presentation, {
    version: 1, kind: 'command', data: { programs: ['git build'], actions: [{ kind: 'search' }] },
  });
  assert.ok(!JSON.stringify(event.presentation).includes('SECRET'));
  assert.ok(!JSON.stringify(event.presentation).includes('PRIVATE'));
});

test('rendering validates metadata again and bounds public output', () => {
  const bad = {
    title: 'safe fallback', summary: 'token=SECRET',
    presentation: { version: 1, kind: 'tool', variant: 'generic', data: { name: 'token=SECRET' } },
  };
  assert.deepEqual(renderPublicToolEntry(bad), { title: 'safe fallback', summary: '[已隐藏凭据]' });
  const project = createPublicProgressProjector();
  const event = project('item/started', { item: { id: 'git', type: 'commandExecution', command: 'git build --flag SECRET' } });
  assert.equal(renderPublicToolEntry(event).title, 'git build');
  assert.ok(renderPublicToolEntry({ title: 'x'.repeat(150), summary: 'y'.repeat(700) }).title.length <= 100);
  assert.ok(renderPublicToolEntry({ title: 'x', summary: 'y'.repeat(700) }).summary.length <= 500);
});
