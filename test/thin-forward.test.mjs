import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from '../src/config.mjs';
import { createForwardRuntime } from '../src/core/forward-runtime.mjs';
import { createCommunicationRuntime } from '../src/core/communication-runtime.mjs';
import { createFeishuMedia } from '../src/channels/feishu/media.mjs';
import { createExecutionFeedback } from '../src/channels/feishu/execution-feedback.mjs';
import { renderExecutionCard } from '../src/channels/feishu/execution-card.mjs';
import { createCodexExecutor } from '../src/agents/codex/executor.mjs';
import { createInboundMessageStore } from '../src/storage/inbound-messages.mjs';

const base={schemaVersion:1,storage:Object.fromEntries(['host','port','user','password','database'].map(k=>[`${k}Env`,`TEST_${k.toUpperCase()}`])),codex:{bin:'./codex',cwd:'./workspace',envNames:[]},feishu:{connectionId:'test',appIdEnv:'TEST_APP',appSecretEnv:'TEST_SECRET',botOpenId:'bot'},routing:{version:'1',privateUserIds:[],groups:[{conversationId:'chat',trigger:'mention',passiveContext:true}]},hooks:[]};
const flush=()=>new Promise(resolve=>setTimeout(resolve,20));

async function communicationDeliveryFailure(error) {
  let claimed = false;
  let settlement;
  const logs = [];
  const row = { id: 'effect', kind: 'create', payload: { kind: 'interactive', content: { schema: '2.0' } },
    platformUuid: 'uuid', conversationId: 'chat', leaseToken: 'lease' };
  const store = {
    async claimJobs() { return []; },
    async claimOutbox() { if (claimed) return []; claimed = true; return [row]; },
    async settleOutbox(value) { settlement = value; },
    async getOutbox() { return null; },
  };
  const runtime = createCommunicationRuntime({ config: validateConfig(base), store,
    chat: { async sendMessage() { throw error; } }, log: (...entry) => logs.push(entry) });
  runtime.start();
  for (let attempt = 0; attempt < 20 && !settlement; attempt += 1) await flush();
  await runtime.stop();
  assert.ok(settlement);
  return { settlement, logs };
}

test('group capabilities default to both and allow either side or neither',()=>{
  const defaults=validateConfig(base);
  assert.deepEqual(defaults.routing.groups[0].capabilities,['bridge','hook']);
  assert.equal(defaults.codex.groupContextMessageLimit,50);
  assert.equal(defaults.codex.groupContextHours,24);
  assert.equal(defaults.codex.groupContextAttachmentLimit,10);
  for(const capabilities of [['bridge'],['hook'],[]])assert.deepEqual(validateConfig({...base,routing:{...base.routing,groups:[{...base.routing.groups[0],capabilities}]}}).routing.groups[0].capabilities,capabilities);
  assert.throws(()=>validateConfig({...base,routing:{...base.routing,groups:[{...base.routing.groups[0],capabilities:['unknown']}]}}),{code:'invalid_group_capabilities'});
});

test('group file trigger all reaches forwarding while unauthorized and hook-only groups stay closed',async()=>{
  for (const [capabilities,userIds,expected] of [[['bridge'],undefined,1],[['hook'],undefined,0],[['bridge'],['other'],0]]) {
    const forwarded=[];
    const config=validateConfig({...base,routing:{...base.routing,groups:[{...base.routing.groups[0],trigger:'all',capabilities,...(userIds?{userIds}:{})}]}});
    const runtime=createCommunicationRuntime({config,store:{acceptInbound:async()=>({duplicate:false})},
      forward:{handleMessage:async input=>{forwarded.push(input);return{execution:{terminal:'completed'}};}},chat:{}});
    await runtime.ingest({connectionId:'test',source:'live',eventKey:`file-${capabilities[0]}-${userIds?.[0]||'all'}`,type:'message.received',
      conversationId:'chat',conversationType:'group',messageId:`file-${capabilities[0]}-${userIds?.[0]||'all'}`,occurredAt:Date.now(),
      actor:{type:'user',openId:'human',name:'Human'},message:{kind:'file',content:'{"file_key":"group-file","file_name":"report.pdf"}',mentions:[]}});
    await new Promise(setImmediate);
    assert.equal(forwarded.length,expected);
    if(expected){assert.equal(forwarded[0].message.type,'file');assert.equal(forwarded[0].message.contextAttachmentLimit,10);}
  }
});

test('passive group attachment metadata is stored without download and carried into a later mention',async()=>{
  const accepted=[];const forwarded=[];
  const config=validateConfig(base);
  const runtime=createCommunicationRuntime({config,store:{acceptInbound:async input=>{accepted.push(input);return{duplicate:false};}},
    inbound:{async loadRecentGroupContext(){const stored=accepted[0].inboundMessage;return[{messageId:'passive-file',senderOpenId:'alice',senderName:'Alice',
      prompt:'',createdAt:1000,attachments:stored.content.attachments,event:{conversationId:'chat',messageId:'passive-file',conversationType:'group',
        message:{kind:'file',content:''}},source:'persisted_group_context'}];}},
    forward:{handleMessage:async input=>{forwarded.push(input);return{execution:{terminal:'completed'}};}},chat:{},now:()=>2500});
  await runtime.ingest({connectionId:'test',source:'live',eventKey:'passive-file',type:'message.received',conversationId:'chat',conversationType:'group',
    messageId:'passive-file',occurredAt:1000,actor:{type:'user',openId:'alice',name:'Alice'},
    message:{kind:'file',content:'{"file_key":"context-file","file_name":"context.pdf"}',mentions:[]}});
  await runtime.ingest({connectionId:'test',source:'live',eventKey:'mention',type:'message.received',conversationId:'chat',conversationType:'group',
    messageId:'mention',occurredAt:2000,actor:{type:'user',openId:'human',name:'Human'},
    message:{kind:'text',content:'{"text":"<at>bot</at> inspect"}',mentions:[{openId:'bot',key:'<at>bot</at>'}]}});
  await new Promise(setImmediate);
  assert.equal(accepted[0].passiveContext,true);
  assert.deepEqual(accepted[0].inboundMessage.content.attachments.map(item=>[item.fileKey,item.fileName,item.status]),
    [['context-file','context.pdf','skipped']]);
  assert.equal(forwarded.length,1);
  assert.equal(forwarded[0].context[0].attachments[0].fileKey,'context-file');
  assert.equal(forwarded[0].context[0].event.messageId,'passive-file');
});

test('expired in-memory group context is supplied only by the 24-hour database window',async()=>{
  let clock=1_700_000_000_000;const forwarded=[];let databaseReads=0;
  const config=validateConfig(base);
  const persisted={inboundId:1,messageId:'persisted',senderOpenId:'alice',senderName:'Alice',prompt:'database context',
    createdAt:clock,attachments:[],source:'persisted_group_context'};
  const runtime=createCommunicationRuntime({config,store:{acceptInbound:async()=>({duplicate:false})},
    inbound:{async loadRecentGroupContext(){databaseReads+=1;return[persisted];}},
    forward:{handleMessage:async input=>{forwarded.push(input);return{execution:{terminal:'completed'}};}},chat:{},now:()=>clock});
  const event=(id,text,mentioned=false)=>({connectionId:'test',source:'live',eventKey:id,type:'message.received',conversationId:'chat',conversationType:'group',
    messageId:id,occurredAt:clock,actor:{type:'user',openId:'alice',name:'Alice'},message:{kind:'text',content:JSON.stringify({text:mentioned?`<at>bot</at> ${text}`:text}),
      mentions:mentioned?[{openId:'bot',key:'<at>bot</at>'}]:[]}});
  await runtime.ingest(event('persisted','database context'));
  clock+=2*60*1000+1;
  await runtime.ingest(event('mention','inspect',true));
  await new Promise(setImmediate);
  assert.equal(databaseReads,1);
  assert.equal(forwarded.length,1);
  assert.deepEqual(forwarded[0].context,[persisted]);
});

test('legacy persisted group context without attachment metadata maps to an empty array',async()=>{
  const row={id:1,message_id:'legacy',chat_id:'chat',chat_type:'group',message_type:'text',sender_open_id:'alice',sender_name:'Alice',
    content_text:'legacy context',content_json:'{"text":"legacy context"}',message_created_at:1000};
  const connection={async query(){},async execute(sql){assert.match(sql,/SELECT m\.id/);return[[row]];},release(){},destroy(){}};
  const inbound=createInboundMessageStore({pool:{async getConnection(){return connection;}},connectionId:'test'});
  const entries=await inbound.loadRecentGroupContext({connectionId:'test',chatId:'chat',beforeMs:2000,windowMs:24*60*60*1000,limit:50});
  assert.equal(entries.length,1);
  assert.deepEqual(entries[0].attachments,[]);
});

