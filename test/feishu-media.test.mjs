import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeishuMedia, extractMessageText, extractPostImageKeys, sendOutboundAttachment } from '../src/channels/feishu/media.mjs';

const event = (kind, content, conversationType = 'p2p') => ({ conversationId:'chat', messageId:'message', conversationType, message:{kind,content:JSON.stringify(content)} });
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-production-media-'));
  const calls = [];
  const chat = options.chat || { async downloadResource(input) { calls.push(input); return { stream: Readable.from(['image']), contentType: 'image/png', size: 5 }; } };
  const media = await createFeishuMedia({ chat, inboxDir:join(root,'inbox'), ...options });
  return { root, calls, media, close:()=>rm(root,{recursive:true,force:true}) };
}

test('production post extraction keeps text, links and unique image keys', () => {
  const source=event('post',{title:'Title',content:[[{tag:'text',text:'hello '},{tag:'a',text:'site',href:'https://example.com'}],[{tag:'img',image_key:'image'},{tag:'img',image_key:'image'}]]});
  assert.equal(extractMessageText(source),'Title\nhello site (https://example.com)');
  assert.deepEqual(extractPostImageKeys(source),['image']);
});

test('production text extraction keeps raw malformed content and ignores a title without a post body', () => {
  const malformed = event('text', {});
  malformed.message.content = 'plain text from an invalid JSON envelope';
  assert.equal(extractMessageText(malformed), 'plain text from an invalid JSON envelope');
  assert.equal(extractMessageText(event('post', { title: 'title only' })), '');
});

test('every direct message type is represented without blocking Codex', async () => {
  const f=await fixture();
  try {
    const cases = [
      ['text',{text:'hello'},0], ['image',{image_key:'image'},1], ['file',{file_key:'file',file_name:'report.pdf'},1],
      ['audio',{file_key:'audio',duration:2500},1], ['media',{file_key:'video',file_name:'demo.mp4',duration:12000,image_key:'cover'},1],
      ['sticker',{file_key:'sticker'},1], ['share_chat',{chat_id:'oc_shared'},1], ['share_user',{open_id:'ou_shared'},1],
      ['merge_forward',{message_id:'om_forward'},1], ['interactive',{schema:'2.0'},1], ['future_type',{answer:42},1],
    ];
    for (const [kind,content,count] of cases) {
      const prepared=await f.media.prepare(event(kind,content));
      assert.equal(prepared.status,'ready',kind); assert.equal(prepared.attachments.length,count,kind);
    }
    assert.equal((await f.media.prepare(event('sticker',{file_key:'sticker'}))).attachments[0].reason,'sticker_not_downloadable');
    assert.equal((await f.media.prepare(event('share_chat',{chat_id:'oc_shared'}))).attachments[0].refId,'oc_shared');
    assert.equal((await f.media.prepare(event('share_user',{user_id:'ou_shared'}))).attachments[0].refId,'ou_shared');
    const other=await f.media.prepare(event('interactive',{schema:'2.0'}));
    assert.equal(other.attachments[0].raw,'{"schema":"2.0"}'); assert.match(other.addendum,/\n\{"schema":"2\.0"\}/);
    assert.equal(f.calls.some(call=>call.fileKey==='cover'),false);
  } finally { await f.close(); }
});

test('post file and mixed attachments preserve node order', async () => {
  const f=await fixture();
  try {
    const prepared=await f.media.prepare(event('post',{title:'Title',content:[[{tag:'text',text:'caption'}],[
      {tag:'file',file_key:'one',file_name:'one.pdf'},{tag:'img',image_key:'two'},{tag:'media',file_key:'three',file_name:'three.mp4',duration:9000},
    ]]}));
    assert.equal(prepared.text,'Title\ncaption');
    assert.deepEqual(prepared.attachments.map(item=>[item.index,item.kind,item.messageType,item.fileKey]),[
      [1,'file','file','one'],[2,'image','img','two'],[3,'video','media','three'],
    ]);
    assert.deepEqual(f.calls.map(call=>[call.fileKey,call.type]),[['one','file'],['two','image'],['three','file']]);
    assert.match(prepared.addendum,/\u3010附件 1\/3】文件 one\.pdf/);
  } finally { await f.close(); }
});

