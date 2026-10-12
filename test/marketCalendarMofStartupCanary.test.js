"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const A=require("../js/marketCalendarHistory/formalWriterAuthorityV2.js"),E=require("../js/marketCalendarHistory/mofStartupCanaryEnvelope.js");
const P=require("../js/marketCalendarHistory/mofStartupCanaryPlan.js"),Store=require("../js/marketCalendarHistory/mofStartupCanaryStore.js");
const Old=require("../js/marketCalendarHistory/writerSafetySourceSetEnvelope.js"),Permission=require("../js/marketCalendarHistory/writerSafetySourceSetPermission.js");
const Guard=require("../scripts/marketCalendarG14bFilesystemGuard.js"),F=require("./fixtures/marketCalendar/mofStartupCanaryFixture.js");
const Core=require("../js/marketCalendarHistory/formalControlledWriterCore.js");
const context=f=>P.createIsolatedStartupContext({targetEnvironment:"isolated_test",cycleIdentity:A.hash("new-cycle"),checkedAt:f.checkedAt});
const prepare=(f,ctx=context(f))=>P.prepare({...f,context:ctx});
async function temp(action){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"optionmap-g14bg-fixture-g17-"));
  const profile=Guard.createIsolatedPolicy({targetEnvironment:"isolated_test",fixtureRoot:root}).profile;fs.mkdirSync(profile,{recursive:true,mode:0o700});
  try{return await action(root,profile);}finally{fs.rmSync(root,{recursive:true});}}
