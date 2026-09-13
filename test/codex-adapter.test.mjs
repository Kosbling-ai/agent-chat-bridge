import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAdapter } from '../src/agents/codex/adapter.mjs';

// Real OS child, synthetic newline-delimited protocol; never launches Codex.
const fixtureSource = `
import readline from 'node:readline';
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const mode=process.env.MODE;let initialized=false;let floodRequestId;
if(mode==='ignore-term')process.on('SIGTERM',()=>{});
process.stderr.write('SYNTHETIC_SECRET_STDERR');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize'){
  if(mode==='init-silent')return;
  const text=JSON.stringify({id:m.id,result:{userAgent:'fixture'}})+'\\n';
  process.stdout.write(text.slice(0,8));setTimeout(()=>process.stdout.write(text.slice(8)),5);return;
 }
 if(m.method==='initialized'){initialized=true;return;}
 if(m.error){send({method:'fixture/request-reply',params:m});return;}
 if(!initialized){send({id:m.id,error:{code:-1,message:'missing initialized'}});return;}
 if(mode==='silent')return;
 if(mode==='exit'){process.exit(9);return;}
 if(mode==='malformed'){process.stdout.write('not JSON SYNTHETIC_SECRET\\n');return;}
 if(mode==='oversized'){process.stdout.write('x'.repeat(4096));return;}
 if(mode==='reject'){send({id:m.id,error:{code:-32001,message:'SYNTHETIC_SECRET_REJECT'}});return;}
 if(mode==='archived'){send({id:m.id,error:{code:-32001,message:'SYNTHETIC_SECRET session '+m.params.threadId+' is archived'}});return;}
 if(mode==='request'){
   send({id:'provider-1',method:'item/commandExecution/requestApproval',params:{threadId:'t1',turnId:'r1',command:'SYNTHETIC_SECRET_REQUEST'}});
   send({id:m.id,result:{turn:{id:'r1',status:'inProgress'}}});return;
 }
 if(mode==='flood'){
   if(m.method==='fixture/release-flood'){
     for(let i=0;i<8;i++)send({method:'item/agentMessage/delta',params:{delta:'x'}});
     send({id:floodRequestId,result:{}});
   }else{floodRequestId=m.id;send({method:'item/agentMessage/delta',params:{delta:'first'}});}
   return;
 }
 if(m.method==='thread/read'){
   setTimeout(()=>send({id:m.id,result:{thread:{id:m.params.threadId}}}),m.params.threadId==='slow'?40:1);return;
 }
 if(m.method==='turn/start'){
   process.stdout.write(JSON.stringify({id:m.id,result:{turn:{id:'r1',status:'inProgress'}}})+'\\n'+JSON.stringify({method:'turn/completed',params:{threadId:'t1',turn:{id:'r1',status:'completed'}}})+'\\n');return;
 }
 send({id:m.id,result:{params:m.params,thread:{id:'t1'},turnId:m.params.expectedTurnId}});
});
`;

async function setup(t, mode = 'normal', overrides = {}, callbacks = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-codex-'));
  const fixture = join(directory, 'mock.mjs');
  await writeFile(fixture, fixtureSource);
  const notices = [], faults = [], logs = [], children = [];
  const adapter = createCodexAdapter({ bin: 'fixture-codex', cwd: directory, env: { MODE: mode }, rpcTimeoutMs: 500, shutdownGraceMs: 100, ...overrides }, {
    spawnProcess(bin, args, options) {
      assert.equal(bin, 'fixture-codex');
      assert.deepEqual(args, ['app-server', '--listen', 'stdio://']);
      assert.equal(options.shell, false);
      assert.deepEqual(options.env, { MODE: mode });
      const child = spawn(process.execPath, [fixture], options); children.push(child); return child;
    },
    onNotification: callbacks.onNotification || (async message => { notices.push(message); }),
    onFault: callbacks.onFault || (async value => { faults.push(value); }),
    log: callbacks.log || ((...args) => logs.push(args)),
  });
  t.after(async () => {
    await adapter.close().catch(() => {});
    for (const child of children) assert(child.exitCode !== null || child.signalCode !== null, 'child must exit');
    await rm(directory, { recursive: true, force: true });
  });
  return { adapter, notices, faults, logs, directory, children };
}
const input = [{ type: 'text', text: 'synthetic request' }];
const options = { timeout: 5000 };

test('async logger rejection never escapes lifecycle cleanup', options, async t => {
  const { adapter } = await setup(t, 'normal', {}, { log: async () => { throw new Error('SYNTHETIC_SECRET_LOG'); } });
  await adapter.start(); await adapter.close();
  await new Promise(resolve => setImmediate(resolve));
});

