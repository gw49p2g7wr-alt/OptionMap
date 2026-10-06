"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), cp = require("node:child_process");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js");
const E = require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js");
const root = path.resolve(__dirname, ".."), MOF = "jp-mof-jgb-auction-calendar";
// Independent historical expectation, not derived from the registry/helper under test.
const ORDER = ["jp-boj-calendar", "jp-stat-cpi", "jp-stat-labor",
  "jp-esri-machinery-orders-calendar", "jp-esri-sna-calendar", "us-fed-fomc-calendar",
  "us-bls-calendar", "us-bea-calendar", "us-census-calendar", "jp-jpx-derivatives-calendar",
  "jp-jpx-market-holidays", "us-nyse-market-holidays"];
const IDS = [...ORDER].sort();
const IDENTITIES = { v1: "446f8a7a18f25aa8f41bbdf1f382637f268b3ac5ad4687ba3dd222741d841708",
  shadow: "bd2caea336e528d9c66c9bc010ffa14f959c764bd13e84bea6cd6f37a4348af6",
  v2: "1fd05aefc041d299a1e3c2f0b1fe6c8f47403af11b56fa765d3ca26c7656d58c",
  permission: "e039f9830dada915645686bd51fbe70c2d5ad5c8eced66ce29c94d861d7f82ba",
  v3: "62d49ff8d78e01daae2bd42a556cca11e6b6a4de38e58a64355fa385bf8ea758",
  route: "a1f487bf1b82a781cc586cf6954834f2865a6b3d4b523135874069c93fd38b93" };