test('zero group context count disables in-memory attachment context',async()=>{
  const forwarded=[];
  const config=validateConfig({...base,codex:{...base.codex,groupContextMessageLimit:0}});
  const runtime=createCommunicationRuntime({config,store:{acceptInbound:async()=>({duplicate:false})},
    inbound:{async loadRecentGroupContext(){throw new Error('context_disabled');}},
    forward:{handleMessage:async input=>{forwarded.push(input);return{execution:{terminal:'completed'}};}},chat:{}});
  const groupEvent=(id,message)=>({connectionId:'test',source:'live',eventKey:id,type:'message.received',conversationId:'chat',conversationType:'group',
    messageId:id,occurredAt:Date.now(),actor:{type:'user',openId:'human',name:'Human'},message});
  await runtime.ingest(groupEvent('passive',{kind:'image',content:'{"image_key":"image"}',mentions:[]}));
  await runtime.ingest(groupEvent('mention',{kind:'text',content:'{"text":"<at>bot</at> inspect"}',mentions:[{openId:'bot',key:'<at>bot</at>'}]}));
  await new Promise(setImmediate);
  assert.equal(forwarded.length,1);
  assert.deepEqual(forwarded[0].context,[]);
});

test('private allow-all is opt-in and accepts only a boolean',()=>{
  assert.equal(validateConfig(base).routing.allowAllPrivateUsers,false);
  assert.equal(validateConfig({...base,routing:{...base.routing,allowAllPrivateUsers:true}}).routing.allowAllPrivateUsers,true);
  for(const allowAllPrivateUsers of [null,'true',1])assert.throws(
    ()=>validateConfig({...base,routing:{...base.routing,allowAllPrivateUsers}}),
    {code:'invalid_private_access_policy'},
  );
});

test('private allow-all admits human direct messages only and keeps groups closed',async()=>{
  const forwarded=[];
  const config=validateConfig({...base,routing:{...base.routing,privateUserIds:[],allowAllPrivateUsers:true}});
  const runtime=createCommunicationRuntime({config,store:{acceptInbound:async()=>({duplicate:false})},
    forward:{handleMessage:async input=>{forwarded.push(input);return{accepted:true};}},chat:{}});
  const event=(id,overrides={})=>({connectionId:'test',source:'live',eventKey:id,type:'message.received',conversationId:`private-${id}`,
    conversationType:'p2p',messageId:id,occurredAt:Date.now(),actor:{type:'user',openId:`human-${id}`,name:'Human'},
    message:{kind:'text',content:'{"text":"hello"}',mentions:[]},...overrides});
  await runtime.ingest(event('human'));
  await runtime.ingest(event('app',{isApp:true}));
  await runtime.ingest(event('self',{isSelf:true}));
  await runtime.ingest(event('missing-open-id',{actor:{type:'user',name:'Human'}}));
  await runtime.ingest(event('unlisted-group',{conversationId:'unlisted-group',conversationType:'group'}));
  await new Promise(setImmediate);
  assert.equal(forwarded.length,1);
  assert.equal(forwarded[0].message.messageId,'human');
});

test('delivery persists definite Feishu rejection separately from write uncertainty', async () => {
  for (const [error, status, code] of [
    [Object.assign(new Error('provider secret'), { code: 'feishu_api_rejected', outcome: 'failed' }), 'failed', 'feishu_api_rejected'],
    [Object.assign(new Error('local detail'), { code: 'invalid_message_content', outcome: 'failed' }), 'failed', 'invalid_content'],
    [Object.assign(new Error('other detail'), { code: 'other_failure', outcome: 'failed' }), 'failed', 'chat_delivery_failed'],
    [Object.assign(new Error('network secret'), { code: 'feishu_transport_error', outcome: 'unknown' }), 'unknown', 'chat_delivery_unconfirmed'],
  ]) {
    const { settlement, logs } = await communicationDeliveryFailure(error);
    assert.equal(settlement.status, status);
    assert.equal(settlement.errorCode, code);
    assert.equal(JSON.stringify(logs).includes('secret'), false);
  }
});

test('group mention can register forward and hook branches without either consuming the other',async()=>{
  const accepted=[];const forwarded=[];let receipts=0;const config=validateConfig({...base,hooks:[{id:'h',url:'https://example.invalid/h',tokenEnv:'TEST_HOOK',conversationIds:['chat']}]});
  const runtime=createCommunicationRuntime({config,store:{acceptInbound:async input=>{accepted.push(input);receipts++;return{duplicate:receipts>1,hookJobIds:['hook']};}},
    forward:{handleMessage:async input=>{forwarded.push(input);return{accepted:true};}},chat:{}});
  const event={connectionId:'test',source:'live',eventKey:'event',type:'message.received',conversationId:'chat',conversationType:'group',messageId:'message',occurredAt:Date.now(),actor:{type:'user',openId:'human',name:'Human'},message:{kind:'text',content:'{"text":"<at>bot</at> hello"}',parsedContent:{text:'<at>bot</at> hello'},mentions:[{openId:'bot',key:'<at>bot</at>'}]}};
  await runtime.ingest(event);await runtime.ingest(event);
  await new Promise(setImmediate);
  assert(accepted.every(item=>item.forwardJob===undefined&&item.hooks.length===1));
  assert.equal(forwarded.length,2,'forward upsert owns Agent terminal deduplication after an inbox replay');
  assert.equal(forwarded[0].prompt,'【提到你的消息 来自 Human（open_id=human）】\nhello');
});

test('hook-only, bridge-only and both capabilities keep independent routing',async()=>{
  for(const [capabilities,expectedHooks,expectedForwards] of [[['hook'],1,0],[['bridge'],0,1],[['bridge','hook'],1,1]]) {
    const accepted=[];const forwarded=[];
    const config=validateConfig({...base,routing:{...base.routing,groups:[{...base.routing.groups[0],capabilities}]},
      hooks:[{id:'h',url:'https://example.invalid/h',tokenEnv:'TEST_HOOK',conversationIds:['chat']}]});
    const runtime=createCommunicationRuntime({config,store:{acceptInbound:async input=>{accepted.push(input);return{duplicate:false};}},
      forward:{handleMessage:async input=>{forwarded.push(input);return{accepted:true};}},chat:{}});
    await runtime.ingest({connectionId:'test',source:'live',eventKey:`event-${capabilities.join('-')}`,type:'message.received',conversationId:'chat',conversationType:'group',messageId:`message-${capabilities.join('-')}`,occurredAt:Date.now(),actor:{type:'user',openId:'human',name:'Human'},message:{kind:'text',content:'{"text":"<at>bot</at> hello"}',mentions:[{openId:'bot',key:'<at>bot</at>'}]}});
    await new Promise(setImmediate);
    assert.equal(accepted[0].hooks.length,expectedHooks);
    assert.equal(forwarded.length,expectedForwards);
  }
});

test('stale group input is skipped while private history catchup keeps the original exception',async()=>{
  const forwarded=[];const config=validateConfig({...base,routing:{...base.routing,privateUserIds:['human'],groups:[{...base.routing.groups[0],trigger:'all',capabilities:['bridge']}]}});
  const runtime=createCommunicationRuntime({config,store:{acceptInbound:async()=>({duplicate:false})},
    forward:{handleMessage:async input=>{forwarded.push(input);return{accepted:true};}},chat:{},now:()=>1_000_000});
  const message={kind:'text',content:'{"text":"old"}',mentions:[]};
  await runtime.ingest({connectionId:'test',source:'live',eventKey:'stale-group',type:'message.received',conversationId:'chat',conversationType:'group',messageId:'stale-group',occurredAt:1,actor:{type:'user',openId:'human',name:'Human'},message});
  await runtime.ingest({connectionId:'test',source:'history_catchup',eventKey:'stale-private',type:'message.received',conversationId:'private',conversationType:'p2p',messageId:'stale-private',occurredAt:1,actor:{type:'user',openId:'human',name:'Human'},message});
  await new Promise(setImmediate);
  assert.equal(forwarded.length,1);
  assert.equal(forwarded[0].message.messageId,'stale-private');
});

