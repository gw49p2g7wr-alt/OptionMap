"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const Native=require("../scripts/marketCalendarG17CanaryNative.js"),E=require("../js/marketCalendarHistory/mofStartupCanaryEnvelope.js");
test("C2 real hidden-renderer startup new1: one tx/token, fresh readback, completed14→19",async()=>{
  const r=await Native.nativeCase(),v=r.executed.result;assert.equal(v.status,"PASS");assert.deepEqual(v.receipt.counts,E.COUNTS);
  assert.deepEqual(v.receipt.transactions,{readwrite:1,commit:1,abort:0});assert.deepEqual(v.receipt.localToken,{minted:1,writerCalls:1,success:true});
  assert.equal(v.audit.mainExecutionTokens,0);assert.equal(v.mainTokenAttempts,0);assert.equal(v.audit.store.authorizations,1);
  assert.equal(v.audit.handlers,0);assert.equal(v.audit.grants,0);assert.equal(v.audit.windows,0);
  assert.deepEqual(v.phases.map(p=>p.sequence),[15,16,17,18,19]);assert.equal(r.reload.result.loaded.record.safety.pendingFence,null);
  assert.equal(r.reload.result.loaded.record.canaryAuthority.manual,false);assert.equal(r.historyUnchanged,true);
  assert.notEqual(v.freshRenderer.prior.osProcessId,v.freshRenderer.next.osProcessId);
  assert.deepEqual(v.security,{nodeIntegration:false,contextIsolation:true,sandbox:true,mainWorldNode:"undefined",mainWorldBridge:"undefined"});
  assert.equal(v.parity.realChromium,true);assert.equal(v.parity.version,1);assert.equal(v.parity.origin,"file://");
  assert.deepEqual(v.guard,{productionAttempts:0,networkAttempts:0});assert(r.reload.result.formal.snapshot.entries.some(x=>x.eventKey.endsWith("10Y|2026-12-28")));
});
test("C1 real hidden renderer unchanged16: authorization/tx/lifecycle0 and fresh reload unchanged",async()=>{
  const r=await Native.nativeCase(null,0),v=r.executed.result;assert.equal(v.writerAttempts,0);assert.equal(v.skip.reason,"unchanged");
  assert.equal(v.storeAudit.authorizations,0);assert.equal(v.storeAudit.persists,0);assert.equal(r.reload.result.loaded.record.safety.sequence,14);
  assert.equal(r.reload.result.formal.snapshot.entries.filter(x=>x.sourceId===E.SOURCE).length,16);
});
for(const fault of ["after_authorization","before_window","before_load","after_load","after_challenge","started_before_permit",
  "permit_lost","after_permit","after_token","during_tx","commit_ambiguous","commit_before_readback","readback_before_completion",
  "wrong_sender","wrong_frame","wrong_challenge","reload","replay_challenge","replay_consume","second_tx"])
  test(`native crash/loss/replay blocks second attempt: ${fault}`,async()=>{
    const r=await Native.nativeCase(fault),v=r.executed.result,loaded=r.reload.result.loaded;
    assert(r.executed.code===86||v?.status==="FAIL");assert.equal(loaded.owned,true);assert.equal(loaded.retryAllowed,false);
    const committed=["commit_ambiguous","commit_before_readback","readback_before_completion","second_tx"].includes(fault);
    assert.equal(r.reload.result.formal.snapshot.entries.filter(x=>x.sourceId===E.SOURCE).length,committed?17:16);
    assert.deepEqual(r.reload.result.guard,{productionAttempts:0,networkAttempts:0});assert.equal(r.reload.result.mainTokenAttempts,0);
    if(v){assert.equal(v.audit.handlers,0);assert.equal(v.audit.grants,0);assert.equal(v.audit.windows,0);assert.equal(v.audit.store.handles,0);}
  });
const Atomic=require("../js/marketCalendarHistory/writerSafetyAtomicCore.js");
for(const phase of ["activation",...E.PHASES])for(const point of [...Atomic.CRASH_POINTS,"before_publish","after"])
  test(`atomic fresh-process fail closed: ${phase}/${point}`,async()=>{
    const fault=point==="before_publish"?`before_publish_${phase}`:point==="after"?`after_${phase}`:`${phase}:${point}`;
    const r=await Native.atomicCase(fault);assert.equal(r.audit.handles,0);assert.equal(r.receiptFixturesOnly,true);
  });
