import { randomUUID } from 'node:crypto';
import { feishuEventIdentity } from '../channels/feishu/normalize.mjs';
import { extractAttachments } from '../channels/feishu/media.mjs';
import { buildCodexForwardPrompt, createRecentMentionPrompts, isBotJoinNotice,
  mergeMentionPrompts, normalizeFeishuInput } from '../channels/feishu/input.mjs';
import { DEFAULT_REPLY_CONTEXT_MAX_CHARS, loadReplySegment } from '../channels/feishu/reply-context.mjs';
import { createReplyTrigger } from '../channels/feishu/reply-trigger.mjs';
import { databaseError } from '../storage/errors.mjs';

const parse=value=>typeof value==='string'?JSON.parse(value):value;
const sleep=milliseconds=>new Promise(resolve=>{const timer=setTimeout(resolve,milliseconds);timer.unref?.();});
// Only claim polling is retried here; no hook or platform send has started.
const TRANSIENT_STORE_ERRORS=new Set(['store_unavailable','store_contention','store_timeout','commit_unknown']);
const POLL_RETRY_BASE_MS=1000;
const POLL_RETRY_MAX_MS=30000;
const DEGRADED_LOG_INTERVAL_MS=5*60*1000;
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

export function createCommunicationRuntime({config,store,inbound,forward,chat,outbound,botAppId='',hookTokens={},fetchImpl=fetch,log=()=>{},now=Date.now,wait=sleep}={}) {
  const connectionId=config.feishu.connectionId; const owner=randomUUID(); const leaseMs=60000;
  let started=false,stopping=false,healthy=true,worker,degraded=false,consecutiveFailures=0,lastFailureLogAt=0,lastLoggedFailureStage='',wakeWait; const active=new Set(); const processing=new Set(); const successfulClaimStages=new Set();
  const capabilities=group=>group?(group.capabilities??['bridge','hook']):[];
  const maxEventAgeMs=Number(config.codex.maxEventAgeMs??10*60*1000);
  const contextLimit=Number(config.codex.groupContextMessageLimit??50);
  const contextWindowMs=Number(config.codex.groupContextHours??24)*60*60*1000;
  const contextAttachmentLimit=Number(config.codex.groupContextAttachmentLimit??10);
  const contextEnabled=contextLimit>0&&contextWindowMs>0;
  const recent=createRecentMentionPrompts({now});
  const botReply=createReplyTrigger({inbound,chat,botOpenId:config.feishu.botOpenId,botAppId,now,log});
  const unlistedReplies=new Map();
  async function replyUnlistedGroup(event) {
    const {text,cooldownMs}=config.routing.unlistedGroupReply; const key=`${event.conversationId}:${event.actor.openId||''}`; const at=now();
    if(unlistedReplies.has(key)&&at-unlistedReplies.get(key)<cooldownMs)return;
    for(const [entry,sentAt] of unlistedReplies)if(at-sentAt>=cooldownMs)unlistedReplies.delete(entry);
    unlistedReplies.set(key,at);
    try {
      if(typeof store.recordOutbox!=='function')throw new Error('outbox_unavailable');
      await store.recordOutbox({connectionId,conversationId:event.conversationId,idempotencyKey:`unlisted-group-reply:${event.messageId}`,kind:'reply',
        payload:{kind:'text',content:{text:text.replaceAll('{{chat_id}}',event.conversationId)},messageId:event.messageId}});
      log('info','unlisted_group_reply','queued',{code:'unlisted_group_mention'});
    } catch { if(unlistedReplies.get(key)===at)unlistedReplies.delete(key); log('warning','unlisted_group_reply','failed',{code:'unlisted_group_reply_unrecorded'}); }
  }
  // A recall of a message this bot sent (execution card, reply) is the bridge's
  // own effect. Feishu recall events carry no operator, so check the recorded
  // outbound IDs; a failed lookup keeps the previous hook delivery.
  async function ownOutboundRecall(event) {
    if(event.type!=='message.recalled'||typeof inbound?.hasBotMessage!=='function'||!config.feishu.botOpenId)return false;
    try { return Boolean(await inbound.hasBotMessage({messageId:event.messageId,chatId:event.conversationId,botOpenId:config.feishu.botOpenId})); }
    catch { log('warning','recall_filter','failed',{code:'outbound_message_lookup_failed'}); return false; }
  }
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
    const replyTrigger=agentAllowed&&!ignoredByAgent&&event.type==='message.received'&&group?.replyTriggers===true
      &&group.trigger!=='all'&&!mentioned?await botReply(event,{deadlineAt:context.deadlineAt}):{triggered:false};
    if(context.signal?.aborted)throw new Error('ingress_stopped');
    const triggerEligible=event.type==='message.received'&&!ignoredByAgent
      &&(event.conversationType==='p2p'||group?.trigger==='all'||mentioned||replyTrigger.triggered);
    const triggered=agentAllowed&&triggerEligible;
    // Hook subscriptions are event notifications with their own scope. They are
    // deliberately independent from Agent authorization and routing outcomes.
    const hookAllowed=event.conversationType==='p2p'||Boolean(capabilities(group).includes('hook'));
    const hookCandidates=config.hooks.filter(hook=>hookAllowed&&hook.conversationIds.includes(event.conversationId)&&!event.isSelf&&!event.isApp);
    const ownRecall=hookCandidates.length>0&&await ownOutboundRecall(event);
    if(context.signal?.aborted)throw new Error('ingress_stopped');
    const hooks=ownRecall?[]:hookCandidates.map(hook=>({hookId:hook.id,payload:event}));
    const contextCandidate=Boolean(agentAllowed&&!triggered&&!ignoredByAgent&&!ownRecall&&group?.passiveContext&&event.type==='message.received'
      &&(normalized.rawText.trim()||attachmentMetadata.length));
    const receipt=await store.acceptInbound({connectionId,conversationId:event.conversationId,source:event.source,conversationType:event.conversationType,eventKey:event.eventKey,eventType:event.type,messageId:event.messageId,...(event.type==='message.recalled'?{recalledMessageId:event.messageId}:{}),revision:event.revision,occurredAt:event.occurredAt,payload:event,semanticPayload:feishuEventIdentity(event),policyVersion:config.routing.version,passiveContext:contextCandidate,
      inboundMessage:{...normalized,content:{text:normalized.rawText,attachments:attachmentMetadata,
        ...(normalized.parentId?{parentId:normalized.parentId}:{}),...(normalized.rootId?{rootId:normalized.rootId}:{})},groupContextCandidate:contextCandidate},
      hooks});
    if(contextCandidate&&!receipt.duplicate)recent.remember({chatId:normalized.chatId,messageId:normalized.messageId,prompt:normalized.rawText,
      parentId:normalized.parentId,rootId:normalized.rootId,createdAt:normalized.createdAt,
      senderOpenId:normalized.senderOpenId,senderUnionId:normalized.senderUnionId,senderName:normalized.senderName});
    if(event.type==='message.received'&&event.source==='live'&&event.conversationType==='group'&&!group&&mentioned&&!ignoredByAgent
      &&event.actor?.type==='user'&&!event.isApp&&!event.isSelf&&config.routing.unlistedGroupReply?.enabled&&!receipt.duplicate)await replyUnlistedGroup(event);
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
      const replyTo=normalized.chatType==='p2p'?'':(normalized.parentId||normalized.rootId);
      const replySegment=replyTo?await loadReplySegment({chat,parentId:replyTo,parentMessage:replyTrigger.parentMessage,chatId:normalized.chatId,contextEntries,
        cardJson:group?.replyContext?.cardJson===true,maxChars:group?.replyContext?.maxChars??DEFAULT_REPLY_CONTEXT_MAX_CHARS,log}):'';
      const prompt=buildCodexForwardPrompt({chatType:normalized.chatType,currentPrompt:normalized.text,
        mergedPrompt:mergedPrompt||normalized.text,recentPrompts:contextEntries,senderName:normalized.senderName,senderOpenId:normalized.senderOpenId,senderUnionId:normalized.senderUnionId,
        chatId:normalized.chatId,messageId:normalized.messageId,parentId:normalized.parentId,rootId:normalized.rootId,createdAt:normalized.createdAt,replySegment});
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
  async function deliver(row){
    let result;
    let payload;
    try { payload=parse(row.payload); }
    catch(error) {
      const status=error?.outcome==='failed'?'failed':'unknown';const code=deliveryErrorCode(error);
      await settle(row,{status,errorCode:code,nextAttemptAt:Date.now()+5000});
      log('warning','chat_delivery',status==='failed'?'failed':'unconfirmed',{code});
      return;
    }
    // This read is storage work, before any platform effect. Let the worker's
    // storage classifier handle it instead of recording a delivery outcome.
    const predecessor=row.kind==='artifact_send'&&outbound?await store.getOutbox({id:row.id}):null;
    try {
      if(row.kind==='reply')result=await chat.replyMessage({...payload,uuid:row.platformUuid});
      else if(row.kind==='create')result=await chat.sendMessage({...payload,conversationId:row.conversationId,uuid:row.platformUuid});
      else if(row.kind==='reaction')result=payload.reactionId?await chat.removeReaction(payload):await chat.addReaction(payload);
      else if(row.kind==='upload')result=payload.mediaType==='image'?await chat.uploadImage({bytes:Buffer.from(payload.base64,'base64')}):await chat.uploadFile({bytes:Buffer.from(payload.base64,'base64'),fileName:payload.fileName});
      else if(row.kind==='artifact_upload'&&outbound)result=await outbound.upload(payload);
      else if(row.kind==='artifact_send'&&outbound){if(predecessor?.predecessorStatus!=='sent')throw Object.assign(new Error('artifact_predecessor_unconfirmed'),{outcome:'failed'});result=await outbound.send({...payload,uploadResult:parse(predecessor.predecessorResult),uuid:row.platformUuid});}
      else throw Object.assign(new Error('unsupported_delivery'),{outcome:'failed'});
    } catch(error) {
      const status=error?.outcome==='failed'?'failed':'unknown';const code=deliveryErrorCode(error);
      await settle(row,{status,errorCode:code,nextAttemptAt:Date.now()+5000});
      log('warning','chat_delivery',status==='failed'?'failed':'unconfirmed',{code});
      return;
    }
    // Settlement is deliberately outside the delivery catch. If storage is
    // uncertain after the platform effect, the durable lease and platform UUID
    // reconcile it; this invocation must not turn around and record a retry.
    await settle(row,{status:'sent',result});
  }
  async function settle(row,outcome){
    try { await store.settleOutbox({id:row.id,leaseToken:row.leaseToken,...outcome}); }
    catch(error) {
      try { const recorded=await store.getOutbox({id:row.id});if(recorded?.status!=='sent')log('warning','chat_delivery','pending',{code:'delivery_settlement_unconfirmed'}); }
      catch { /* The original classified error is the useful worker signal. */ }
      throw error;
    }
  }
  async function hook(job){
    const definition=config.hooks.find(item=>item.id===job.hookId);
    try {
      if(!definition)throw new Error('hook_removed');
      const response=await fetchImpl(definition.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(3000),headers:{'content-type':'application/json',authorization:`Bearer ${hookTokens[definition.id]}`,'idempotency-key':job.id},body:JSON.stringify({deliveryId:job.id,event:parse(job.payload)})});
      await response.body?.cancel();if(response.status!==204)throw new Error('hook_unacknowledged');
    } catch {
      await store.retryJob({id:job.id,leaseToken:job.leaseToken,terminal:!definition||job.attempts>=8,errorCode:'hook_unacknowledged',nextAttemptAt:Date.now()+Math.min(60000,1000*2**job.attempts)});
      log(job.attempts>=8?'error':'warning','hook_delivery','unacknowledged',{code:'hook_unacknowledged'});
      return;
    }
    // A storage failure after HTTP 204 is uncertain. Leave the durable lease to
    // reconcile it instead of immediately issuing the hook again.
    await store.finishJobWithOutbox({id:job.id,leaseToken:job.leaseToken,result:{accepted:true}});
  }
  function launchForward(operation){const promise=operation.catch(error=>{log('error','forward_ingress','failed',{code:error?.code||'forward_ingress_failed'});}).finally(()=>active.delete(promise));active.add(promise);}
  function recordStorageFailure(stage,error,durationMs=0) {
    const normalized=databaseError(error);const failedAt=now();consecutiveFailures+=1;successfulClaimStages.clear();
    const transient=TRANSIENT_STORE_ERRORS.has(normalized.code);
    if(!transient){healthy=false;degraded=false;log('error','communication_worker','failed',{code:'worker_failed',stage,errorClass:normalized.code,reason:normalized.reason,errorCode:normalized.errorCode,errno:normalized.errno,sqlState:normalized.sqlState,durationMs,consecutiveFailures,willRetry:false});return false;}
    degraded=true;
    const shouldLog=consecutiveFailures===1||stage!==lastLoggedFailureStage||failedAt-lastFailureLogAt>=DEGRADED_LOG_INTERVAL_MS;
    if(shouldLog){lastFailureLogAt=failedAt;lastLoggedFailureStage=stage;log('warning','communication_worker','failed',{code:'worker_poll_failed',stage,errorClass:normalized.code,reason:normalized.reason,errorCode:normalized.errorCode,errno:normalized.errno,sqlState:normalized.sqlState,durationMs,consecutiveFailures,willRetry:true});}
    return true;
  }
  function launch(operation,stage){const promise=operation.catch(error=>{recordStorageFailure(stage,error);}).finally(()=>active.delete(promise));active.add(promise);}
  function claimSucceeded(stage) {
    if(!degraded)return;
    successfulClaimStages.add(stage);
    if(successfulClaimStages.size<2)return;
    const recoveredFailures=consecutiveFailures;
    consecutiveFailures=0;lastFailureLogAt=0;lastLoggedFailureStage='';degraded=false;successfulClaimStages.clear();
    log('info','communication_worker','recovered',{code:'worker_recovered',consecutiveFailures:recoveredFailures});
  }
  async function claim(stage,operation){
    const startedAt=now();
    try {
      const result=await operation();claimSucceeded(stage);return result;
    } catch(error) {
      const failedAt=now();
      const willRetry=recordStorageFailure(stage,error,Math.max(0,failedAt-startedAt));
      if(!willRetry)return null;
      const exponent=Math.min(5,Math.max(0,consecutiveFailures-1));
      await pause(Math.min(POLL_RETRY_MAX_MS,POLL_RETRY_BASE_MS*2**exponent));
      return null;
    }
  }
  async function loop() {
    let idleDelayMs = 100;
    while (!stopping && healthy) {
      let busy = false;
      if (active.size < 8) {
        const jobs = await claim('claim_jobs', () => store.claimJobs({ kind: 'hook', owner, leaseMs, limit: 1 }));
        if (!healthy) break;
        if (jobs === null) continue;
        for (const job of jobs) launch(hook(job),'active_hook');
        const rows = await claim('claim_outbox', () => store.claimOutbox({ owner, leaseMs, limit: 1 }));
        if (!healthy) break;
        if (rows === null) continue;
        for (const row of rows) launch(deliver(row),'active_outbox');
        busy ||= jobs.length > 0 || rows.length > 0;
      }
      // Avoid 20 empty transactions/second per idle bot. Newly claimed work keeps
      // the short cadence; an idle outbox is picked up within one second.
      if (busy) idleDelayMs = 100;
      if (!stopping && healthy) await pause(idleDelayMs);
      if (!busy) idleDelayMs = Math.min(1000, idleDelayMs * 2);
    }
  }
  return Object.freeze({ingest,ingestCardAction,status:()=>({running:started&&!stopping&&healthy,healthy,degraded,consecutiveFailures}),start(){if(started)throw new Error('communication_runtime_already_started');started=true;worker=loop();},async stop(){stopping=true;wakeWait?.();await worker;await Promise.allSettled(active);}});
}