test('private image-only post reaches media preparation and empty group mention can use prior context',async()=>{
  const forwarded=[];
  const config=validateConfig({...base,routing:{...base.routing,privateUserIds:['human']}});
  const runtime=createCommunicationRuntime({config,store:{acceptInbound:async()=>({duplicate:false})},
    inbound:{async loadRecentGroupContext(){return[{messageId:'prior',prompt:'prior context',senderOpenId:'other',senderName:'Other',createdAt:1}];}},
    forward:{handleMessage:async input=>{forwarded.push(input);return{execution:{terminal:'completed'}};}},chat:{}});
  await runtime.ingest({connectionId:'test',source:'live',eventKey:'private-post',type:'message.received',conversationId:'private',conversationType:'p2p',messageId:'private-post',occurredAt:Date.now(),actor:{type:'user',openId:'human',name:'Human'},message:{kind:'post',content:'{"content":[[{"tag":"img","image_key":"image"}]]}',mentions:[]}});
  await runtime.ingest({connectionId:'test',source:'live',eventKey:'group-empty',type:'message.received',conversationId:'chat',conversationType:'group',messageId:'group-empty',occurredAt:Date.now(),actor:{type:'user',openId:'human',name:'Human'},message:{kind:'text',content:'{"text":"<at>bot</at>"}',mentions:[{openId:'bot',key:'<at>bot</at>'}]}});
  await new Promise(setImmediate);
  assert.equal(forwarded.length,2);
  assert.equal(forwarded[0].message.type,'post');
  assert.match(forwarded[1].prompt,/prior context/);
});

test('failed forward keeps recent group context until a later accepted execution',async()=>{
  const prompts=[];let attempt=0;
  const config=validateConfig(base);
  const runtime=createCommunicationRuntime({config,store:{acceptInbound:async()=>({duplicate:false})},
    forward:{handleMessage:async input=>{prompts.push(input.prompt);attempt+=1;return attempt===1?{failed:true}:{execution:{terminal:'completed'}};}},chat:{}});
  const event=(id,text,mentioned=false)=>({connectionId:'test',source:'live',eventKey:id,type:'message.received',conversationId:'chat',conversationType:'group',messageId:id,occurredAt:Date.now(),actor:{type:'user',openId:'human',name:'Human'},message:{kind:'text',content:JSON.stringify({text:mentioned?`<at>bot</at> ${text}`:text}),mentions:mentioned?[{openId:'bot',key:'<at>bot</at>'}]:[]}});
  await runtime.ingest(event('context','keep me'));
  await runtime.ingest(event('first','first',true));await new Promise(setImmediate);
  await runtime.ingest(event('second','second',true));await new Promise(setImmediate);
  assert.match(prompts[0],/keep me/);
  assert.match(prompts[1],/keep me/);
});

function memoryJobs(initial){
  let job={id:'run',internalId:'1',callerId:'caller',chatId:'chat',chatType:'group',messageId:'message',senderOpenId:'system:scope',senderName:'Caller',deliveryMode:'caller',executionNamespace:'daily',prompt:'work',attempts:1,result:{},createdAt:1,leaseOwner:'',...initial};
  const calls=[];
  const unsafe=()=>{const execution=job.result?.execution||{};return execution.unconfirmed===true||['start_intent','bound','unknown'].includes(execution.status)||execution.intent||execution.threadId||execution.turnId;};
  const finish=async({status,result})=>{calls.push(['finished',status]);job={...job,status,result,replySentAt:null};};
  const due=()=>job.nextAttemptAt==null||job.nextAttemptAt<=Date.now();
  const claim=async({owner})=>{if(job.status!=='pending'||!due()||unsafe())return null;job={...job,status:'running',leaseOwner:owner,attempts:job.attempts+1};return job;};
  return{calls,get job(){return job;},upsert:async()=>({...job,duplicate:false}),getByMessageId:async()=>null,
    loadRecoverable:async()=>job.status==='pending'&&due()&&!unsafe()?[job]:[],claimById:claim,claimReplyById:async({owner})=>job.status==='reply_pending'?(job={...job,leaseOwner:owner}):null,
    claimReplyPending:async({owner})=>job.status==='reply_pending'?[(job={...job,leaseOwner:owner})]:[],claim:async input=>{const value=await claim(input);return value?[value]:[];},
    renew:async()=>({renewed:true}),patchPreparedInput:async({execution})=>{calls.push(['prepared',execution]);job={...job,result:{...job.result,execution}};return job;},
    patchExecution:async({execution})=>{calls.push(['execution',execution]);job={...job,result:{...job.result,execution}};},
    patchFeedback:async({key,value})=>{calls.push(['feedback',key]);job={...job,result:{...job.result,[key]:structuredClone(value)}};},
    markReplyPending:async({result})=>{const value=structuredClone(result);delete value.executionCard;delete value.typing;delete value.stop;
      calls.push(['reply_pending']);job={...job,status:'reply_pending',result:{...job.result,...value}};},markFinished:finish,markFinishedWithoutReply:finish,
    markRetry:async input=>{calls.push(['retry',input]);job={...job,status:input.held?'held':input.terminal?'failed':'pending',last_error:input.errorCode,nextAttemptAt:input.nextAttemptAt,leaseOwner:''};},
    getRun:async()=>job,readEvents:async()=>[]};
}

test('group attachment flows through communication, persisted mapping, forward, media, and executor once',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'bridge-group-context-composite-'));
  t.after(()=>rm(workspace,{recursive:true,force:true}));
  const rows=[];let nextInboundId=1;
  const connection={
    async query(){},async beginTransaction(){},async commit(){},async rollback(){},release(){},destroy(){},
    async execute(sql,values){
      if(sql.includes('SELECT m.id')){
        const [,chatId,after,before]=values;
        const selected=rows.filter(row=>row.chat_id===chatId&&row.group_context_candidate===1
          &&row.codex_context_forwarded_at==null&&row.message_created_at>=after&&row.message_created_at<=before)
          .sort((left,right)=>right.message_created_at-left.message_created_at||right.id-left.id);
        return[selected];
      }
      if(sql.includes('UPDATE assistant_inbound_messages SET codex_context')){
        let affectedRows=0;
        for(const row of rows){
          if(row.group_context_candidate===1&&row.codex_context_forwarded_at==null
            &&values.some(value=>String(value)===String(row.id)||String(value)===row.message_id)){
            row.codex_context_forwarded_at=values[2];affectedRows+=1;
          }
        }
        return[{affectedRows}];
      }
      throw new Error(`unexpected inbound SQL: ${sql}`);
    },
  };
  const inbound=createInboundMessageStore({pool:{async getConnection(){return connection;}},connectionId:'test',now:()=>1_700_000_010_000});
  const ingressStore={async acceptInbound(input){
    const message=input.inboundMessage;
    rows.push({id:nextInboundId++,message_id:message.messageId,chat_id:message.chatId,chat_type:message.chatType,
      message_type:message.messageType,sender_open_id:message.senderOpenId,sender_name:message.senderName,
      content_text:message.rawText,content_json:JSON.stringify(message.content),message_created_at:message.createdAt,
      bot_mentioned:message.botMentioned?1:0,group_context_candidate:message.groupContextCandidate?1:0,codex_context_forwarded_at:null});
    return{duplicate:false};
  }};
  const jobsById=new Map();
  const jobs={
    async getByMessageId(){return null;},
    async upsert(input){const id=`run-${input.messageId}`;const job={id,status:'pending',attempts:0,leaseOwner:'',callerId:input.callerId,
      chatId:input.conversationId,chatType:input.chatType,messageId:input.messageId,sourceMessageId:input.sourceMessageId,
      bindingOpenId:input.bindingOpenId,senderOpenId:input.senderOpenId,senderName:input.senderName,executionNamespace:input.executionNamespace,
      deliveryMode:input.deliveryMode,prompt:input.prompt,groupChatContext:input.groupChatContext,contextEntries:input.contextEntries,
      result:structuredClone(input.initialResult)};jobsById.set(id,job);return{...job,duplicate:false};},
    async getRun({id}){return jobsById.get(id)||null;},
    async patchPreparedInput({id,execution}){const job=jobsById.get(id);job.result={...job.result,execution};return job;},
    async claimById({id,owner}){const job=jobsById.get(id);if(job?.status!=='pending')return null;job.status='running';job.leaseOwner=owner;job.attempts+=1;return job;},
    async claimReplyById(){return null;},async renew(){return{renewed:true};},
    async markFinishedWithoutReply({id,status,result}){const job=jobsById.get(id);job.status=status;job.result=result;},
    async markRetry(){throw new Error('composite forward must not retry');},
  };
  const downloads=[];const executions=[];
  const media=await createFeishuMedia({inboxDir:join(workspace,'inbox'),chat:{async downloadResource(input){downloads.push(input);
    return{stream:Readable.from([Buffer.from('pdf')]),contentType:'application/pdf'};}}});
  const forward=createForwardRuntime({config:{owner:'composite',pollMs:1},jobs,sessions:{},inbound,media,
    executor:{async execute(input){executions.push(structuredClone(input));return{deferred:true,accepted:true,threadId:'thread',turnId:`turn-${executions.length}`};}},
    replies:{},authorize:async()=>true});
  const config=validateConfig(base);const communicationLogs=[];
  const communication=createCommunicationRuntime({config,store:ingressStore,inbound,forward,chat:{},now:()=>1_700_000_010_000,
    log:(...entry)=>communicationLogs.push(entry)});
  const waitForExecutions=async count=>{
    const deadline=Date.now()+5000;
    while(executions.length<count&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
  };
  const event=(id,occurredAt,message,actor={type:'user',openId:'human',name:'Human'})=>({connectionId:'test',source:'live',eventKey:id,
    type:'message.received',conversationId:'chat',conversationType:'group',messageId:id,occurredAt,actor,message});
  await communication.ingest(event('passive-file',1_700_000_000_000,
    {kind:'file',content:'{"file_key":"context-file","file_name":"context.pdf"}',mentions:[]},
    {type:'user',openId:'alice',name:'Alice'}));
  await communication.ingest(event('mention-one',1_700_000_001_000,
    {kind:'text',content:'{"text":"<at>bot</at> inspect"}',mentions:[{openId:'bot',key:'<at>bot</at>'}]}));
  await waitForExecutions(1);
  assert.deepEqual(communicationLogs,[]);
  assert.equal(executions.length,1);
  const first=executions[0];
  t.diagnostic(`executor prompt: ${JSON.stringify(first.prompt)}`);
  assert.match(first.prompt,/【上下文 1\/1 来自 Alice】【附件 1\/1】文件 context\.pdf/);
  assert.equal(first.attachments.length,1);
  assert.equal(first.attachments[0].messageId,'passive-file');
  assert.equal(first.attachments[0].fileKey,'context-file');
  assert.equal(first.attachments[0].path,join(workspace,'inbox','chat','passive-file','context-file.pdf'));
  assert.deepEqual(downloads.map(({messageId,fileKey,type})=>({messageId,fileKey,type})),
    [{messageId:'passive-file',fileKey:'context-file',type:'file'}]);
  assert.ok(rows.find(row=>row.message_id==='passive-file').codex_context_forwarded_at);

  await communication.ingest(event('mention-two',1_700_000_002_000,
    {kind:'text',content:'{"text":"<at>bot</at> again"}',mentions:[{openId:'bot',key:'<at>bot</at>'}]}));
  await waitForExecutions(2);
  assert.deepEqual(communicationLogs,[]);
  assert.equal(executions.length,2);
  assert.doesNotMatch(executions[1].prompt,/context\.pdf|上下文/);
  assert.deepEqual(executions[1].attachments,[]);
  assert.equal(downloads.length,1);
});

