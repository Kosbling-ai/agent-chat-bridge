import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';

const base={schemaVersion:1,storage:Object.fromEntries(['host','port','user','password','database'].map(k=>[`${k}Env`,`TEST_${k.toUpperCase()}`])),codex:{bin:'./codex',cwd:'./workspace',envNames:[]},feishu:{connectionId:'test',appIdEnv:'TEST_APP',appSecretEnv:'TEST_SECRET',botOpenId:'bot'},routing:{version:'1',privateUserIds:['human'],groups:[{conversationId:'chat',trigger:'mention',passiveContext:true}]},hooks:[]};
const DEFAULT_TEXT='这个群暂时还没有 Kosbling Agent 使用权限。如果需要开通，请联系管理员，并提供 chat_id={{chat_id}}。';
const withReply=unlistedGroupReply=>({...base,routing:{...base.routing,unlistedGroupReply}});
const withGroups=groups=>({...base,routing:{...base.routing,groups}});
let sequence=0;
function event(overrides={}) {
  const id=`m${++sequence}`;
  return {connectionId:'test',source:'live',eventKey:id,type:'message.received',conversationId:'unlisted',conversationType:'group',messageId:id,occurredAt:Date.now(),
    actor:{type:'user',openId:'human',name:'Human'},message:{kind:'text',content:'{"text":"@bot hi"}',mentions:[{key:'@_user_1',openId:'bot',name:'bot'}]},...overrides};
}
function harness(raw=base,{recordOutbox,noOutbox=false,duplicate=false,clock}={}) {
  const outbox=[],accepted=[],forwarded=[],logs=[];let time=clock??1_000_000;
  const store={acceptInbound:async input=>{accepted.push(input);return{duplicate};},
    ...(noOutbox?{}:{recordOutbox:recordOutbox??(async input=>{outbox.push(input);return{id:`effect-${outbox.length}`};})})};
  const runtime=createCommunicationRuntime({config:validateConfig(raw),store,chat:{},now:()=>time,log:(...entry)=>logs.push(entry),
    forward:{handleMessage:async input=>{forwarded.push(input);return{execution:{terminal:'completed'}};}}});
  return {runtime,outbox,accepted,forwarded,logs,advance:ms=>{time+=ms;}};
}

test('unlisted group reply config defaults and explicit overrides',()=>{
  assert.deepEqual(validateConfig(base).routing.unlistedGroupReply,{enabled:true,text:DEFAULT_TEXT,cooldownMs:600000});
  assert.deepEqual(validateConfig(withReply({})).routing.unlistedGroupReply,{enabled:true,text:DEFAULT_TEXT,cooldownMs:600000});
  assert.deepEqual(validateConfig(withReply({enabled:true,text:'  联系 {{chat_id}}  ',cooldownMs:0})).routing.unlistedGroupReply,{enabled:true,text:'联系 {{chat_id}}',cooldownMs:0});
  assert.deepEqual(validateConfig(withReply({enabled:false})).routing.unlistedGroupReply,{enabled:false,text:DEFAULT_TEXT,cooldownMs:600000});
  assert.equal(validateConfig(withReply({text:'x'.repeat(2000),cooldownMs:86_400_000})).routing.unlistedGroupReply.cooldownMs,86_400_000);
});

test('unlisted group reply config rejects invalid values',()=>{
  assert.throws(()=>validateConfig(withReply({enabled:true,extra:1})),{code:'invalid_unlisted_group_reply_fields'});
  assert.throws(()=>validateConfig(withReply(null)),{code:'invalid_unlisted_group_reply_fields'});
  assert.throws(()=>validateConfig(withReply([])),{code:'invalid_unlisted_group_reply_fields'});
  assert.throws(()=>validateConfig(withReply('on')),{code:'invalid_unlisted_group_reply_fields'});
  for (const value of [{enabled:'yes'},{enabled:null},{text:''},{text:'   '},{text:'x'.repeat(2001)},{text:5},{text:null},
    {cooldownMs:-1},{cooldownMs:1.5},{cooldownMs:86_400_001},{cooldownMs:'600000'},{cooldownMs:null}])
    assert.throws(()=>validateConfig(withReply(value)),{code:'invalid_unlisted_group_reply'},JSON.stringify(value));
});

