import test from 'node:test';
import assert from 'node:assert/strict';
import { createPoolFromEnvironment } from '../src/storage/connection.mjs';
import { migrate } from '../src/storage/migrations.mjs';
import { createMysqlStore } from '../src/storage/store.mjs';
const refs = Object.fromEntries(['host','port','user','password','database'].map(key => [`${key}Env`,`BRIDGE_TEST_${key.toUpperCase()}`]));
test('real MySQL resource seals protect native and guidance references while output retires independently', {
  skip: !process.env.BRIDGE_TEST_PASSWORD, timeout: 30000,
}, async () => {
  const pool = createPoolFromEnvironment(refs); await migrate(pool);
  const store = await createMysqlStore({ pool });
  const scope = { connectionId: 'resources', conversationId: 'chat', agentId: 'codex' };
  let counter = 0;
  async function job() {
    const added = await store.enqueueJob({ ...scope, kind: 'agent', idempotencyKey: String(++counter), payload: {} });
    const [row] = await store.claimJobs({ kind: 'agent', owner: 'worker', leaseMs: 300000 });
    assert.equal(row.id,added.id); return row;
  }
  try {
    const parent = await job();
    const attempt = await store.beginAgentAttempt({ ...parent, agentId: 'codex' });
    await store.bindAgentAttempt({ ...parent, expectedGeneration: attempt.generation, nativeThreadId: 'thread', nativeTurnId: 'turn' });
    const guidance = await job(); await store.beginSteerAttempt({ ...guidance, agentId: 'codex' });
    await store.finishSteerAttempt({ ...guidance, outcome: 'accepted' });
    await store.finishJobWithOutbox(parent);
    const page = await store.listRetirableResources({ connectionId: scope.connectionId });
    assert.equal(page.items.length,2);
    for (const row of page.items) {
      assert.equal(row.nativeThreadId,'thread'); assert.equal(row.inputRetirable,false); assert.equal(row.outputRetirable,true);
      await assert.rejects(store.sealResourceRetirement({ runId: row.runId, kind: 'input' }), { code: 'retirement_conflict' });
      assert.equal((await store.sealResourceRetirement({ runId: row.runId, kind: 'output' })).state,'sealed');
      await store.completeResourceRetirement({ runId: row.runId, kind: 'output' });
    }
    await assert.rejects(store.recordOutbox({ ...scope, jobId: parent.id, kind:'create',idempotencyKey:'late',payload:{} }), { code:'resource_retired' });
    await store.rotateIdleSession({ ...scope, expectedGeneration: attempt.generation, expectedThreadId: 'thread', reason:'session_idle',idempotencyKey:'retire' });
    assert.equal((await store.sealResourceRetirement({ runId: guidance.id, kind:'input' })).state,'sealed');
    const unknown = await job(); const unknownAttempt = await store.beginAgentAttempt({ ...unknown, agentId:'codex' });
    await assert.rejects(store.bindAgentAttempt({ ...unknown,expectedGeneration:unknownAttempt.generation,nativeThreadId:'thread' }), { code:'resource_retired' });
    await store.holdAgentAttempt({ ...unknown,errorCode:'synthetic_unknown' });
    await assert.rejects(store.enqueueRecovery({ runId:unknown.id,callerId:'admin',idempotencyKey:'adopt',expectedGeneration:unknownAttempt.generation,
      action:'adopt_turn',evidence:'verified externally',nativeThreadId:'thread',nativeTurnId:'turn' }), { code:'resource_retired' });
    // Completion response loss is replayable after filesystem removal; sealing survives.
    const originalGet = pool.getConnection.bind(pool); let inject = true;
    pool.getConnection = async () => {
      const connection = await originalGet();
      if (inject) { inject = false; const commit = connection.commit.bind(connection); connection.commit = async () => {
        connection.commit = commit; await commit(); throw new Error('synthetic commit loss');
      }; } return connection;
    };
    await assert.rejects(store.completeResourceRetirement({runId:guidance.id,kind:'input'}),{code:'commit_unknown'});
    pool.getConnection = originalGet;
    assert.deepEqual(await store.completeResourceRetirement({runId:guidance.id,kind:'input'}),{state:'complete'});
    assert.equal((await store.sealResourceRetirement({runId:guidance.id,kind:'input'})).state,'complete');
    const list = await store.listRetirableResources({connectionId:scope.connectionId,limit:1});
    assert.equal(list.items.length,1); assert.ok(list.nextCursor);
    assert.equal(list.items[0].runId,parent.id);
    assert.equal((await store.listRetirableResources({connectionId:scope.connectionId,afterRunId:list.nextCursor,limit:1})).items.length,0);
    // Seal versus a concurrent administrative adoption cannot delete a future reference.
    scope.conversationId = 'race';
    const old = await job(); const oldAttempt = await store.beginAgentAttempt({...old,agentId:'codex'});
    await store.bindAgentAttempt({...old,expectedGeneration:oldAttempt.generation,nativeThreadId:'race-thread',nativeTurnId:'race-turn'});
    await store.finishJobWithOutbox(old);
    await store.rotateIdleSession({...scope,expectedGeneration:oldAttempt.generation,expectedThreadId:'race-thread',reason:'session_idle',idempotencyKey:'race-retire'});
    const uncertain = await job(); const uncertainAttempt = await store.beginAgentAttempt({...uncertain,agentId:'codex'});
    await store.holdAgentAttempt({...uncertain,errorCode:'synthetic_unknown'});
    const recovery = {runId:uncertain.id,callerId:'admin',idempotencyKey:'race-adopt',expectedGeneration:uncertainAttempt.generation,
      action:'adopt_turn',evidence:'external verification',nativeThreadId:'race-thread',nativeTurnId:'race-turn'};
    const race = await Promise.allSettled([
      store.sealResourceRetirement({runId:old.id,kind:'input'}), store.enqueueRecovery(recovery),
    ]);
    assert.equal(race.filter(value=>value.status==='fulfilled').length,1);
    const failure = race.find(value=>value.status==='rejected');
    assert.ok(['resource_retired','retirement_conflict'].includes(failure.reason.code));
    if (race[1].status === 'fulfilled') {
      const [lease] = await store.claimRecoveries({owner:'admin-worker',leaseMs:300000});
      await store.finishRecovery({...lease,outcome:'applied',verifiedNative:{threadId:'race-thread',turnId:'race-turn'}});
      await assert.rejects(store.sealResourceRetirement({runId:old.id,kind:'input'}),{code:'retirement_conflict'});
      const [resumed] = await store.claimJobs({kind:'agent',owner:'worker',leaseMs:300000});
      await store.finishJobWithOutbox(resumed);
    }
    await assert.rejects(store.sealResourceRetirement({runId:unknown.id,kind:'output'}),{code:'retirement_conflict'});
    scope.conversationId = 'bind-race';
    const bindingJob = await job(); const bindingAttempt = await store.beginAgentAttempt({...bindingJob,agentId:'codex'});
    await store.bindAgentAttempt({...bindingJob,expectedGeneration:bindingAttempt.generation,nativeThreadId:'binding-thread',nativeTurnId:'binding-turn'});
    await store.finishJobWithOutbox(bindingJob);
    const rotation = await store.rotateIdleSession({...scope,expectedGeneration:bindingAttempt.generation,expectedThreadId:'binding-thread',reason:'session_idle',idempotencyKey:'binding-retire'});
    const bindingRace = await Promise.allSettled([
      store.sealResourceRetirement({runId:bindingJob.id,kind:'input'}),
      store.setSession({...scope,expectedGeneration:rotation.generation,nativeThreadId:'binding-thread'}),
    ]);
    assert.equal(bindingRace.filter(value=>value.status==='fulfilled').length,1);
    assert.ok(['resource_retired','retirement_conflict'].includes(bindingRace.find(value=>value.status==='rejected').reason.code));
  } finally { await store.close(); }
});
