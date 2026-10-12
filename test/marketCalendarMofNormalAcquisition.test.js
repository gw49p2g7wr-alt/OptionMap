"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { IDBFactory } = require("fake-indexeddb");
const Store = require("../js/storage/marketCalendarRuntimeStateStore.js");
const F = require("./fixtures/marketCalendar/mofNormalFixture.js");
const Contracts = require("../js/marketCalendarRuntime/normalAcquisitionContract.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const State = require("../js/marketCalendarRuntime/sourceUpdateState.js");
const Flights = require("../js/marketCalendarRuntime/sourceSingleFlight.js");
const Pool = require("../js/marketCalendarRuntime/boundedTaskPool.js");
const Cycle = require("../js/marketCalendarRuntime/formalShadowCycle.js");
const Mof = require("../js/marketCalendarRuntime/mofNormalAcquisition.js");
const Runtime = require("../js/marketCalendarRuntime/normalCalendarAcquisitionRuntime.js");
const row = r => r.sources.find(s => s.sourceId === F.MOF);
async function setup(options) {
  const store = Store.createRuntimeStateStore({ indexedDB: new IDBFactory(), targetEnvironment: "isolated_test" });
  const f = await F.setup({ store, ...options }); return { ...f, store };
}
test.afterEach(() => {
  assert.equal(Flights.getFlightDiagnostics().activeFlightCount, 0);
  assert.equal(Pool.getTaskPoolDiagnostics().activeTaskCount, 0); assert.equal(Cycle.activeCount(), 0);
});
test("A1 normal13 uses existing orchestration and exact variable documents", async () => {
  const f = await setup(), r = await f.runtime.check({ trigger: "startup" });
  assert.equal(r.sources.length, 13); assert.equal(r.state, "success", JSON.stringify(r.sources));
  assert.equal(row(r).recordCount, 16); assert.equal(r.peakSourceConcurrency, 3);
  assert.equal(f.legacyCalls.length, 12); assert.equal(f.requests.length, 4);
  assert.deepEqual(f.requests.map(x => x.url).sort(), Object.keys(f.documents).sort());
  assert(f.requests.every(x => x.method === "GET" && x.redirect === "manual" && x.credentials === "omit"));
});
test("A2 success creates MOF legacy runtime row using exact existing schema", async () => {
  const f = await setup(); assert.equal((await f.store.read(F.MOF)).value, null);
  await f.runtime.check({ trigger: "startup", sourceIds: [F.MOF] });
  const state = (await f.store.read(F.MOF)).value;
  assert(State.validateRuntimeState(state, F.MOF).valid); assert.equal(state.lastOutcome, "success");
  assert.equal(state.lastSuccessAt, F.AT); assert.equal(f.store.diagnostics().successfulWrites, 1);
  assert.equal((await f.store.readAll()).value.length, 1);
});
test("A3/A4 later success updates same key without duplicate creation", async () => {
  const f = await setup(); await f.runtime.check({ trigger: "startup", sourceIds: [F.MOF] });
  f.setClock("2026-10-14T00:00:00.000Z"); await f.runtime.check({ trigger: "startup", sourceIds: [F.MOF] });
  assert.equal((await f.store.readAll()).value.length, 1); assert.equal(f.store.diagnostics().successfulWrites, 2);
  assert.equal((await f.store.read(F.MOF)).value.lastSuccessAt, "2026-10-14T00:00:00.000Z");
  assert.equal(f.store.diagnostics().successfulCreates, 1);
});
test("A5 existing Formal16 comparison is unchanged, no evidence-only/new/changed/ambiguity", async () => {
  const f = await setup(), before = structuredClone(f.snapshot); await f.runtime.check({ sourceIds: [F.MOF] });
  const d = f.runtime.diagnostics(), s = d.comparison.comparison.summaries.find(s => s.sourceId === F.MOF);
  assert.equal(d.comparison.comparison.status, "compared"); assert.equal(s.unchanged, 16);
  for (const k of ["changed", "new", "evidenceOnly", "ambiguity", "notEvaluated"]) assert.equal(s[k], 0, k);
  assert.deepEqual(f.snapshot, before); assert.equal(d.comparison.performance.snapshotValidationCount, 1);
  assert.equal(d.comparison.performance.fullSnapshotHashCount, 1); assert.equal(d.comparison.performance.fullMaterialCopies, 0);
});
test("A6/A7 no writer/safety capabilities and readonly Formal inspection", async () => {
  const f = await setup(); await f.runtime.check({ sourceIds: [F.MOF] });
  const d = f.runtime.diagnostics(); assert.equal(d.writerExecution, 0); assert.equal(d.safetyWrites, 0);
  assert.equal(d.comparison.formalAudit.readwrite, 0); assert.equal(d.comparison.permission, "not_approved");
  assert.equal(d.comparison.writeAllowed, false);
  const fs = require("node:fs"), source = fs.readFileSync(require.resolve("../js/marketCalendarRuntime/normalCalendarAcquisitionRuntime.js"), "utf8");
  assert.doesNotMatch(source, /require\([^\n]*(?:Authorization|Grant|WriterCore|SafetyStore|SafetyRuntime)/);
});
test("same JST day skips without network/Runtime State write/Formal read", async () => {
  const f = await setup(); await f.runtime.check({ trigger: "startup", sourceIds: [F.MOF] });
  const before = await f.store.readAll(), writes = f.store.diagnostics().successfulWrites;
  const r = await f.runtime.check({ trigger: "startup", sourceIds: [F.MOF] });
  assert.equal(row(r).reasonClass, "already_succeeded_today"); assert.equal(f.requests.length, 4);
  assert.equal(f.store.diagnostics().successfulWrites, writes); assert.equal(f.reads(), 1);
  assert.deepEqual((await f.store.readAll()).value, before.value);
});
test("manual retains existing daily override, not writer permission", async () => {
  const f = await setup(); await f.runtime.check({ sourceIds: [F.MOF] });
  const r = await f.runtime.check({ sourceIds: [F.MOF] });
  assert.equal(row(r).planningReason, "manual_daily_override"); assert.equal(f.requests.length, 8);
  assert.equal(f.runtime.diagnostics().comparison.writeAllowed, false);
});
for (const [name, url] of [["A8 index failure", "index"], ["A9 partial monthly failure", "2611"]])
  test(name + " retains previous success, no candidates or cancellation", async () => {
    const f = await setup(); await f.runtime.check({ sourceIds: [F.MOF] });
    f.setClock("2026-10-14T00:00:00.000Z");
    f.documents[`https://www.mof.go.jp/jgbs/auction/calendar/${url}.htm`] = () => new Response(null, { status: 500 });
    const r = await f.runtime.check({ trigger: "startup", sourceIds: [F.MOF] });
    assert.equal(row(r).status, "failed"); const state = (await f.store.read(F.MOF)).value;
    assert.equal(state.lastOutcome, "failure"); assert.equal(state.lastSuccessAt, F.AT);
    assert(State.validateRuntimeState(state, F.MOF).valid);
    const s = f.runtime.diagnostics().comparison.comparison.summaries.find(s => s.sourceId === F.MOF);
    assert.equal(s.candidate, 0); assert.equal(s.notEvaluated, 16);
    assert.equal(f.runtime.diagnostics().comparison.absenceAuthority, "none");
  });
test("A10 existing12 state fields and managed v2 bindings unchanged in meaning", async () => {
  const f = await setup(); await f.runtime.check({ trigger: "startup" });
  for (const id of Registry.HISTORICAL_SOURCE_ORDER) {
    const s = f.states.get(id) || (await f.store.read(id)).value;
    assert(State.validateCompatibleRuntimeState(s, id).valid, id); assert.equal(s.lastOutcome, "success");
  }
  assert.equal((await f.store.readAll()).value.length, 10); // three controlled sources remain main-owned
});
test("A11/A12 historical defaults, Machinery ceiling, BOJ permission are unchanged", () => {
  assert.equal(Registry.getSource(F.MOF).acquisitionEnabled, false); assert.equal(Registry.getSource(F.MOF).writerAllowed, false);
  assert.equal(Registry.getAcquisitionEnabledSourceIds().length, 12);
  const policy = require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js").policyFor(3);
  assert.deepEqual(policy.global.permittedSources, ["jp-esri-machinery-orders-calendar"]);
  assert.equal(policy.permissions.entries.find(e => e.sourceId === "jp-boj-calendar").permission, "writer_ineligible");
});
test("lookalike factory capability and renderer enablement spoof rejected", async () => {
  assert.throws(() => Contracts.resolve({ ...Contracts.NORMAL13 }), /contract_invalid/);
  const f = await setup(); const r = await f.runtime.check({ acquisitionContract: Contracts.NORMAL13, sourceIds: [F.MOF] });
  assert.equal(r.reasonClass, "invalid_argument"); assert.equal(f.requests.length, 0);
});
test("unknown/missing monthly document, bad MIME/encoding/redirect remain fail-closed", async () => {
  for (const response of [() => new Response(null, { status: 404 }),
    () => new Response("bad", { headers: { "content-type": "application/json" } }),
    () => new Response("<h1>bad</h1>", { headers: { "content-type": "text/html; charset=Shift_JIS" } }),
    () => new Response(null, { status: 302, headers: { location: "https://example.com/" } })]) {
    const f = await setup({ patch: { "https://www.mof.go.jp/jgbs/auction/calendar/2610.htm": response } });
    const r = await f.runtime.check({ sourceIds: [F.MOF] }); assert.equal(row(r).status, "failed");
    assert.equal(f.runtime.diagnostics().transport.activeTasks, 0);
  }
});
test("raw bodies never enter Runtime State or public normal result", async () => {
  const f = await setup(), r = await f.runtime.check({ sourceIds: [F.MOF] });
  assert.doesNotMatch(JSON.stringify([r, await f.store.readAll(), f.runtime.diagnostics()]), /<h1|<tbody|parserInput/);
  assert.equal(f.store.diagnostics().openHandles, 0); assert.equal(f.runtime.diagnostics().transport.activeTimers, 0);
});
test("restore includes MOF under fixed normal13 contract without network/writes", async () => {
  const f = await setup(); await f.runtime.check({ sourceIds: [F.MOF] });
  const before = f.store.diagnostics().successfulWrites, result = await f.runtime.restore();
  assert.equal(row(result).sourceId, F.MOF); assert.equal(result.requestedSourceCount, 13);
  assert.equal(row(result).displayName, Registry.getSource(F.MOF).sourceOwner);
  assert.equal(f.store.diagnostics().successfulWrites, before); assert.equal(f.requests.length, 4);
});
test("MOF-only failure does not block other12 acquisition or alter their writer permission", async () => {
  const f = await setup({ patch: { "https://www.mof.go.jp/jgbs/auction/calendar/2610.htm": () => new Response(null, { status: 500 }) } });
  const r = await f.runtime.check({ trigger: "startup" });
  assert.equal(r.state, "partial"); assert.equal(r.successfulSourceCount, 12); assert.deepEqual(r.failedSourceIds, [F.MOF]);
  assert.equal(f.runtime.diagnostics().comparison.comparison.status, "compared");
});
test("native temp Chromium: normal13, Runtime State create/update, Formal unchanged", () => {
  const r = require("../scripts/marketCalendarG16aNormalNative.js").run("isolated");
  assert.equal(r.status, "PASS"); assert.equal(r.sources, 13); assert.equal(r.candidates, 16);
  assert.equal(r.runtime.audit.runtimeCreates, 1); assert.equal(r.runtime.audit.runtimeUpdates, 2);
  assert.equal(r.runtime.audit.formalReadwrite, 0); assert.equal(r.formalUnchanged, true);
  assert.deepEqual(r.writerTraps, { authorization: 0, grant: 0, executionToken: 0 });
  assert.equal(r.guard.productionContentAttempts, 0); assert.equal(r.guard.networkAttempts, 0); assert.equal(r.tempDeleted, true);
});
