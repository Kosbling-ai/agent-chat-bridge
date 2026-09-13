import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createFeishuMedia, extractMessageText, extractPostImageKeys } from '../src/channels/feishu/media.mjs';
const event = (kind, content, conversationType = 'p2p') => ({ connectionId:'connection', conversationId:'chat', messageId:'message', revision:'1', conversationType, message:{kind,content:JSON.stringify(content)} });
async function fixture(options = {}) {
  const workspace = await mkdtemp(join(tmpdir(),'bridge-media-'));
  const calls = [];
  const chat = { async downloadResource(input) { calls.push(input); return { contentType:'image/png',stream:Readable.from([Buffer.from('synthetic-image')]) }; } };
  const params = { workspace,inboxDir:join(workspace,'inbox'),chat,...options };
  const media = await createFeishuMedia(params);
  return { workspace,calls,media,params,close:()=>rm(workspace,{recursive:true,force:true}) };
}
test('post extraction preserves original rows, links, title and image deduplication',()=>{
  const source=event('post',{title:'Title',content:[[{tag:'text',text:'hello '},{tag:'a',text:'site',href:'https://example.com'}],[{tag:'img',image_key:'image'},{tag:'img',image_key:'image'}],[{tag:'text',text:'last'}]]});
  assert.equal(extractMessageText(source),'Title\nhello site (https://example.com)\nlast');
  assert.deepEqual(extractPostImageKeys(source),['image']);
  assert.equal(extractMessageText({...source,message:{kind:'text',content:'invalid JSON'}}),'invalid JSON');
});
test('real image bytes, restrictive modes, stable restart reuse and explicit release',{timeout:3000},async()=>{
  const f=await fixture();
  try{
    const source=event('image',{image_key:'image'});
    const prepared=await f.media.prepare(source,{runId:'run'});
    assert.equal(prepared.status,'ready');assert.equal(prepared.localPaths.length,1);
    assert.equal((await readFile(prepared.localPaths[0])).toString(),'synthetic-image');
    assert.equal((await stat(prepared.localPaths[0])).mode & 0o777,0o600);
    assert.equal((await stat(f.params.inboxDir)).mode & 0o777,0o700);
    assert.equal(prepared.addendum,`（用户发来一张图片，已下载到 ${prepared.localPaths[0]}）`);
    const restart=await createFeishuMedia(f.params);
    assert.deepEqual((await restart.prepare(source,{runId:'run'})).localPaths,prepared.localPaths);
    assert.equal(f.calls.length,1);
    const conflict=await restart.prepare({...source,messageId:'other'},{runId:'run'});
    assert.equal(conflict.status,'failed');assert.equal(conflict.reason,'media_run_conflict');
    assert.equal((await readFile(prepared.localPaths[0])).toString(),'synthetic-image');
    await restart.release('run');await restart.release('run');
    await assert.rejects(readFile(prepared.localPaths[0]),{code:'ENOENT'});
  }finally{await f.close();}
});
test('group captions remain text-only and original unsupported binaries never download',async()=>{
  const f=await fixture();
  try{
    const group=event('post',{content:[[{tag:'text',text:'caption'},{tag:'img',image_key:'image'}]]},'group');
    const result=await f.media.prepare(group,{runId:'group'});
    assert.equal(result.text,'caption');assert.deepEqual(result.localPaths,[]);
    assert.equal((await f.media.prepare(event('image',{image_key:'i'},'group'),{runId:'ignored'})).status,'ignored');
    for(const kind of ['file','media','audio','sticker','interactive'])assert.equal((await f.media.prepare(event(kind,{}),{runId:kind})).status,'unsupported');
    assert.equal(f.calls.length,0);
  }finally{await f.close();}
});
test('byte, MIME and capacity limits reject actual streams and remove only new partial files',async()=>{
  for(const options of [ {maxBytes:2,maxTotalBytes:2048}, {maxBytes:20,maxTotalBytes:20}, {chat:{downloadResource:async()=>({contentType:'text/html',stream:Readable.from(['wrong'])})}} ]) {
    const f=await fixture(options);
    try{
      assert.equal((await f.media.prepare(event('image',{image_key:'image'}),{runId:'run'})).status,'failed');
      for(const dir of await readdir(f.params.inboxDir))assert.deepEqual(await readdir(join(f.params.inboxDir,dir)),[]);
    }finally{await f.close();}
  }
});
test('all post images must succeed, and a timed-out source cannot produce a false attachment',{timeout:3000},async()=>{
  let count=0;
  const f=await fixture({timeoutMs:30,chat:{downloadResource:async()=>{
    count++;if(count===2)throw Error('private platform payload');
    return {contentType:'image/png',stream:Readable.from([Buffer.from('first')])};
  }}});
  try{
    const result=await f.media.prepare(event('post',{content:[[{tag:'img',image_key:'one'},{tag:'img',image_key:'two'}]]}),{runId:'post'});
    assert.equal(result.status,'failed');assert.deepEqual(result.localPaths,[]);assert.equal(result.addendum,'');
    for(const dir of await readdir(f.params.inboxDir))assert.deepEqual(await readdir(join(f.params.inboxDir,dir)),[]);
    const hung=await createFeishuMedia({...f.params,timeoutMs:20,chat:{downloadResource:()=>new Promise(()=>{})}});
    const timeout=await hung.prepare(event('image',{image_key:'hung'}),{runId:'timeout'});
    assert.equal(timeout.status,'failed');assert.equal(timeout.reason,'media_cancelled');
  }finally{await f.close();}
});
test('reject out-of-workspace and symlink roots without touching their target',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'bridge-media-path-'));
  const outside=await mkdtemp(join(tmpdir(),'bridge-media-target-'));
  const chat={downloadResource(){throw Error('must not download');}};
  try{
    await assert.rejects(createFeishuMedia({workspace,inboxDir:outside,chat}),{code:'invalid_media_directory'});
    const link=join(workspace,'link');await symlink(outside,link);
    await assert.rejects(createFeishuMedia({workspace,inboxDir:link,chat}),{code:'unsafe_media_directory'});
    assert.deepEqual(await readdir(outside),[]);
  }finally{await rm(workspace,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test('image count is bounded before download and late failed download closes its stream', {timeout:3000}, async()=>{
  const f=await fixture({maxImages:1});
  try{
    const result=await f.media.prepare(event('post',{content:[[{tag:'img',image_key:'a'},{tag:'img',image_key:'b'}]]}),{runId:'count'});
    assert.equal(result.reason,'media_too_many');assert.equal(f.calls.length,0);
    let finish;
    const late=await createFeishuMedia({...f.params,timeoutMs:10,chat:{downloadResource:()=>new Promise(resolve=>{finish=resolve;})}});
    assert.equal((await late.prepare(event('image',{image_key:'late'}),{runId:'late'})).status,'failed');
    const stream=Readable.from([Buffer.from('late')]);finish({stream,contentType:'image/png'});
    await new Promise(setImmediate);assert.equal(stream.destroyed,true);
  }finally{await f.close();}
});
test('file queue cancellation returns before a gated predecessor and never runs cancelled work',{timeout:3000},async()=>{
  const {createMediaFiles}=await import('../src/channels/feishu/media-files.mjs');
  const f=await fixture();
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  try{
    const files=await createMediaFiles({...f.params,maxTotalBytes:4096});
    const first=files.prepare({runId:'first',identity:'first',resources:['one'],maxBytes:100,download:async()=>{entered();await gate;return {stream:Readable.from([Buffer.from('one')]),extension:'.png'};}});
    await started;
    const controller=new AbortController();let downloaded=false;
    const second=files.prepare({runId:'second',identity:'second',resources:['two'],maxBytes:100,signal:controller.signal,download:async()=>{downloaded=true;throw Error('must not run');}});
    controller.abort();await assert.rejects(second,{code:'media_cancelled'});
    assert.equal(downloaded,false);release();await first;await new Promise(setImmediate);
    assert.equal(downloaded,false);assert.equal((await readdir(f.params.inboxDir)).length,1);
  }finally{release?.();await f.close();}
});
test('abort between resource return and file open destroys the real stream',{timeout:3000},async()=>{
  const {createMediaFiles}=await import('../src/channels/feishu/media-files.mjs');
  const f=await fixture();
  try{
    const files=await createMediaFiles({...f.params,maxTotalBytes:4096});
    const controller=new AbortController();const stream=new Readable({read(){}});
    await assert.rejects(files.prepare({runId:'abort-gap',identity:'gap',resources:['one'],maxBytes:100,signal:controller.signal,download:async()=>{
      controller.abort();return {stream,extension:'.png'};
    }}),{code:'media_cancelled'});
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(stream.destroyed,true);
  }finally{await f.close();}
});
test('file open failure destroys an already acquired resource stream',{timeout:3000},async()=>{
  const {createMediaFiles}=await import('../src/channels/feishu/media-files.mjs');
  const f=await fixture();const stream=new Readable({read(){}});
  try{
    const files=await createMediaFiles({...f.params,maxTotalBytes:4096});
    await assert.rejects(files.prepare({runId:'open-fail',identity:'open',resources:['one'],maxBytes:100,download:async()=>{
      const [dir]=await readdir(f.params.inboxDir);await rm(join(f.params.inboxDir,dir),{recursive:true});
      return {stream,extension:'.png'};
    }}));
    assert.equal(stream.destroyed,true);
  }finally{await f.close();}
});


test('directory fsync precedes ready and failed publication sync preserves complete files for replay',{timeout:3000},async(t)=>{
  const f=await fixture();
  const directory=await open(f.params.inboxDir,'r');
  const prototype=Object.getPrototypeOf(directory);
  const original=prototype.sync;
  await directory.close();
  let directorySyncs=0,failPublished=true;
  t.mock.method(prototype,'sync',async function(){
    if((await this.stat()).isDirectory()){
      directorySyncs++;
      const runs=await readdir(f.params.inboxDir);
      if(failPublished && runs.length && (await readdir(join(f.params.inboxDir,runs[0]))).includes('manifest.json')){
        failPublished=false;
        throw Object.assign(new Error('synthetic directory sync failure'),{code:'EIO'});
      }
    }
    return original.call(this);
  });
  try{
    const source=event('image',{image_key:'image'});
    const failed=await f.media.prepare(source,{runId:'durable'});
    assert.equal(failed.status,'failed');
    const [run]=await readdir(f.params.inboxDir);
    assert.equal((await readdir(join(f.params.inboxDir,run))).length,2);
    const before=directorySyncs;
    const retried=await f.media.prepare(source,{runId:'durable'});
    assert.equal(retried.status,'ready');
    assert.ok(directorySyncs-before>=2);
    assert.equal(f.calls.length,1);
    assert.equal(await readFile(retried.localPaths[0],'utf8'),'synthetic-image');
  }finally{t.mock.restoreAll();await f.close();}
});

test('release retries parent durability after deletion even when the run is already absent', {timeout:3000}, async t => {
  const f=await fixture();
  try {
    assert.equal((await f.media.prepare(event('image',{image_key:'image'}),{runId:'retire'})).status,'ready');
    const rootInfo=await stat(f.params.inboxDir);
    const handle=await open(f.params.inboxDir,'r');
    const prototype=Object.getPrototypeOf(handle),original=prototype.sync;await handle.close();
    let calls=0,fail=true;
    t.mock.method(prototype,'sync',async function(){
      const info=await this.stat();
      if(info.dev===rootInfo.dev && info.ino===rootInfo.ino) {
        calls++;
        if(fail)throw Object.assign(new Error('synthetic root sync failure'),{code:'EIO'});
      }
      return original.call(this);
    });
    await assert.rejects(f.media.release('retire'),{code:'EIO'});
    assert.deepEqual(await readdir(f.params.inboxDir),[]);
    await assert.rejects(f.media.release('retire'),{code:'EIO'});
    assert.equal(calls,2);
    fail=false;
    await f.media.release('retire');assert.equal(calls,3);
  }finally{t.mock.restoreAll();await f.close();}
});