// A fresh process adds metadata ONLY inside a memory-compiled fixture. It then
// loads the actual dependency graph afresh, catching module-load registry coupling.
// No production file, profile, network, DB, state store or writer is accessed.
let futureResult;
function future() {
  if (futureResult) return futureResult;
  const script = `
    const fs = require('node:fs'), Module = require('node:module'), path = require('node:path');
    const filename = require.resolve('./js/marketCalendar/sourceRegistry.js');
    const mof = ${JSON.stringify(MOF)};
    const text = fs.readFileSync(filename, 'utf8'), needle = 'const SOURCES = Object.freeze(sourceEntries);';
    if (text.split(needle).length !== 2) throw Error('fixture_injection_shape_invalid');
    const m = new Module(filename); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
    m._compile(text.replace(needle, 'sourceEntries[' + JSON.stringify(mof) + '] = Object.freeze({ sourceId: ' +
      JSON.stringify(mof) + ', formalEligible: true, acquisitionEnabled: true }); ' + needle), filename);
    m.loaded = true; require.cache[filename] = m;
    const R = m.exports, V1 = require('./js/marketCalendarHistory/formalWriterAuthority.js');
    const A = require('./js/marketCalendarHistory/formalWriterAuthorityV2.js');
    const S = require('./js/marketCalendarHistory/formalWriterSafetyEvaluator.js');
    const E = require('./js/marketCalendarHistory/writerSafetyVersionedEnvelope.js');
    const Old = require('./js/marketCalendarHistory/writerSafetyFileSchema.js');
    const Routes = require('./js/marketCalendarRuntime/calendarRouteAuthority.js');
    const C = require('./js/marketCalendarRuntime/updateCoordinator.js');
    const P = require('./js/marketCalendarRuntime/updatePolicy.js');
    const M = require('./js/marketCalendarRuntime/calendarManualCheckService.js');
    const Compare = require('./js/marketCalendarRuntime/formalExactComparison.js');
    const B = require('./js/marketCalendarHistory/firstProductionWriteBoundary.js');
    const Receipt = require('./js/marketCalendarRuntime/freshDayCanaryReceipt.js');
    const Schema = require('./js/marketCalendarHistory/productionSchemaV1.js');
    const Bootstrap = require('./js/marketCalendarHistory/bootstrapSchemaV1.js');
    const Network = require('./js/marketCalendarRuntime/calendarNetworkPolicy.js');
    const Fixture = require('./test/fixtures/marketCalendar/automaticShadowFixture.js');
    (async () => {
      const gate = A.hash({fixture:'historical'}), legacy = Old.build(null, S.createMemorySafety(), null,
        'provision_disabled', A.PRODUCTION_POLICY);
      const record = E.append(E.migrate(legacy, gate), { type:'authority_transition', expectedAuthorityVersion:2,
        nextAuthorityVersion:3, approvedSourceCeiling:[E.SOURCE], suspendedSourceSet:[] }, gate);
      const loaded = { available:true, record, contentHash:A.hash(record) };
      const sources = R.HISTORICAL_SOURCE_ORDER.map(sourceId => ({sourceId, planningDecision:'skip',
        planningReason:'already_succeeded_today', acquisitionStatus:'not_attempted'}));
      const storage = () => ({create:0,upgrade:0,marketWrites:0,localStorageWrites:0,handles:0,pending:0,listeners:0,
        opens:0,readonly:0,readwrite:0,formalWrites:0,perStore:Object.fromEntries(Bootstrap.STORE_ORDER.map(([,n])=>[n,0]))});
      const receiptInput = {before:loaded,after:loaded,runtime:{status:'hold',reason:'same_day_skip',writerExecution:0,
        acquisition:{sources},safetyAudit:{fileHandles:0,lockHandles:0,closed:true,busy:false,states:[],attempted:false}},
        storageAudits:[storage(),storage(),storage()]};
      const receipt = Receipt.validate(receiptInput);
      const expandedReceipt = Receipt.validate({...receiptInput,runtime:{...receiptInput.runtime,
        acquisition:{sources:[...sources,{sourceId:mof}]}}});
      const now = () => new Date().toISOString(), plan = trigger => C.planUpdate({trigger,requestedAt:now()});
      const denied = C.planUpdate({trigger:'startup',requestedAt:now(),sourceIds:[mof],enabledSourceIds:[mof]});
      const directDenied = P.evaluateSourceUpdate({sourceId:mof,trigger:'startup',requestedAt:now()});
      const calls = [], service = M.createCalendarManualCheckService({now,
        acquire:async ({sourceId}) => {calls.push(sourceId); return {success:true,sourceId,documents:[]};},
        builder:{buildCalendarCandidate:async ({sourceId})=>({sourceId,formalEligible:true,candidateStatus:'available',recordCount:0})},
        simulator:{simulateCalendarTransition:async()=>({simulationStatus:'unchanged',commitOutcome:'writer_disabled'})}});
      const startup = await service.check({trigger:'startup'}), manual = await service.check({trigger:'manual'});
      const disabledManual = await service.check({sourceIds:[mof],trigger:'manual'});
      const spoof = await service.check({trigger:'startup',acquisitionEnabled:true,enabledSourceIds:[mof]});
      // PREWRITE_ONLY fixture performs pure in-memory validation, never executes a writer.
      const f = await Fixture.fixture({perSource:4}), session = B.beginPrewrite();
      await B.captureFormalRead(session,f.snapshot,Schema.EXPECTED_FINGERPRINT);
      const Canon = require('./js/marketCalendar/marketEventCanonicalizer.js'), stamp = now();
      for (const s of f.sources) for (const event of s.canonicalRecords) {
        event.acquisitionEvidence.fetchedAt = stamp; event.source = event.acquisitionEvidence;
        event.acquisitionEvidenceHash = await Canon.sha256(event.acquisitionEvidence);
        event.acquisitionEvidenceKey = s.sourceId + '|sha256:' + event.acquisitionEvidenceHash;
      }
      const boundary = await B.completePrewrite(session,{sourceResults:f.sources,endingFormalSnapshot:f.snapshot,completedAt:now()});
      const second = B.beginPrewrite(); await B.captureFormalRead(second,f.snapshot,Schema.EXPECTED_FINGERPRINT);
      const expandedBoundary = await B.completePrewrite(second,{sourceResults:[...f.sources,{sourceId:mof}],
        endingFormalSnapshot:f.snapshot,completedAt:now()});
      console.log(JSON.stringify({registered:Object.keys(R.SOURCES),enabled:R.getAcquisitionEnabledSourceIds(),
        ids:A.SOURCE_IDS,bindings:[R.getHistoricalSourceSet(2,1).sourceIds,R.getHistoricalSourceSet(3,1).sourceIds],
        identities:{v1:V1.PRODUCTION_AUTHORITY.identity,shadow:V1.SHADOW_AUTHORITY.identity,
          v2:A.PRODUCTION_POLICY.global.identity,permission:A.PRODUCTION_POLICY.permissions.identity,
          v3:E.policyFor(3).global.identity,route:Routes.PRODUCTION_AUTHORITY.authorityIdentity},
        legacyValid:Old.validate(legacy).valid,envelopeValid:E.validateEnvelope(record).valid,
        v2SafetyValid:S.validateSafety(legacy.safety).valid,v3SafetyValid:S.validateSafety(E.safetyInput(record.safety),E.policyFor(3)).valid,
        receipt,expandedReceipt,boundary:{status:boundary.status,reason:boundary.reason,coreWriteExecutions:boundary.coreWriteExecutions},
        expandedBoundary,scope:B.HISTORICAL_SOURCE_IDS,comparisonScope:Compare.SOURCE_IDS,canaryScope:A.SOURCE_IDS,
        startupPlan:plan('startup').sourceResults.map(s=>s.sourceId),manualPlan:plan('manual').sourceResults.map(s=>s.sourceId),
        denied:denied.sourceResults[0],directDenied,networkDenied:Network.validateRequest({sourceId:mof,operation:Network.OPERATION}),
        startup:startup.sources.map(s=>s.sourceId),manual:manual.sources.map(s=>s.sourceId),disabledManual,spoof:spoof.sources.map(s=>s.sourceId),calls}));
    })().catch(e=>{console.error(e);process.exitCode=1;});
  `;
  const result = cp.spawnSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  futureResult = JSON.parse(result.stdout); return futureResult;
}

