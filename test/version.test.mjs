import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkVersion } from '../scripts/check-version.mjs';

test('release metadata agrees and --version exits without config or provider startup',async()=>{
  const version=await checkVersion();
  const cli=fileURLToPath(new URL('../bin/agent-chat-bridge.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[cli,'--version'],{cwd:tmpdir(),env:{},encoding:'utf8',timeout:2000});
  assert.equal(result.status,0);assert.equal(result.stdout,`${version}\n`);assert.equal(result.stderr,'');
  assert.notEqual(spawnSync(process.execPath,[cli,'--version','extra'],{env:{},timeout:2000}).status,0);
});

test('version check rejects drift, missing notes and accidental npm publication',async()=>{
  const root=await mkdtemp(join(tmpdir(),'bridge-version-'));
  const url=pathToFileURL(root+'/');
  const files=['VERSION','package.json','package-lock.json','README.md','CHANGELOG.md','MIGRATIONS.md'];
  try{
    for(const file of files)await writeFile(new URL(file,url),await readFile(new URL('../'+file,import.meta.url)));
    const pkg=JSON.parse(await readFile(new URL('package.json',url),'utf8'));
    await writeFile(new URL('package.json',url),JSON.stringify({...pkg,version:'0.1.1'}));
    await assert.rejects(checkVersion(url),/release_version_mismatch/);
    await writeFile(new URL('package.json',url),JSON.stringify({...pkg,private:false}));
    await assert.rejects(checkVersion(url),/npm_publishing_not_authorized/);
    await writeFile(new URL('package.json',url),JSON.stringify(pkg));
    await writeFile(new URL('CHANGELOG.md',url),'# No version yet');
    await assert.rejects(checkVersion(url),/release_notes_missing/);
    await writeFile(new URL('VERSION',url),'01.0.0');
    await assert.rejects(checkVersion(url),/invalid_release_version/);
  }finally{await rm(root,{recursive:true,force:true});}
});
