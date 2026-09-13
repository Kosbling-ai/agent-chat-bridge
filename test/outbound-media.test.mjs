import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, utimes, symlink, link, open, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOutboundMedia } from '../src/channels/feishu/outbound-media.mjs';

const sinceMs = 1789250000000;
const scope = { connectionId: 'fixture', conversationId: 'chat', runId: 'run', conversationType: 'p2p', sinceMs };
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-outbound-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const chat = {
    async uploadFile(input) { calls.push(['file', input]); return { file_key: 'file-key' }; },
    async uploadImage(input) { calls.push(['image', input]); return { image_key: 'image-key' }; },
    async sendMessage(input) { calls.push(['send', input]); return { message_id: 'sent' }; },
    ...options.chat,
  };
  const config = { workspace: root, outboxDir: join(root, 'outbox'), spoolDir: join(root, 'outbound-spool'), ...options, chat };
  const media = await createOutboundMedia(config);
  const dir = await media.directory(scope);
  async function put(name, content, offset = 0) {
    const path = join(dir, name); await writeFile(path, content); await utimes(path, (sinceMs + offset) / 1000, (sinceMs + offset) / 1000); return path;
  }
  return { root, config, media, dir, put, calls };
}

test('private flat scan keeps newest nine in time order and excludes old files and group output', async t => {
  const f = await fixture(t);
  await f.put('old.txt', 'old', -2000);
  for (let i = 0; i < 11; i++) await f.put(`${i}.txt`, String(i), i * 10);
  const result = await f.media.prepare(scope);
  assert.equal(result.omitted, 2); assert.deepEqual(result.artifacts.map(a => a.fileName), ['2.txt', '3.txt', '4.txt', '5.txt', '6.txt', '7.txt', '8.txt', '9.txt', '10.txt']);
  assert.equal((await f.media.prepare({ ...scope, conversationType: 'group' })).artifacts.length, 0);
  assert.equal(f.calls.length, 0);
});

test('manifest freezes bytes before effects and restart does not rescan a new file or changed source', async t => {
  const f = await fixture(t); const path = await f.put('report.pdf', 'original');
  const prepared = await f.media.prepare(scope);
  await writeFile(path, 'new report'); await f.put('extra.txt', 'extra', 3000);
  const restarted = await createOutboundMedia(f.config);
  assert.deepEqual(await restarted.prepare(scope), prepared);
  const ref = prepared.artifacts[0].ref;
  const uploaded = await restarted.upload({ scope, ref });
  assert.equal(f.calls[0][1].bytes.toString(), 'original'); assert.equal(f.calls[0][1].fileType, 'pdf');
  await restarted.send({ scope, ref, uploadResult: uploaded, uuid: 'stable-effect-uuid' });
  assert.equal(f.calls[1][1].uuid, 'stable-effect-uuid');
  const cleaned = await restarted.cleanup({ scope, ref, confirmedSent: true });
  assert.equal(cleaned.sourceChanged, true); assert.equal(await readFile(path, 'utf8'), 'new report');
  assert.deepEqual(await restarted.cleanup({ scope, ref, confirmedSent: true }), cleaned);
});

test('separate upload/send preserve type mapping and only confirmed send permits source deletion', async t => {
  const f = await fixture(t); const path = await f.put('photo.PNG', 'image');
  const { artifacts } = await f.media.prepare(scope), ref = artifacts[0].ref;
  const result = await f.media.upload({ scope, ref }); assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'image');
  await assert.rejects(f.media.cleanup({ scope, ref }), { code: 'artifact_send_unconfirmed' });
  assert.equal(await readFile(path, 'utf8'), 'image');
  await f.media.send({ scope, ref, uploadResult: result, uuid: 'uuid' });
  await f.media.cleanup({ scope, ref, confirmedSent: true });
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  assert.equal(f.calls.length, 2);
});

test('unknown upload does not send, retry or discard the retained snapshot', async t => {
  let uploads = 0;
  const f = await fixture(t, { chat: { async uploadFile() { uploads++; throw Object.assign(new Error('unknown'), { outcome: 'unknown' }); } } });
  const path = await f.put('archive.zip', 'zip'); const prepared = await f.media.prepare(scope);
  await assert.rejects(f.media.upload({ scope, ref: prepared.artifacts[0].ref }), { outcome: 'unknown' });
  assert.equal(uploads, 1); assert.equal(await readFile(path, 'utf8'), 'zip');
  assert.deepEqual(await f.media.prepare(scope), prepared);
});

test('scope mismatch, symlink and hardlinked source cannot become an upload', async t => {
  const f = await fixture(t); const ordinary = await f.put('ok.txt', 'ok');
  await symlink(ordinary, join(f.dir, 'symlink.txt')); await link(ordinary, join(f.dir, 'hardlink.txt'));
  const blocked = await f.media.prepare(scope);
  assert.equal(blocked.artifacts.length, 0); assert.equal(blocked.failures.length, 2);
  await f.put('isolated.txt', 'only one');
  const otherScope = { ...scope, runId: 'run2' }; const prepared = await f.media.prepare(otherScope);
  const ref = prepared.artifacts[0].ref;
  await assert.rejects(f.media.upload({ scope: { ...otherScope, conversationId: 'forbidden' }, ref }), { code: 'artifact_scope_mismatch' });
  assert.equal(f.calls.length, 0);
});

