"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),EventEmitter=require("node:events");
const A=require("../js/marketCalendarHistory/formalWriterAuthorityV2.js"),E=require("../js/marketCalendarHistory/mofStartupCanaryEnvelope.js");
const Reader=require("../js/marketCalendarRuntime/writerSafetyReadOnly.js"),Store=require("../js/marketCalendarHistory/mofStartupCanaryStore.js");
const Bridge=require("../js/marketCalendarRuntime/mofStartupPersistenceBridge.js"),Runtime=require("../js/marketCalendarRuntime/mofStartupCanaryProductionRuntime.js");
const F=require("./fixtures/marketCalendar/mofStartupCanaryFixture.js"),W=require("./fixtures/marketCalendar/mofStartupWiringFixture.js"),Guard=require("../scripts/marketCalendarG14bFilesystemGuard.js");
async function temp(action){const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),"optionmap-g14bg-fixture-g17-wiring-")),profile=Guard.createIsolatedPolicy({targetEnvironment:"isolated_test",fixtureRoot:root}).profile;
  fs.mkdirSync(profile,{recursive:true,mode:0o700});try{const f=await F.setup();W.seedHistorical(profile,f.historical);return await action(root,profile,f);}finally{fs.rmSync(root,{recursive:true});}}
const store=root=>Store.createIsolatedStore({targetEnvironment:"isolated_test",fixtureRoot:root,crashAt:null});
test("R1 Envelope4 readonly recognition preserves exact completed Envelope3 history",()=>temp(async(root,profile,f)=>{
  const reader=Reader.createReader(profile),old=reader.load();assert.equal(old.envelopeVersion,3);assert.equal(old.status,"valid");
  store(root).activateHistorical(f.historical,f.gate);const loaded=reader.load();assert.equal(loaded.status,"valid",loaded.reason);
  assert.equal(loaded.envelopeVersion,4);assert.equal(loaded.safety.sequence,14);assert.deepEqual(loaded.record.historicalRecord,f.historical);
  assert.equal(loaded.permissions.entries.find(r=>r.sourceId===E.SOURCE).permission,"not_approved");
  assert.equal(loaded.writeAllowed,false);assert.equal(reader.audit().writes,0);assert.equal(reader.audit().handles,0);
}));
for(const [label,mutate]of [
  ["partial namespace",(root,profile)=>fs.mkdirSync(path.join(profile,Store.DIRECTORY),{mode:0o700})],
  ["bad pointer",(root,profile)=>fs.writeFileSync(path.join(profile,Store.DIRECTORY,"selection.json"),"{}")],
  ["future schema",(root,profile)=>{const d=path.join(profile,Store.DIRECTORY,"mof-canary-14","market-calendar-writer-safety","safety.json");const r=JSON.parse(fs.readFileSync(d));r.schemaVersion=5;fs.writeFileSync(d,JSON.stringify(r));}],
  ["pending ownership",(root,profile)=>fs.writeFileSync(path.join(profile,Store.DIRECTORY,"attempt.lock"),"owned",{mode:0o600})],
  ["historical drift",(root,profile)=>fs.writeFileSync(path.join(profile,"market-calendar-source-set-safety","selection.json"),"{}")]
])test(`R2 fail closed, no fallback: ${label}`,()=>temp(async(root,profile,f)=>{
  if(label!=="partial namespace")store(root).activateHistorical(f.historical,f.gate);mutate(root,profile);
  assert.equal(Reader.createReader(profile).load().status,"corrupt");
}));
test("R3 production factory rejects path/source/patch input before production access",()=>{
  assert.throws(()=>Store.createProductionStore("/arbitrary"),/override/);
  assert.throws(()=>Runtime.initializeProductionContext("/arbitrary"),/native_main/);
  assert.equal(Runtime.validateProductionContext({}),false);
});
test("historical guard permits only exact namespace lstat, no contents/enumeration/write",()=>{
  const G=require("../scripts/marketCalendarG15b1FilesystemGuard.js"),root="/isolated/Library/Application Support/OptionMap",p=path.join(root,Store.DIRECTORY),policy=G.bindResolvedProfile(root);
  assert.equal(policy.permits(p,"lstatSync",false),true);
  for(const op of ["readFileSync","openSync","readdirSync","mkdirSync","statSync","realpathSync"])assert.equal(policy.permits(p,op,false),false);
  assert.equal(policy.permits(p,"lstatSync",true),false);assert.equal(policy.permits(path.join(p,"selection.json"),"openSync",false),false);
});
async function fixture(){const f=await F.setup(),wc=new EventEmitter();Object.assign(wc,{id:1,mainFrame:{url:Bridge.DOCUMENTS[0],processId:2,routingId:3,frameToken:"fixed"},
  getURL:()=>Bridge.DOCUMENTS[0],getOSProcessId:()=>4,isDestroyed:()=>false});const event={sender:wc,senderFrame:wc.mainFrame};let persisted=f.runtimeState,proof=null;
  const old={...f.runtimeState,lastAttemptAt:"2026-10-09T00:00:00.000Z",lastSuccessAt:"2026-10-09T00:00:00.000Z"};let reads=0;
  const b=Bridge.createIsolatedBridge({targetEnvironment:"isolated_test",webContents:wc,readRuntimeState:async()=>({status:"ok",value:++reads===1?old:persisted}),onPersisted:async e=>{proof=e.proof;return {status:"PASS"};}});
  const t=b.claim(event);await b.start(event,t,{[E.SOURCE]:old});b.capture({checkedAt:f.checkedAt,state:"partial",sources:[{...f.sourceOutcome,lastHttpStatus:200},{sourceId:"us-bls-calendar",status:"unavailable"}]},f.source);
  return {b,t,event,wc,f,setPersisted:r=>{persisted=r;},proof:()=>proof};}