const bridgeInput={source:'live',callerId:'live',idempotencyKey:'message',conversationId:'chat',chatType:'p2p',actor:{openId:'human'},prompt:'work'};
const bridgeJob=()=>({status:'pending',callerId:'live',executionNamespace:null,deliveryMode:'bridge',sourceMessageId:'message',senderOpenId:'human',chatType:'p2p'});
const quietTyping={async start(){return null;},async cleanup(){}};

test('successful live and recovered steering do not create a synthetic execution card',async()=>{
  for(const recovered of [false,true]){
    const jobs=memoryJobs(bridgeJob());let creates=0;
    const sessions={async loadBinding(){return null;},async readPublicProgress(){return[];}};
    const feedback=createExecutionFeedback({jobs,sessions,typing:quietTyping,
      cardClient:{im:{v1:{message:{async create(){creates+=1;return{code:0,data:{message_id:'card'}};}}}}}});
    const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1},jobs,sessions,feedback,
      executor:{async execute(){return{threadId:'thread',turnId:'turn',answer:'steered',rawAnswer:'steered',attachments:[],deferred:true,accepted:true};}},
      replies:{},authorize:async()=>true});
    if(recovered)await runtime.recover();else await runtime.handleMessage(bridgeInput);
    await runtime.stop();
    assert.equal(jobs.job.status,'deferred',recovered?'recovered':'live');
    assert.equal(creates,0,recovered?'recovered':'live');
    assert.equal(jobs.calls.filter(([name])=>name==='feedback').length,0,recovered?'recovered':'live');
  }
});

test('real started progress creates a stoppable card and normal completion updates it',async()=>{
  const jobs=memoryJobs(bridgeJob());const cards=[];let releaseCreate;
  const created=new Promise(resolve=>{releaseCreate=resolve;});let deliveredProgress=false;
  const sessions={async loadBinding(){return{codexSessionId:'thread'};},async readPublicProgress(){
    if(deliveredProgress)return[];deliveredProgress=true;
    return[{id:1,created_at:2,detail_json:{kind:'started',turnId:'turn'}}];
  }};
  const feedback=createExecutionFeedback({jobs,sessions,typing:quietTyping,
    cardClient:{im:{v1:{message:{
      async create(input){cards.push(JSON.parse(input.data.content));releaseCreate();return{code:0,data:{message_id:'card'}};},
      async patch(input){cards.push(JSON.parse(input.data.content));return{code:0};},
    }}}}});
  const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1},jobs,sessions,feedback,
    executor:{async execute(){await created;return{threadId:'thread',turnId:'turn',answer:'done',rawAnswer:'done',attachments:[]};}},
    replies:{async prepare(_job,result){return result;},async deliver(){return{status:'sent'};}},authorize:async()=>true});
  await runtime.handleMessage(bridgeInput);await runtime.stop();
  assert.equal(cards.length,2);
  assert.match(JSON.stringify(cards[0]),/stop_execution/);
  assert.equal(cards.at(-1).header.template,'green');
  assert.match(JSON.stringify(cards.at(-1)),/done/);
});

test('normal completion without progress still creates one terminal card',async()=>{
  const jobs=memoryJobs(bridgeJob());const cards=[];
  const sessions={async loadBinding(){return null;},async readPublicProgress(){return[];}};
  const feedback=createExecutionFeedback({jobs,sessions,typing:quietTyping,
    cardClient:{im:{v1:{message:{async create(input){cards.push(JSON.parse(input.data.content));return{code:0,data:{message_id:'card'}};}}}}}});
  const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1},jobs,sessions,feedback,
    executor:{async execute(){return{threadId:'thread',turnId:'turn',answer:'done',rawAnswer:'done',attachments:[]};}},
    replies:{async prepare(_job,result){return result;},async deliver(){return{status:'sent'};}},authorize:async()=>true});
  await runtime.handleMessage(bridgeInput);await runtime.stop();
  assert.equal(cards.length,1);
  assert.equal(cards[0].header.template,'green');
  assert.match(JSON.stringify(cards[0]),/done/);
});

test('forward runtime uses only its response waiter signal and persists caller result',async()=>{
  const jobs=memoryJobs({status:'pending'});const options=[];const executor={execute:async(_input,value)=>{options.push(value);return{threadId:'thread',turnId:'turn',answer:'shown',rawAnswer:'full machine answer',attachments:[]};}};
  const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1,leaseMs:10000},jobs,sessions:{},executor,replies:{readResource:async()=>null},feedback:null,authorize:async()=>true});runtime.start();await flush();await runtime.stop();
  assert.deepEqual(jobs.calls.map(x=>x[0]),['reply_pending','finished']);
  assert.equal(jobs.job.result.rawAnswer,'full machine answer');assert.equal(jobs.job.status,'completed');
  assert.deepEqual(Object.keys(options[0]),['signal']);
});

test('a new unconfirmed native outcome follows the ordinary failed reply path',async()=>{
  const jobs=memoryJobs({status:'pending'});let calls=0;const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1},jobs,sessions:{},executor:{execute:async()=>{calls++;throw Object.assign(new Error('lost'),{code:'CODEX_TURN_START_UNCONFIRMED',outcome:'unknown',threadId:'thread'});}},replies:{readResource:async()=>null},authorize:async()=>true});runtime.start();await flush();await runtime.stop();assert.equal(calls,1);assert.equal(jobs.job.status,'failed');assert.equal(jobs.calls.filter(x=>x[0]==='retry').length,0);assert.equal(jobs.job.result.execution.terminal,'failed');
});

