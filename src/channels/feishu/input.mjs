function contentText(event={}) {
  if(typeof event.text==='string')return event.text;
  if(typeof event.message?.text==='string')return event.message.text;
  if(typeof event.message?.parsedContent?.text==='string')return event.message.parsedContent.text;
  if(typeof event.message?.content==='string') { try{return JSON.parse(event.message.content).text||'';}catch{return '';} }
  return event.message?.content?.text||'';
}

export function removeBotMention(text,mentions=[],botOpenId='') {
  let value=String(text||'');
  for(const mention of mentions) if(mention?.openId===botOpenId||mention?.id?.open_id===botOpenId) {
    const key=mention.key||mention.name; if(key)value=value.replaceAll(key,'');
  }
  return value.trim();
}

export function normalizeFeishuInput(event,{botOpenId}={}) {
  const mentions=event.message?.mentions||event.mentions||[];
  const raw=contentText(event);
  const senderName=String(event.actor?.name||event.senderName||event.sender?.sender_name||'').trim();
  const botMentioned=mentions.some(item=>item?.openId===botOpenId||item?.id?.open_id===botOpenId);
  return {
    messageId:event.messageId||event.message?.message_id||'', chatId:event.conversationId||event.message?.chat_id||'',
    chatType:event.conversationType||event.message?.chat_type||'', messageType:event.message?.type||event.message?.message_type||'text',
    senderOpenId:event.actor?.openId||event.sender?.sender_id?.open_id||'', senderName,
    text:removeBotMention(raw,mentions,botOpenId), mentions, botMentioned,
    createdAt:Number(event.occurredAt||event.message?.create_time||Date.now()), raw:event,
  };
}

export function formatGroupContext(entries=[]) {
  return entries.slice(-10).map(item=>`${item.senderName||'群成员'}：${item.text}`).join('\n');
}
