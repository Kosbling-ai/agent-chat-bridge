import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicProgressProjector } from '../src/shared/public-progress.mjs';

test('only completed public commentary and allowlisted lifecycle are published', () => {
  const project = createPublicProgressProjector();
  for (const type of ['reasoning', 'plan', 'function_call_output', 'unknown']) {
    assert.equal(project('item/completed', { item: { id: type, type, text: 'PRIVATE', output: 'PRIVATE' } }), null);
  }
  assert.equal(project('item/started', { item: { id: 'm', type: 'agentMessage', phase: 'commentary', text: 'token=abc' } }), null);
  assert.equal(project('item/agentMessage/delta', { itemId: 'm', delta: 'SECRET' }), null);
  const commentary = project('item/completed', { item: { id: 'm', type: 'agentMessage', phase: 'commentary', text: '正在检查 token=abcSECRET' } });
  assert.equal(commentary.kind, 'commentary');
  assert.ok(!commentary.text.includes('abc'));
  assert.equal(project('item/completed', { item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'answer' } }), null);
});

test('tools never expose raw commands, arbitrary arguments, sensitive paths or output', () => {
  const project = createPublicProgressProjector();
  const started = project('item/started', { item: { id: 't', type: 'commandExecution', command: 'curl SECRET', cwd: '/PRIVATE', arguments: { password: 'SECRET' } } });
  assert.equal(started.status, 'running'); assert.equal(started.title, 'curl');
  const completed = project('item/completed', { item: { id: 't', type: 'commandExecution', exitCode: 1, aggregatedOutput: 'SECRET' } });
  assert.equal(completed.status, 'failed');
  assert.ok(!JSON.stringify([started, completed]).includes('SECRET'));
  assert.equal(project('item/started', { item: { id: 'order', type: 'mcpToolCall', tool: 'cancel_order' } }).title, 'cancel_order · 处理订单');
});


test('structured actions expose program and relative target with real completion facts', () => {
  const project = createPublicProgressProjector();
  const start = project('item/started', { item: { id: 'read', type: 'commandExecution', command: 'cat /work/README.md', cwd: '/work', commandActions: [{ type: 'read', command: 'cat /work/README.md', path: '/work/README.md', name: 'README.md' }] } });
  assert.equal(start.title, '读取 README.md');
  assert.match(start.summary, /命令：cat/);
  const end = project('item/completed', { item: { id: 'read', type: 'commandExecution', command: 'cat /work/README.md', commandActions: [], durationMs: 1250, exitCode: 0 } });
  assert.equal(end.title, start.title);
  assert.match(end.summary, /README.md/); assert.match(end.summary, /1.3 秒/); assert.match(end.summary, /退出码：0/);
});

test('shell summaries never forward arguments, search queries, outputs or sensitive targets', () => {
  const project = createPublicProgressProjector();
  for (const command of ["/bin/zsh -lc 'curl -H token=SECRET https://private.example'", 'PASSWORD=SECRET curl --data SECRET', 'node -e "SECRET"', 'git diff -- SECRET']) {
    const event = project('item/started', { item: { id: 'safe-id', type: 'commandExecution', command, aggregatedOutput: 'SECRET' } });
    assert.ok(!JSON.stringify(event).includes('SECRET'));
    assert.ok(!event.title.includes('执行命令'));
  }
  for (const path of ['/outside/private', '/work/.env', '/work/local.env', '../private', '/work/.ssh/id_rsa']) {
    const event = project('item/started', { item: { id: 'safe-path-id', type: 'commandExecution', cwd: '/work', commandActions: [{type:'search', command:'rg SECRET', path, query:'SECRET'}] } });
    assert.ok(!JSON.stringify(event).includes(path)); assert.ok(!JSON.stringify(event).includes('SECRET'));
  }
});


test('structured skill action supplies a human-readable title without its absolute directory', () => {
 const project = createPublicProgressProjector();
 const start = project('item/started', {item:{id:'skill',type:'commandExecution',cwd:'/work',command:'sed -n 1,100p /Users/private/.claude/skills/foreman/SKILL.md',commandActions:[{type:'read',command:'sed -n 1,100p /Users/private/.claude/skills/foreman/SKILL.md',name:'SKILL.md',path:'/Users/private/.claude/skills/foreman/SKILL.md'}]}});
 assert.equal(start.title,'读取 foreman 技能'); assert.match(start.summary,/命令：sed/);
 assert.ok(!JSON.stringify(start).includes('/Users/'));
 const end = project('item/completed',{item:{id:'skill',type:'commandExecution',command:'sed',commandActions:[],exitCode:0}});
 assert.equal(end.title,start.title);
 const unknown=project('item/started',{item:{id:'unknown',type:'commandExecution',command:'git diff'}});
 assert.equal(unknown.title,'git diff');
});