test('original transport network errors retain the bounded retry classification',async()=>{
  for (const error of [
    new TypeError('fetch failed'),
    Object.assign(new Error('write failed'),{code:'EPIPE'}),
    Object.assign(new Error('request failed'),{cause:new Error('network unavailable')}),
    new Error('stream disconnected before completion'),
    new Error('error sending request'),
  ]) {
    const jobs=memoryJobs({status:'pending',attempts:0});
    const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1},jobs,sessions:{},executor:{execute:async()=>{throw error;}},replies:{readResource:async()=>null},authorize:async()=>true});
    await runtime.handleMessage({source:'live',callerId:'live',idempotencyKey:'network',message:{messageId:'network',conversationId:'chat',conversationType:'p2p',type:'text'},actor:{openId:'human'},prompt:'work'});
    await runtime.stop();
    assert.equal(jobs.job.status,'pending',`${error.code||error.message} should retry`);
    assert.equal(jobs.calls.filter(([name])=>name==='retry').length,1);
    assert.equal(jobs.calls.filter(([name])=>name==='reply_pending').length,0);
  }
});

test('bridge delivery cleans Typing after replies and cleanup failure does not undo completion',async()=>{
  const effects=[];let claimed=false;
  const job={id:'run',leaseOwner:'owner',status:'reply_pending',callerId:'live',chatId:'chat',chatType:'p2p',messageId:'message',sourceMessageId:'message',deliveryMode:'bridge',result:{answer:'done'},createdAt:1};
  const jobs={async claimReplyPending(){if(claimed)return[];claimed=true;return[job];},async claim(){return[];},async renew(){},async markFinished(){effects.push('finished');job.status='completed';}};
  const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1},jobs,sessions:{},executor:{},
    feedback:{async finish(){effects.push('card');return false;},async cleanup(){effects.push('typing:cleanup');throw new Error('synthetic cleanup failure');}},
    replies:{async prepare(_job,result){return result;},async deliver(){effects.push('reply');return{status:'sent'};},async readResource(){return null;}},authorize:async()=>true});
  runtime.start();await flush();await runtime.stop();
  assert.equal(job.status,'completed');assert.deepEqual(effects,['card','reply','finished','typing:cleanup']);
});

test('unknown reply stays pending and a failed reply never records a successful inbound answer', async () => {
  async function runDelivery(status) {
    const calls = [];
    let claimed = false;
    const job = {
      id: `delivery-${status}`, leaseOwner: 'delivery-worker', status: 'reply_pending',
      callerId: 'live', chatId: 'chat', chatType: 'group', messageId: 'message',
      sourceMessageId: 'message', deliveryMode: 'bridge', result: { answer: 'answer' }, createdAt: 1,
    };
    const jobs = {
      async claimReplyPending() { if (claimed) return []; claimed = true; return [job]; },
      async claim() { return []; },
      async renew() {},
      async markRetry(value) { calls.push(['retry', value]); },
      async markFinished(value) { calls.push(['finished', value]); },
    };
    const runtime = createForwardRuntime({
      config: { owner: 'delivery-worker', pollMs: 1, leaseMs: 10_000 }, jobs, sessions: {}, executor: {},
      feedback: { async finish() { return false; } },
      replies: { async prepare(_job, result) { return result; }, async deliver() { return { status }; } },
      inbound: { async recordReply() { calls.push(['recorded']); } },
    });
    runtime.start(); await flush(); await runtime.stop();
    return calls;
  }

  const unknown = await runDelivery('unknown');
  assert.equal(unknown.some(([name]) => name === 'finished'), false);
  assert.equal(unknown.find(([name]) => name === 'retry')[1].replyPending, true);
  const failed = await runDelivery('failed');
  assert.equal(failed.some(([name]) => name === 'recorded'), false);
  const finished = failed.find(([name]) => name === 'finished')[1];
  assert.equal(finished.replySent, false);
  assert.equal(finished.errorCode, 'reply_delivery_failed');
});

test('persisted start intent stays isolated without a new executor call', async () => {
  const jobs = memoryJobs({ status: 'pending', result: { execution: { threadId: 'thread', startedAt: 2, status: 'start_intent', unconfirmed: true } } });
  let executions = 0;
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1 }, jobs, sessions: {},
    executor: { async execute() { executions += 1; } },
    replies: { readResource: async () => null }, authorize: async () => true,
  });
  runtime.start(); await flush(); await runtime.stop();
  assert.equal(executions, 0);
  assert.equal(jobs.job.status, 'pending');
  assert.deepEqual(jobs.calls, []);
});

test('persisted known native identity stays isolated without restore or resume', async () => {
  const jobs = memoryJobs({ status: 'pending', deliveryMode: 'bridge', result: { execution: { bindingOpenId: 'group:binding', threadId: 'thread', turnId: 'turn', startedAt: 2 } } });
  const calls = [];
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1 }, jobs, sessions: {},
    executor: { async execute() { calls.push(['execute']); } },
    feedback: {
      async restore() { calls.push(['restore']); return { card: {} }; },
      observe(_job, _state, execution) { calls.push(['observe', execution.turnId]); },
      async prepare() {}, async finish() { return true; },
    },
    replies: { readResource: async () => null }, authorize: async () => true,
  });
  runtime.start(); await flush(); await runtime.stop();
  assert.deepEqual(calls, []);
  assert.equal(jobs.job.status,'pending');
});

test('media preparation feeds a durable image addendum to executor input', async () => {
  const jobs = memoryJobs({ status: 'pending', prompt: 'User：', result: { inputEvent: { messageId: 'message', message: { kind: 'image' } } } });
  let prompt;const order=[];
  const patchPreparedInput=jobs.patchPreparedInput.bind(jobs);jobs.patchPreparedInput=async input=>{order.push('prepare');return patchPreparedInput(input);};
  const claimById=jobs.claimById.bind(jobs);jobs.claimById=async input=>{order.push('claim');return claimById(input);};
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1 }, jobs, sessions: {},
    media: { async prepare() { return { status: 'ready', text: '', addendum: '【附件 1/1】图片 （类型 image，1 B，已下载：/safe/image.png）', attachments: [{ index:1,kind:'image',status:'downloaded',path:'/safe/image.png' }] }; } },
    executor: { async execute(input) { prompt = input.prompt; assert.equal(input.attachments[0].path,'/safe/image.png'); return { threadId: 'thread', turnId: 'turn', answer: 'done', rawAnswer: 'done', attachments: [] }; } },
    replies: { readResource: async () => null }, authorize: async () => true,
  });
  runtime.start(); await flush(); await runtime.stop();
  assert.match(prompt, /safe\/image\.png/);
  assert.deepEqual(order.slice(0,2),['prepare','claim']);
  assert.equal(jobs.calls.filter(([name]) => name === 'prepared')[0][1].inputStatus, 'ready');
});

test('forward preparation passes persisted context attachment metadata to media', async () => {
  const contextEntries=[{messageId:'prior',senderName:'Alice',prompt:'',createdAt:1,
    attachments:[{index:1,kind:'image',messageType:'image',fileKey:'context-image',status:'skipped',reason:'not_downloadable'}],
    event:{conversationId:'chat',messageId:'prior',conversationType:'group',message:{kind:'image',content:''}},source:'persisted_group_context'}];
  const jobs=memoryJobs({status:'pending',prompt:'inspect',contextEntries,
    result:{inputEvent:{conversationId:'chat',messageId:'current',conversationType:'group',message:{kind:'text',content:'{"text":"inspect"}'}},contextAttachmentLimit:10}});
  let preparedOptions;
  const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1},jobs,sessions:{},
    media:{async prepare(_event,options){preparedOptions=options;return{status:'ready',text:'inspect',addendum:'context ready',
      attachments:[{index:1,kind:'image',status:'downloaded',path:'/safe/context.png'}]};}},
    executor:{async execute(input){assert.match(input.prompt,/context ready/);return{threadId:'thread',turnId:'turn',answer:'done',rawAnswer:'done',attachments:[]};}},
    replies:{readResource:async()=>null},authorize:async()=>true});
  runtime.start();await flush();await runtime.stop();
  assert.deepEqual(preparedOptions.contextEntries,contextEntries);
  assert.equal(preparedOptions.contextAttachmentLimit,10);
  assert.equal(jobs.job.result.execution.attachments[0].path,'/safe/context.png');
});

