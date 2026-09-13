import { createHash } from 'node:crypto';
import { readFile, unlink, stat } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { splitReplyCards } from './reply-card.mjs';

const stable = value => createHash('sha256').update(String(value)).digest('hex').slice(0,32);
const imageTypes=new Set(['.png','.jpg','.jpeg','.gif','.webp','.bmp']);

export function publicAttachments(attachments=[]) {
  return attachments.map((value,index)=>{const path=typeof value==='string'?value:value.filePath; return {id:String(index),fileName:basename(path||`attachment-${index}`),size:Number(value?.size||0)||null,kind:imageTypes.has(extname(path||'').toLowerCase())?'image':'file'};});
}

export function createFeishuReplies({chat,outboxRoot,maxBytes=28*1024*1024,log=()=>{}}={}) {
  const root=resolve(outboxRoot||'.');
  function safePath(value){const path=resolve(String(value||'')); if(path!==root&&!path.startsWith(`${root}${sep}`))throw Object.assign(new Error('attachment_outside_outbox'),{code:'attachment_outside_outbox'}); return path;}
  async function sendText(job,result){const text=String(result.answer||'Codex 没有返回可用结论。'); const cards=splitReplyCards(text); const sent=[]; for(const [index,content] of cards.entries()){const args={kind:'interactive',content,uuid:stable(`run:${job.id}:answer:${index}`)}; sent.push(job.messageId?await chat.replyMessage({...args,messageId:job.messageId}):await chat.sendMessage({...args,conversationId:job.chatId}));} return sent;}
  async function sendAttachments(job,result){const sent=[]; for(const [index,value] of (result.attachments||[]).entries()){const path=safePath(typeof value==='string'?value:value.filePath); const info=await stat(path); if(!info.isFile()||info.size>maxBytes)throw Object.assign(new Error('attachment_invalid'),{code:'attachment_invalid'}); const bytes=await readFile(path); const extension=extname(path).toLowerCase(); const kind=imageTypes.has(extension)?'image':'file'; const uploaded=kind==='image'?await chat.uploadImage({bytes}):await chat.uploadFile({bytes,fileName:basename(path)}); const key=kind==='image'?'image_key':'file_key'; await chat.sendMessage({conversationId:job.chatId,kind,content:{[key]:uploaded[key]},uuid:stable(`run:${job.id}:attachment:${index}`)}); await unlink(path); sent.push({index,kind,fileName:basename(path),size:bytes.length});} return sent;}
  return Object.freeze({
    async deliver(job,result){const messages=await sendText(job,result); const attachments=await sendAttachments(job,result); return {messages:messages.length,attachments};},
    async readResource(job,index){const value=(job.result?.attachments||[])[index]; if(!value) return null; const path=safePath(typeof value==='string'?value:value.filePath); const info=await stat(path); if(!info.isFile()||info.size>maxBytes)return null; const bytes=await readFile(path); return {fileName:basename(path),kind:imageTypes.has(extname(path).toLowerCase())?'image':'file',size:bytes.length,base64:bytes.toString('base64')};},
    publicAttachments,
  });
}
