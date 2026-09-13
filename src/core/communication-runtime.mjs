import { randomUUID } from 'node:crypto';
import { feishuEventIdentity } from '../channels/feishu/normalize.mjs';
import { extractMessageText } from '../channels/feishu/media.mjs';
import { formatGroupContext, normalizeFeishuInput } from '../channels/feishu/input.mjs';

const parse=value=>typeof value==='string'?JSON.parse(value):value;
const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

export function createCommunicationRuntime({config,store,inbound,chat,outbound,hookTokens={},fetchImpl=fetch,log=()=>{}}={}) {
  const connectionId=config.feishu.connectionId; const owner=randomUUID(); const leaseMs=60000;
  let started=false,stopping=false,healthy=true,worker; const active=new Set();
  async function ingest(event,context={}) {
    if(stopping||context.signal?.aborted)throw new Error('ingress_stopped');
    const group=config.routing.groups.find(item=>item.conversationId===event.conversationId);
    const human=!event.isApp&&!event.isSelf&&event.actor.type==='user';
    const agentAllowed=human&&(event.conversationType==='p2p'?config.routing.privateUserIds.includes(event.actor.openId):Boolean(group&&group.capabilities.includes('bridge')&&(group.userIds===undefined||group.userIds.includes(event.actor.openId))));
    const mentioned=event.message?.mentions?.some(mention=>mention.openId===config.feishu.botOpenId);
    const triggered=agentAllowed&&event.type==='message.received'&&(event.conversationType==='p2p'||group?.trigger==='all'||mentioned);
    // Hook subscriptions are event notifications with their own scope. They are
    // deliberately independent from Agent authorization and routing outcomes.
    const hookAllowed=event.conversationType==='p2p'||Boolean(group?.capabilities.includes('hook'));
    const hooks=config.hooks.filter(hook=>hookAllowed&&hook.conversationIds.includes(event.conversationId)&&!event.isSelf&&!event.isApp).map(hook=>({hookId:hook.id,payload:event}));
    const normalized=normalizeFeishuInput(event,{botOpenId:config.feishu.botOpenId});
    const prompt=normalized.text||extractMessageText(event);
    const contextEntries=triggered&&event.conversationType==='group'&&group?.passiveContext&&inbound
      ? await inbound.loadRecentGroupContext({chatId:event.conversationId,beforeMs:normalized.createdAt,limit:10}) : [];
    const contextText=formatGroupContext(contextEntries);
    const forwardPrompt=[contextText?`【最近群聊上下文】\n${contextText}`:'',`${normalized.senderName||'群成员'}：${prompt}`].filter(Boolean).join('\n\n');
    return store.acceptInbound({connectionId,conversationId:event.conversationId,source:event.source,conversationType:event.conversationType,eventKey:event.eventKey,eventType:event.type,messageId:event.messageId,...(event.type==='message.recalled'?{recalledMessageId:event.messageId}:{}),revision:event.revision,occurredAt:event.occurredAt,payload:event,semanticPayload:feishuEventIdentity(event),policyVersion:config.routing.version,passiveContext:Boolean(agentAllowed&&!triggered&&group?.passiveContext&&event.type==='message.received'),
      inboundMessage:{...normalized,content:{text:normalized.text},groupContextCandidate:Boolean(agentAllowed&&!triggered&&group?.passiveContext&&event.type==='message.received')},
      ...(triggered&&typeof prompt==='string'&&prompt.trim()?{forwardJob:{prompt:forwardPrompt,senderOpenId:normalized.senderOpenId,senderName:normalized.senderName,messageType:normalized.messageType,contextEntries,groupChatContext:{chatId:event.conversationId,name:group?.name||'',description:group?.description||''}}}:{}),hooks});
  }
  async function deliver(row){let result;try{const payload=parse(row.payload);if(row.kind==='reply')result=await chat.replyMessage({...payload,uuid:row.platformUuid});else if(row.kind==='create')result=await chat.sendMessage({...payload,conversationId:row.conversationId,uuid:row.platformUuid});else if(row.kind==='reaction')result=payload.reactionId?await chat.removeReaction(payload):await chat.addReaction(payload);else if(row.kind==='upload')result=payload.mediaType==='image'?await chat.uploadImage({bytes:Buffer.from(payload.base64,'base64')}):await chat.uploadFile({bytes:Buffer.from(payload.base64,'base64'),fileName:payload.fileName});else if(row.kind==='artifact_upload'&&outbound)result=await outbound.upload(payload);else if(row.kind==='artifact_send'&&outbound){const effect=await store.getOutbox({id:row.id});if(effect?.predecessorStatus!=='sent')throw Object.assign(new Error('artifact_predecessor_unconfirmed'),{outcome:'failed'});result=await outbound.send({...payload,uploadResult:parse(effect.predecessorResult),uuid:row.platformUuid});}else throw Object.assign(new Error('unsupported_delivery'),{outcome:'failed'});await settle(row,{status:'sent',result});}catch(error){await settle(row,{status:error.outcome==='failed'?'failed':'unknown',errorCode:'chat_delivery_unconfirmed',nextAttemptAt:Date.now()+5000});log('warning','chat_delivery','unconfirmed',{code:'chat_delivery_unconfirmed'});}}
  async function settle(row,outcome){try{await store.settleOutbox({id:row.id,leaseToken:row.leaseToken,...outcome});}catch{const recorded=await store.getOutbox({id:row.id});if(recorded?.status!=='sent')log('warning','chat_delivery','pending',{code:'delivery_settlement_unconfirmed'});}}
  async function hook(job){const definition=config.hooks.find(item=>item.id===job.hookId);try{if(!definition)throw new Error('hook_removed');const response=await fetchImpl(definition.url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(3000),headers:{'content-type':'application/json',authorization:`Bearer ${hookTokens[definition.id]}`,'idempotency-key':job.id},body:JSON.stringify({deliveryId:job.id,event:parse(job.payload)})});await response.body?.cancel();if(response.status!==204)throw new Error('hook_unacknowledged');await store.finishJobWithOutbox({id:job.id,leaseToken:job.leaseToken,result:{accepted:true}});}catch{await store.retryJob({id:job.id,leaseToken:job.leaseToken,terminal:!definition||job.attempts>=8,errorCode:'hook_unacknowledged',nextAttemptAt:Date.now()+Math.min(60000,1000*2**job.attempts)});log(job.attempts>=8?'error':'warning','hook_delivery','unacknowledged',{code:'hook_unacknowledged'});}}
  function launch(operation){const promise=operation.catch(()=>{healthy=false;log('error','communication_worker','failed',{code:'worker_failed'});}).finally(()=>active.delete(promise));active.add(promise);}
  async function loop(){while(!stopping&&healthy){try{if(active.size<8){for(const job of await store.claimJobs({kind:'hook',owner,leaseMs,limit:1}))launch(hook(job));for(const row of await store.claimOutbox({owner,leaseMs,limit:1}))launch(deliver(row));}}catch{healthy=false;log('error','communication_worker','failed',{code:'worker_poll_failed'});}await sleep(100);}}
  return Object.freeze({ingest,status:()=>({running:started&&!stopping&&healthy}),start(){if(started)throw new Error('communication_runtime_already_started');started=true;worker=loop();},async stop(){stopping=true;await worker;await Promise.allSettled(active);}});
}