test('live replay lets the existing forward row decide terminal duplication',async()=>{
  const existing={id:'existing',status:'completed',messageId:'same',chatId:'chat',chatType:'p2p',deliveryMode:'bridge',result:{answer:'done',execution:{terminal:'completed'}}};
  let upserts=0;let claims=0;
  const runtime=createForwardRuntime({jobs:{async getByMessageId(){return existing;},async upsert(){upserts+=1;},async getRun(){return existing;},async claimById(){claims+=1;},async claimReplyById(){return null;},async readEvents(){return[];}},sessions:{},executor:{},replies:{},authorize:async()=>true});
  const result=await runtime.handleMessage({source:'live',callerId:'live',idempotencyKey:'same',message:{messageId:'same',conversationId:'chat',conversationType:'p2p',type:'text'},actor:{openId:'human'},prompt:'changed context'});
  assert.equal(result.answer,'done');assert.equal(upserts,0);assert.equal(claims,1);
});

test('prepared context media prompt and attachments are reused without downloading again', async () => {
  const attachments=[{index:1,kind:'image',status:'downloaded',path:'/safe/image.png'}];
  const jobs = memoryJobs({ status: 'pending', contextEntries:[{messageId:'prior',attachments:[{fileKey:'image'}]}],
    result: { inputEvent: { messageId: 'message', message: { kind: 'text' } }, execution: { inputStatus: 'ready', preparedPrompt: 'User：\n\n【上下文 1/1 来自 Alice】【附件 1/1】图片 （类型 image，1 B，已下载：/safe/image.png）', attachments } } });
  let preparations = 0;
  let prompt;
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1 }, jobs, sessions: {},
    media: { async prepare() { preparations += 1; throw new Error('must_not_prepare_again'); } },
    executor: { async execute(input) { prompt = input.prompt; assert.deepEqual(input.attachments,attachments); return { threadId: 'thread', turnId: 'turn', answer: 'done', rawAnswer: 'done', attachments: [] }; } },
    replies: {}, authorize: async () => true,
  });
  runtime.start(); await flush(); await runtime.stop();
  assert.equal(preparations, 0);
  assert.match(prompt, /safe\/image\.png/);
});

test('actual turn/start and steer requests keep text first and add only downloaded images', async () => {
  class Stream extends EventEmitter { setEncoding() {} }
  class Child extends EventEmitter {
    constructor(handler){super();this.exitCode=null;this.stdout=new Stream();this.stderr=new Stream();this.stderr.resume=()=>{};this.stdin=new Stream();this.stdin.writable=true;this.stdin.writableLength=0;
      this.stdin.write=line=>{handler(JSON.parse(line),this);return true;};this.stdin.end=()=>{this.stdin.writable=false;setImmediate(()=>{this.exitCode=0;this.emit('exit',0,null);});};this.kill=signal=>setImmediate(()=>this.emit('exit',null,signal));}
    send(value){this.stdout.emit('data',`${JSON.stringify(value)}\n`);}
  }
  const calls=[];let child;
  const spawnImpl=()=>{child=new Child((message,instance)=>{calls.push(message);const reply=result=>setImmediate(()=>instance.send({id:message.id,result}));
    if(message.method==='initialize')reply({});
    else if(message.method==='thread/start')reply({thread:{id:'thread-1'}});
    else if(message.method==='turn/start')reply({turn:{id:'turn-1'}});
    else if(message.method==='thread/read')reply({thread:{id:'thread-1',turns:[{id:'turn-1',status:'inProgress',items:[]}]}});
    else if(message.method==='turn/steer'||message.method==='turn/interrupt')reply({});
  });return child;};
  const bindings=new Map();const events=[];
  const sessions={
    async loadBinding(identity){return bindings.get(`${identity.feishuOpenId}:${identity.chatId}`)||null;},
    async saveCodexBinding(binding){bindings.set(`${binding.feishuOpenId}:${binding.chatId}`,{...binding,created:false});},
    async touchCodexBinding(binding){bindings.set(`${binding.feishuOpenId}:${binding.chatId}`,{...binding,created:false});},
    async saveCodexRealtimeEvent(binding,event){events.push({...event,event_key:event.eventKey,detail_json:JSON.stringify(event.detail||{}),binding});},
    async findAcceptedMessageEvent(){return null;},async loadSteerEvents(){return[];},async readPublicProgress(){return[];},
  };
  const executor=createCodexExecutor({config:{bin:'/synthetic/codex',cwd:'/tmp',sharedHome:'/tmp',rpcTimeoutMs:1000,turnTimeoutMs:1000,closeGraceMs:20,idleCloseMs:0,
    networkAccess:false,sandbox:'workspace-write',approvalPolicy:'auto',approvalsReviewer:'auto_review',allowedGroupChatIds:new Set()},sessionStore:sessions,spawnImpl,
    spawnSyncImpl:()=>({status:0,stdout:''})});
  const attachments=[
    {kind:'file',status:'downloaded',path:'/tmp/report.pdf'},
    {kind:'image',status:'failed',path:null},
    {kind:'image',status:'downloaded',path:'/tmp/image.png'},
    {kind:'audio',status:'downloaded',path:'/tmp/audio.wav'},
  ];
  const first=executor.execute({bindingOpenId:'human',chatId:'chat',chatType:'p2p',messageId:'first',prompt:'first prompt',attachments});
  while(!calls.some(call=>call.method==='turn/start'))await new Promise(resolve=>setImmediate(resolve));
  await executor.execute({bindingOpenId:'human',chatId:'chat',chatType:'p2p',messageId:'second',prompt:'second prompt',attachments});
  const start=calls.find(call=>call.method==='turn/start').params.input;
  const steer=calls.find(call=>call.method==='turn/steer').params.input;
  assert.deepEqual(start,[{type:'text',text:'【飞书私聊会话】\nchat_id：chat\n对方 open_id：human\n回发文件目录：data/feishu-outbox/chat\n说明：需要回发本机图片或文件时，必须复制或写入该目录；只在 Markdown 中引用本机路径不会上传。\n\nfirst prompt',text_elements:[]},{type:'localImage',path:'/tmp/image.png'}]);
  assert.deepEqual(steer,[{type:'text',text:'second prompt',text_elements:[]},{type:'localImage',path:'/tmp/image.png'}]);
  child.send({method:'turn/completed',params:{threadId:'thread-1',turnId:'turn-1',turn:{id:'turn-1',status:'completed',items:[{type:'agentMessage',phase:'final_answer',text:'done'}]}}});
  await first;await executor.close();
});

test('ordinary live busy failures deliver on the first attempt without retrying', async () => {
  for (const facts of [
    { outcome: 'rejected', phase: 'pre_admission', rpcMethod: 'thread/resume' },
    { outcome: 'unknown', phase: 'turn_start', rpcMethod: 'turn/start' },
    {},
  ]) {
    const jobs = memoryJobs({ status: 'pending', attempts: 0, callerId: 'live', executionNamespace: null, deliveryMode: 'bridge',
      sourceMessageId: 'message', senderOpenId: 'human', chatType: 'p2p', result: {} });
    let admissions = 0;
    let deliveries = 0;
    const error = Object.assign(new Error('busy'), { code: 'CODEX_THREAD_BUSY', retryable: true, ...facts });
    const runtime = createForwardRuntime({
      config: { owner: 'owner', pollMs: 1 }, jobs, sessions: { async loadBinding() { return { codexSessionId: 'source-thread' }; } },
      executor: { async execute() { admissions += 1; throw error; } },
      feedback: { async start() { return {}; }, async prepare() {}, async finish() { return false; } },
      replies: { async prepare(_job, result) { return result; }, async deliver() { deliveries += 1; return { status: 'sent' }; } }, authorize: async () => true,
    });
    runtime.start(); await flush(); await runtime.stop();
    assert.equal(admissions, 1);
    assert.equal(jobs.job.attempts, 1);
    assert.equal(jobs.calls.filter(([name]) => name === 'retry').length, 0);
    assert.equal(jobs.calls.filter(([name]) => name === 'reply_pending').length, 1);
    assert.equal(deliveries, 1);
    assert.equal(jobs.job.status, 'failed');
    assert.equal(jobs.job.result.failed, true);
    assert.match(jobs.job.result.answer, /会话被其他客户端占用/);
    assert.deepEqual(jobs.job.result.busyFork, { sourceThreadId: 'source-thread', bindingOpenId: 'human', chatId: 'chat' });
    assert.equal(jobs.job.result.execution.terminal, 'failed');
    assert.equal(error.outcome, facts.outcome);
  }
});

test('only a failed busy card with a frozen source thread renders the explicit fork button', () => {
  const baseState = { status: 'failed', jobId: 'run', entries: [] };
  const busy = renderExecutionCard({ ...baseState, forkSourceThreadId: 'source-thread' }, 'busy');
  const value = busy.body.elements.flatMap(element => element.behaviors || []).find(item => item.value?.action === 'fork_busy_session')?.value;
  assert.deepEqual(value, { action: 'fork_busy_session', jobId: 'run', expectedSourceThreadId: 'source-thread' });
  assert.equal(JSON.stringify(renderExecutionCard(baseState, 'failed')).includes('fork_busy_session'), false);
  assert.equal(JSON.stringify(renderExecutionCard({ ...baseState, status: 'completed', forkSourceThreadId: 'source-thread' }, 'done')).includes('fork_busy_session'), false);
});

