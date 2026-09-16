import {createHash,randomUUID} from 'node:crypto';
import {answersFromForm,renderUserInputCard} from './user-input-card.mjs';
import {normalizeUserInputAnswers} from '../../agents/codex/user-input-request.mjs';

const toast=(content,type='info')=>({toast:{type,content}});
const stable=value=>createHash('sha256').update(String(value)).digest('hex').slice(0,40);
const check=response=>{if(response?.code!=null&&response.code!==0)throw Object.assign(new Error('Feishu card rejected'),{code:String(response.code)});};

export function createUserInputRuntime({jobs,executor,cardClient,authorize=async()=>true,runAsync=operation=>Promise.resolve().then(operation).catch(()=>{}),config={},log=()=>{},now=Date.now}={}){
  let accepting=true; const live=new Map(); const operations=new Set();
  const track=operation=>{const pending=Promise.resolve().then(operation).finally(()=>operations.delete(pending));operations.add(pending);pending.catch(()=>{});return pending;};
  const patchTerminal=async(userInput,terminal)=>{
    if(!userInput.card?.messageId)return false;
    check(await cardClient.im.v1.message.patch({path:{message_id:userInput.card.messageId},data:{content:JSON.stringify(renderUserInputCard(userInput,{displayName:config.displayName,terminal}))}}));
    return true;
  };
  async function open(request){
    if(!accepting)throw Object.assign(new Error('runtime closing'),{code:'user_input_closing'});
    return track(async()=>{
      const job=await jobs.getByMessageId({messageId:request.messageId});
      if(!job)throw Object.assign(new Error('job not found'),{code:'user_input_job_missing'});
      const requestKey=request.requestKey; const cardUuid=stable(`user-input:${job.id}:${requestKey}:${request.itemId}`);
      const begun=await jobs.beginUserInput({id:job.id,messageId:job.messageId,threadId:request.threadId,turnId:request.turnId,itemId:request.itemId,
        requestKey,questions:request.questions,cardUuid});
      if(request.signal?.aborted){await jobs.expireUserInput({id:job.id,requestKey}).catch(()=>{});throw Object.assign(new Error('request expired'),{code:'user_input_expired'});}
      if(!['new','replay'].includes(begun.outcome)||begun.userInput?.status!=='pending')throw Object.assign(new Error('request stale'),{code:'user_input_stale'});
      const userInput={...begun.userInput,jobId:job.id,requestId:request.requestId};
      if(begun.outcome==='replay'&&userInput.card?.status==='confirmed'){live.set(`${job.id}:${requestKey}`,userInput);return;}
      if(userInput.card?.status==='unknown')throw Object.assign(new Error('card create unconfirmed'),{code:'user_input_card_unknown',outcome:'unknown'});
      let response;
      try{response=await cardClient.im.v1.message.create({params:{receive_id_type:'chat_id'},data:{receive_id:job.chatId,msg_type:'interactive',content:JSON.stringify(renderUserInputCard(userInput,{displayName:config.displayName})),uuid:cardUuid}});check(response);}
      catch(error){await jobs.finishUserInputCard({id:job.id,requestKey,status:error?.outcome==='unknown'?'unknown':'failed'}).catch(()=>{});throw error;}
      const cardMessageId=response?.data?.message_id;
      if(!cardMessageId){await jobs.finishUserInputCard({id:job.id,requestKey,status:'unknown'}).catch(()=>{});throw Object.assign(new Error('card id missing'),{outcome:'unknown'});}
      const saved=await jobs.finishUserInputCard({id:job.id,requestKey,status:'confirmed',cardMessageId});
      if(request.signal?.aborted||saved.userInput?.status!=='pending'){
        const expired=await jobs.expireUserInput({id:job.id,requestKey}).catch(()=>saved);
        await patchTerminal({...expired.userInput,jobId:job.id},'expired').catch(()=>log('error','user_input_card','delivery_failed',{runId:job.id,status:'expired'}));
        throw Object.assign(new Error('request expired'),{code:'user_input_expired'});
      }
      if(saved.outcome!=='confirmed'&&saved.userInput?.card?.messageId!==cardMessageId)throw Object.assign(new Error('card persistence unconfirmed'),{outcome:'unknown'});
      live.set(`${job.id}:${requestKey}`,{...saved.userInput,jobId:job.id,requestId:request.requestId});
    });
  }
  async function expire(request){
    const job=await jobs.getByMessageId({messageId:request.messageId}).catch(()=>null); if(!job)return;
    const saved=await jobs.expireUserInput({id:job.id,requestKey:request.requestKey}).catch(()=>null);
    const userInput=saved?.userInput||job.result?.userInput; live.delete(`${job.id}:${request.requestKey}`);
    if(userInput)await patchTerminal({...userInput,jobId:job.id},'expired').catch(()=>log('warning','user_input_card','delivery_failed',{runId:job.id}));
  }
  async function handleCardAction(data){
    const value=data?.action?.value||{}; if(value.action!=='submit_user_input')return null;
    if(!accepting)return toast('服务正在关闭，该提问已失效','error');
    const operator=data?.operator?.open_id||''; const job=await jobs.getRun({id:String(value.jobId||'')}); const userInput=job?.result?.userInput;
    if(!job||!userInput||!operator||job.chatId!==data?.context?.open_chat_id||job.senderOpenId!==operator
      ||userInput.card?.messageId!==data?.context?.open_message_id||userInput.requestKey!==value.requestKey||userInput.itemId!==value.itemId)return toast('该提问已失效','error');
    if(!(await authorize({source:'card',callerId:job.callerId,actor:{openId:operator},conversationId:job.chatId,conversationType:job.chatType,operation:'user_input'})))return toast('没有回答该提问的权限','error');
    if(userInput.status==='submitted')return toast('回答已提交');
    if(userInput.status==='submitting')return toast('回答正在提交，状态确认前请勿重复提交');
    if(userInput.status==='unknown')return toast('提交状态未确认，请勿重复提交','error');
    if(job.status!=='running'||userInput.status!=='pending')return toast('该提问已失效','error');
    let answers; try{answers=answersFromForm(userInput,data?.action?.form_value);normalizeUserInputAnswers(userInput.questions,answers);}catch{return toast('请检查并完整填写每一道题','error');}
    if(!accepting)return toast('服务正在关闭，该提问已失效','error');
    const active=live.get(`${job.id}:${userInput.requestKey}`);
    if(!active)return toast('该提问已失效','error');
    const operationId=randomUUID(); let begun;
    try{begun=await jobs.beginUserInputAnswer({id:job.id,requestKey:userInput.requestKey,itemId:userInput.itemId,actor:operator,
      chatId:job.chatId,cardMessageId:userInput.card.messageId,answers,operationId});}
    catch{
      const observed=await jobs.getRun({id:job.id}).catch(()=>null);const saved=observed?.result?.userInput;
      if(saved?.requestKey===userInput.requestKey&&saved.operationId===operationId&&saved.status==='submitting')begun={outcome:'new',userInput:saved};
      else{
        const unknown=await jobs.markUserInputUnknown({id:job.id,requestKey:userInput.requestKey,operationId}).catch(()=>null);
        live.delete(`${job.id}:${userInput.requestKey}`);
        const terminal=(unknown?.userInput||saved)?.status==='submitted'?'submitted':'unknown';
        await patchTerminal({...((unknown?.userInput)||saved||userInput),jobId:job.id},terminal).catch(()=>log('error','user_input_card','delivery_failed',{runId:job.id,status:terminal}));
        return terminal==='submitted'?toast('回答已提交'):toast('提交状态未确认，请勿重复提交','error');
      }
    }
    if(begun.outcome==='replay')return begun.userInput?.status==='submitted'?toast('回答已提交'):toast('提交状态未确认，请勿重复提交','error');
    if(begun.outcome!=='new')return toast('该提问已失效','error');
    active.status='submitting';
    runAsync(()=>track(async()=>{
      try{
      const response=await executor.answerUserInput({threadId:userInput.threadId,turnId:userInput.turnId,requestId:active.requestId,
        itemId:userInput.itemId,messageId:userInput.messageId,answers});
      const status=response.status==='submitted'?'submitted':response.status==='unknown'?'unknown':'expired';
      const saved=await jobs.finishUserInput({id:job.id,requestKey:userInput.requestKey,operationId,status}); live.delete(`${job.id}:${userInput.requestKey}`);
      const terminal=saved.userInput?.status==='submitted'?'submitted':saved.userInput?.status==='expired'?'expired':'unknown';
      await patchTerminal({...saved.userInput,jobId:job.id},terminal).catch(()=>log('error','user_input_card','delivery_failed',{runId:job.id,status:terminal}));
      }catch(error){
        let reconciled=await jobs.getRun({id:job.id}).catch(()=>null);let saved=reconciled?.result?.userInput;
        if(saved?.requestKey===userInput.requestKey&&saved.operationId===operationId&&saved.status==='submitting'){
          await jobs.markUserInputUnknown({id:job.id,requestKey:userInput.requestKey,operationId}).catch(()=>{});
          reconciled=await jobs.getRun({id:job.id}).catch(()=>null);saved=reconciled?.result?.userInput;
        }
        live.delete(`${job.id}:${userInput.requestKey}`);
        const terminal=saved?.status==='submitted'?'submitted':saved?.status==='expired'?'expired':'unknown';
        if(saved)await patchTerminal({...saved,jobId:job.id},terminal).catch(()=>log('error','user_input_card','delivery_failed',{runId:job.id,status:terminal}));
        log('error','user_input_submit','failed',{runId:job.id,code:String(error?.code||'unknown').slice(0,64)});
      }
    }));
    return toast('回答正在提交');
  }
  async function close(){
    accepting=false;
    await Promise.allSettled([...live.values()].filter(userInput=>userInput.status==='pending').map(userInput=>expire({messageId:userInput.messageId,requestKey:userInput.requestKey})));
    while(operations.size)await Promise.allSettled([...operations]);
  }
  return Object.freeze({open,expire,handleCardAction,close,status:()=>({accepting,pending:live.size,operations:operations.size})});
}
