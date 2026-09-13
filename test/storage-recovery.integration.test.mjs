import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
const refs = Object.fromEntries(['host','port','user','password','database'].map(key => [`${key}Env`,`BRIDGE_TEST_${key.toUpperCase()}`]));
test('real MySQL administrative recovery is fenced, idempotent and preserves permanent thread ownership', {
  skip: !process.env.BRIDGE_TEST_PASSWORD, timeout: 30000,
}, async () => {
  let pool = createPoolFromEnvironment(refs);
  await migrate(pool);
  let clock = Date.now();
  let store = await createMysqlStore({ pool, now: () => clock });
  const scope = conversationId => ({ connectionId:'recovery', conversationId, agentId:'codex' });
  const claim = () => store.claimJobs({ kind:'agent', owner:'worker', leaseMs:1000 });
  async function attempt(conversationId, unknown = true) {
    const job = await store.enqueueJob({ ...scope(conversationId), kind:'agent', idempotencyKey:conversationId, payload:{} });
    const [lease] = await claim(); assert.equal(lease.id, job.id);
    const admitted = await store.beginAgentAttempt({ ...lease, agentId:'codex' });
    if (unknown) await store.holdAgentAttempt({ ...lease, errorCode:'rpc_unknown' });
    return { ...lease, generation:admitted.generation };
  }
  const request = (run, action='adopt_turn', extra={}) => ({
    runId:run.id, callerId:'trusted-admin', idempotencyKey:run.id, expectedGeneration:run.generation,
    action, evidence:'synthetic verified reference', ...(action === 'adopt_turn' ? { nativeThreadId:`thread-${run.id}`,nativeTurnId:`turn-${run.id}` } : {}), ...extra,
  });
  const claimRecovery = async () => (await store.claimRecoveries({ owner:'admin-worker', leaseMs:1000, limit:1 }))[0];
  const apply = row => store.finishRecovery({ id:row.id,leaseToken:row.leaseToken,outcome:'applied',
    ...(row.action === 'adopt_turn' ? { verifiedNative:{threadId:row.nativeThreadId,turnId:row.nativeTurnId} } : {}) });
  try {
    assert.equal(await store.getAgentAttempt({id:'missing'}),null);
    const run = await attempt('one');
    const info = await store.getAgentAttempt({id:run.id}); assert.equal(info.runId,run.id); assert.equal(info.status,'unknown');
    const input = request(run);
    const registrations = await Promise.all([store.enqueueRecovery(input),store.enqueueRecovery(input)]);
    assert.equal(registrations[0].id,registrations[1].id); assert.equal(registrations.filter(item=>item.duplicate).length,1);
    await assert.rejects(store.enqueueRecovery({...input,evidence:'different'}),{code:'recovery_conflict'});
    await store.close();
    pool = createPoolFromEnvironment(refs);
    store = await createMysqlStore({pool,now:()=>clock});
    let recovery = await claimRecovery(); assert.equal(recovery.evidence,input.evidence);
    assert.equal(Object.hasOwn(await store.getRecovery({id:recovery.id}),'evidence'),false);
    await assert.rejects(store.finishRecovery({id:recovery.id,leaseToken:recovery.leaseToken,outcome:'applied',verifiedNative:{threadId:'wrong',turnId:input.nativeTurnId}}),{code:'recovery_conflict'});
    clock += 1001;
    const reclaimed = await claimRecovery(); await assert.rejects(apply(recovery),{code:'stale_lease'}); recovery = reclaimed;
    // COMMIT is durable but its response disappears; replay discovers the same result.
    const originalGet = pool.getConnection.bind(pool);
    let loseCommit = true;
    pool.getConnection = async () => {
      const connection = await originalGet();
      if (loseCommit) {
        loseCommit = false;
        const commit = connection.commit.bind(connection);
        connection.commit = async () => { connection.commit = commit; await commit(); throw new Error('synthetic lost commit response'); };
      }
      return connection;
    };
    await assert.rejects(apply(recovery),{code:'commit_unknown'});
    pool.getConnection = originalGet;
    assert.deepEqual(await apply(recovery),{status:'applied'});
    assert.equal((await store.enqueueRecovery(input)).duplicate,true);
    const [resumed] = await claim(); assert.equal(resumed.id,run.id);
    const resumedAttempt = await store.beginAgentAttempt({...resumed,agentId:'codex'});
    assert.equal(resumedAttempt.recoveryRequired,true); assert.equal(resumedAttempt.nativeTurnId,input.nativeTurnId);
    await store.finishJobWithOutbox({...resumed});
    await store.resetSession({...scope('one'),expectedGeneration:run.generation});
    await assert.rejects(store.setSession({...scope('other'),expectedGeneration:0,nativeThreadId:input.nativeThreadId}),{code:'thread_scope_conflict'});
    const cross = await attempt('cross');
    await store.enqueueRecovery(request(cross,'adopt_turn',{nativeThreadId:input.nativeThreadId}));
    const crossRecovery = await claimRecovery(); await assert.rejects(apply(crossRecovery),{code:'thread_scope_conflict'});
    await store.finishRecovery({...crossRecovery,outcome:'rejected',errorCode:'thread_scope_conflict'});
    assert.equal((await store.getJob({id:cross.id})).status,'unknown');
    await store.enqueueRecovery(request(cross,'abandon_verified',{idempotencyKey:'abandon-a'}));
    await store.enqueueRecovery(request(cross,'abandon_verified',{idempotencyKey:'abandon-b'}));
    const actions = await store.claimRecoveries({owner:'admin-worker',leaseMs:1000}); assert.equal(actions.length,2);
    const outcomes = await Promise.allSettled(actions.map(apply));
    assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);
    assert.equal(outcomes.find(item=>item.status==='rejected').reason.code,'recovery_conflict');
    const loser = actions[outcomes.findIndex(item=>item.status==='rejected')];
    await store.finishRecovery({...loser,outcome:'rejected',errorCode:'recovery_conflict'});
    assert.equal((await store.getJob({id:cross.id})).status,'cancelled');
    assert.equal(Number((await store.getSession(scope('cross'))).generation),Number(cross.generation)+1); assert.deepEqual(await claim(),[]);
    const adoption = await attempt('adoption'); const binding = await attempt('binding',false);
    await store.enqueueRecovery(request(adoption,'adopt_turn',{nativeThreadId:'racing-thread',nativeTurnId:'racing-turn'}));
    const administrative = await claimRecovery();
    const race = await Promise.allSettled([apply(administrative),store.bindAgentAttempt({...binding,expectedGeneration:binding.generation,nativeThreadId:'racing-thread',nativeTurnId:'racing-turn'})]);
    assert.equal(race.filter(item=>item.status==='fulfilled').length,1); assert.equal(race.find(item=>item.status==='rejected').reason.code,'thread_scope_conflict');
    await assert.rejects(store.enqueueRecovery(request(binding,'abandon_verified')),{code:'recovery_conflict'});
    await assert.rejects(async()=>store.enqueueRecovery({...request(adoption),evidence:'x'.repeat(4097)}),{code:'invalid_recovery'});
    const [[owners]] = await pool.query("SELECT COUNT(*) AS n FROM bridge_thread_owners WHERE connection_id='recovery' AND native_thread_id='racing-thread'"); assert.equal(Number(owners.n),1);
  } finally { await store.close(); }
});