test('group media remains outside the private attachment path', async () => {
  const f=await fixture();
  try {
    const post=await f.media.prepare(event('post',{content:[[{tag:'text',text:'caption'},{tag:'img',image_key:'one'}]]},'group'));
    assert.equal(post.status,'ready'); assert.equal(post.text,'caption'); assert.deepEqual(post.attachments,[]); assert.equal(post.addendum,'');
    assert.deepEqual((await f.media.prepare(event('file',{file_key:'one'},'group'))).attachments,[]);
    assert.equal(f.calls.length,0);
  } finally { await f.close(); }
});

test('media disabled keeps metadata and skips all downloadable attachments', async () => {
  const f=await fixture({enabled:false});
  try {
    const prepared=await f.media.prepare(event('post',{content:[[{tag:'file',file_key:'one',file_name:'one.pdf'},{tag:'img',image_key:'two'}]]}));
    assert.deepEqual(prepared.attachments.map(item=>[item.status,item.reason]),[['skipped','media_disabled'],['skipped','media_disabled']]);
    assert.match(prepared.addendum,/媒体下载已关闭/); assert.equal(f.calls.length,0);
  } finally { await f.close(); }
});

test('over-limit stream is interrupted and its partial file is removed', async () => {
  let destroyed=false;
  const chat={async downloadResource(){const source=Readable.from([Buffer.alloc(4),Buffer.alloc(4)]);const original=source.destroy.bind(source);source.destroy=(...args)=>{destroyed=true;return original(...args);};
    const stream=Readable.from((async function*(){let total=0;try{for await(const chunk of source){total+=chunk.length;if(total>5)throw Object.assign(new Error('large'),{code:'media_too_large'});yield chunk;}}finally{source.destroy();}})());
    return{stream,contentType:'application/pdf'};}};
  const f=await fixture({chat,maxBytes:5});
  try {
    const prepared=await f.media.prepare(event('file',{file_key:'large',file_name:'large.pdf'}));
    assert.equal(prepared.attachments[0].status,'failed'); assert.equal(prepared.attachments[0].reason,'over_limit'); assert.equal(destroyed,true);
    const dir=join(f.root,'inbox','chat','message'); assert.deepEqual(await readdir(dir),[]);
  } finally { await f.close(); }
});

test('one attachment failure does not prevent later downloads', async () => {
  const f=await fixture({chat:{async downloadResource({fileKey}){if(fileKey==='bad')throw Object.assign(new Error('rejected'),{platformCode:234});return{stream:Readable.from(['ok']),contentType:'image/png'};}}});
  try {
    const prepared=await f.media.prepare(event('post',{content:[[{tag:'file',file_key:'bad'},{tag:'img',image_key:'good'}]]}));
    assert.deepEqual(prepared.attachments.map(item=>[item.status,item.reason]),[['failed','feishu_234'],['downloaded',null]]);
    assert.equal(await readFile(prepared.attachments[1].path,'utf8'),'ok'); assert.match(prepared.addendum,/飞书返回错误 234/);
  } finally { await f.close(); }
});

test('production outbound attachment uploads by type, enforces per-file cap and sends to chat', async () => {
  const root=await mkdtemp(join(tmpdir(),'bridge-production-outbound-')); const calls=[];
  const client={im:{v1:{
    image:{async create(){calls.push('upload:image');return{image_key:'image-key'};}},
    file:{async create(){calls.push('upload:file');return{file_key:'file-key'};}},
    message:{async create(input){calls.push(input.data.msg_type);return{data:{message_id:'sent'}};}},
  }}};
  try {
    const image=join(root,'a.png'),file=join(root,'a.txt');await writeFile(image,'image');await writeFile(file,'file');
    assert.equal((await sendOutboundAttachment({client,chatId:'chat',filePath:image,uuid:'one',maxBytes:100})).messageId,'sent');
    await sendOutboundAttachment({client,chatId:'chat',filePath:file,uuid:'two',maxBytes:100});
    await assert.rejects(sendOutboundAttachment({client,chatId:'chat',filePath:file,maxBytes:1}),/attachment_too_large/);
    assert.deepEqual(calls,['upload:image','image','upload:file','file']); assert.equal((await stat(file)).isFile(),true);
  } finally { await rm(root,{recursive:true,force:true}); }
});