test('handshake, split frames, correlated out-of-order RPC and fixed workspace', options, async t => {
  const { adapter, directory } = await setup(t);
  await assert.rejects(adapter.readThread({ threadId: 'before-start' }), { code: 'codex_not_ready' });
  await Promise.all([adapter.start(), adapter.start()]);
  const thread = await adapter.startThread();
  assert.equal(thread.params.cwd, directory);
  const [slow, fast] = await Promise.all([adapter.readThread({ threadId: 'slow' }), adapter.readThread({ threadId: 'fast' })]);
  assert.equal(slow.thread.id, 'slow'); assert.equal(fast.thread.id, 'fast');
  assert.throws(() => adapter.startThread({ cwd: '/arbitrary' }), { code: 'invalid_codex_params' });
  assert.throws(() => adapter.resumeThread({ threadId: 't1', approvalPolicy: 'never' }), { code: 'invalid_codex_params' });
  assert.throws(() => adapter.steerTurn({ threadId: 't1', input }), { code: 'invalid_codex_params' });
  assert.throws(() => adapter.startTurn({ threadId: 't1' }), { code: 'invalid_codex_input' });
  assert.equal((await adapter.steerTurn({ threadId: 't1', expectedTurnId: 'r1', input })).turnId, 'r1');
  await adapter.interruptTurn({ threadId: 't1', turnId: 'r1' });
  await adapter.resumeThread({ threadId: 't1' });
  assert.equal(adapter.status().state, 'ready');
  await Promise.all([adapter.close(), adapter.close()]);
  await assert.rejects(adapter.start(), { code: 'codex_lifecycle_closed' });
});

test('admission precedes immediate completion notification and notifications are ordered', options, async t => {
  const order = [];
  const { adapter } = await setup(t, 'normal', {}, { onNotification: async m => { order.push(m.method); } });
  await adapter.start();
  const result = await adapter.startTurn({ threadId: 't1', input }).then(r => { order.push('admitted'); return r; });
  assert.equal(result.turn.status, 'inProgress');
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(order, ['admitted', 'turn/completed']);
});

test('server requests get matching-id explicit errors; no approval or payload logging', options, async t => {
  const { adapter, notices, logs } = await setup(t, 'request');
  await adapter.start(); await adapter.startTurn({ threadId: 't1', input });
  await new Promise(r => setTimeout(r, 20));
  const rejection = notices.find(m => m.method === 'bridge/serverRequestRejected');
  assert.equal(rejection.params.requestId, 'provider-1');
  assert.equal(rejection.params.turnId, 'r1');
  const reply = notices.find(m => m.method === 'fixture/request-reply').params;
  assert.equal(reply.id, 'provider-1'); assert.equal(reply.error.code, -32601);
  assert(!Object.hasOwn(reply, 'result')); assert(!JSON.stringify(logs).includes('SYNTHETIC_SECRET'));
});

test('RPC rejection is explicit and redacted without destroying healthy connection', options, async t => {
  const { adapter, faults, logs } = await setup(t, 'reject');
  await adapter.start();
  await assert.rejects(adapter.startThread(), e => e.code === 'codex_rpc_rejected' && e.outcome === 'rejected' && e.rpcCode === -32001 && !e.message.includes('SECRET'));
  assert.equal(adapter.status().state, 'ready'); assert.equal(faults.length, 0); assert(!JSON.stringify(logs).includes('SECRET'));
});

test('RPC safe archived reason survives redaction only for the requested thread', options, async t => {
  const { adapter, logs } = await setup(t, 'archived');
  await adapter.start();
  await assert.rejects(adapter.resumeThread({ threadId: 'thread-1' }), error => {
    assert.deepEqual(error.reason, { kind: 'thread_archived', threadId: 'thread-1' });
    assert(!JSON.stringify(error).includes('SYNTHETIC_SECRET'));
    return error.outcome === 'rejected';
  });
  assert(!JSON.stringify(logs).includes('SYNTHETIC_SECRET'));
});

for (const [mode, expected] of [['silent', 'codex_rpc_timeout'], ['exit', 'codex_process_exited'], ['malformed', 'codex_invalid_frame'], ['oversized', 'codex_frame_too_large']]) {
  test(`failure ${mode} rejects all waiters with unknown outcome and cleans child`, options, async t => {
    const { adapter, faults, logs } = await setup(t, mode, { maxFrameBytes: 2048 });
    await adapter.start();
    const results = await Promise.allSettled([adapter.startThread(), adapter.resumeThread({ threadId: 't1' })]);
    for (const result of results) { assert.equal(result.status, 'rejected'); assert.equal(result.reason.outcome, 'unknown'); assert.equal(result.reason.code, expected); }
    await adapter.close(); assert.equal(faults.length, 1); assert(!JSON.stringify(logs).includes('SECRET'));
  });
}

test('initialization timeout and spawn error are bounded and redacted', options, async t => {
  const { adapter } = await setup(t, 'init-silent', { rpcTimeoutMs: 80 });
  await assert.rejects(adapter.start(), { code: 'codex_rpc_timeout' });
  await adapter.close();
  const broken = createCodexAdapter({ bin: '/nonexistent-codex-synthetic', cwd: tmpdir(), env: {}, rpcTimeoutMs: 100, shutdownGraceMs: 50 }, { onNotification: async()=>{}, onFault: async()=>{} });
  await assert.rejects(broken.start(), { code: 'codex_spawn_failed' }); await broken.close();
});