test("B1 fresh row verified after persistence; epoch/acquisition binding opaque one-use",async()=>{
  const x=await fixture();await x.b.persisted(x.event,x.t);assert.equal(x.b.diagnostics().audit.proofs,1);assert.equal(x.b.diagnostics().audit.runtimeWrites,0);
  const p=Bridge.consumeProof(x.proof());assert.equal(p.runtimeIdentity,A.hash(x.f.runtimeState));assert.equal(p.sourceId,E.SOURCE);
  assert.throws(()=>Bridge.consumeProof(x.proof()),/spent/);await assert.rejects(x.b.persisted(x.event,x.t),/replayed/);x.b.close();assert.equal(x.wc.listenerCount("did-start-navigation"),0);
});
for(const field of ["lastSuccessAt","lastAttemptAt","lastOutcome","sourceId"])
  test(`B2 stale/wrong persisted ${field} rejects with proof0`,async()=>{const x=await fixture(),r=structuredClone(x.f.runtimeState);
    r[field]=field==="lastOutcome"?"failure":field==="sourceId"?"jp-boj-calendar":"2026-10-13T00:00:00.000Z";x.setPersisted(r);
    await assert.rejects(x.b.persisted(x.event,x.t),/fresh_persistence/);assert.equal(x.b.diagnostics().audit.proofs,0);x.b.close();});
for(const kind of ["sender","frame","reload","process","nonce"])
  test(`B3 ${kind} substitution rejects`,async()=>{const x=await fixture();let e=x.event,t=x.t;
    if(kind==="sender")e={...e,sender:{}};if(kind==="frame")e={...e,senderFrame:{}};if(kind==="reload")x.wc.emit("did-start-navigation");
    if(kind==="process")x.wc.getOSProcessId=()=>99;if(kind==="nonce")t={...t,nonce:"wrong"};await assert.rejects(x.b.persisted(e,t));assert.equal(x.b.diagnostics().audit.proofs,0);x.b.close();});
test("B4 forged proof cannot issue production context; private bridge exposes no path/writer",async()=>{
  const x=await fixture();assert.throws(()=>Bridge.consumeProof({}),/unknown/);assert(!JSON.stringify(x.t).includes("/Users/"));
  assert.deepEqual(Object.keys(x.b).sort(),["claim","start","capture","persisted","close","diagnostics"].sort());x.b.close();
});
test("B5 spoofed renderer Runtime State rejects before normal acquisition",async()=>{
  const f=await F.setup(),wc=new EventEmitter();Object.assign(wc,{id:1,mainFrame:{url:Bridge.DOCUMENTS[0],processId:2,routingId:3,frameToken:"fixed"},
    getURL:()=>Bridge.DOCUMENTS[0],getOSProcessId:()=>4,isDestroyed:()=>false});const event={sender:wc,senderFrame:wc.mainFrame};
  const b=Bridge.createIsolatedBridge({targetEnvironment:"isolated_test",webContents:wc,readRuntimeState:async()=>({status:"ok",value:f.runtimeState}),onPersisted:async()=>{throw Error("must_not_run");}});
  const t=b.claim(event);await assert.rejects(b.start(event,t,{}),/prestate_mismatch/);assert.equal(b.diagnostics().audit.normalStarts,0);b.close();
});
test("S1 createWindow profile resolution absent; unchanged Security assertions retained",()=>{
  const m=fs.readFileSync(path.join(__dirname,"../main.js"),"utf8"),block=m.slice(m.indexOf("function createWindow()"),m.indexOf("app.whenReady().then"));
  assert.doesNotMatch(block,/userData|app\.getPath|resolveProductionProfile|setPath\(/);
  assert(m.indexOf("initializeProductionContext()")>m.indexOf("app.whenReady().then"));
  assert(m.indexOf("initializeProductionContext()")<m.indexOf("app.whenReady().then(createWindow)"));
});
for(const [label,n,mode]of [["unchanged16",0,true],["new1",1,true],["stale persistence",1,"stale"]])
  test(`N real production factories in dedicated temp profile: ${label}`,async()=>{
    const r=await require("../scripts/marketCalendarG17CanaryNative.js").nativeCase(null,n,mode),v=r.executed.result;
    assert.deepEqual(v.guard,{productionAttempts:0,networkAttempts:0});assert.equal(v.diagnostics.bridge.audit.runtimeWrites,0);
    assert.equal(v.diagnostics.bridge.audit.normalStarts,1);assert.equal(v.requests,4);
    if(mode==="stale"){assert.equal(v.status,"FAIL");assert.equal(v.reason,"startup_fresh_persistence_required");assert.equal(v.diagnostics.bridge.audit.proofs,0);assert.equal(v.safety.safety.sequence,14);}
    else if(!n){assert.equal(v.diagnostics.canary.reason,"unchanged");assert.equal(v.diagnostics.canary.writerAttempts,0);assert.equal(v.safety.safety.sequence,14);}
    else{assert.equal(v.diagnostics.canary.status,"PASS");assert.deepEqual(v.diagnostics.canary.receipt.counts,E.COUNTS);
      assert.deepEqual(v.diagnostics.canary.receipt.transactions,{readwrite:1,commit:1,abort:0});assert.equal(v.safety.safety.sequence,19);}
    assert.equal(r.historyUnchanged,true);
  });
