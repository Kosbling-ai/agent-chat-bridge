import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('isolated database harness rejects multiple or missing suites before invoking Docker',()=>{
  for(const args of [
    ['test/storage.integration.test.mjs','test/storage-recovery.integration.test.mjs'],
    ['test/no-such-suite.test.mjs'],
    ['../outside.test.mjs'],
  ]){
    const result=spawnSync(process.execPath,['scripts/test-storage.mjs',...args],{
      cwd:fileURLToPath(new URL('..',import.meta.url)),
      env:{PATH:'/nonexistent'},encoding:'utf8',timeout:3000,
    });
    assert.equal(result.status,2);
    assert.equal(result.stdout,'');
    assert.equal(result.stderr,'Pass at most one existing test/*.test.mjs path per isolated database.\n');
  }
});
