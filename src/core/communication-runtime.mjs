import { randomUUID } from 'node:crypto';
import { feishuEventIdentity } from '../channels/feishu/normalize.mjs';
import { buildCodexForwardPrompt, createRecentMentionPrompts, isBotJoinNotice,
  mergeGroupContextPrompts, mergeMentionPrompts, normalizeFeishuInput } from '../channels/feishu/input.mjs';

const parse=value=>typeof value==='string'?JSON.parse(value):value;
const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

export function createCommunicationRuntime({config,store,inbound,forward,chat,outbound,hookTokens={},fetchImpl=fetch,log=()=>{},now=Date.now}={}) {
  const connectionId=config.feishu.connectionId; const owner=randomUUID(); const leaseMs=60000;
  let started=false,stopping=false,healthy=true,worker; const active=new Set(); const processing=new Set();
  const recent=createRecentMentionPrompts({now});
  const capabilities=group=>group?(group.capabilities??['bridge','hook']):[];
  const maxEventAgeMs=Number(config.codex.maxEventAgeMs??10*60*1000);
  const contextLimit=Number(config.codex.groupContextMessageLimit??10);
  const contextWindowMs=Number(config.codex.groupContextHours??2)*60*60*1000;
  function humanAllowed(event,group) {
    if(event.isApp||event.isSelf||event.actor?.type!=='user')return false;
    if(event.conversationType==='p2p')return config.routing.privateUserIds.includes(event.actor.openId);
    return Boolean(group&&capabilities(group).includes('bridge')&&(group.userIds===undefined||group.userIds.includes(event.actor.openId)));
  }
  function stale(event,createdAt) {
    if(!Number.isFinite(maxEventAgeMs)||maxEventAgeMs<=0)return false;
    if(event.source==='history_catchup'&&event.conversationType==='p2p')return false;
    return Math.max(0,now()-createdAt)>maxEventAgeMs;
  }
  async function ingest(event,context={}) {
    if(stopping||context.signal?.aborted)throw new Error('ingress_stopped');
    if(!event?.conversationId||!event?.messageId)throw new Error('invalid_feishu_event_identity');
    if(processing.has(event.messageId))return {duplicate:true,inFlight:true};
    processing.add(event.messageId);
    try {
    const group=config.routing.groups.find(item=>item.conversationId===event.conversationId);
    if(event.source==='history_catchup'&&event.actor?.type==='user'&&!event.actor.openId
      &&((event.conversationType==='p2p')||group?.userIds!==undefined))throw Object.assign(new Error('history_authorization_identity_missing'),{code:'history_authorization_identity_missing'});
    if(event.source==='history_catchup'&&group?.trigger==='mention'&&(event.message?.mentions?.length||0)>0
      &&!event.message.mentions.some(mention=>mention.openId))throw Object.assign(new Error('history_authorization_identity_missing'),{code:'history_authorization_identity_missing'});
    const agentAllowed=humanAllowed(event,group);
    const mentioned=event.message?.mentions?.some(mention=>mention.openId===config.feishu.botOpenId);
    const normalized=normalizeFeishuInput(event,{botOpenId:config.feishu.botOpenId});
    const ignoredByAgent=isBotJoinNotice(normalized)||stale(event,normalized.createdAt);
    const triggerEligible=event.type==='message.received'&&!ignoredByAgent
      &&(event.conversationType==='p2p'||group?.trigger==='all'||mentioned);
    const triggered=agentAllowed&&triggerEligible;
    // Hook subscriptions are event notifications with their own scope. They are
    // deliberately independent from Agent authorization and routing outcomes.
    const hookAllowed=event.conversationType==='p2p'||Boolean(capabilities(group).includes('hook'));
    const hooks=config.hooks.filter(hook=>hookAllowed&&hook.conversationIds.includes(event.conversationId)&&!event.isSelf&&!event.isApp).map(hook=>({hookId:hook.id,payload:event}));
    const contextCandidate=Boolean(agentAllowed&&!triggered&&!ignoredByAgent&&group?.passiveContext&&event.type==='message.received'&&normalized.rawText.trim());
    const receipt=await store.acceptInbound({connectionId,conversationId:event.conversationId,source:event.source,conversationType:event.conversationType,eventKey:event.eventKey,eventType:event.type,messageId:event.messageId,...(event.type==='message.recalled'?{recalledMessageId:event.messageId}:{}),revision:event.revision,occurredAt:event.occurredAt,payload:event,semanticPayload:feishuEventIdentity(event),policyVersion:config.routing.version,passiveContext:contextCandidate,
      inboundMessage:{...normalized,content:{text:normalized.rawText},groupContextCandidate:contextCandidate},
      hooks});
    if(contextCandidate&&!receipt.duplicate)recent.remember({chatId:normalized.chatId,messageId:normalized.messageId,prompt:normalized.rawText,
      senderOpenId:normalized.senderOpenId,senderName:normalized.senderName});
    const hasResolvablePayload=event.conversationType==='p2p'&&!['text','post'].includes(normalized.messageType);
    if(!triggered||receipt.duplicate||(!normalized.text&&!hasResolvablePayload)||!forward)return receipt;
    const memoryEntries=event.conversationType==='group'?recent.take(normalized.chatId):[];
    const persistedEntries=event.conversationType==='group'&&group?.passiveContext&&inbound
      ? await inbound.loadRecentGroupContext({connectionId,chatId:normalized.chatId,beforeMs:normalized.createdAt,windowMs:contextWindowMs,
        limit:contextLimit,excludeMessageIds:[normalized.messageId,...memoryEntries.map(entry=>entry.messageId)]}) : [];
    const contextEntries=mergeGroupContextPrompts(persistedEntries,memoryEntries);
    const mergedPrompt=mergeMentionPrompts(contextEntries,normalized.text);
    const prompt=buildCodexForwardPrompt({chatType:normalized.chatType,currentPrompt:normalized.text,
      mergedPrompt:mergedPrompt||normalized.text,recentPrompts:contextEntries,senderName:normalized.senderName,senderOpenId:normalized.senderOpenId});
    launchForward(Promise.resolve().then(()=>forward.handleMessage({
      source:'live',callerId:'live',idempotencyKey:`live:${connectionId}:${normalized.chatId}:${normalized.messageId}`,
      message:{messageId:normalized.messageId,conversationId:normalized.chatId,conversationType:normalized.chatType,type:normalized.messageType,event},
      actor:{openId:normalized.senderOpenId,name:normalized.senderName},prompt,context:contextEntries,
      groupChatContext:normalized.chatType==='group'?{chatId:normalized.chatId,name:group?.name||'',description:group?.description||''}:null,
      deliveryMode:'bridge',
    })).then(result=>{
      if(result?.deferred&&result.accepted===false)return;
      recent.consume(contextEntries);
    }));
    return receipt;
    } finally { processing.delete(event.messageId); }
  }
  async function deliver(row){let result;try{const payload=parse(row.payload);if(row.kind==='reply')result=await chat.replyMessage({...payload,uuid:row.platformUuid});else if(row.kind==='create')result=await chat.sendMessage({...payload,conversationId:row.conversationId,uuid:row.platformUuid});else if(row.kind==='reaction')result=payload.reactionId?await chat.removeReaction(payload):await chat.addReaction(payload);else if(row.kind==='upload')result=payload.mediaType==='image'?await chat.uploadImage({bytes:Buffer.from(payload.base64,'base64')}):await chat.uploadFile({bytes:Buffer.from(payload.base64,'base64'),fileName:payload.fileName});else if(row.kind==='artifact_upload'&&outbound)result=await outbound.upload(payload);else if(row.kind==='artifact_send'&&outbound){const effect=await store.getOutbox({id:row.id});if(effect?.predecessorStatus!=='sent')throw Object.assign(new Error('artifact_predecessor_unconfirmed'),{outcome:'failed'});result=await outbound.send({...payload,uploadResult:parse(effect.predecessorResult),uuid:row.platformUuid});}else throw Object.assign(new Error('unsupported_delivery'),{outcome:'failed'});await settle(row,{status:'sent',result});}catch(error){await settle(row,{status:error.outcome==='failed'?'failed':'unknown',errorCode:'chat_delivery_unconfirmed',nextAttemptAt:Date.now()+5000});log('warning','chat_delivery','unconfirmed',{code:'chat_delivery_unconfirmed'});}}
  async function settle(row,outcome){try{await store.settleOutbox({id:row.id,leaseToken:row.leaseToken,...outcome});}catch{const recorded=await store.getOutbox({id:row.id});if(recorded?.status!=='sent')log('warning','chat_delivery','pending',{code:'delivery_settlement_unconfirmed'});}}
  async function hook(job){const definition=config.hooks.find(item=>item.id===job.hookId);try{if(!definition)throw new Error('hook_removed');const response=await fetchImpl(definition.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(3000),headers:{'content-type':'application/json',authorization:`Bearer ${hookTokens[definition.id]}`,'idempotency-key':job.id},body:JSON.stringify({deliveryId:job.id,event:parse(job.payload)})});await response.body?.cancel();if(response.status!==204)throw new Error('hook_unacknowledged');await store.finishJobWithOutbox({id:job.id,leaseToken:job.leaseToken,result:{accepted:true}});}catch{await store.retryJob({id:job.id,leaseToken:job.leaseToken,terminal:!definition||job.attempts>=8,errorCode:'hook_unacknowledged',nextAttemptAt:Date.now()+Math.min(60000,1000*2**job.attempts)});log(job.attempts>=8?'error':'warning','hook_delivery','unacknowledged',{code:'hook_unacknowledged'});}}
  function launchForward(operation){const promise=operation.catch(error=>{log('error','forward_ingress','failed',{code:error?.code||'forward_ingress_failed'});}).finally(()=>active.delete(promise));active.add(promise);}
  function launch(operation){const promise=operation.catch(()=>{healthy=false;log('error','communication_worker','failed',{code:'worker_failed'});}).finally(()=>active.delete(promise));active.add(promise);}
  async function loop(){while(!stopping&&healthy){try{if(active.size<8){for(const job of await store.claimJobs({kind:'hook',owner,leaseMs,limit:1}))launch(hook(job));for(const row of await store.claimOutbox({owner,leaseMs,limit:1}))launch(deliver(row));}}catch{healthy=false;log('error','communication_worker','failed',{code:'worker_poll_failed'});}await sleep(100);}}
  return Object.freeze({ingest,status:()=>({running:started&&!stopping&&healthy}),start(){if(started)throw new Error('communication_runtime_already_started');started=true;worker=loop();},async stop(){stopping=true;await worker;await Promise.allSettled(active);}});
}