const store=root=>Store.createIsolatedStore({targetEnvironment:"isolated_test",fixtureRoot:root,crashAt:null});
test("E4 additive authority preserves completed G1.5b and Machinery history exactly",async()=>{
  const f=await F.setup(),oldHash=A.hash(f.historical);assert.equal(f.historical.safety.sequence,13);assert.equal(f.record.safety.sequence,14);
  assert.equal(E.validate(f.record).valid,true);assert.equal(Old.validate(f.historical).valid,true);assert.equal(Old.validate(f.record).valid,false);
  assert.deepEqual(f.record.historicalRecord,f.historical);assert.equal(A.hash(f.historical),oldHash);
  assert.equal(f.record.safety.persistedAuthorityIdentity,f.historical.safety.persistedAuthorityIdentity);
  assert.equal(f.record.safety.sourcePermissionIdentity,f.historical.safety.sourcePermissionIdentity);
  assert.equal(f.record.safety.persistedAuthorityVersion,3);assert.equal(f.record.safety.sourcePermissionVersion,2);
  assert.equal(Permission.PERMISSIONS.entries.find(x=>x.sourceId===E.SOURCE).permission,"not_approved");
  assert.equal(E.AUTHORITY.manual,false);assert.equal(E.AUTHORITY.general,false);assert.equal(E.AUTHORITY.maxNewEvents,1);
  assert.equal(Permission.PERMISSIONS.entries.find(x=>x.sourceId==="jp-boj-calendar").permission,"writer_ineligible");
});
test("C1 unchanged16 returns no preparation, no Evidence/Run/Observation writes",async()=>{
  const f=await F.setup({newEvents:0}),r=await prepare(f);assert.equal(r.status,"skipped");assert.equal(r.reason,"unchanged");
  assert.equal(r.writerAttempts,0);assert.equal(r.comparison.unchanged,16);assert.equal(r.preparation,undefined);
});
test("C2 new1 plans public exact8 only and preserves all existing event material",async()=>{
  const f=await F.setup(),r=await prepare(f),d=P.inspect(r.preparation);assert.equal(r.status,"prepared");assert.equal(r.comparison.new,1);
  assert.equal(r.comparison.unchanged,16);assert.deepEqual(d.plan.counts,E.COUNTS);assert.equal(d.plan.mutations.updateEntries.length,0);
  assert.equal(d.plan.mutations.closeRevisions.length,0);assert.equal(d.plan.mutations.appendObservations.length,1);assert.equal(d.plan.mutations.appendEvidence.length,1);
  for(const [field]of Core.STORE_ORDER)for(const old of d.before[field])if(field!=="cursors"||old.sourceId!==E.SOURCE)
    assert.deepEqual(d.expected[field].find(r=>Core.same(r,old)),old);
});
test("C3 trusted startup is opaque, one-use; copied context/preparation fail closed",async()=>{
  const f=await F.setup(),ctx=context(f);await assert.rejects(prepare(f,{}),/context_unknown/);
  const p=await prepare(f,ctx);await assert.rejects(prepare(f,ctx),/context_unknown_or_spent/);
  assert.throws(()=>P.inspect(JSON.parse(JSON.stringify(p.preparation))),/preparation_unknown/);P.consume(p.preparation);
  assert.throws(()=>P.consume(p.preparation),/preparation_unknown_or_spent/);
});
test("C4 duplicate/ambiguity rejects before a writer can be selected",async()=>{
  const f=await F.setup();f.source.canonicalRecords.push(f.source.canonicalRecords[0]);
  await assert.rejects(prepare(f),/candidate_identity_invalid/);
});
test("C5 blocked source rejects; source outcome cannot be replaced by aggregate success",async()=>{
  const f=await F.setup();f.sourceOutcome.status="unavailable";f.sourceOutcome.acquisitionStatus="not_attempted";
  await assert.rejects(prepare(f),/fresh_normal_acquisition_required/);
});
test("C6 pending fence blocks a new startup; completed lifecycle cannot be replayed",async()=>temp(async root=>{
  const f=await F.setup();store(root).activateHistorical(f.historical,f.gate);const s=store(root),p=await prepare(f);
  const a=s.begin(p.preparation),loaded=s.load();assert.equal(loaded.record.safety.pendingFence.phase,"prepared");
  await assert.rejects(prepare({...f,record:loaded.record}),/safety_unavailable/);
  assert.throws(()=>s.begin(p.preparation),/attempt_already_issued/);assert.throws(()=>s.markWriteStarted({}),/attempt_invalid/);
  s.markWriteStarted(a.token);s.markCommitObserved(a.token,{readwrite:1,commit:1,abort:0});
  const d=loaded.record.lifecycleAudit[0].binding;assert.equal(d.counts.eventEntryCreate,1);
}));
test("C7/C8 wrong source and BOJ cannot use MOF authority",async()=>{
  for(const id of ["jp-boj-calendar","jp-esri-machinery-orders-calendar","us-bls-calendar"]){const f=await F.setup();f.sourceOutcome.sourceId=id;
    await assert.rejects(prepare(f),/source_invalid/);}
});
test("C9 Machinery authority/permission and historical completion proof remain valid",async()=>{
  const f=await F.setup(),H=require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js");
  assert.equal(H.validateEnvelope(f.historical.historicalRecord).valid,true);
  assert.deepEqual(H.policyFor(3).global.permittedSources,["jp-esri-machinery-orders-calendar"]);
  assert.deepEqual(f.record.safety.sources,f.historical.safety.sources);
});
test("shared startup ceiling: Machinery reservation stops MOF; MOF selection forbids a second reservation",async()=>{
  const f=await F.setup(),ctx=context(f),receipt={sourceId:"jp-esri-machinery-orders-calendar",cycleIdentity:A.hash("new-cycle"),attemptIdentity:A.hash("machinery-attempt")};
  P.observeExistingMachineryAttempt(ctx,receipt);await assert.rejects(prepare(f,ctx),/context_unknown_or_spent/);
  const next=context(f);await prepare(f,next);assert.throws(()=>P.observeExistingMachineryAttempt(next,receipt),/cycle_attempt_unavailable/);
  assert.throws(()=>P.observeExistingMachineryAttempt(context(f),{...receipt,sourceId:"jp-boj-calendar"}),/cycle_attempt_unavailable/);
});
test("C10 BLS blocked is not an authority input or a MOF bypass",async()=>{
  const f=await F.setup();f.aggregate={state:"partial",sources:[{sourceId:"us-bls-calendar",status:"unavailable",reasonClass:"automatic_retry_disabled_parser_structure_change"}]};
  const r=await prepare(f);assert.equal(r.status,"prepared");
  const g=await F.setup();g.aggregate=f.aggregate;g.sourceOutcome.status="unavailable";await assert.rejects(prepare(g),/fresh_normal_acquisition_required/);
});
test("same-day normal skip stays writer0, with no forced acquisition",async()=>{
  const f=await F.setup();f.sourceOutcome={sourceId:E.SOURCE,status:"success",acquisitionStatus:"not_attempted",reasonClass:"already_succeeded_today",planningDecision:"skip"};
  assert.equal((await prepare(f)).reason,"already_succeeded_today");
});
for(const [label,change,reason]of [
  ["fresh Runtime State",f=>{f.runtimeState.lastSuccessAt="2026-10-13T00:00:00.000Z";},/fresh_normal/],
  ["failed acquisition",f=>{f.source.acquisitionOutcome="failed";},/acquisition_invalid/],
  ["route mismatch",f=>{f.source.routeIdentity=A.hash("wrong");},/acquisition_invalid/],
  ["MIME/encoding rejection",f=>{f.source.canonicalRecords[0].acquisitionEvidence.httpMetadata.encodingEvidence.resolvedEncoding="windows-1252";},/canonical_evidence/],
  ["fake canonical hash",f=>{f.source.canonicalRecords[0].canonicalContentHash=A.hash("wrong");},/canonical_evidence_invalid/],
  ["old observation",f=>{f.checkedAt="2026-10-15T00:00:00.000Z";f.runtimeState.lastAttemptAt=f.checkedAt;f.runtimeState.lastSuccessAt=f.checkedAt;},/canonical_evidence/],
  ["future observation",f=>{f.checkedAt="2026-10-13T00:00:00.000Z";f.runtimeState.lastAttemptAt=f.checkedAt;f.runtimeState.lastSuccessAt=f.checkedAt;},/canonical_evidence/],
  ["delete/cancel",f=>{f.source.canonicalRecords[0].lifecycleStatus="cancelled";},/canonical_evidence/],
  ["missing authority",f=>{delete f.record.canaryAuthority;},/safety_unavailable/],
  ["global suspend",f=>{f.record.safety.globalSuspend.suspended=true;},/safety_unavailable/],
  ["source suspend",f=>{f.record.safety.sources.find(s=>s.sourceId===E.SOURCE).suspended=true;},/safety_unavailable/]
])test(`fail closed: ${label}`,async()=>{const f=structuredClone(await F.setup());change(f);await assert.rejects(prepare(f),reason);});
test("multiple new events exceed initial canary ceiling",async()=>{await assert.rejects(prepare(await F.setup({newEvents:2})),/new_event_ceiling/);});
test("valid semantic change is not an allowed automatic Revision transition",async()=>{
  const f=await F.setup(),C=require("../js/marketCalendarHistory/historyIntegrity.js"),R=require("../js/marketCalendar/sourceRegistry.js");
  const r=f.source.canonicalRecords[0];r.title.ja+=" (changed)";r.canonicalContentHash=A.hash(C.semanticContent(r));r.revisionKey=`${r.eventKey}|sha256:${r.canonicalContentHash}`;
  const meta=R.getSource(E.SOURCE);f.source.candidateIdentity=A.hash({sourceId:E.SOURCE,parserId:meta.parserId,parserVersion:meta.parserVersion,
    candidateSchemaVersion:1,revisionKeys:f.source.canonicalRecords.map(r=>r.revisionKey).sort()});
  await assert.rejects(prepare(f),/comparison_unsafe/);
});
test("explicit activation only; unknown schema/authority/audit changes are rejected",async()=>{
  const f=await F.setup();for(const change of [r=>{r.schemaVersion=5;},r=>{r.canaryAuthority.manual=true;},r=>{r.safety.persistedAuthorityVersion=4;},
    r=>{r.extra=true;},r=>{r.historicalRecord.controlledLifecycleAudit=[];},r=>{r.activationAudit.reason="implicit";}]){
    const r=structuredClone(f.record);change(r);assert.equal(E.validate(r).valid,false);}
});
test("isolated store rejects production/path substitution before content access",()=>{
  assert.throws(()=>Store.createIsolatedStore({targetEnvironment:"production",fixtureRoot:"/Users/natsu/Library/Application Support/OptionMap",crashAt:null}),/isolated_canary/);
  assert.throws(()=>Store.createIsolatedStore({targetEnvironment:"isolated_test",fixtureRoot:"/Users/natsu/Library/Application Support/OptionMap",crashAt:null}),/migration_guard/);
});
test("durable lifecycle14→19 requires exact commit, fresh readback, then completion",async()=>temp(async root=>{
  const f=await F.setup(),h=A.hash(f.historical);store(root).activateHistorical(f.historical,f.gate);const s=store(root),p=await prepare(f),data=P.inspect(p.preparation);
  const {token}=s.begin(p.preparation);assert.equal(s.load().record.safety.sequence,15);
  assert.throws(()=>s.complete(token),/attempt_invalid/);s.markWriteStarted(token);
  assert.throws(()=>s.markCommitObserved(token,{readwrite:1,commit:0,abort:1}),/commit_incomplete/);
  s.markCommitObserved(token,{readwrite:1,commit:1,abort:0});assert.throws(()=>s.markReadbackVerified(token,data.expected,false),/fresh_readback/);
  s.markReadbackVerified(token,data.expected,true);s.complete(token);const fresh=store(root).load();assert.equal(fresh.status,"valid");assert.equal(fresh.record.safety.sequence,19);
  assert.equal(fresh.record.safety.pendingFence,null);assert.equal(fresh.owned,false);assert.equal(E.validate(fresh.record).valid,true);
  assert.equal(A.hash(fresh.record.historicalRecord),h);assert.equal(s.audit().handles,0);
  const replay=await prepare(f);assert.throws(()=>store(root).begin(replay.preparation),/authority_unavailable/);
}));
test("stale safety binding fails before any lifecycle mutation",async()=>temp(async root=>{
  const f=await F.setup();store(root).activateHistorical(f.historical,f.gate);const p=await prepare(f),other=store(root);
  other.begin(p.preparation);const q=await prepare(f);assert.throws(()=>store(root).begin(q.preparation),/authority_unavailable/);
}));
test("corrupt selection fails closed, without legacy fallback",async()=>temp(async(root,profile)=>{
  const f=await F.setup();store(root).activateHistorical(f.historical,f.gate);
  fs.writeFileSync(path.join(profile,Store.DIRECTORY,"selection.json"),"{}",{mode:0o600});assert.equal(store(root).load().status,"corrupt");
}));
module.exports={};
