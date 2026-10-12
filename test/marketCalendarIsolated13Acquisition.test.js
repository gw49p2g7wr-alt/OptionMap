"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const F = require("./fixtures/marketCalendar/calendar13Fixture.js"), C = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Shadow = require("../js/marketCalendarIsolated/calendar13Shadow.js"), Cycle = require("../js/marketCalendarRuntime/formalShadowCycle.js");
const Acquisition = require("../js/marketCalendarIsolated/calendar13Acquisition.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Policy = require("../js/marketCalendarRuntime/updatePolicy.js");
const State = require("../js/marketCalendarRuntime/sourceUpdateState.js");
const Store = require("../js/storage/marketCalendarRuntimeStateStore.js");
const { IDBFactory } = require("fake-indexeddb");
const S = F.S, URL = "https://www.mof.go.jp/jgbs/auction/calendar/2610.htm";
const evaluate = f => Shadow.evaluate({ sourceResults: f.sources, snapshot: f.snapshot });
const store = () => Store.createRuntimeStateStore({ indexedDB: new IDBFactory(), targetEnvironment: "isolated_test" });
const success = id => ({ sourceId: id, lastAttemptAt: F.AT, lastSuccessAt: F.AT, lastOutcome: "success", retryAfter: null,
  lastHttpStatus: 200, lastDiagnosticClass: null, coordinatorVersion: 1 });
test("isolated explicit enablement cannot alter production flags or accept lookalike input", () => {
  assert.throws(() => F.Mof.create({ enablement: { ...F.Mof.ENABLEMENT }, fetchImpl: async () => {} }), /isolated_enablement/);
  assert.equal(Registry.getSource(S.SOURCE_ID).acquisitionEnabled, true); // separate code-fixed normal activation
  assert.equal(Registry.getSource(S.SOURCE_ID).writerAllowed, false);
  assert.equal(Registry.getAcquisitionEnabledSourceIds().length, 12);
  assert.equal(Acquisition.SOURCE_IDS.length, 13);
});
test("variable set exact equality, typed candidates and role/hash/encoding linkage", async () => {
  const { source, requests } = await F.mof();
  assert.equal(source.acquisitionOutcome, "complete"); assert.equal(requests, 3);
  assert.deepEqual(source.documentHealth.map(d => d.role), ["index", "month:2026-10", "month:2026-11"]);
  assert.equal(source.canonicalRecords.length, 11);
  for (const r of source.canonicalRecords) {
    assert.equal(r.acquisitionEvidence.httpMetadata.documentSetIdentity, source.documentSetIdentity);
    assert.equal(r.acquisitionEvidence.httpMetadata.role, "month:" + r.logical.auctionIdentity.auctionDate.slice(0, 7));
    assert.equal(r.schedule.sourceLocal.startTime, null); assert.equal(r.schedule.sourceLocal.timeZone, "Asia/Tokyo");
    assert.equal(Object.hasOwn(r.logical, "scope"), false);
  }
  assert.doesNotMatch(JSON.stringify(source), /<h1|<tbody/);
});
for (const [name, patch, reason] of [
  ["F1 index failure", { [S.INDEX_URL]: u => F.response(u, null, 403) }, "http_status_rejected"],
  ["F2 missing discovered month", { [URL]: u => F.response(u, null, 500) }, "http_status_rejected"],
  ["F3 malformed month", { [URL]: "<meta charset='UTF-8'><h1>wrong</h1>" }, "month_heading_mismatch"]
]) test(name + " is source-local; no records or plan", async () => {
  const { source } = await F.mof(patch); assert.equal(source.acquisitionOutcome, "failed"); assert.equal(source.reason, reason);
  assert.equal(source.canonicalRecords.length, 0);
  const f = await F.fixture(); f.sources[f.sources.length - 1] = source;
  const baseline = await evaluate(await F.fixture()), result = await evaluate(f);
  assert.equal(result.status, "evaluated"); assert.equal(result.sourceRows.at(-1)?.writeAllowed, false);
  assert.deepEqual(result.plans.filter(p => p.sourceId !== S.SOURCE_ID), baseline.plans.filter(p => p.sourceId !== S.SOURCE_ID));
  assert.deepEqual(result.sourceRows.find(s => s.sourceId === S.SOURCE_ID).counts,
    Object.fromEntries(Object.keys(result.aggregatePlannedCounts).map(k => [k, 0])));
});
test("F4 zero qualifying rows is complete/no-event, not cancellation", async () => {
  const t = F.transport({ [S.INDEX_URL]: F.G1.index(["2610"]), [URL]: F.G1.month("2610", [F.G1.row("10月7日", "国庫短期証券（3ヶ月）")]) });
  const source = await F.Mof.create({ enablement: F.Mof.ENABLEMENT, fetchImpl: t.fetchImpl })
    .acquire({ sourceId: S.SOURCE_ID, assessmentDateJst: "2026-10-07" });
  assert.equal(source.acquisitionOutcome, "complete"); assert.equal(source.noEvent, true); assert.equal(source.absenceAuthority, "none");
  const f = await F.fixture(); f.sources[f.sources.length - 1] = source;
  const r = (await evaluate(f)).sourceRows.find(s => s.sourceId === S.SOURCE_ID);
  assert.equal(r.reason, "complete_no_event"); assert.equal(r.counts.sourceCursorUpdate, 0);
});
for (const [label, href] of [["foreign host", "https://evil.example/2610.htm"], ["HTTP", "http://www.mof.go.jp/jgbs/auction/calendar/2610.htm"],
  ["wrong path", "/other/2610.htm"], ["query", "2610.htm?x=1"]]) test(label + " in discovery rejects before month fetch", async () => {
  const { source, requests } = await F.mof({ [S.INDEX_URL]: `<meta charset="UTF-8"><h1>入札カレンダー</h1><a href="${href}">10月</a>` });
  assert.equal(source.acquisitionOutcome, "failed"); assert.equal(requests, 1);
});
test("duplicate discovery is rejected, not silently deduplicated", async () => {
  const { source, requests } = await F.mof({ [S.INDEX_URL]: F.G1.index(["2610", "2610"]) });
  assert.equal(source.reason, "duplicate_month_document"); assert.equal(requests, 1);
});
for (const [label, make] of [
  ["outside redirect", u => F.response(u, null, 302, { location: "https://evil.example/" })],
  ["oversized body", u => F.response(u, "x", 200, { "content-length": String(S.MAX_BYTES + 1) })],
  ["wrong MIME", u => F.response(u, "x", 200, { "content-type": "text/plain" })],
  ["invalid UTF-8", u => F.response(u, new Uint8Array([0xc3, 0x28]))]
]) test(label + " is fail closed", async () => {
  const { source } = await F.mof({ [URL]: make }); assert.equal(source.acquisitionOutcome, "failed");
  assert.equal(source.canonicalRecords.length, 0);
});
test("duplicate auction rows cannot pass the new variable-set builder", async () => {
  const row = F.G1.row("10月7日", "10年利付国債");
  assert.equal((await F.mof({ [URL]: F.G1.month("2610", [row, row]) })).source.reason, "duplicate_candidate");
});
test("unknown/missing/reordered month material rejects; no predicted future fetch", async () => {
  const a = await S.createAcquirer({ fetchImpl: F.transport().fetchImpl }).acquire({ sourceId: S.SOURCE_ID, assessmentDateJst: "2026-10-07" });
  assert.equal(F.Mof.validateSet(a), null);
  for (const mutate of [x => x.documents.pop(), x => x.documents.push(x.documents[1]), x => x.discovery.months.reverse(),
    x => x.documents[1].requestedUrl = "https://www.mof.go.jp/jgbs/auction/calendar/2612.htm"]){
    const x = structuredClone(a); mutate(x); assert.notEqual(F.Mof.validateSet(x), null);
  }
});
test("R1/R2/R3 no row, first success, JST same-day skip network0", async () => {
  const db = store(), t = F.transport(), cycle = Acquisition.create({ enablement: Acquisition.ENABLEMENT, fetchImpl: t.fetchImpl, store: db });
  assert.equal((await db.read(S.SOURCE_ID)).value, null);
  const first = await cycle.acquireOne(S.SOURCE_ID, "2026-10-07", F.AT);
  assert.equal(first.acquisitionOutcome, "complete"); const saved = (await db.read(S.SOURCE_ID)).value;
  assert.equal(saved.lastSuccessAt, F.AT); assert.deepEqual(Object.keys(saved).sort(), Object.keys(success(S.SOURCE_ID)).sort());
  const before = t.requests(), second = await cycle.acquireOne(S.SOURCE_ID, "2026-10-07", "2026-10-07T12:00:00.000Z");
  assert.equal(second.reason, "already_succeeded_today"); assert.equal(t.requests(), before);
  assert.equal(db.diagnostics().openHandles, 0); assert.equal(db.diagnostics().successfulCreates, 1); assert.equal(Store.VERSION, 1);
});
test("R4/R5/R6 failure updates MOF only; identity isolation", async () => {
  const db = store(); for (const id of Registry.HISTORICAL_SOURCE_IDS) await db.write(id, success(id));
  const before = (await db.readAll()).value;
  const cycle = Acquisition.create({ enablement: Acquisition.ENABLEMENT, store: db, fetchImpl: F.transport({ [S.INDEX_URL]: u => F.response(u, null, 500) }).fetchImpl });
  const r = await cycle.acquireOne(S.SOURCE_ID, "2026-10-07", F.AT);
  assert.equal(r.diagnosticClass, "network_failure"); assert.equal((await db.read(S.SOURCE_ID)).value.lastOutcome, "failure");
  assert.deepEqual((await db.readAll()).value.filter(s => s.sourceId !== S.SOURCE_ID), before);
  assert.equal((await db.write(S.SOURCE_ID, success(Registry.HISTORICAL_SOURCE_IDS[0]))).status, "unavailable");
  assert.equal(db.diagnostics().openHandles, 0);
});
test("production policy still refuses MOF; isolated policy changes only the enablement gate", () => {
  const input = { sourceId: S.SOURCE_ID, requestedAt: F.AT, trigger: "startup", runtimeState: null, sessionState: { attemptCount: 0 },
    formalState: { databaseStatus: "absent", sourceCursorStatus: "absent", lastAcceptedAt: null, schemaStatus: "compatible", securityStatus: "clear" } };
  assert.equal(Policy.evaluateSourceUpdate(input).reason, "acquisition_disabled");
  const isolated = Policy.createIsolated13Policy(); assert.equal(isolated.evaluateSourceUpdate(input).eligible, true);
  for (const id of Registry.HISTORICAL_SOURCE_IDS) assert.deepEqual(isolated.evaluateSourceUpdate({ ...input, sourceId: id }), Policy.evaluateSourceUpdate({ ...input, sourceId: id }));
});
test("13-source coordinator leaves same-day twelve rows unchanged and makes MOF one source task", async () => {
  const db = store(), t = F.transport(); for (const id of Registry.HISTORICAL_SOURCE_IDS) await db.write(id, success(id));
  const before = (await db.readAll()).value;
  const runner = Acquisition.create({ enablement: Acquisition.ENABLEMENT, fetchImpl: t.fetchImpl, store: db, now: () => F.AT });
  const first = await runner.cycle(); assert.equal(first.sourceResults.length, 13); assert.equal(first.requests, 3);
  assert.equal(first.sourceConcurrency <= 3, true);
  assert(first.sourceResults.filter(s => s.sourceId !== S.SOURCE_ID).every(s => s.reason === "already_succeeded_today"));
  assert.deepEqual((await db.readAll()).value.filter(s => s.sourceId !== S.SOURCE_ID), before);
  const second = await runner.cycle(); assert.equal(second.requests, 0); assert.equal(t.requests(), 3);
  assert(second.sourceResults.every(s => s.reason === "already_succeeded_today"));
});
test("JST midnight policy parity including UTC cross-day and failure cooldown", () => {
  const policy = Policy.createIsolated13Policy(), state = success(S.SOURCE_ID);
  state.lastSuccessAt = state.lastAttemptAt = "2026-10-06T14:59:00.000Z";
  const input = { sourceId: S.SOURCE_ID, trigger: "startup", runtimeState: state, sessionState: { attemptCount: 0 },
    formalState: { databaseStatus: "absent", sourceCursorStatus: "absent", lastAcceptedAt: null, schemaStatus: "compatible", securityStatus: "clear" } };
  assert.equal(policy.evaluateSourceUpdate({ ...input, requestedAt: "2026-10-06T14:59:59.000Z" }).reason, "already_succeeded_today");
  assert.equal(policy.evaluateSourceUpdate({ ...input, requestedAt: "2026-10-06T15:00:00.000Z" }).eligible, true);
  const failed = { ...state, lastAttemptAt: F.AT, lastOutcome: "failure", lastDiagnosticClass: "network_failure", retryAfter: State.retryAfterFor("network_failure", F.AT) };
  assert.equal(policy.evaluateSourceUpdate({ ...input, runtimeState: failed, requestedAt: "2026-10-07T00:30:00.000Z" }).decision, "cooldown");
});
test("native package harness is import-only, temp-only and uses native Runtime State store", () => {
  const h = require("../scripts/marketCalendarG13aIsolated.js"); assert.equal(typeof h.runNative, "function");
  const code = fs.readFileSync(path.join(__dirname, "../scripts/marketCalendarG13aIsolated.js"), "utf8");
  assert.match(code, /meta\.name/); assert.match(code, /meta\.version/); assert.match(code, /length.*sha256|byteLength/);
  assert.match(code, /marketCalendarRuntimeStateStore\.js/);
  assert.doesNotMatch(code, /setUserAgent|user-agent['"]\s*:|app\.getPath\(['"]userData|firstProductionWriteExecutor/);
});
test("Electron store setup returns only cloneable undefined, never a function-bearing capability", () => {
  const vm = require("node:vm"), h = require("../scripts/marketCalendarG13aIsolated.js");
  const context = vm.createContext({ indexedDB: {}, OptionMapCalendarRuntimeStateStore: {
    createRuntimeStateStore: () => ({ read: async () => null }) } });
  const result = vm.runInContext(h.STORE_SETUP_SCRIPT, context);
  assert.equal(result, undefined); assert.equal(structuredClone(result), undefined);
  assert.equal(typeof context.__g13Store.read, "function");
});
test("S1-S7 13 rows, MOF new plan but permission unavailable, historical plans byte-identical", async () => {
  const f = await F.fixture(), before = await require("../js/marketCalendarRuntime/automaticFormalShadow.js").evaluate({
    sourceResults: f.sources.filter(s => s.sourceId !== S.SOURCE_ID), before: structuredClone(f.snapshot),
    schemaFingerprint: require("../js/marketCalendarHistory/productionSchemaV1.js").EXPECTED_FINGERPRINT });
  const result = await evaluate(f), row = result.sourceRows.find(s => s.sourceId === S.SOURCE_ID);
  assert.equal(result.sourceRows.length, 13); assert.equal(row.new, 11); assert.equal(row.changed, 0); assert.equal(row.notEvaluated, 0);
  assert.equal(row.writeAllowed, false); assert.equal(row.permission, "unavailable_not_approved"); assert.equal(row.shadowPlanGenerated, true);
  assert.equal(row.counts.eventEntryCreate, 11); assert.equal(row.counts.semanticRevisionCreate, 11);
  assert.deepEqual(result.plans.filter(p => p.sourceId !== S.SOURCE_ID), before.plans);
  assert.equal(result.sourceRows.find(s => s.sourceId === "jp-boj-calendar").eligible, false);
  assert.deepEqual(require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js").policyFor(3).global.permittedSources,
    ["jp-esri-machinery-orders-calendar"]);
  for (const field of ["snapshotValidationCount", "fullSnapshotSortCount", "fullSnapshotHashCount"]) assert.equal(result.performance[field], 1);
  assert.equal(result.performance.fullMaterialCopies, 0); assert.equal(Cycle.activeCount(), 0);
});
test("F6 old safety states validate without MOF; missing MOF is not global corruption", () => {
  const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js"), E = require("../js/marketCalendarHistory/formalWriterSafetyEvaluator.js");
  const File = require("../js/marketCalendarHistory/writerSafetyFileSchema.js"), V = require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js");
  const legacy = File.build(null, E.createMemorySafety(), null, "provision_disabled", A.PRODUCTION_POLICY);
  assert.equal(File.validate(legacy).valid, true); assert.equal(V.validateEnvelope(V.migrate(legacy, A.hash("test"))).valid, true);
  assert.equal(A.SOURCE_IDS.length, 12); assert.equal(A.SOURCE_IDS.includes(S.SOURCE_ID), false);
});
test("F7 schema/integrity failures are global unsafe, with disposed cycle", async () => {
  const f = await F.fixture(); f.snapshot.entries[0].activeRevisionKey = "orphan";
  assert.equal((await evaluate(f)).status, "unsafe");
  const g = await F.fixture(); assert.equal((await Shadow.evaluate({ sourceResults: g.sources, snapshot: g.snapshot, schemaFingerprint: "wrong" })).status, "unsafe");
  assert.equal(Cycle.activeCount(), 0);
});
test("MOF ordering is deterministic and changes no memory plan identity", async () => {
  const a = await F.fixture(), b = structuredClone(a); b.sources.reverse(); b.sources.forEach(s => s.canonicalRecords.reverse());
  const x = await evaluate(a), y = await evaluate(b); assert.deepEqual(x.plans, y.plans);
});
test("isolated modules are unreachable from main/startup/manual and never import writer executors", () => {
  for (const name of ["calendar13Acquisition", "calendar13Shadow", "mofJgbVariableAdapter"]) {
    const code = fs.readFileSync(path.join(__dirname, "../js/marketCalendarIsolated", name + ".js"), "utf8");
    assert.doesNotMatch(code, /ControlledWriter|WriteExecutor|writerSafety.*Store|localStorage/);
    for (const entry of ["../main.js", "../preload.js", "../js/marketCalendarRuntime/calendarManualCheckService.js"])
      assert.doesNotMatch(fs.readFileSync(path.join(__dirname, entry), "utf8"), new RegExp(name));
  }
});
