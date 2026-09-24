import { randomUUID } from 'node:crypto';
import { feishuEventIdentity } from '../channels/feishu/normalize.mjs';
import { extractAttachments } from '../channels/feishu/media.mjs';
import { buildCodexForwardPrompt, createRecentMentionPrompts, isBotJoinNotice,
  mergeMentionPrompts, normalizeFeishuInput } from '../channels/feishu/input.mjs';
import { databaseError } from '../storage/errors.mjs';

const parse=value=>typeof value==='string'?JSON.parse(value):value;
const sleep=milliseconds=>new Promise(resolve=>{const timer=setTimeout(resolve,milliseconds);timer.unref?.();});
const TRANSIENT_STORE_ERRORS=new Set(['store_unavailable','store_contention','store_timeout']);
const POLL_RETRY_BASE_MS=1000;
const POLL_RETRY_MAX_MS=10000;
const POLL_FAILURE_LIMIT=6;
const POLL_FAILURE_WINDOW_MS=30000;
function mergeContextEntries(...groups) {
  const seen=new Set();
  return groups.flat().map(entry=>({...entry,prompt:String(entry?.prompt??entry?.text??'').trim()}))
    .filter(entry=>entry.prompt||entry.attachments?.length)
    .filter(entry=>{const key=entry.messageId||JSON.stringify([entry.senderOpenId||'',entry.createdAt||'',entry.prompt,
      (entry.attachments||[]).map(item=>item.fileKey)]);if(seen.has(key))return false;seen.add(key);return true;})
    .sort((left,right)=>(Number(left.createdAt)||0)-(Number(right.createdAt)||0));
}
function deliveryErrorCode(error) {
  if (error?.outcome !== 'failed') return 'chat_delivery_unconfirmed';
  if (error?.code === 'feishu_api_rejected') return 'feishu_api_rejected';
  if (error?.code === 'invalid_message_content') return 'invalid_content';
  return 'chat_delivery_failed';
}

