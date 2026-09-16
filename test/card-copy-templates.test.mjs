import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CARD_TEXT, CARD_TEXT_TEMPLATES, createCardTextProvider } from '../src/channels/feishu/card-text.mjs';
import { formatText } from '../src/shared/text-template.mjs';
import { ExecutionCard, renderExecutionCard } from '../src/channels/feishu/execution-card.mjs';

test('templates are single pass and unknown or malformed variables retain last valid copy', async t => {
  const root = await mkdtemp(join(tmpdir(), 'card-templates-')); t.after(() => rm(root, { recursive:true, force:true }));
  const file = join(root, 'copy.json'), get = createCardTextProvider({file});
  await writeFile(file, JSON.stringify({toolGroup:'{count} 项操作 · {activity}'}));
  const valid = await get();
  for (const value of ['{unknown}', '{count', '{{count}}', '{count.toString()}', '{count} {unknown}']) {
    await writeFile(file, JSON.stringify({toolGroup:value})); assert.deepEqual(await get(), valid);
  }
  assert.equal(formatText('{title} {status}', {title:'{status} $&',status:'完成'}), '{status} $& 完成');
  for (const [key, variables] of Object.entries(CARD_TEXT_TEMPLATES)) {
    const defaultValue = DEFAULT_CARD_TEXT[key];
    assert.equal(typeof defaultValue, 'string');
    for (const match of defaultValue.matchAll(/\{([^{}]+)\}/g)) assert.ok(variables.includes(match[1]));
  }
});

test('tool count and activity templates keep actual counts and callbacks', () => {
  const copy = {...DEFAULT_CARD_TEXT,toolGroup:'{count} 项行动 · {activity}',toolGroupRunning:'正在执行 {running} 项',toolGroupFinished:'全数收工',toolItem:'{title}（{status}）',toolUnknownStatus:'状态未知',cardSummary:'{title}：{status}'};
  const state = {status:'running',jobId:'job',turnId:'turn',entries:[{kind:'tool',title:'检查',status:'running'},{kind:'tool',title:'读取',status:'completed'}]};
  const card = renderExecutionCard(state,'','Cookie',copy);
  assert.equal(card.body.elements[0].header.title.content,'2 项行动 · 正在执行 1 项');
  assert.equal(card.body.elements[0].elements[0].header.title.content,'检查（执行中）');
  assert.equal(card.body.elements[0].elements[0].elements[0].text.content,'执行中');
  assert.equal(card.config.summary.content,'Cookie：执行中');
  assert.deepEqual(card.body.elements.at(-1).behaviors[0].value,{action:'stop_execution',jobId:'job',expectedTurnId:'turn'});
  state.entries.forEach(x=>x.status='completed');
  assert.equal(renderExecutionCard(state,'','Cookie',copy).body.elements[0].header.title.content,'2 项行动 · 全数收工');
});

test('missing tool summary follows hot-loaded state text instead of storing an old default', async () => {
  let current = {...DEFAULT_CARD_TEXT,running:'开工'}, content;
  const card = new ExecutionCard({client:{im:{v1:{message:{async create(p){content=JSON.parse(p.data.content);return {code:0,data:{message_id:'m'}};},async patch(p){content=JSON.parse(p.data.content);return {code:0};}}}}},chatId:'c',uuid:'u',cardTextProvider:async()=>current,logger:{info(){},warn(){}}});
  card.push({kind:'tool',id:'t',title:'检查',status:'running'});await card.chain;card.stop();
  assert.equal(card.snapshot().entries[0].summary,'');
  current={...current,running:'忙碌'};await card.update();
  assert.equal(content.body.elements[0].elements[0].elements[0].text.content,'忙碌');
});
