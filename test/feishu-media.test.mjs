import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeishuChatClient } from '../src/channels/feishu/chat-client.mjs';
import { createFeishuMedia, extractMessageText, sendOutboundAttachment } from '../src/channels/feishu/media.mjs';

const event = (kind, content, conversationType = 'p2p') => ({ conversationId:'chat', messageId:'message', conversationType, message:{kind,content:JSON.stringify(content)} });
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-production-media-'));
  const calls = [];
  const chat = options.chat || { async downloadResource(input) { calls.push(input); return { stream: Readable.from(['image']), contentType: 'image/png', size: 5 }; } };
  const media = await createFeishuMedia({ chat, inboxDir:join(root,'inbox'), ...options });
  return { root, calls, media, close:()=>rm(root,{recursive:true,force:true}) };
}

test('production post extraction keeps text and links', () => {
  const source=event('post',{title:'Title',content:[[{tag:'text',text:'hello '},{tag:'a',text:'site',href:'https://example.com'}],[{tag:'img',image_key:'image'},{tag:'img',image_key:'image'}]]});
  assert.equal(extractMessageText(source),'Title\nhello site (https://example.com)');
});

test('production text extraction keeps raw malformed content and ignores a title without a post body', () => {
  const malformed = event('text', {});
  malformed.message.content = 'plain text from an invalid JSON envelope';
  assert.equal(extractMessageText(malformed), 'plain text from an invalid JSON envelope');
  assert.equal(extractMessageText(event('post', { title: 'title only' })), '');
});

