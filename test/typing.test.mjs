import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessingTyping } from '../src/channels/feishu/typing.mjs';

const job={id:'run',chatId:'chat',chatType:'p2p',messageType:'text',messageId:'message',sourceMessageId:'message'};

test('production Typing records add and removes direct, persisted and listed app reactions',async()=>{
  const effects=[],events=[];
  const typing=createProcessingTyping({chat:{
    async addReaction(){effects.push('add');return{reaction_id:'direct'};},
    async removeReaction({reactionId}){effects.push(`remove:${reactionId}`);},
    async listReactions(){return{items:[{reaction_id:'listed',operator:{operator_type:'app'},reaction_type:{emoji_type:'Typing'}},{reaction_id:'human',operator:{operator_type:'user'},reaction_type:{emoji_type:'Typing'}}]};},
  },inbound:{async recordEvent(value){events.push(value);},async loadOpenProcessingReactionIds(){return new Set(['persisted']);}}});
  const reaction=await typing.start(job); await typing.cleanup(job,reaction);
  assert.deepEqual(effects,['add','remove:direct','remove:persisted','remove:listed']);
  assert.deepEqual(events.map(item=>item.event),['processing_reaction_added','processing_reaction_removed','processing_reaction_removed','processing_reaction_removed']);
});

test('failed Typing add sends one fallback and never blocks cleanup failures',async()=>{
  const effects=[];
  const typing=createProcessingTyping({chat:{async addReaction(){throw new Error('private');},async sendMessage(input){effects.push(input.content.text);},async listReactions(){throw new Error('private');}},inbound:{async loadOpenProcessingReactionIds(){throw new Error('private');}}});
  assert.equal(await typing.start(job),null); await typing.cleanup(job); assert.deepEqual(effects,['收到，正在查询。']);
});

test('Typing audit failure stays best effort and does not send a false fallback',async()=>{
  const effects=[];
  const typing=createProcessingTyping({chat:{async addReaction(){effects.push('add');return{reaction_id:'reaction'};},async sendMessage(){effects.push('fallback');}},inbound:{async recordEvent(){throw new Error('synthetic audit failure');}}});
  assert.deepEqual(await typing.start(job),{reactionId:'reaction'});assert.deepEqual(effects,['add']);
});
