import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFeishuMedia, extractMessageText, extractPostImageKeys, sendOutboundAttachment } from '../src/channels/feishu/media.mjs';

const event = (kind, content, conversationType = 'p2p') => ({ conversationId:'chat', messageId:'message', conversationType, message:{kind,content:JSON.stringify(content)} });
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-production-media-'));
  const calls = [];
  const client = options.client || { im:{v1:{messageResource:{async get(input){calls.push(input);return{headers:{'content-type':'image/png'},async writeFile(path){await writeFile(path,'image');}};}}}}};
  const media = await createFeishuMedia({ client, inboxDir:join(root,'inbox'), ...options });
  return { root, calls, media, close:()=>rm(root,{recursive:true,force:true}) };
}

test('production post extraction keeps text, links and unique image keys', () => {
  const source=event('post',{title:'Title',content:[[{tag:'text',text:'hello '},{tag:'a',text:'site',href:'https://example.com'}],[{tag:'img',image_key:'image'},{tag:'img',image_key:'image'}]]});
  assert.equal(extractMessageText(source),'Title\nhello site (https://example.com)');
  assert.deepEqual(extractPostImageKeys(source),['image']);
});

test('private image and every private post image download to the configured inbox', async () => {
  const f=await fixture();
  try {
    const image=await f.media.prepare(event('image',{image_key:'one'}));
    assert.equal(image.status,'ready'); assert.equal(await readFile(image.localPaths[0],'utf8'),'image');
    const post=await f.media.prepare(event('post',{content:[[{tag:'img',image_key:'two'},{tag:'img',image_key:'three'}]]}));
    assert.equal(post.localPaths.length,2); assert.equal(f.calls.length,3);
  } finally { await f.close(); }
});

test('group media stays text-only and the media switch only affects private downloads', async () => {
  const f=await fixture(); const off=await fixture({enabled:false});
  try {
    const group=await f.media.prepare(event('post',{content:[[{tag:'text',text:'caption'},{tag:'img',image_key:'one'}]]},'group'));
    assert.equal(group.status,'ready'); assert.equal(group.text,'caption'); assert.deepEqual(group.localPaths,[]);
    assert.equal((await f.media.prepare(event('image',{image_key:'one'},'group'))).status,'ignored');
    assert.equal((await off.media.prepare(event('image',{image_key:'one'}))).reason,'media_disabled');
    assert.equal(f.calls.length,0); assert.equal(off.calls.length,0);
  } finally { await f.close(); await off.close(); }
});

test('inbound maxBytes is advisory while unsupported and failed inputs retain production replies', async () => {
  const warnings=[]; const f=await fixture({maxBytes:1,log:(...args)=>warnings.push(args)});
  try {
    assert.equal((await f.media.prepare(event('image',{image_key:'one'}))).status,'ready');
    assert.equal(warnings[0][2],'oversize');
    assert.match((await f.media.prepare(event('file',{}))).replyText,/暂不支持/);
    const failed=await fixture({client:{im:{v1:{messageResource:{async get(){throw new Error('private provider text');}}}}}});
    try { assert.equal((await failed.media.prepare(event('image',{image_key:'one'}))).reason,'image_download_failed'); }
    finally { await failed.close(); }
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
