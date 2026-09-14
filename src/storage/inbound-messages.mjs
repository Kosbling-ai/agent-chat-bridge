import { withConnection } from './connection.mjs';
import { StoreError } from './errors.mjs';

const json = value => JSON.stringify(value ?? null);
const text = (value,max=255) => { if(typeof value!=='string'||!value||value.length>max)throw new StoreError('invalid_store_input'); return value; };
const parse = value => { try{return value?JSON.parse(value):null;}catch{return null;} };

export function createInboundMessageStore({pool,now=Date.now,operationTimeoutMs=1800}={}) {
  if(!pool)throw new StoreError('invalid_store_input');
  const read=operation=>withConnection(pool,operation,{timeoutMs:operationTimeoutMs});
  const write=operation=>withConnection(pool,operation,{timeoutMs:operationTimeoutMs,transaction:true});
  return Object.freeze({
    persist(input){return write(async connection=>{const at=now(); await connection.execute(`INSERT INTO assistant_inbound_messages
      (message_id,chat_id,chat_type,message_type,sender_open_id,sender_name,content_text,content_json,mentions_json,raw_event_json,bot_mentioned,group_context_candidate,message_created_at,message_updated_at,received_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE message_updated_at=GREATEST(COALESCE(message_updated_at,0),VALUES(message_updated_at)),updated_at=VALUES(updated_at)`,
      [text(input.messageId,191),text(input.chatId,191),input.chatType||'',input.messageType||'text',input.senderOpenId||'',input.senderName||'',input.text||'',json(input.content||{text:input.text||''}),json(input.mentions||[]),json(input.raw||{}),input.botMentioned?1:0,input.groupContextCandidate?1:0,input.createdAt??at,input.updatedAt??input.createdAt??at,at,at]); return {persisted:true};});},
    loadRecentGroupContext({connectionId,chatId,beforeMs,windowMs=2*60*60*1000,limit=10,excludeMessageIds=[]}){if(!Number.isFinite(beforeMs)||!Number.isFinite(windowMs)||windowMs<0)throw new StoreError('invalid_store_input'); const take=Math.max(0,Math.min(100,Number(limit))); if(!take)return Promise.resolve([]); const excluded=new Set(excludeMessageIds.map(String)); return read(async connection=>{const [rows]=await connection.execute(`SELECT m.id,m.message_id,m.sender_open_id,m.sender_name,m.content_text,m.message_created_at FROM assistant_inbound_messages m
      WHERE m.chat_id=? AND m.content_text!='' AND m.group_context_candidate=1 AND m.bot_mentioned=0 AND m.codex_context_forwarded_at IS NULL
        AND m.message_created_at>=? AND m.message_created_at<=?
        AND NOT EXISTS (SELECT 1 FROM bridge_message_tombstones t WHERE t.connection_id=? AND t.message_id=m.message_id)
      ORDER BY m.message_created_at DESC,m.id DESC LIMIT ${take*3}`,[text(chatId,191),beforeMs-windowMs,beforeMs,text(connectionId,128)]); return rows.reverse().filter(row=>!excluded.has(String(row.message_id||''))).slice(-take).map(row=>({id:String(row.id),inboundId:Number(row.id),messageId:row.message_id,senderOpenId:row.sender_open_id,senderName:row.sender_name,prompt:String(row.content_text||'').trim(),text:String(row.content_text||'').trim(),createdAt:Number(row.message_created_at),source:'persisted_group_context'}));});},
    markForwarded({entries,threadId,turnId}){const ids=[...new Set((entries||[]).map(item=>Number(item.inboundId??item.id)).filter(id=>Number.isInteger(id)&&id>0))]; const messageIds=[...new Set((entries||[]).map(item=>String(item.messageId||'').trim()).filter(Boolean))]; if(!ids.length&&!messageIds.length)return Promise.resolve({updated:0}); const conditions=[]; const values=[]; if(ids.length){conditions.push(`id IN (${ids.map(()=>'?').join(',')})`);values.push(...ids);} if(messageIds.length){conditions.push(`message_id IN (${messageIds.map(()=>'?').join(',')})`);values.push(...messageIds);} return write(async connection=>{const at=now();const [result]=await connection.execute(`UPDATE assistant_inbound_messages SET codex_context_session_id=?,codex_context_turn_id=?,codex_context_forwarded_at=?,updated_at=? WHERE group_context_candidate=1 AND codex_context_forwarded_at IS NULL AND (${conditions.join(' OR ')})`,[threadId||'',turnId||'',at,at,...values]); return {updated:result.affectedRows};});},
    recordReply(input){return write(async connection=>{const at=now(); const messageId=text(input.messageId,191); await connection.execute(`INSERT IGNORE INTO assistant_inbound_messages
      (message_id,chat_id,chat_type,message_type,sender_open_id,sender_name,content_text,content_json,mentions_json,raw_event_json,bot_mentioned,group_context_candidate,message_created_at,message_updated_at,received_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[messageId,text(input.chatId,191),input.chatType||'group','text',input.senderOpenId||'bot',input.senderName||'Agent Chat Bridge',input.text||'',json({text:input.text||''}),'[]',json({synthetic:true,source:'bridge_reply'}),0,0,input.createdAt??at,input.createdAt??at,at,at]); return {persisted:true};});},
    recordEvent(input){return write(async connection=>{const [result]=await connection.execute(`INSERT INTO assistant_message_events (message_id,chat_id,event,ok,reason,detail,chat_type,message_type,elapsed_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,[text(input.messageId,191),text(input.chatId,191),text(input.event,64),input.ok?1:0,input.reason||'',typeof input.detail==='string'?input.detail:json(input.detail||{}),input.chatType||'',input.messageType||'',input.elapsedMs??null,now()]); return {id:String(result.insertId)};});},
  });
}