test('bot mention from an unlisted group queues one fixed reply without forwarding',async()=>{
  const {runtime,outbox,accepted,forwarded,logs}=harness();
  const message=event({conversationId:'oc_unlisted'});
  const receipt=await runtime.ingest(message);await new Promise(setImmediate);
  assert.deepEqual(receipt,{duplicate:false});
  assert.equal(accepted.length,1);
  assert.equal(forwarded.length,0);
  assert.equal(outbox.length,1);
  const [effect]=outbox;
  assert.equal(effect.kind,'reply');
  assert.equal(effect.connectionId,'test');
  assert.equal(effect.conversationId,'oc_unlisted');
  assert.equal(effect.idempotencyKey,`unlisted-group-reply:${message.messageId}`);
  assert.equal(effect.payload.messageId,message.messageId);
  assert.equal(effect.payload.kind,'text');
  assert.ok(effect.payload.content.text.includes('chat_id=oc_unlisted'));
  assert.ok(!effect.payload.content.text.includes('{{chat_id}}'));
  assert.deepEqual(logs,[['info','unlisted_group_reply','queued',{code:'unlisted_group_mention'}]]);
});

test('custom text replaces every chat id placeholder',async()=>{
  const {runtime,outbox}=harness(withReply({text:'{{chat_id}} / {{chat_id}}'}));
  await runtime.ingest(event({conversationId:'oc_x'}));
  assert.equal(outbox[0].payload.content.text,'oc_x / oc_x');
});

test('unlisted group reply cooldown is per group and speaker',async()=>{
  const {runtime,outbox,advance}=harness();
  await runtime.ingest(event());
  await runtime.ingest(event());
  assert.equal(outbox.length,1);
  await runtime.ingest(event({actor:{type:'user',openId:'other',name:'Other'}}));
  assert.equal(outbox.length,2);
  await runtime.ingest(event({conversationId:'unlisted-2'}));
  assert.equal(outbox.length,3);
  advance(599_999);
  await runtime.ingest(event());
  assert.equal(outbox.length,3);
  advance(1);
  await runtime.ingest(event());
  assert.equal(outbox.length,4);
  const zero=harness(withReply({cooldownMs:0}));
  for (let index=0;index<3;index+=1) await zero.runtime.ingest(event());
  assert.equal(zero.outbox.length,3);
});

test('unlisted group reply stays silent outside its trigger conditions',async()=>{
  const cases=[
    ['no mention',base,event({message:{kind:'text',content:'{"text":"hi"}',mentions:[]}})],
    ['other mention',base,event({message:{kind:'text',content:'{"text":"@x hi"}',mentions:[{key:'@_user_1',openId:'x',name:'x'}]}})],
    ['hook-only group',withGroups([{conversationId:'unlisted',trigger:'mention',passiveContext:false,capabilities:['hook']}]),event()],
    ['unauthorized speaker',withGroups([{conversationId:'unlisted',trigger:'mention',passiveContext:false,capabilities:['bridge'],userIds:['someone']}]),event()],
    ['history catchup',base,event({source:'history_catchup'})],
    ['self',base,event({isSelf:true})],
    ['app',base,event({isApp:true})],
    ['bot actor',base,event({actor:{type:'bot',openId:'human'}})],
    ['disabled',withReply({enabled:false}),event()],
    ['recall',base,event({type:'message.recalled'})],
  ];
  for (const [name,raw,message] of cases) {
    const {runtime,outbox,accepted}=harness(raw);
    await runtime.ingest(message);await new Promise(setImmediate);
    assert.equal(outbox.length,0,name);
    assert.equal(accepted.length,1,name);
  }
  const duplicate=harness(base,{duplicate:true});
  await duplicate.runtime.ingest(event());
  assert.equal(duplicate.outbox.length,0);
});

test('private chats and listed groups keep forwarding instead of the unlisted reply',async()=>{
  const p2p=harness();
  await p2p.runtime.ingest(event({conversationId:'p2p-chat',conversationType:'p2p'}));await new Promise(setImmediate);
  assert.equal(p2p.outbox.length,0);
  assert.equal(p2p.forwarded.length,1);
  const listed=harness();
  await listed.runtime.ingest(event({conversationId:'chat'}));await new Promise(setImmediate);
  assert.equal(listed.outbox.length,0);
  assert.equal(listed.forwarded.length,1);
});

test('unlisted group reply failures only log a warning',async()=>{
  const failing=harness(base,{recordOutbox:async()=>{throw new Error('store down');}});
  assert.deepEqual(await failing.runtime.ingest(event()),{duplicate:false});
  assert.deepEqual(failing.logs,[['warning','unlisted_group_reply','failed',{code:'unlisted_group_reply_unrecorded'}]]);
  const missing=harness(base,{noOutbox:true});
  assert.deepEqual(await missing.runtime.ingest(event()),{duplicate:false});
  assert.deepEqual(missing.logs,[['warning','unlisted_group_reply','failed',{code:'unlisted_group_reply_unrecorded'}]]);
});