export function createCommunicationRuntime({config,store,inbound,forward,chat,outbound,hookTokens={},fetchImpl=fetch,log=()=>{},now=Date.now,wait=sleep}={}) {
  const connectionId=config.feishu.connectionId; const owner=randomUUID(); const leaseMs=60000;
  let started=false,stopping=false,healthy=true,worker,degraded=false,consecutiveFailures=0,failureDeadline=0,lastFailureStage='',lastErrorClass='',wakeWait; const active=new Set(); const processing=new Set();
  const capabilities=group=>group?(group.capabilities??['bridge','hook']):[];
  const maxEventAgeMs=Number(config.codex.maxEventAgeMs??10*60*1000);
  const contextLimit=Number(config.codex.groupContextMessageLimit??50);
  const contextWindowMs=Number(config.codex.groupContextHours??24)*60*60*1000;
  const contextAttachmentLimit=Number(config.codex.groupContextAttachmentLimit??10);
  const contextEnabled=contextLimit>0&&contextWindowMs>0;
  const recent=createRecentMentionPrompts({now});
  const pause=milliseconds=>{let wake;const interrupted=new Promise(resolve=>{wake=resolve;wakeWait=wake;});return Promise.race([wait(milliseconds),interrupted]).finally(()=>{if(wakeWait===wake)wakeWait=undefined;});};
  function humanAllowed(event,group) {
    if(event.isApp||event.isSelf||event.actor?.type!=='user')return false;
    if(event.conversationType==='p2p')return (config.routing.privateUserIds.includes(event.actor.openId) || (config.routing.allowAllPrivateUsers === true && Boolean(event.actor.openId)));
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
    const attachmentMetadata=extractAttachments(event);
    const ignoredByAgent=isBotJoinNotice(normalized)||stale(event,normalized.createdAt);
    const triggerEligible=event.type==='message.received'&&!ignoredByAgent
      &&(event.conversationType==='p2p'||group?.trigger==='all'||mentioned);
    const triggered=agentAllowed&&triggerEligible;
    // Hook subscriptions are event notifications with their own scope. They are
    // deliberately independent from Agent authorization and routing outcomes.
    const hookAllowed=event.conversationType==='p2p'||Boolean(capabilities(group).includes('hook'));
    const hooks=config.hooks.filter(hook=>hookAllowed&&hook.conversationIds.includes(event.conversationId)&&!event.isSelf&&!event.isApp).map(hook=>({hookId:hook.id,payload:event}));
    const contextCandidate=Boolean(agentAllowed&&!triggered&&!ignoredByAgent&&group?.passiveContext&&event.type==='message.received'
      &&(normalized.rawText.trim()||attachmentMetadata.length));
    const receipt=await store.acceptInbound({connectionId,conversationId:event.conversationId,source:event.source,conversationType:event.conversationType,eventKey:event.eventKey,eventType:event.type,messageId:event.messageId,...(event.type==='message.recalled'?{recalledMessageId:event.messageId}:{}),revision:event.revision,occurredAt:event.occurredAt,payload:event,semanticPayload:feishuEventIdentity(event),policyVersion:config.routing.version,passiveContext:contextCandidate,
      inboundMessage:{...normalized,content:{text:normalized.rawText,attachments:attachmentMetadata},groupContextCandidate:contextCandidate},
      hooks});
    if(contextCandidate&&!receipt.duplicate)recent.remember({chatId:normalized.chatId,messageId:normalized.messageId,prompt:normalized.rawText,
      senderOpenId:normalized.senderOpenId,senderUnionId:normalized.senderUnionId,senderName:normalized.senderName});
    if(!triggered||!forward)return receipt;
    launchForward((async()=>{
      const memoryEntries=event.conversationType==='group'&&contextEnabled?recent.take(normalized.chatId):[];
      const persistedEntries=event.conversationType==='group'&&group?.passiveContext&&contextEnabled&&inbound
        ? await inbound.loadRecentGroupContext({connectionId,chatId:normalized.chatId,beforeMs:normalized.createdAt,windowMs:contextWindowMs,
          limit:contextLimit,excludeMessageIds:[normalized.messageId]}) : [];
      const contextEntries=contextEnabled?mergeContextEntries(persistedEntries,memoryEntries).slice(-contextLimit):[];
      const mediaResolvable=normalized.messageType!=='text';
      if(!normalized.text&&!contextEntries.length&&!mediaResolvable)return;
      const mergedPrompt=normalized.chatType==='p2p'?normalized.text:mergeMentionPrompts(contextEntries,normalized.text);
      const prompt=buildCodexForwardPrompt({chatType:normalized.chatType,currentPrompt:normalized.text,
        mergedPrompt:mergedPrompt||normalized.text,recentPrompts:contextEntries,senderName:normalized.senderName,senderOpenId:normalized.senderOpenId,senderUnionId:normalized.senderUnionId});
      const result=await forward.handleMessage({
        source:'live',callerId:'live',idempotencyKey:`live:${connectionId}:${normalized.chatId}:${normalized.messageId}`,
        message:{messageId:normalized.messageId,conversationId:normalized.chatId,conversationType:normalized.chatType,
          type:normalized.messageType,event,contextAttachmentLimit},
        actor:{openId:normalized.senderOpenId,unionId:normalized.senderUnionId,name:normalized.senderName},prompt,context:contextEntries,
        groupChatContext:normalized.chatType==='group'?{chatId:normalized.chatId,name:group?.name||'',description:group?.description||''}:null,
        deliveryMode:'bridge',
      });
      const accepted=result?.deferred===true?result.accepted!==false
        : result?.failed!==true&&result?.execution?.terminal==='completed';
      if(accepted)recent.consume(contextEntries);
    })());
    return receipt;
    } finally { processing.delete(event.messageId); }
  }
  async function ingestCardAction({hookId,eventId,chatId,messageId,event}) {
    if(stopping)throw new Error('ingress_stopped');
    return store.acceptInbound({connectionId,conversationId:chatId,source:'live',conversationType:'group',
      eventKey:`card_action:${eventId}`,eventType:'card.action',messageId,
      ...(event.occurredAt?{occurredAt:Date.parse(event.occurredAt)}:{}),
      payload:event,semanticPayload:event,policyVersion:config.routing.version,passiveContext:false,
      hooks:[{hookId,payload:event}]});
  }
  async function deliver(row){let result;try{const payload=parse(row.payload);if(row.kind==='reply')result=await chat.replyMessage({...payload,uuid:row.platformUuid});else if(row.kind==='create')result=await chat.sendMessage({...payload,conversationId:row.conversationId,uuid:row.platformUuid});else if(row.kind==='reaction')result=payload.reactionId?await chat.removeReaction(payload):await chat.addReaction(payload);else if(row.kind==='upload')result=payload.mediaType==='image'?await chat.uploadImage({bytes:Buffer.from(payload.base64,'base64')}):await chat.uploadFile({bytes:Buffer.from(payload.base64,'base64'),fileName:payload.fileName});else if(row.kind==='artifact_upload'&&outbound)result=await outbound.upload(payload);else if(row.kind==='artifact_send'&&outbound){const effect=await store.getOutbox({id:row.id});if(effect?.predecessorStatus!=='sent')throw Object.assign(new Error('artifact_predecessor_unconfirmed'),{outcome:'failed'});result=await outbound.send({...payload,uploadResult:parse(effect.predecessorResult),uuid:row.platformUuid});}else throw Object.assign(new Error('unsupported_delivery'),{outcome:'failed'});await settle(row,{status:'sent',result});}catch(error){const status=error?.outcome==='failed'?'failed':'unknown';const code=deliveryErrorCode(error);await settle(row,{status,errorCode:code,nextAttemptAt:Date.now()+5000});log('warning','chat_delivery',status==='failed'?'failed':'unconfirmed',{code});}}
  async function settle(row,outcome){try{await store.settleOutbox({id:row.id,leaseToken:row.leaseToken,...outcome});}catch{const recorded=await store.getOutbox({id:row.id});if(recorded?.status!=='sent')log('warning','chat_delivery','pending',{code:'delivery_settlement_unconfirmed'});}}
  async function hook(job){const definition=config.hooks.find(item=>item.id===job.hookId);try{if(!definition)throw new Error('hook_removed');const response=await fetchImpl(definition.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(3000),headers:{'content-type':'application/json',authorization:`Bearer ${hookTokens[definition.id]}`,'idempotency-key':job.id},body:JSON.stringify({deliveryId:job.id,event:parse(job.payload)})});await response.body?.cancel();if(response.status!==204)throw new Error('hook_unacknowledged');await store.finishJobWithOutbox({id:job.id,leaseToken:job.leaseToken,result:{accepted:true}});}catch{await store.retryJob({id:job.id,leaseToken:job.leaseToken,terminal:!definition||job.attempts>=8,errorCode:'hook_unacknowledged',nextAttemptAt:Date.now()+Math.min(60000,1000*2**job.attempts)});log(job.attempts>=8?'error':'warning','hook_delivery','unacknowledged',{code:'hook_unacknowledged'});}}
  function launchForward(operation){const promise=operation.catch(error=>{log('error','forward_ingress','failed',{code:error?.code||'forward_ingress_failed'});}).finally(()=>active.delete(promise));active.add(promise);}
  function launch(operation){const promise=operation.catch(error=>{healthy=false;degraded=false;log('error','communication_worker','failed',{code:'worker_failed',errorClass:databaseError(error).code});}).finally(()=>active.delete(promise));active.add(promise);}
  async function claim(stage,operation){
    if(consecutiveFailures&&now()>=failureDeadline){
      healthy=false;degraded=false;
      log('error','communication_worker','failed',{code:'worker_poll_failed',reason:'retry_deadline',stage:lastFailureStage||stage,
        errorClass:lastErrorClass||'store_timeout',durationMs:0,consecutiveFailures,willRetry:false});
      return null;
    }
    const startedAt=now();
    try {
      return await operation();
    } catch(error) {
      const normalized=databaseError(error);
      const failedAt=now();
      if(!consecutiveFailures)failureDeadline=failedAt+POLL_FAILURE_WINDOW_MS;
      consecutiveFailures+=1;
      lastFailureStage=stage;lastErrorClass=normalized.code;
      const transient=TRANSIENT_STORE_ERRORS.has(normalized.code);
      const withinCount=consecutiveFailures<POLL_FAILURE_LIMIT;
      const withinWindow=failedAt<failureDeadline;
      const willRetry=transient&&withinCount&&withinWindow;
      degraded=willRetry;
      log(willRetry?'warning':'error','communication_worker','failed',{code:'worker_poll_failed',stage,errorClass:normalized.code,
        durationMs:Math.max(0,failedAt-startedAt),consecutiveFailures,willRetry});
      if(!willRetry){healthy=false;return null;}
      const remaining=Math.max(0,failureDeadline-now());
      await pause(Math.min(remaining,POLL_RETRY_MAX_MS,POLL_RETRY_BASE_MS*2**(consecutiveFailures-1)));
      return null;
    }
  }
  async function loop(){while(!stopping&&healthy){if(active.size<8){const jobs=await claim('claim_jobs',()=>store.claimJobs({kind:'hook',owner,leaseMs,limit:1}));if(!healthy)break;if(jobs===null)continue;for(const job of jobs)launch(hook(job));const rows=await claim('claim_outbox',()=>store.claimOutbox({owner,leaseMs,limit:1}));if(!healthy)break;if(rows===null)continue;for(const row of rows)launch(deliver(row));if(consecutiveFailures){consecutiveFailures=0;failureDeadline=0;lastFailureStage='';lastErrorClass='';degraded=false;}}if(!stopping&&healthy)await pause(100);}}
  return Object.freeze({ingest,ingestCardAction,status:()=>({running:started&&!stopping&&healthy,healthy,degraded,consecutiveFailures}),start(){if(started)throw new Error('communication_runtime_already_started');started=true;worker=loop();},async stop(){stopping=true;wakeWait?.();await worker;await Promise.allSettled(active);}});
}
