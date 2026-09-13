import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
const refs=Object.fromEntries(['host','port','user','password','database'].map(key=>[`${key}Env`,`BRIDGE_TEST_${key.toUpperCase()}`]));
test('real MySQL canonical receipt wins across live/history while recalls and known scopes stay distinct',{
  skip:!process.env.BRIDGE_TEST_PASSWORD,timeout:30000,
},async()=>{
  const pool=createPoolFromEnvironment(refs);await migrate(pool);const store=await createMysqlStore({pool});
  const input=(key,source='live',chat='a')=>({connectionId:'c',conversationId:chat,conversationType:'p2p',source,eventKey:key,eventType:'message.received',messageId:'message',revision:'1',payload:{source,conversationType:'p2p',text:key,actor:{name:source}},policyVersion:'v1',passiveContext:true,agentJob:{payload:{text:key}},hooks:[{hookId:'business',payload:{text:key}}]});
  try{
    const pair=await Promise.all([store.acceptInbound(input('live')),store.acceptInbound(input('history','history_catchup'))]);
    const first=pair.find(result=>result.firstReceipt);const duplicate=pair.find(result=>result.duplicateCanonical);
    assert.ok(first);assert.ok(duplicate);assert.equal(first.agentJobId,duplicate.agentJobId);assert.deepEqual(first.hookJobIds,duplicate.hookJobIds);assert.equal(first.eventId,duplicate.eventId);
    const changed=await store.acceptInbound({...input('history','history_catchup'),payload:{source:'history_catchup',conversationType:'p2p',text:'changed back and forth'}});
    assert.equal(changed.duplicateCanonical,true);assert.equal(changed.agentJobId,first.agentJobId);
    const [jobs]=await pool.query("SELECT kind,COUNT(*) AS n FROM bridge_jobs WHERE connection_id='c' GROUP BY kind");
    assert.deepEqual(jobs.map(row=>[row.kind,Number(row.n)]).sort(),[['agent',1],['hook',1]]);
    const [[ledger]]=await pool.query("SELECT COUNT(*) AS n FROM bridge_inbox WHERE connection_id='c'");assert.equal(Number(ledger.n),2);
    const recall=await store.acceptInbound({...input('recall'),eventType:'message.recalled',recalledMessageId:'message',agentJob:undefined,passiveContext:false});
    assert.equal(recall.firstReceipt,true);assert.equal(recall.duplicateCanonical,false);assert.equal(recall.agentJobId,null);assert.equal(recall.hookJobIds.length,1);
    assert.deepEqual(await store.readPassiveContext({connectionId:'c',conversationId:'a'}),[]);
    // No platform event_id required: history's derived eventKey establishes first receipt.
    const historyFirst=await store.acceptInbound(input('derived:b:message','history_catchup','b'));
    assert.equal(historyFirst.firstReceipt,true);
    const lateLive=await store.acceptInbound(input('platform-live-b','live','b'));
    assert.equal(lateLive.duplicateCanonical,true);assert.equal(lateLive.agentJobId,historyFirst.agentJobId);
    await store.acceptInbound({...input('group-event','live','group'),conversationType:'group',payload:{source:'live',conversationType:'group'},agentJob:undefined,hooks:[]});
    await assert.rejects(store.acceptInbound({...input('type-conflict','history_catchup','a'),conversationType:'group',payload:{source:'history_catchup',conversationType:'group'}}),{code:'conversation_type_conflict'});
    const page=await store.listKnownConversations({connectionId:'c',conversationType:'p2p',limit:1});
    assert.deepEqual(page,{items:[{conversationId:'a',conversationType:'p2p'}],nextCursor:'a'});
    assert.deepEqual(await store.listKnownConversations({connectionId:'c',conversationType:'p2p',limit:1,afterConversationId:page.nextCursor}),{items:[{conversationId:'b',conversationType:'p2p'}],nextCursor:null});
    await assert.rejects(store.acceptInbound({...input('bad-source'),source:'anything'}),{code:'invalid_inbound_source'});
    await assert.rejects(store.listKnownConversations({connectionId:'c',conversationType:'p2p',limit:101}),{code:'invalid_store_limit'});
    for(const [eventKey,nativeTurnId] of [['one','turn1'],['two','turn2'],['unknown',null]])await store.bufferNativeEvent({connectionId:'c',eventKey,nativeThreadId:'thread',nativeTurnId,payload:{eventKey}});
    const filtered=await store.readNativeEvents({connectionId:'c',nativeThreadId:'thread',nativeTurnId:'turn1'});
    assert.equal(filtered.length,1);assert.equal(filtered[0].nativeTurnId,'turn1');
    assert.equal((await store.readNativeEvents({connectionId:'c',nativeThreadId:'thread'})).length,3);
    assert.deepEqual(await store.readNativeEvents({connectionId:'c',nativeThreadId:'thread',nativeTurnId:'turn1',afterSequence:filtered[0].sequence}),[]);
  }finally{await store.close();}
});
