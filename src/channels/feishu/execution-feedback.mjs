import { createHash } from 'node:crypto';
import { ExecutionCard, observeExecutionCard } from './execution-card.mjs';
import { codexBindingOpenId } from '../../agents/codex/thread-scope.mjs';

const stable=value=>createHash('sha256').update(String(value)).digest('hex').slice(0,32);
const toast=(content,type='info')=>({toast:{type,content}});

export function createExecutionFeedback({jobs,sessions,chat,cardClient,authorize=async()=>true,executor,config={},log=()=>{},now=Date.now}={}) {
  const bindingOpenId=job=>codexBindingOpenId({feishuOpenId:job.senderOpenId,chatId:job.chatId,chatType:job.chatType});
  const persist=(job,key,value)=>jobs.patchFeedback({id:job.id,leaseOwner:job.leaseOwner,key,value});
  async function typingDesired(job,desired){const previous=job.result?.typing||{}; const intent={...previous,desired,operation:desired?'add':'remove',intentAt:now(),outcome:'pending'}; await persist(job,'typing',intent); job.result={...job.result,typing:intent}; try{
    let response;
    if(desired) response=await chat.addReaction({messageId:job.messageId,emojiType:config.typingEmoji||'Typing'});
    else if(previous.reactionId) response=await chat.removeReaction({messageId:job.messageId,reactionId:previous.reactionId});
    else { const absent={...intent,outcome:'absent',confirmedAt:now()}; await persist(job,'typing',absent); job.result={...job.result,typing:absent}; return absent; }
    const reactionId=response?.reaction_id||response?.reactionId||previous.reactionId||'';
    if(desired&&job.result?.typing?.desired===false){const late={...job.result.typing,reactionId,outcome:'late_add_confirmed',confirmedAt:now()};await persist(job,'typing',late);job.result={...job.result,typing:late};return typingDesired(job,false);}
    const confirmed={...intent,reactionId,outcome:'confirmed',confirmedAt:now()}; await persist(job,'typing',confirmed); job.result={...job.result,typing:confirmed};
    if(desired===false&&reactionId) return confirmed;
    // A late add confirmation after a terminal desired=false is reconciled by finish/restore.
    return confirmed;
  } catch(error){await persist(job,'typing',{...intent,outcome:error?.outcome==='failed'?'failed':'unknown',nextRetryAt:now()+1000}); throw error;}}
  function cardFor(job,saved){return new ExecutionCard({client:cardClient,chatId:job.chatId,jobId:job.id,messageId:job.messageId,displayName:config.displayName,uuid:stable(`execution-card:${job.messageId}`),saved,intervalMs:config.executionCardIntervalMs||1000,persist:value=>persist(job,'executionCard',value),audit:event=>sessions?.saveCodexRealtimeEvent?.({feishuOpenId:bindingOpenId(job),chatId:job.chatId,chatType:job.chatType,codexSessionId:event.threadId||''},{messageId:job.messageId,eventKey:`feedback:${job.id}:${event.status}:${now()}`,eventType:'execution_card',role:'activity',title:'执行卡片',text:'',createdAt:now(),detail:event})});}
  async function start(job){if(job.deliveryMode==='caller')return null; const typing=typingDesired(job,true).catch(()=>null); const saved=job.result?.executionCard; const card=cardFor(job,saved); card.push({kind:'started'}); return {card,observer:null,typing};}
  function observe(job,state,execution){if(!state?.card||state.observer)return state?.observer||null; state.observer=observeExecutionCard({card:state.card,since:Number(job.result?.executionCard?.observerCursor?.at||job.createdAt||now()),load:async cursor=>(await sessions.readPublicProgress({binding:{feishuOpenId:bindingOpenId(job),chatId:job.chatId},threadId:execution.threadId,messageId:job.messageId,cursor:cursor.id||0,limit:100})).map(row=>({...row,progress_json:row.detail_json}))});return state.observer;}
  async function restore(job){if(job.deliveryMode==='caller')return null; if(job.result?.typing?.desired===false&&job.result.typing.outcome!=='confirmed')await typingDesired(job,false).catch(()=>{}); return start(job);}
  async function prepare(job,result,state){
    if(job.deliveryMode==='caller')return;
    if(state?.observer) result.executionCard=await state.observer.stop();
    else if(state?.card) { state.card.stop(); await state.card.chain; result.executionCard=state.card.snapshot(); }
    const typing={...(job.result?.typing||{}),desired:false,operation:'remove',intentAt:now(),outcome:'pending'};
    await persist(job,'typing',typing);
    job.result={...job.result,typing};
    await state?.typing;
  }
  async function finish(job,result,state,error){if(job.deliveryMode==='caller')return false; const snapshot=state?.observer?await state.observer.stop():job.result?.executionCard; let delivered=false; if(snapshot){const card=cardFor(job,snapshot); delivered=await card.finish(result.answer||'Codex 没有返回可用结论。',error?(error.code==='CODEX_TURN_INTERRUPTED'?'interrupted':'failed'):'completed'); result.executionCard=card.snapshot();} await typingDesired({...job,result:{...job.result,typing:{...(job.result?.typing||{}),desired:false}}},false).catch(()=>{}); return delivered;}
  async function handleCardAction(data){const value=data?.action?.value||{}; if(value.action!=='stop_execution')return{}; const operator=data?.operator?.open_id||''; const job=await jobs.getRun({id:String(value.jobId||'')}); if(!job||!operator||job.chatId!==data?.context?.open_chat_id||job.result?.executionCard?.messageId!==data?.context?.open_message_id)return toast('该卡片已失效'); if(job.status!=='running')return toast('该任务已结束'); if(!job.senderOpenId.startsWith('system:')&&!job.senderOpenId.startsWith('group:')&&job.senderOpenId!==operator)return toast('只有本次任务的发起者可以停止执行','error'); if(!(await authorize({source:'card',callerId:job.callerId,actor:{openId:operator},conversationId:job.chatId,operation:'stop'})))return toast('没有停止该任务的权限','error'); const execution=job.result?.execution||{}; if(!execution.turnId||execution.turnId!==value.expectedTurnId)return toast('该卡片已失效'); const previous=job.result?.stop; if(previous?.threadId===execution.threadId&&previous?.turnId===execution.turnId&&previous?.messageId===job.messageId&&['requested','already_finished'].includes(previous.outcome))return previous.outcome==='requested'?toast('已请求停止执行'):toast('该执行已结束，不会影响新的任务'); const intent={threadId:execution.threadId,turnId:execution.turnId,messageId:job.messageId,actor:operator,intentAt:now(),outcome:'pending'}; await jobs.patchFeedback({id:job.id,leaseOwner:job.leaseOwner,key:'stop',value:intent}); const binding=await sessions.loadBinding({feishuOpenId:bindingOpenId(job),chatId:job.chatId,chatType:job.chatType}); const response=await executor.interrupt({binding,threadId:execution.threadId,turnId:execution.turnId,messageId:job.messageId}); await jobs.patchFeedback({id:job.id,leaseOwner:job.leaseOwner,key:'stop',value:{...intent,outcome:response.status,confirmedAt:now()}}); return response.status==='requested'?toast('已请求停止执行'):response.status==='already_finished'?toast('该执行已结束，不会影响新的任务'):toast('暂未确认停止，请稍后重试','error');}
  return Object.freeze({start,observe,restore,prepare,finish,handleCardAction,stop:typingDesired});
}