test('slow notification sink is bounded; rejected fault sink never becomes unhandled rejection', options, async t => {
  let entered, rejectSink;
  const sinkStarted = new Promise(resolve => { entered = resolve; });
  const { adapter, logs, children } = await setup(t, 'flood', { maxQueuedNotifications: 2 }, {
    onNotification: () => { entered(); return new Promise((_, reject) => { rejectSink = reject; }); },
    onFault: async()=>{ throw new Error('SYNTHETIC_SECRET_FAULT'); },
  });
  await adapter.start();
  const admission = assert.rejects(adapter.startThread(), { code: 'codex_notification_capacity' });
  // A protocol handshake, not a sleep, guarantees that this case has one
  // genuinely in-flight callback before the queue is flooded.
  await sinkStarted;
  children[0].stdin.write(JSON.stringify({ method: 'fixture/release-flood' }) + '\n');
  await admission;
  rejectSink(new Error('SYNTHETIC_SECRET_PERSISTENCE'));
  await assert.rejects(adapter.close(), { code: 'codex_notification_delivery_failed', outcome: 'unknown' });
  assert(!JSON.stringify(logs).includes('SYNTHETIC_SECRET'));
});

test('overflow before a sink enters reports lost notifications without inventing a callback failure', options, async t => {
  const { adapter, notices, faults, children } = await setup(t, 'silent', { maxQueuedNotifications: 2 });
  await adapter.start();
  const admission = assert.rejects(adapter.startThread(), { code: 'codex_notification_capacity' });
  // Inject one synchronous transport data event: promise callbacks cannot run
  // between these frames, irrespective of OS pipe chunking or scheduling.
  const frames = Array.from({ length: 4 }, () => JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'fixture' } })).join('\n') + '\n';
  children[0].stdout.emit('data', Buffer.from(frames));
  await admission;
  await adapter.close();
  assert.equal(notices.length, 0);
  assert.deepEqual(faults, [{ code: 'codex_notification_capacity', outcome: 'unknown' }]);
});

test('close escalates SIGTERM to SIGKILL and rejects pending work', options, async t => {
  const { adapter, children } = await setup(t, 'ignore-term');
  await adapter.start();
  const started = Date.now(); await adapter.close();
  assert(Date.now() - started < 1000); assert.equal(children[0].signalCode, 'SIGKILL');
  assert.equal(adapter.status().pendingRequests, 0);
});

test('a single stalled notification fails observably instead of blocking later work forever', options, async t => {
  let resolveFault;
  const failure = new Promise(resolve => { resolveFault = resolve; });
  const { adapter } = await setup(t, 'normal', { rpcTimeoutMs: 100 }, {
    onNotification: () => new Promise(() => {}), onFault: async value => { resolveFault(value); },
  });
  await adapter.start();
  await adapter.startTurn({ threadId: 't1', input });
  assert.equal((await failure).code, 'codex_notification_delivery_failed');
  await assert.rejects(adapter.close(), { code: 'codex_notification_delivery_failed', outcome: 'unknown' });
});

test('shutdown rejects and reports unknown when an in-flight durable callback fails', options, async t => {
  let entered, rejectSink;
  const started = new Promise(resolve => { entered = resolve; });
  const { adapter, faults, logs } = await setup(t, 'normal', {}, {
    onNotification: () => { entered(); return new Promise((_, reject) => { rejectSink = reject; }); },
  });
  await adapter.start();
  await adapter.startTurn({ threadId: 't1', input });
  await started;
  const closed = adapter.close();
  const rejected = assert.rejects(closed, { code: 'codex_notification_delivery_failed', outcome: 'unknown' });
  rejectSink(new Error('SYNTHETIC_SECRET_PERSISTENCE'));
  await rejected;
  assert.equal(faults.length, 1);
  assert.equal(faults[0].outcome, 'unknown');
  assert(logs.some(row => JSON.stringify(row).includes('codex_notification_delivery_failed')));
  assert(!JSON.stringify(logs).includes('SYNTHETIC_SECRET_PERSISTENCE'));
});

test('pending capacity and local frame rejection never create additional provider work', options, async t => {
  const { adapter } = await setup(t, 'silent', { maxPendingRequests: 1, maxFrameBytes: 2048 });
  await adapter.start();
  await assert.rejects(adapter.startTurn({ threadId: 't1', input: [{ type: 'text', text: 'x'.repeat(4096) }] }), { code: 'codex_frame_too_large', outcome: 'not_started' });
  const first = adapter.startThread();
  const observed = assert.rejects(first, { code: 'codex_closed', outcome: 'unknown' });
  await assert.rejects(adapter.startThread(), { code: 'codex_request_capacity', outcome: 'not_started' });
  await adapter.close(); await observed;
});