test('every direct message type has the complete attachment record and attachment block', async () => {
  const f=await fixture();
  try {
    const downloaded=(kind,messageType,fileKey,fileName,durationMs,path)=>({index:1,kind,messageType,fileKey,fileName,durationMs,refId:null,raw:null,
      status:'downloaded',path,bytes:5,reason:null});
    const skipped=(kind,messageType,values={})=>({index:1,kind,messageType,fileKey:null,fileName:null,durationMs:null,refId:null,raw:null,
      status:'skipped',path:null,bytes:null,reason:'not_downloadable',...values});
    const inbox=join(f.root,'inbox','chat','message');
    const cases = [
      ['text',{text:'hello'},[], ''],
      ['image',{image_key:'image'},[downloaded('image','image','image',null,null,join(inbox,'image.png'))],`【附件 1/1】图片 （类型 image，5 B，已下载：${join(inbox,'image.png')}）`],
      ['file',{file_key:'file',file_name:'report.pdf'},[downloaded('file','file','file','report.pdf',null,join(inbox,'file.pdf'))],`【附件 1/1】文件 report.pdf（类型 file，5 B，已下载：${join(inbox,'file.pdf')}）`],
      ['audio',{file_key:'audio',duration:2500},[downloaded('audio','audio','audio',null,2500,join(inbox,'audio.png'))],`【附件 1/1】语音 （类型 audio，时长 2.5 秒，5 B，已下载：${join(inbox,'audio.png')}）`],
      ['media',{file_key:'video',file_name:'demo.mp4',duration:12000,image_key:'cover'},[downloaded('video','media','video','demo.mp4',12000,join(inbox,'video.mp4'))],`【附件 1/1】视频 demo.mp4（类型 media，时长 12 秒，5 B，已下载：${join(inbox,'video.mp4')}）`],
      ['sticker',{file_key:'sticker'},[skipped('sticker','sticker',{fileKey:'sticker',reason:'sticker_not_downloadable'})],'【附件 1/1】表情包 （类型 sticker，未能下载：表情包无法下载）'],
      ['share_chat',{chat_id:'oc_shared'},[skipped('share_chat','share_chat',{refId:'oc_shared'})],'【附件 1/1】群名片 （类型 share_chat，oc_shared，未能下载：该附件无可下载的资源）'],
      ['share_user',{open_id:'ou_shared'},[skipped('share_user','share_user',{refId:'ou_shared'})],'【附件 1/1】用户名片 （类型 share_user，ou_shared，未能下载：该附件无可下载的资源）'],
      ['merge_forward',{message_id:'om_forward'},[skipped('other','merge_forward',{raw:'{"message_id":"om_forward"}'})],'【附件 1/1】其他消息 （类型 merge_forward，未能下载：该附件无可下载的资源）\n{"message_id":"om_forward"}'],
      ['interactive',{schema:'2.0'},[skipped('other','interactive',{raw:'{"schema":"2.0"}'})],'【附件 1/1】其他消息 （类型 interactive，未能下载：该附件无可下载的资源）\n{"schema":"2.0"}'],
      ['future_type',{answer:42},[skipped('other','future_type',{raw:'{"answer":42}'})],'【附件 1/1】其他消息 （类型 future_type，未能下载：该附件无可下载的资源）\n{"answer":42}'],
    ];
    for (const [kind,content,attachments,addendum] of cases) {
      const prepared=await f.media.prepare(event(kind,content));
      assert.deepEqual(prepared,{status:'ready',text:kind==='text'?'hello':'',addendum,attachments},kind);
    }
    assert.equal(cases.find(([kind])=>kind==='sticker')[2][0].status,'skipped');
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
    const inbox=join(f.root,'inbox','chat','message');
    assert.deepEqual(prepared.attachments,[
      {index:1,kind:'file',messageType:'file',fileKey:'one',fileName:'one.pdf',durationMs:null,refId:null,raw:null,status:'downloaded',path:join(inbox,'one.pdf'),bytes:5,reason:null},
      {index:2,kind:'image',messageType:'img',fileKey:'two',fileName:null,durationMs:null,refId:null,raw:null,status:'downloaded',path:join(inbox,'two.png'),bytes:5,reason:null},
      {index:3,kind:'video',messageType:'media',fileKey:'three',fileName:'three.mp4',durationMs:9000,refId:null,raw:null,status:'downloaded',path:join(inbox,'three.mp4'),bytes:5,reason:null},
    ]);
    assert.deepEqual(f.calls.map(call=>[call.fileKey,call.type]),[['one','file'],['two','image'],['three','file']]);
    assert.equal(prepared.addendum,[
      `【附件 1/3】文件 one.pdf（类型 file，5 B，已下载：${join(inbox,'one.pdf')}）`,
      `【附件 2/3】图片 （类型 img，5 B，已下载：${join(inbox,'two.png')}）`,
      `【附件 3/3】视频 three.mp4（类型 media，时长 9 秒，5 B，已下载：${join(inbox,'three.mp4')}）`,
    ].join('\n'));
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
    assert.deepEqual(prepared.attachments,[
      {index:1,kind:'file',messageType:'file',fileKey:'one',fileName:'one.pdf',durationMs:null,refId:null,raw:null,status:'skipped',path:null,bytes:null,reason:'media_disabled'},
      {index:2,kind:'image',messageType:'img',fileKey:'two',fileName:null,durationMs:null,refId:null,raw:null,status:'skipped',path:null,bytes:null,reason:'media_disabled'},
    ]);
    assert.equal(prepared.addendum,'【附件 1/2】文件 one.pdf（类型 file，未能下载：媒体下载已关闭）\n【附件 2/2】图片 （类型 img，未能下载：媒体下载已关闭）'); assert.equal(f.calls.length,0);
  } finally { await f.close(); }
});

test('over-limit stream is interrupted and its partial file is removed', async () => {
  let destroyed=false;
  const raw={im:{v1:{messageResource:{async get(){const source=Readable.from([Buffer.alloc(4),Buffer.alloc(4)]);const original=source.destroy.bind(source);source.destroy=(...args)=>{destroyed=true;return original(...args);};
    return{getReadableStream:()=>source,headers:{'content-type':'application/pdf'}};}}}}};
  const chat=createFeishuChatClient({client:raw,maxMediaBytes:32});
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