test('28 MiB boundary retains oversized failures and contains asynchronous logging rejection', async t => {
  const f = await fixture(t, { log: async () => { throw new Error('logger'); } });
  const path = await f.put('large.dat', '');
  const handle = await open(path, 'r+'); await handle.truncate(28 * 1024 * 1024 + 1); await handle.close();
  await utimes(path, sinceMs / 1000, sinceMs / 1000);
  await f.put('small.docx', 'small');
  const result = await f.media.prepare(scope);
  assert.equal(result.failures[0].code, 'artifact_too_large'); assert.equal(result.artifacts[0].fileType, 'stream');
  assert((await readdir(f.dir)).includes('large.dat'));
});

test('tampered snapshot fails integrity checks', async t => {
  const f = await fixture(t);
  await f.put('data.csv', 'original'); const prepared = await f.media.prepare(scope);
  const runDirectory = (await readdir(f.config.spoolDir))[0];
  await writeFile(join(f.config.spoolDir, runDirectory, prepared.artifacts[0].ref.artifactId), 'tampered');
  await assert.rejects(f.media.upload({ scope, ref: prepared.artifacts[0].ref }), { code: 'artifact_integrity_failed' });
  assert.equal(f.calls.length, 0);
});

test('an exact 28 MiB file is snapshotted and uploaded within the internal limit', async t => {
  const f = await fixture(t);
  const path = await f.put('limit.dat', '');
  const handle = await open(path, 'r+'); await handle.truncate(28 * 1024 * 1024); await handle.close();
  await utimes(path, sinceMs / 1000, sinceMs / 1000);
  const result = await f.media.prepare(scope);
  assert.equal(result.artifacts[0].size, 28 * 1024 * 1024); assert.equal(result.failures.length, 0);
  await f.media.upload({ scope, ref: result.artifacts[0].ref });
  assert.equal(f.calls[0][1].bytes.length, 28 * 1024 * 1024);
});


test('published manifests claim a source version across overlapping runs and unchanged uploads', async t => {
  const f = await fixture(t);
  await f.put('shared.pdf','original');
  const [first,second] = await Promise.all([
    f.media.prepare(scope), f.media.prepare({...scope,runId:'overlap',sinceMs:sinceMs+500}),
  ]);
  assert.equal(first.artifacts.length,1); assert.equal(second.artifacts.length,0);
  assert.equal(await readFile(join(f.dir,'shared.pdf'),'utf8'),'original');
  const restarted = await createOutboundMedia(f.config);
  assert.deepEqual(await restarted.prepare(scope),first);
  assert.equal((await restarted.prepare({...scope,runId:'after-restart',sinceMs:sinceMs+500})).artifacts.length,0);
});

test('same path and identical stat fields with changed bytes are a new version', async t => {
  const f = await fixture(t);
  await f.put('shared.txt','aaaa');
  const first = await f.media.prepare(scope);
  await f.put('shared.txt','bbbb'); // Same inode, length and restored mtime.
  const second = await f.media.prepare({...scope,runId:'updated'});
  assert.equal(first.artifacts.length,1); assert.equal(second.artifacts.length,1);
  await f.media.upload({scope:{...scope,runId:'updated'},ref:second.artifacts[0].ref});
  assert.equal(f.calls[0][1].bytes.toString(),'bbbb');
  assert.equal((await f.media.prepare({...scope,runId:'unchanged-again'})).artifacts.length,0);
});

test('already claimed newest files do not consume the next runs nine-file selection', async t => {
  const f = await fixture(t);
  for(let i=0;i<9;i++) await f.put(`claimed-${i}.txt`,'old',i);
  assert.equal((await f.media.prepare(scope)).artifacts.length,9);
  await f.put('new-older-time.txt','new',-500);
  const next = await f.media.prepare({...scope,runId:'next'});
  assert.deepEqual(next.artifacts.map(item=>item.fileName),['new-older-time.txt']);
  assert.equal(next.omitted,0);
});

test('post-manifest sync failure retains the only claim and original run recovers its snapshot', async t => {
  const f = await fixture(t);
  await f.put('recover.pdf','original');
  const probe = await open(f.config.spoolDir,'r');
  const prototype = Object.getPrototypeOf(probe), originalSync = prototype.sync;
  await probe.close();
  let injected = false;
  t.mock.method(prototype,'sync',async function(){
    if(!injected && (await this.stat()).isDirectory()) {
      const dirs = await readdir(f.config.spoolDir);
      for(const dir of dirs) if((await readdir(join(f.config.spoolDir,dir))).includes('manifest.json')) {
        injected = true; throw Object.assign(new Error('synthetic fsync failure'),{code:'EIO'});
      }
    }
    return originalSync.call(this);
  });
  await assert.rejects(f.media.prepare(scope),{code:'EIO'});
  t.mock.restoreAll();
  const restarted = await createOutboundMedia(f.config);
  assert.equal((await restarted.prepare({...scope,runId:'other'})).artifacts.length,0);
  const original = await restarted.prepare(scope); assert.equal(original.artifacts.length,1);
  await restarted.upload({scope,ref:original.artifacts[0].ref});
  assert.equal(f.calls[0][1].bytes.toString(),'original');
});

test('failed preparation before a manifest cannot claim and silently swallow a source', async t => {
  const f = await fixture(t,{maxBytes:10,maxTotalBytes:100});
  await f.put('unclaimed.txt','data');
  await assert.rejects(f.media.prepare(scope),{code:'artifact_storage_full'});
  const restored = await createOutboundMedia({...f.config,maxTotalBytes:1024*1024});
  assert.equal((await restored.prepare({...scope,runId:'sufficient-space'})).artifacts.length,1);
  assert.equal(await readFile(join(f.dir,'unclaimed.txt'),'utf8'),'data');
});