test('busy fork callback validates the original sender and runs one durable fork intent', async () => {
  const job = {
    id: '00000000-0000-0000-0000-000000000001', callerId: 'live', chatId: 'chat', chatType: 'p2p',
    messageId: 'message', senderOpenId: 'human', status: 'failed', last_error: 'CODEX_THREAD_BUSY',
    result: { busyFork: { sourceThreadId: 'source-thread', bindingOpenId: 'human', chatId: 'chat' },
      executionCard: { messageId: 'card-message', status: 'failed', entries: [], forkSourceThreadId: 'source-thread' } },
  };
  let intent;
  let forks = 0;
  let pending;
  const jobs = {
    async getRun() { return job; },
    async beginFork(input) { intent = input; return { outcome: 'new', fork: { operationId: input.operationId, status: 'pending' } }; },
    async finishFork(input) { return { outcome: input.status, fork: input }; },
    async patchFeedback() {},
  };
  const feedback = createExecutionFeedback({
    jobs, sessions: {}, typing: {}, authorize: async ({ operation }) => operation === 'fork',
    executor: { async forkBinding(input) { forks += 1; return { committed: await input.onForked({ targetThreadId: 'target-thread' }) }; } },
    runAsync(operation) { pending = Promise.resolve().then(operation); return pending; },
    cardClient: { im: { v1: { message: { async patch() { return { code: 0 }; } } } } },
  });
  const stale = await feedback.handleCardAction({ action: { value: { action: 'fork_busy_session', jobId: job.id, expectedSourceThreadId: 'source-thread' } },
    operator: { open_id: 'other' }, context: { open_chat_id: 'chat', open_message_id: 'card-message' } });
  assert.match(stale.toast.content, /失效/);
  assert.equal(forks, 0);
  const accepted = await feedback.handleCardAction({ action: { value: { action: 'fork_busy_session', jobId: job.id, expectedSourceThreadId: 'source-thread' } },
    operator: { open_id: 'human' }, context: { open_chat_id: 'chat', open_message_id: 'card-message' } });
  assert.match(accepted.toast.content, /正在创建/);
  await pending;
  assert.equal(forks, 1);
  assert.equal(intent.bindingOpenId, 'human');
  assert.equal(intent.cardMessageId, 'card-message');
});

test('busy fork reconciles durable outcomes and reports an undelivered terminal card', async () => {
  const original = {
    id: '00000000-0000-0000-0000-000000000001', callerId: 'live', chatId: 'chat', chatType: 'p2p',
    messageId: 'message', senderOpenId: 'human', status: 'failed', last_error: 'CODEX_THREAD_BUSY',
    result: { busyFork: { sourceThreadId: 'source', bindingOpenId: 'human', chatId: 'chat' },
      executionCard: { messageId: 'card', status: 'failed', delivery: 'fallback', entries: [], forkSourceThreadId: 'source' } },
  };
  const payload = { action: { value: { action: 'fork_busy_session', jobId: original.id, expectedSourceThreadId: 'source' } },
    operator: { open_id: 'human' }, context: { open_chat_id: 'chat', open_message_id: 'card' } };
  for (const mode of ['commit_ack_lost','reconcile_failed','card_rejected','superseded']) {
    let pending; let forks = 0; let durable = { operationId: '', status: 'pending' }; const cards = []; const logs = [];
    const jobs = {
      async getRun() { return structuredClone(original); },
      async beginFork(input) { durable.operationId = input.operationId; return { outcome: 'new', fork: { ...durable } }; },
      async finishFork(input) {
        if (mode === 'reconcile_failed') throw Object.assign(new Error('storage unavailable'), { code: 'store_unavailable' });
        if (durable.status !== 'pending') return { outcome: 'replay', fork: { ...durable } };
        durable = { ...durable, status: mode === 'superseded' ? 'superseded' : 'succeeded', targetThreadId: 'target' };
        if (mode === 'commit_ack_lost') throw Object.assign(new Error('commit unknown'), { code: 'commit_unknown' });
        return { outcome: durable.status, fork: { ...durable } };
      },
    };
    const feedback = createExecutionFeedback({ jobs, sessions: {}, authorize: async () => true,
      log: (...event) => logs.push(event), runAsync(operation) { pending = Promise.resolve().then(operation); },
      executor: { async forkBinding(input) {
        forks += 1;
        try { return { targetThreadId: 'target', committed: await input.onForked({ targetThreadId: 'target' }) }; }
        catch (error) { error.outcome = 'unknown'; error.forkTargetThreadId = 'target'; throw error; }
      } },
      cardClient: { im: { v1: { message: { async patch(input) {
        cards.push(JSON.parse(input.data.content)); return { code: mode === 'card_rejected' ? 999 : 0 };
      } } } } },
    });
    await feedback.handleCardAction(payload); await pending;
    assert.equal(forks, 1, mode);
    if (cards.length) assert.doesNotMatch(JSON.stringify(cards.at(-1)), /结果将通过普通消息送达/);
    if (mode === 'commit_ack_lost') assert.match(JSON.stringify(cards.at(-1)), /已保留历史并切换/);
    if (mode === 'reconcile_failed') {
      assert.match(JSON.stringify(cards.at(-1)), /状态未确认/);
      assert.doesNotMatch(JSON.stringify(cards.at(-1)), /原会话绑定保持不变/);
    }
    if (mode === 'card_rejected') {
      assert.equal(durable.status, 'succeeded');
      assert.equal(cards.length, 1);
      assert(logs.some(([level,operation,status]) => level === 'error' && operation === 'busy_session_fork_delivery' && status === 'failed'));
    }
    if (mode === 'superseded') assert.match(JSON.stringify(cards.at(-1)), /当前会话绑定已变化/);
  }
});

test('ordinary busy finishes the real feedback card and stops its observer and lease timer', async () => {
  const originalSetInterval=globalThis.setInterval;const originalClearInterval=globalThis.clearInterval;
  const timers=new Map();let sequence=0;let reads=0;const cards=[];
  globalThis.setInterval=(callback,ms)=>{const token={id:++sequence,unref(){}};timers.set(token,{callback,ms});return token;};
  globalThis.clearInterval=token=>timers.delete(token);
  try {
    const jobs=memoryJobs({status:'pending',callerId:'live',executionNamespace:null,deliveryMode:'bridge',sourceMessageId:'message',senderOpenId:'human',
      result:{execution:{bindingOpenId:'human'}}});
    const sessions={async loadBinding(){reads+=1;return{codexSessionId:'thread'};},async readPublicProgress(){return[];}};
    const feedback=createExecutionFeedback({jobs,sessions,typing:{async start(){return null;},async cleanup(){}},
      cardClient:{im:{v1:{message:{async create(input){cards.push(JSON.parse(input.data.content));return{code:0,data:{message_id:'card-message'}};}}}}}});
    const runtime=createForwardRuntime({config:{owner:'owner',pollMs:1},jobs,sessions,feedback,
      executor:{async execute(){throw Object.assign(new Error('busy'),{code:'CODEX_THREAD_BUSY'});}},
      replies:{async prepare(_job,result){return result;},async deliver(){return{status:'sent'};}},authorize:async()=>true});
    await runtime.handleMessage({source:'live',callerId:'live',idempotencyKey:'message',conversationId:'chat',chatType:'p2p',actor:{openId:'human'},prompt:'work'});
    await new Promise(setImmediate);
    const readsAfterFailure=reads;
    assert.equal(timers.size,0);
    for(const {callback} of timers.values())await callback();
    assert.equal(reads,readsAfterFailure);
    assert.equal(jobs.calls.filter(([name])=>name==='retry').length,0);
    assert.equal(jobs.job.status,'failed');
    assert.equal(jobs.job.result.busyFork?.sourceThreadId,'thread');
    assert.equal(jobs.job.result.executionCard?.forkSourceThreadId,'thread');
    assert(cards.some(card=>card.header.template==='red'&&JSON.stringify(card).includes('会话被其他客户端占用')));
    assert.match(JSON.stringify(cards.at(-1)),/fork_busy_session/);
    await runtime.stop();
    assert.equal(timers.size,0);
  } finally {
    globalThis.setInterval=originalSetInterval;globalThis.clearInterval=originalClearInterval;
  }
});