test("H1 authority v2 historical source set is exact twelve", () => {
  assert.deepEqual(Registry.getHistoricalSourceSet(2, 1).sourceIds, IDS);
  assert.deepEqual(A.SOURCE_IDS, IDS);
});
test("H2 authority v3 historical source set is exact twelve", () => {
  assert.deepEqual(Registry.getHistoricalSourceSet(3, 1).sourceIds, IDS);
  assert.deepEqual(E.policyFor(3).permissions.entries.map(e => e.sourceId), IDS);
});
test("H3 permission v1 preserves the recorded identity", () => {
  assert.equal(A.PRODUCTION_POLICY.permissions.permissionVersion, 1);
  assert.equal(A.PRODUCTION_POLICY.permissions.identity, IDENTITIES.permission);
});
test("H4 fresh graph with thirteen registered metadata entries cannot change historical identities/state validation", () => {
  const f = future(); assert.equal(f.registered.length, 13); assert(f.registered.includes(MOF));
  assert.deepEqual(f.ids, IDS); assert.deepEqual(f.bindings, [IDS, IDS]);
  assert.deepEqual(f.identities, IDENTITIES);
  for (const key of ["legacyValid", "envelopeValid", "v2SafetyValid", "v3SafetyValid"]) assert.equal(f[key], true, key);
});
test("H5 actual receipt validator retains historical twelve-source HOLD and rejects thirteen", () => {
  const f = future(); assert.deepEqual(f.canaryScope, IDS);
  assert.equal(f.receipt.valid, true); assert.equal(f.receipt.status, "HOLD");
  assert.equal(f.expandedReceipt.reason, "receipt_acquisition_incomplete");
});
test("H6 actual historical PREWRITE_ONLY boundary accepts its old scope and rejects expansion", () => {
  const f = future(); assert.deepEqual(f.scope, IDS); assert.deepEqual(f.comparisonScope, IDS);
  assert.equal(f.boundary.status, "prewrite_eligible", f.boundary.reason);
  assert.equal(f.boundary.coreWriteExecutions, 0);
  assert.equal(f.expandedBoundary.reason, "fresh_acquisition_required");
});
test("H7 registered but disabled MOF is not a startup target", () => {
  const f = future(); assert.deepEqual(f.startupPlan, ORDER); assert.deepEqual(f.startup, ORDER);
  assert.equal(f.denied.reason, "acquisition_disabled"); assert.equal(f.directDenied.reason, "acquisition_disabled");
});
test("H8 registered but disabled MOF is not a manual target", () => {
  const f = future(); assert.deepEqual(f.manualPlan, ORDER); assert.deepEqual(f.manual, ORDER);
  assert.equal(f.disabledManual.reasonClass, "source_selection_invalid");
  assert.equal(f.networkDenied.valid, false);
});
test("H9 arbitrary request fields and renderer startup cannot enable a source", async () => {
  const f = future(); assert.deepEqual(f.spoof, ORDER); assert(!f.calls.includes(MOF));
  let bridge, calls = 0;
  vm.runInNewContext(fs.readFileSync(path.join(root, "preload.js"), "utf8"), {
    require: id => { assert.equal(id, "electron"); return {contextBridge:{exposeInMainWorld:(_, api)=>{bridge=api;}},
      ipcRenderer:{invoke:()=>{calls++;}}}; }
  });
  for (const request of [{enabledSourceIds:[MOF]}, {acquisitionEnabled:true}, {sourceSetVersion:2}, {authorityVersion:3}])
    assert.equal((await bridge.checkCalendarSources(request)).errorCode, "invalid_argument");
  assert.equal(calls, 0); assert.equal(Object.keys(bridge).length, 8);
});
test("H10 pure selector chooses only explicitly enabled registered entries", () => {
  assert.deepEqual(Registry.selectRegisteredEnabledSourceIds([...ORDER, MOF], [ORDER[1], ORDER[0]]), ORDER.slice(0, 2));
  assert.deepEqual(Registry.selectRegisteredEnabledSourceIds([...ORDER, MOF], []), []);
  assert.throws(() => Registry.selectRegisteredEnabledSourceIds(ORDER, [MOF]), /acquisition_source_set_invalid/);
  assert.throws(() => Registry.selectRegisteredEnabledSourceIds(ORDER, [ORDER[0], ORDER[0]]), /acquisition_source_set_invalid/);
});
test("H11 historical sources and current startup order remain twelve despite disabled metadata registration", () => {
  assert.deepEqual(Object.keys(Registry.SOURCES).filter(id => IDS.includes(id)), ORDER);
  assert.deepEqual(Registry.getAcquisitionEnabledSourceIds(), ORDER);
  assert.equal(Registry.getSource(MOF).acquisitionEnabled, false); assert.equal(Registry.isAcquisitionEnabled(MOF), false);
  assert.equal(A.PRODUCTION_POLICY.global.state, "disabled");
});
test("H12 Machinery-only startup ceiling, manual denial and BOJ ineligibility remain exact", () => {
  const S = require("../js/marketCalendarHistory/formalWriterSafetyEvaluator.js"), p = E.policyFor(3);
  assert.deepEqual(p.global.permittedSources, ["jp-esri-machinery-orders-calendar"]);
  assert.equal(p.permissions.entries.find(e => e.sourceId === "jp-boj-calendar").permission, "writer_ineligible");
  for (const sourceId of IDS) for (const operation of ["startup", "manual"]) {
    const cycleIdentity = A.hash({sourceId,operation});
    const result = S.evaluate({ policy:p, safety:S.createMemorySafety(p), sourceId, operation, cycleIdentity,
      context:A.createMainContextCandidate({operation,cycleIdentity,attemptIdentity:A.hash({attempt:sourceId,operation})}),
      acquisition:{outcome:"complete",failedRoles:[]}, routeIdentity:A.hash("route"),expectedRouteIdentity:A.hash("route"),
      schemaFingerprint:p.global.schemaFingerprint,integrityValid:true,changed:0,planValid:true,revisionTransitionCount:0,absenceAuthority:"none" });
    assert.equal(result.writeAllowed, sourceId === E.SOURCE && operation === "startup");
  }
});
test("candidate source-set v2 is pure, immutable and cannot become a historical policy", () => {
  assert.equal(Registry.getSourceSet(2).candidateOnly, true);
  assert.deepEqual(Registry.getSourceSet(2).sourceIds, [...IDS, MOF].sort());
  assert.equal(Registry.getHistoricalSourceSet(3, 2), null);
  for (const value of [0, 3, "1", null, undefined, "__proto__"]) assert.equal(Registry.getSourceSet(value), null);
  assert.throws(() => Registry.getSourceSet(2).sourceIds.push("unknown"), TypeError);
  assert.deepEqual(Registry.ACQUISITION_ENABLED_SOURCE_IDS, ORDER);
});
test("registry keeps the browser UMD contract without an additional script/require dependency", () => {
  const context = {window:{document:{}}};
  vm.runInNewContext(fs.readFileSync(path.join(root, "js/marketCalendar/sourceRegistry.js"), "utf8"), context);
  const r = context.window.OptionMapMarketEventSourceRegistry;
  assert.deepEqual(Array.from(r.getAcquisitionEnabledSourceIds()), ORDER);
  assert.deepEqual(Array.from(r.getHistoricalSourceSet(3, 1).sourceIds), IDS);
});
test("pure enabled selection has no hashing/IO and bounded small-set overhead", t => {
  const start = performance.now();
  for (let n = 0; n < 20000; n++) assert.equal(Registry.getAcquisitionEnabledSourceIds().length, 12);
  t.diagnostic(JSON.stringify({iterations:20000,elapsedMs:performance.now()-start,sourceCount:12,
    filesystemReads:0,hashes:0,network:0}));
});
