import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateConfig } from '../src/config.mjs';
import { startService } from '../src/service.mjs';

const proxyNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
const base = {
  schemaVersion: 1,
  storage: Object.fromEntries(['host', 'port', 'user', 'password', 'database'].map(key => [`${key}Env`, `TEST_${key.toUpperCase()}`])),
  codex: { bin: '/synthetic/codex', cwd: '/synthetic/workspace', envNames: ['PATH', 'HOME'] },
  feishu: { connectionId: 'proxy-test', appIdEnv: 'TEST_APP', appSecretEnv: 'TEST_SECRET', botOpenId: 'bot', catchup: false },
  routing: { version: '1', privateUserIds: [], groups: [] },
  hooks: [],
};
test('only Codex environment selection allows lowercase names; secret references stay strict', () => {
  assert.deepEqual(validateConfig({ ...base, codex: { ...base.codex, envNames: proxyNames } }).codex.envNames, proxyNames);
  for (const name of ['HTTPS-PROXY', 'https_proxy=value', '1proxy', 'proxy name']) {
    assert.throws(() => validateConfig({ ...base, codex: { ...base.codex, envNames: [name] } }), { code: 'invalid_environment_reference' });
  }
  for (const proxyEnv of [{ FTP_PROXY: 'BRIDGE_PROXY' }, { HTTPS_PROXY: 'http://proxy.invalid' }, { HTTPS_PROXY: 42 }, { HTTPS_PROXY: 'lowercase_reference' }]) {
    assert.throws(() => validateConfig({ ...base, codex: { ...base.codex, proxyEnv } }));
  }
  for (const config of [
    { ...base, storage: { ...base.storage, passwordEnv: 'db_password' } },
    { ...base, feishu: { ...base.feishu, appSecretEnv: 'app_secret' } },
  ]) assert.throws(() => validateConfig(config), { code: 'invalid_environment_reference' });
});

for (const { selected, mapped = false } of [{ selected: proxyNames }, { selected: [] }, { selected: ['https_proxy', 'no_proxy'] }, { selected: proxyNames, mapped: true }]) {
  test(`actual app-server fixture receives only selected proxy variables (${selected.length}, mapped=${mapped})`, { timeout: 5000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'bridge-proxy-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fixture = join(directory, 'fixture.mjs');
    const observedNames = [...proxyNames, 'UNSELECTED_SECRET', 'TEST_APP', 'TEST_SECRET', 'TEST_TOKEN', 'BRIDGE_CODEX_PROXY', 'BRIDGE_CODEX_NO_PROXY'];
    await writeFile(fixture, `import readline from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 else if(m.method==='initialized') send({method:'fixture/environment',params:Object.fromEntries(${JSON.stringify(observedNames)}.map(name=>[name,process.env[name]??null]))});
 else throw new Error('unexpected model request');
});`);
    const injected = {
      PATH: '/synthetic/path', HOME: directory, BRIDGE_CODEX_PROXY: 'http://127.0.0.1:29999', BRIDGE_CODEX_NO_PROXY: 'localhost,127.0.0.1,::1', UNSELECTED_SECRET: 'SYNTHETIC_NOT_FOR_CHILD',
      TEST_APP: 'synthetic-app', TEST_SECRET: 'synthetic-app-secret', TEST_TOKEN: 'synthetic-token-at-least-24-characters',
      ...Object.fromEntries(proxyNames.map(name => [name, name.toLowerCase() === 'no_proxy' ? 'localhost,127.0.0.1,::1' : 'http://127.0.0.1:19999'])),
    };
    if (mapped) delete injected.HTTP_PROXY; // An overridden name needs only its explicit source.
    const proxyEnv = mapped ? Object.fromEntries(proxyNames.map(name => [name, name.toLowerCase() === 'no_proxy' ? 'BRIDGE_CODEX_NO_PROXY' : 'BRIDGE_CODEX_PROXY'])) : undefined;
    const snapshot = { ...injected };
    const parentProxy = Object.fromEntries(proxyNames.map(name => [name, process.env[name]]));
    let resolveObserved, resolveSocket;
    const observed = new Promise(resolve => { resolveObserved = resolve; });
    const socket = new Promise(resolve => { resolveSocket = resolve; });
    const controller = new AbortController();
    const config = validateConfig({ ...base, codex: { bin: process.execPath, cwd: directory, envNames: ['PATH', 'HOME', ...selected], ...(proxyEnv ? { proxyEnv } : {}) } });
    const service = startService({ config, configPath: join(directory, 'config.json'), env: injected, signal: controller.signal, dependencies: {
      pool: () => ({}),
      store: async () => ({ close: async () => {} }),
      executor: ({childEnv}) => { resolveObserved(Object.fromEntries(observedNames.map(name=>[name,childEnv[name]??null]))); return {status:()=>({closing:false,restartPending:null}),close:async()=>{}}; },
      sdk: { Client: class { constructor(options) { assert.equal(options.appId, injected.TEST_APP); assert(!('proxy' in options)); } }, WSClient: class {}, defaultHttpInstance: {} },
      chat: () => ({}), media: async () => ({}), outbound: async () => ({}),
      feishu: () => ({ start: () => { resolveSocket(); return new Promise(() => {}); }, stop() {} }),
    } });
    const closed = assert.rejects(service, { code: 'startup_cancelled' });
    t.after(() => { controller.abort(); });
    try {
      const [actual] = await Promise.all([observed, socket]);
      for (const name of observedNames) assert.equal(actual[name], proxyEnv?.[name] ? injected[proxyEnv[name]] : selected.includes(name) ? injected[name] : null, name);
      assert.deepEqual(injected, snapshot);
      assert.deepEqual(Object.fromEntries(proxyNames.map(name => [name, process.env[name]])), parentProxy);
    } finally { controller.abort(); await closed; }
  });
}

test('missing or non-string proxy sources fail before any component starts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-proxy-missing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const value of [undefined, '', 42]) {
    const config = validateConfig({ ...base, codex: { bin: process.execPath, cwd: directory, envNames: [], proxyEnv: { HTTPS_PROXY: 'BRIDGE_CODEX_PROXY' } } });
    let created = false;
    await assert.rejects(startService({ config, configPath: join(tmpdir(), 'config.json'), env: { BRIDGE_CODEX_PROXY: value }, dependencies: { pool: () => { created = true; } } }), { code: 'required_environment_missing' });
    assert.equal(created, false);
  }
});