test('other retryable admission failures stop after three 60-second-spaced claims', async () => {
  let clock = 10_000;
  const job = {
    id: 'bounded-run', callerId: 'live', chatId: 'chat', chatType: 'p2p', messageId: 'bounded-message',
    senderOpenId: 'human', deliveryMode: 'caller', executionNamespace: null, prompt: 'work',
    attempts: 0, status: 'pending', result: {}, createdAt: 1, leaseOwner: '', nextAttemptAt: clock,
  };
  const retries = [];
  let finalResults = 0;
  const jobs = {
    async claimReplyPending({ owner }) {
      if (job.status !== 'reply_pending') return [];
      Object.assign(job, { leaseOwner: owner });
      return [{ ...job, result: structuredClone(job.result) }];
    },
    async claim({ owner }) {
      if (job.status !== 'pending' || job.nextAttemptAt > clock) return [];
      Object.assign(job, { status: 'running', leaseOwner: owner, attempts: job.attempts + 1 });
      return [{ ...job, result: structuredClone(job.result) }];
    },
    async renew() {},
    async patchExecution({ execution }) { job.result = { ...job.result, execution }; },
    async markRetry(input) {
      retries.push(input);
      Object.assign(job, { status: 'pending', last_error: input.errorCode, nextAttemptAt: input.nextAttemptAt, leaseOwner: '' });
    },
    async markReplyPending({ result }) { finalResults += 1; Object.assign(job, { status: 'reply_pending', result }); },
    async markFinished({ status, result }) { Object.assign(job, { status, result }); },
  };
  let admissions = 0;
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1, retryDelayMs: 60_000, maxAttempts: 3 }, jobs, sessions: {},
    executor: { async execute() { admissions += 1; throw Object.assign(new Error('write failed'), { code: 'EPIPE' }); } },
    replies: {}, now: () => clock,
  });
  const settle = async () => {
    for (let count = 0; count < 100 && job.status === 'running'; count += 1) await new Promise(resolve => setImmediate(resolve));
  };
  runtime.start();
  await flush(); await settle();
  assert.equal(job.nextAttemptAt, 70_000);
  clock = 70_000; await flush(); await settle();
  assert.equal(job.nextAttemptAt, 130_000);
  clock = 130_000; await flush(); await settle();
  for (let count = 0; count < 100 && job.status === 'reply_pending'; count += 1) await new Promise(resolve => setImmediate(resolve));
  await runtime.stop();
  assert.equal(admissions, 3);
  assert.equal(job.attempts, 3);
  assert.equal(retries.length, 2);
  assert(retries.every(input => input.preserveAttempt !== true));
  assert.equal(finalResults, 1);
  assert.equal(job.status, 'failed');
});

test('a transient recovery claim failure is contained to one poll', async () => {
  let polls = 0;
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1 },
    jobs: {
      async claimReplyPending() { polls += 1; if (polls === 1) throw new Error('database unavailable'); return []; },
      async loadRecoverable() { return []; },
    },
    sessions: {}, executor: {}, replies: {},
  });
  runtime.start(); await flush();
  assert.ok(polls > 1);
  assert.equal(runtime.status().healthy, true);
  assert.equal(runtime.status().running, true);
  await runtime.stop();
});

test('recovery executes claimed jobs serially', async () => {
  const baseJob = { internalId: '1', callerId: 'live', chatId: 'chat', chatType: 'group', senderOpenId: 'human', senderName: 'Human', deliveryMode: 'caller', executionNamespace: null, prompt: 'work', attempts: 1, result: {}, createdAt: 1, leaseOwner: 'owner' };
  const queued = [{ ...baseJob, id: 'run-1', messageId: 'message-1' }, { ...baseJob, id: 'run-2', internalId: '2', messageId: 'message-2' }];
  let claimed = false;
  let releaseFirst;
  let secondEntered = false;
  const jobs = {
    async claimReplyPending() { return []; },
    async claim() { if (claimed) return []; claimed = true; return queued; },
    async renew() { return { renewed: true }; },
    async patchExecution() {},
    async markReplyPending() {},
    async markFinished() {},
    async markFinishedWithoutReply() {},
    async markRetry() {},
    async getRun() { return null; },
    async readEvents() { return []; },
  };
  const executor = { async execute(input) {
    if (input.messageId === 'message-2') { secondEntered = true; return { threadId: 'thread', turnId: 'turn-2', answer: 'steered', rawAnswer: 'steered', attachments: [], deferred: true }; }
    return new Promise(resolve => { releaseFirst = () => resolve({ threadId: 'thread', turnId: 'turn-1', answer: 'done', rawAnswer: 'done', attachments: [] }); });
  } };
  const runtime = createForwardRuntime({ config: { owner: 'owner', pollMs: 1, maxActive: 5 }, jobs, sessions: {}, executor, replies: {}, authorize: async () => true });
  runtime.start();
  await flush();
  assert.equal(typeof releaseFirst, 'function');
  assert.equal(secondEntered, false);
  releaseFirst();
  await flush();
  await runtime.stop();
  assert.equal(secondEntered, true);
});

test('lease loss after binding aborts observation without a terminal write', async () => {
  const jobs = memoryJobs({ status: 'pending', deliveryMode: 'bridge' });
  let renewals = 0;
  let abandoned = 0;
  jobs.renew = async () => {
    renewals += 1;
    if (renewals > 1) throw Object.assign(new Error('lost'), { code: 'forward_lease_lost' });
    return { renewed: true };
  };
  const runtime = createForwardRuntime({
    config: { owner: 'owner', pollMs: 1, leaseMs: 100, heartbeatMs: 5 }, jobs, sessions: {},
    executor: { async execute(_input, options) {
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'CODEX_WAIT_ABORTED', outcome: 'unknown' })), { once: true }));
    } },
    feedback: {
      async start() { return { observer: { stop() {} }, card: { stop() {} } }; },
      observe() {},
      abandon(state) { abandoned += 1; state.observer = null; state.card = null; },
    },
    replies: { readResource: async () => null }, authorize: async () => true,
  });
  runtime.start(); await flush(); await runtime.stop();
  assert.ok(renewals > 1);
  assert.deepEqual(jobs.calls.map(([name]) => name), []);
  assert.equal(jobs.job.status, 'running');
  assert.equal(abandoned, 1);
});

test('every claim batch gets a distinct lease identity', async () => {
  const owners = [];
  let claims = 0;
  const jobs = {
    async claimReplyPending({ owner }) { owners.push(owner); return []; },
    async claim() { claims += 1; if (claims > 1) throw new Error('stop polling'); return []; },
  };
  const runtime = createForwardRuntime({
    config: { owner: 'process-worker', pollMs: 1 }, jobs, sessions: {}, executor: {}, replies: {},
  });
  runtime.start(); await flush(); await runtime.stop();
  assert(owners.length >= 2);
  assert.equal(new Set(owners).size, owners.length);
  assert(owners.every(owner => owner.startsWith('process-worker:')));
});

test('usage exhaustion sends one failed reply and never automatically replays, including recovered results', async () => {
  for (const recovered of [false, true]) {
    const jobs = memoryJobs({ status: 'pending', attempts: 0, deliveryMode: 'bridge', senderOpenId: 'human', chatType: 'p2p' });
    let executions = 0, deliveries = 0, storedCode;
    const markReplyPending = jobs.markReplyPending;
    jobs.markReplyPending = async input => { storedCode = input.errorCode; return markReplyPending(input); };
    const runtime = createForwardRuntime({ config: { owner: 'owner', pollMs: 1 }, jobs, sessions: {},
      executor: { async execute() { executions++; if (recovered) return { failed: true, turnStatus: 'failed', errorCode: 'CODEX_USAGE_LIMIT_EXCEEDED' }; throw Object.assign(new Error('SECRET network timeout'), { code: 'CODEX_USAGE_LIMIT_EXCEEDED' }); } },
      replies: { async prepare(_job, result) { return result; }, async deliver() { deliveries++; return { status: 'sent' }; } }, authorize: async () => true });
    runtime.start(); await flush(); await runtime.stop();
    assert.equal(executions, 1); assert.equal(deliveries, 1);
    assert.equal(jobs.job.status, 'failed');
    assert.equal(storedCode, 'CODEX_USAGE_LIMIT_EXCEEDED');
    assert.match(jobs.job.result.answer, /Codex 额度不足/);
    assert.doesNotMatch(jobs.job.result.answer, /SECRET|稍后重试/);
    assert.equal(jobs.calls.filter(([name]) => name === 'retry').length, 0);
  }
});
