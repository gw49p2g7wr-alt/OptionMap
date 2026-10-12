"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const Runtime = require("../js/marketCalendarRuntime/automaticFormalShadowRuntime.js");
const Policy = require("../js/marketCalendarRuntime/routeReevaluationPolicy.js");
const Routes = require("../js/marketCalendarRuntime/calendarRouteAuthority.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Cycle = require("../js/marketCalendarRuntime/formalShadowCycle.js");
const Harness = require("../scripts/marketCalendarE4eRuntimeShadow.js");
const F = require("./fixtures/marketCalendar/automaticShadowFixture.js");
const AT = F.FRESH, SOURCE = "jp-esri-machinery-orders-calendar";
function completed(sourceId, at = F.OLD) {
  const old = { sourceId, lastAttemptAt: at, lastSuccessAt: null, lastOutcome: "failure",
    retryAfter: sourceId === "us-bls-calendar" ? new Date(Date.parse(at) + 3600000).toISOString() : null,
    lastHttpStatus: sourceId === "us-bls-calendar" ? null : 404,
    lastDiagnosticClass: Policy.APPROVALS[sourceId].allowedDiagnostic, coordinatorVersion: 1 };
  const evaluation = Policy.evaluate({ sourceId, state: old, authority: Routes.PRODUCTION_AUTHORITY, requestedAt: at });
  assert.equal(evaluation.eligible, true);
  const state = Policy.reserveState(old, evaluation, at);
  const result = Policy.completeState({ state, token: Policy.reservationToken(state), authority: Routes.PRODUCTION_AUTHORITY,
    result: { lastAttemptAt: at, lastOutcome: "success", lastHttpStatus: 200, lastDiagnosticClass: null }, completedAt: at });
  assert.equal(result.valid, true); return result.state;
}
async function setup({ f, readFailure = false, sameDay = false } = {}) {
  f ||= await F.fixture(); let calls = 0, reads = 0, writes = 0;
  const cpiSource = f.sources.find(s => s.sourceId === "jp-stat-cpi");
  const tokyo = await F.event(cpiSource.sourceId, AT, { referencePeriod: cpiSource.canonicalRecords[0].logical.referencePeriod,
    eventType: "JP_TOKYO_CPI", scope: "tokyo", edition: "preliminary" });
  const stores = {}, states = new Map();
  for (const [name, id] of [["labor", "jp-stat-labor"], ["cpi", "jp-stat-cpi"], ["bls", "us-bls-calendar"]]) {
    states.set(id, completed(id, sameDay ? AT : F.OLD));
    stores[name] = { read: async () => ({ status: "ok", value: structuredClone(states.get(id)) }),
      reserveReevaluation: async () => { throw Error("new_reservation_forbidden"); },
      completeReevaluation: async () => { throw Error("new_reservation_forbidden"); },
      completeActiveAcquisition: async input => { writes++;
        const checked = Policy.normalStateUpdate({ ...input, state: states.get(id), authority: Routes.PRODUCTION_AUTHORITY });
        assert.equal(checked.valid, true, checked.reason); states.set(id, checked.state);
        return { status: "ok", state: checked.state }; } };
  }
  const candidate = s => ({ candidateStatus: s.candidateStatus, formalEligible: s.candidateStatus === "available",
    canonicalRecords: s.canonicalRecords, candidateIdentity: s.candidateIdentity, recordCount: s.canonicalRecords.length,
    parserStatus: "success", canonicalDiagnostics: [] });
  const runtime = Runtime.createRuntime({ stores, now: () => AT, fetchImpl: async () => { throw Error("unexpected_transport"); },
    acquire: async request => { calls++; const s = f.sources.find(s => s.sourceId === request.sourceId);
      return { success: s.acquisitionOutcome === "complete", sourceId: s.sourceId, reason: "network_failure",
        documents: s.documentHealth.map(d => ({ role: d.role, httpStatus: d.httpStatus, redirects: [] })) }; },
    builder: { buildCalendarCandidate: async ({ sourceId }) => candidate(f.sources.find(s => s.sourceId === sourceId)) },
    simulator: { simulateCalendarTransition: async () => ({ simulationStatus: "preview", commitOutcome: "writer_disabled" }) },
    adapterFactory: () => ({ acquire: async ({ sourceId }) => { calls++; const s = f.sources.find(s => s.sourceId === sourceId);
      let c = candidate(s);
      if (sourceId === "jp-stat-cpi") c = { ...c, canonicalRecords: [...c.canonicalRecords, tokyo], recordCount: c.recordCount + 1 };
      return { ...F.envelope(s), candidateEnvelope: c,
        documentHealth: s.documentHealth.map(d => ({ ...d, candidateCount: 1 })),
        coverage: { coverageState: "sufficient", laneAssessments: ["national", "tokyo"].map(lane => ({ lane, coverageState: "sufficient" })),
          roleCoverage: ["cpi", "ppi", "employment_situation", "jolts"].map(role => ({ role, state: "sufficient" })) } }; } }),
    readFormal: async () => { reads++; if (readFailure) throw Error("read_failed");
      return { status: "ok", snapshot: structuredClone(f.snapshot), schemaFingerprint: Schema.EXPECTED_FINGERPRINT,
        audit: { readonly: 1, readwrite: 0, writes: 0, handles: 0 } }; } });
  return { runtime, f, states, stores, counts: () => ({ calls, reads, writes }) };
}
const shadow = f => f.runtime.diagnostics().shadow;
const row = (r, id = SOURCE) => r.sourceRows.find(s => s.sourceId === id);
for (const trigger of ["startup", "manual"]) test(`R1/R2 ${trigger} real service composition reuses candidates`, async () => {
  const f = await setup(); const r = await f.runtime.check({ trigger, sourceIds: [SOURCE] });
  assert.equal(r.state, "success"); assert.equal(shadow(f).status, "evaluated"); assert.equal(row(shadow(f)).eligible, true);
  assert.deepEqual(f.counts(), { calls: 1, reads: 1, writes: 0 });
  assert.equal(Object.hasOwn(r, "shadow"), false); assert.equal(JSON.stringify(r).includes("planIdentity"), false);
});
test("R3 same acquired material startup/manual identities match", async () => {
  const f = await setup(); await f.runtime.check({ trigger: "startup", sourceIds: [SOURCE] }); const a = row(shadow(f));
  await f.runtime.check({ trigger: "manual", sourceIds: [SOURCE] }); const b = row(shadow(f));
  for (const key of ["candidateIdentity", "acquisitionIdentity", "planIdentity"]) assert.equal(a[key], b[key]);
});
test("R4 separate acquisition creates a separate plan without semantic change", async () => {
  const f = await setup(); await f.runtime.check({ sourceIds: [SOURCE] }); const a = row(shadow(f));
  const s = f.f.sources.find(s => s.sourceId === SOURCE);
  s.canonicalRecords[0] = await F.event(SOURCE, "2026-10-02T00:00:00.000Z", { referencePeriod: "2000-01" });
  await f.runtime.check({ sourceIds: [SOURCE] }); const b = row(shadow(f));
  assert.equal(b.unchanged, 1); assert.notEqual(a.acquisitionIdentity, b.acquisitionIdentity); assert.notEqual(a.planIdentity, b.planIdentity);
});
test("R5 same-day alternative skip: no capture/read/Run/Observation replay", async () => {
  const f = await setup({ sameDay: true }); const before = structuredClone([...f.states]);
  const r = await f.runtime.check({ trigger: "startup", sourceIds: [...f.states.keys()] });
  assert.equal(r.successfulSourceCount, 3); assert.ok(r.sources.every(s => s.planningDecision === "skip"));
  assert.deepEqual(f.counts(), { calls: 0, reads: 0, writes: 0 }); assert.deepEqual([...f.states], before);
  assert.equal(shadow(f).status, "skipped"); assert.ok(Object.values(shadow(f).aggregatePlannedCounts).every(n => n === 0));
});
for (const outcome of ["failed", "partial"]) test(`R6/R7 ${outcome} BLS keeps successful candidates but mutation/cursor 0`, async () => {
  const f = await setup(); const s = f.f.sources.find(s => s.sourceId === "us-bls-calendar");
  s.acquisitionOutcome = outcome; s.failedRoles = ["jolts"];
  const r = await f.runtime.check({ sourceIds: [SOURCE, s.sourceId] });
  const report = shadow(f), b = row(report, s.sourceId);
  assert.equal(r.state, "partial"); assert.equal(b.acquisition, outcome);
  assert.ok(Object.values(b.counts).every(n => n === 0)); assert.equal(b.retainedCandidateKeys.length, 1);
  assert.equal(row(report).eligible, true); assert.equal(f.states.get(s.sourceId).lastOutcome, "failure");
});
test("R8 BOJ compared/ineligible, not acquisition failure", async () => {
  const f = await setup(); const r = await f.runtime.check({ sourceIds: ["jp-boj-calendar", SOURCE] });
  assert.equal(r.state, "success"); const b = row(shadow(f), "jp-boj-calendar");
  assert.equal(b.reason, "writer_ineligible_identity_transition"); assert.equal(b.unchanged, 1);
  assert.ok(Object.values(b.counts).every(n => n === 0)); assert.equal(row(shadow(f)).eligible, true);
});
test("R9/R10 changed source plan cannot authorize writes, other source continues", async () => {
  const f = await setup(), id = "us-bea-calendar";
  const original = f.f.sources.find(s => s.sourceId === id).canonicalRecords[0];
  f.f.sources.find(s => s.sourceId === id).canonicalRecords[0] = await F.event(id, AT,
    { referencePeriod: original.logical.referencePeriod, titleJa: "changed" });
  await f.runtime.check({ sourceIds: [id, SOURCE] }); const b = row(shadow(f), id);
  assert.equal(b.changed, 1); assert.equal(b.eligible, false); assert.equal(b.productionWriteEligible, false);
  assert.equal(b.reason, "unsupported_changed"); assert.equal(row(shadow(f)).eligible, true);
});
test("R11 actual normal Runtime State completion remains success after shadow failure", async () => {
  const f = await setup({ readFailure: true }); const r = await f.runtime.check({ sourceIds: ["jp-stat-labor"] });
  assert.equal(r.state, "success"); assert.equal(f.states.get("jp-stat-labor").lastOutcome, "success");
  assert.equal(shadow(f).status, "unsafe"); assert.deepEqual(f.counts(), { calls: 1, reads: 1, writes: 1 });
});
test("R12/R13 static runtime graph has no writer/core execution or Formal readwrite", () => {
  const visited = new Set();
  function visit(file) {
    if (visited.has(file)) return; visited.add(file); const text = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(file, /(?:firstProductionWriteExecutor|formalControlledWriterCore|productionHistoryWriter|existingDbControlledWriter)/);
    for (const match of text.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
      const child = path.resolve(path.dirname(file), match[1]); if (fs.existsSync(child)) visit(child);
    }
  }
  visit(path.resolve(__dirname, "../js/marketCalendarRuntime/automaticFormalShadowRuntime.js"));
  const reader = fs.readFileSync(path.resolve(__dirname, "../js/marketCalendarRuntime/formalShadowElectronRead.js"), "utf8");
  assert.doesNotMatch(reader, /transaction\([^\n]*["']readwrite/);
});
test("R14 capture/plan adds zero acquisition requests", async () => {
  for (const readFailure of [false, true]) {
    const f = await setup({ readFailure }); await f.runtime.check({ sourceIds: [SOURCE, "jp-stat-labor", "us-bls-calendar"] });
    assert.equal(f.counts().calls, 3); assert.equal(f.counts().reads, 1); assert.equal(shadow(f).writerExecution, 0);
  }
});
test("R15 integrity/schema failure globally unsafe without changing acquisition", async () => {
  for (const fault of ["duplicate", "orphan", "active"]) {
    const f = await setup();
    if (fault === "duplicate") f.f.snapshot.entries.push(f.f.snapshot.entries[0]);
    if (fault === "orphan") f.f.snapshot.evidence[0].revisionKey = "missing";
    if (fault === "active") f.f.snapshot.entries[0].activeRevisionKey = "missing";
    const r = await f.runtime.check({ sourceIds: [SOURCE] }); assert.equal(r.state, "success");
    assert.equal(shadow(f).status, "unsafe"); assert.equal(shadow(f).failureScope, "global_suspend_candidate");
  }
});
test("R16 current-size runtime overhead: one snapshot validation/sort/hash per cycle", async () => {
  const f = await setup({ f: await F.fixture({ perSource: 21, historyRuns: 3 }) });
  await f.runtime.check({ sourceIds: [SOURCE, "us-bea-calendar"] }); const d = f.runtime.diagnostics(), p = d.shadow.performance;
  for (const k of ["snapshotValidationCount", "fullSnapshotSortCount", "fullSnapshotHashCount"]) assert.equal(p[k], 1);
  assert.equal(p.fullMaterialCopies, 0); assert.ok(p.elapsedMs < 5000);
  console.log(JSON.stringify({ benchmark: "runtime-current", readonlyMs: d.formalRead.latencyMs, planningMs: p.elapsedMs }));
});
test("R17 cleanup and singleflight leave no active cycle/cache, next request has fresh read", async () => {
  const f = await setup(); const request = { sourceIds: [SOURCE] };
  const a = f.runtime.check(request), b = f.runtime.check(request); assert.equal(a, b); await a;
  assert.equal(f.runtime.diagnostics().activeCycles, 0); assert.equal(Cycle.activeCount(), 0);
  assert.equal(shadow(f).performance.cacheDisposed, true); await f.runtime.check(request); assert.equal(f.counts().reads, 2);
});
test("main startup/manual share a single fixed adapter; IPC has no new shadow capability", () => {
  const main = fs.readFileSync(path.resolve(__dirname, "../main.js"), "utf8");
  assert.equal((main.match(/normalAcquisitionRuntime.create/g) || []).length, 1);
  assert.match(main, /runtimeStateOwner: "renderer"/);
  assert.match(main, /calendarShadowRuntime.check\(request\)/); assert.doesNotMatch(main, /return.*\.diagnostics\(/);
  assert.doesNotMatch(fs.readFileSync(path.resolve(__dirname, "../preload.js"), "utf8"), /automaticFormalShadow/);
});
test("all 12 runtime sources capture once; 11 eligible plans, BOJ comparison only", async () => {
  const f = await setup(); const r = await f.runtime.check({ trigger: "manual" });
  assert.equal(r.successfulSourceCount, 12); assert.equal(f.counts().calls, 12);
  assert.equal(shadow(f).eligibleCount, 11); assert.equal(shadow(f).sourceRows.length, 12);
  assert.equal(f.counts().writes, 3); assert.equal(Cycle.activeCount(), 0);
});
test("native harness instrumentation detects and blocks Formal mutations before native execution", async () => {
  const IDB = require("fake-indexeddb"), vm = require("node:vm");
  const Harness = require("../scripts/marketCalendarE4eRuntimeShadow.js");
  const factory = new IDB.IDBFactory(), name = Schema.DATABASE_NAME, store = "marketCalendarEventEntries";
  const seed = await new Promise((resolve, reject) => { const r = factory.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(store, { keyPath: "eventKey" });
    r.onsuccess = () => resolve(r.result); r.onerror = reject; }); seed.close();
  // Isolated prototype holders avoid monkey-patching other tests' fake IDB classes.
  const context = vm.createContext({ indexedDB: factory, IDBDatabase: IDB.IDBDatabase,
    IDBObjectStore: IDB.IDBObjectStore, Storage: class { setItem() {} removeItem() {} clear() {} } });
  try {
    vm.runInContext(`(${Harness.installAudit.toString()})(${JSON.stringify(name)}, 'runtime', [${JSON.stringify(store)}])`, context);
    const db = await new Promise((resolve, reject) => { const r = factory.open(name); r.onsuccess = () => resolve(r.result); r.onerror = reject; });
    assert.throws(() => db.transaction(store, "readwrite"), /formal_readwrite_forbidden/);
    const tx = db.transaction(store, "readonly");
    assert.throws(() => tx.objectStore(store).put({ eventKey: "forbidden" }), /formal_write_forbidden/);
    const result = tx.objectStore(store).getAll();
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = reject; });
    assert.deepEqual(result.result, []); db.close();
    const audit = context.__runtimeShadowAudit;
    assert.equal(audit.formal.readwrite, 1); assert.equal(audit.formal.writes, 1);
    assert.equal(audit.handles, 0); assert.equal(audit.pending, 0); assert.equal(audit.listeners, 0);
  } finally { context.__runtimeShadowDetach?.(); }
});
for (const outcome of ["failed", "partial"]) test(`D1 ${outcome} compact FAIL envelope retains all 12 including NYSE and other plans`, async () => {
  const f = await setup(), s = f.f.sources.find(s => s.sourceId === "us-bls-calendar");
  s.acquisitionOutcome = outcome; s.failedRoles = ["jolts"];
  s.documentHealth[0].diagnostics = ["request_timeout"];
  const acquisition = await f.runtime.check({ trigger: "manual" });
  const summary = Harness.compactSummary(acquisition, f.runtime.diagnostics());
  assert.equal(summary.acquisition.state, "partial"); assert.equal(summary.sourceRows.length, 12);
  assert.equal(new Set(summary.sourceRows.map(s => s.sourceId)).size, 12);
  const bls = row(summary, s.sourceId), nyse = row(summary, "us-nyse-market-holidays");
  assert.equal(bls.acquisition, outcome); assert.equal(bls.failureClass, "timeout");
  assert.ok(bls.failureReasons.includes("request_timeout")); assert.deepEqual(bls.failedRoles, ["jolts"]);
  assert.equal(nyse.comparisonReached, true); assert.equal(nyse.eligible, true);
  assert.ok(Object.values(bls.counts).every(n => n === 0)); assert.equal(row(summary, "jp-boj-calendar").eligible, false);
  assert.equal(summary.eligibleCount, 10); assert.equal(summary.metricsComplete, true);
  assert.equal(summary.formalRead.audit.readonly, 1); assert.equal(summary.writerExecution, 0);
  const serialized = JSON.stringify(summary); assert.ok(serialized.length < 24000);
  for (const forbidden of ["canonicalRecords", "retainedCandidateKeys", "createEntries", "rawBody", '"plans":'])
    assert.equal(serialized.includes(forbidden), false);
  assert.equal(f.counts().calls, 12); assert.equal(f.counts().writes, 3);
});
test("D2 failed Formal read retains elapsed metrics and source acquisition success without invented comparison", async () => {
  const f = await setup({ readFailure: true }); const acquisition = await f.runtime.check({ trigger: "manual" });
  const s = Harness.compactSummary(acquisition, f.runtime.diagnostics());
  assert.equal(s.shadowStatus, "unsafe"); assert.equal(s.acquisition.state, "success");
  assert.equal(s.formalRead.status, "threw"); assert.equal(s.formalRead.reason, "formal_read_threw");
  assert.equal(s.metrics.readonlyAttempted, true); assert.equal(s.metrics.planningAttempted, false);
  assert.equal(s.metricsComplete, true); assert.ok(s.metrics.readonlyMs >= 0);
  assert.ok(s.sourceRows.every(r => r.formalActive === null && !r.comparisonReached && !r.eligible));
  assert.equal(s.sourceRows.length, 12); assert.equal(f.states.get("jp-stat-labor").lastOutcome, "success");
});
test("D3 skip metrics explicitly mark unattempted phases; missing metrics cannot satisfy Gate", async () => {
  const f = await setup({ sameDay: true }); const a = await f.runtime.check({ trigger: "startup", sourceIds: [...f.states.keys()] });
  const summary = Harness.compactSummary(a, f.runtime.diagnostics());
  assert.equal(summary.metricsComplete, true); assert.equal(summary.metrics.readonlyMs, 0);
  assert.equal(summary.metrics.planningMs, 0); assert.equal(summary.metrics.readonlyAttempted, false);
  assert.equal(row(summary, "jp-stat-cpi").acquisition, "skipped");
  assert.equal(Harness.compactSummary(null, null).metricsComplete, false);
});
test("D4 integrity failure still returns all source reasons/counts with latency and zero plans", async () => {
  const f = await setup(); f.f.snapshot.entries.push(f.f.snapshot.entries[0]);
  const a = await f.runtime.check({ trigger: "manual" }), s = Harness.compactSummary(a, f.runtime.diagnostics());
  assert.equal(s.shadowReason, "formal_integrity_invalid"); assert.equal(s.sourceRows.length, 12);
  assert.equal(s.metricsComplete, true); assert.ok(s.sourceRows.every(r => !r.eligible && r.formalActive === null));
  assert.ok(Object.values(s.aggregatePlannedCounts).every(n => n === 0));
});
test("D4b acquisition exception after a previous cycle never leaks the previous comparison/plans", async () => {
  const f = await setup(); await f.runtime.check({ sourceIds: [SOURCE] });
  assert.equal(shadow(f).status, "evaluated");
  f.stores.labor.read = async () => { throw Error("reader_exception"); };
  await assert.rejects(f.runtime.check({ sourceIds: ["jp-stat-labor"] }), /reader_exception/);
  const summary = Harness.compactSummary(null, f.runtime.diagnostics());
  assert.equal(summary.shadowReason, "acquisition_cycle_failed"); assert.equal(summary.sourceRows.length, 12);
  assert.ok(summary.sourceRows.every(r => !r.comparisonReached && !r.eligible));
  assert.equal(summary.metricsComplete, true); assert.equal(f.runtime.diagnostics().activeCycles, 0);
});
test("D5 source diagnostic projection excludes raw bytes/body/canonical material and unsafe reason text", () => {
  const r = Runtime.acquisitionDiagnostic({ sourceId: SOURCE, acquisitionOutcome: "failed",
    diagnostics: ["body_timeout", "secret/path?x=y"], rawBody: "secret", candidateEnvelope: { canonicalRecords: [{}] },
    documentHealth: [{ role: "primary", parserInput: new Uint8Array([1]), diagnostics: ["mime_invalid"] }] });
  assert.equal(r.candidateCount, 1); assert.deepEqual(r.diagnostics, ["body_timeout"]);
  assert.doesNotMatch(JSON.stringify(r), /secret|parserInput|canonicalRecords/);
});
const BR = require("../js/marketCalendarIsolated/blsFixedRoute.js"), BF = require("./fixtures/marketCalendar/blsFixedFixture.js");
function fixtureTransport(fault) {
  let count = 0;
  return { count: () => count, fetch: async (url, settings) => {
    count++; const role = BR.ROLES.find(r => r.url === url); assert.ok(role);
    assert.equal(settings.redirect, "manual"); assert.equal(settings.credentials, "omit");
    assert.deepEqual(settings.headers, { accept: "text/html" });
    if (role.role === "jolts" && fault === "network") throw Error("secret/transport");
    if (role.role === "jolts" && fault === "timeout") throw Object.assign(Error("secret/timeout"), { code: "request_timeout" });
    const bad = role.role === "jolts";
    const body = bad && fault === "utf8" ? new Uint8Array([0xc3, 0x28]) : bad && fault === "parser" ?
      "<html>no schedule</html>" : BF.html(role.role).replace('<meta charset="utf-8">', "");
    return new Response(body, { status: bad && fault === "http" ? 503 : 200, headers: {
      "content-type": bad && fault === "mime" ? "text/plain" : "text/html" } });
  } };
}
test("D6 BLS diagnostic uses production adapter, 4 requests only, bounded bytes + real charset/parser/coverage", async () => {
  const t = fixtureTransport(), d = await Harness.diagnoseBls(t.fetch, "2026-09-26");
  assert.equal(d.acquisitionOutcome, "complete"); assert.equal(t.count(), 4); assert.equal(d.rows.length, 4);
  for (const r of d.rows) { assert.equal(r.httpStatus, 200); assert.equal(r.charset.evidence.resolutionBasis, "source_policy_strict_utf8");
    assert.equal(r.strictUtf8, "valid"); assert.equal(r.parser, "success"); assert.ok(r.byteLength > 0);
    assert.equal(r.coverage.state, "sufficient"); assert.deepEqual(r.failureReasons, []); }
  assert.equal(d.candidateCount, 13); assert.equal(d.formalAccess, 0); assert.equal(d.runtimeStateAccess, 0);
  assert.equal(d.resources.bls.activeTasks, 0); assert.equal(d.resources.bls.activeTimers, 0);
  assert.doesNotMatch(JSON.stringify(d), /chunks|parserInput|canonicalRecords|<html/);
});
for (const [fault, reason] of [["http", "http_status_rejected"], ["network", "network_failure"],
  ["timeout", "request_timeout"],
  ["utf8", "encoding_utf8_strict_decode_failed"], ["mime", "mime_invalid"], ["parser", "release_identity_invalid"]])
  test(`D7 diagnostic ${fault} exact role reason survives; no retry or extra body request`, async () => {
    const t = fixtureTransport(fault), d = await Harness.diagnoseBls(t.fetch, "2026-09-26"), r = d.rows[3];
    assert.equal(t.count(), 4); assert.equal(d.acquisitionOutcome, fault === "parser" ? "complete" : "partial");
    assert.deepEqual(d.failedRoles, ["jolts"]);
    assert.ok(r.failureReasons.includes(reason), JSON.stringify(r));
    assert.equal(d.rows[0].parser, "success"); assert.equal(d.retryCount, 0);
    assert.equal(d.pendingTransport, 0); assert.equal(d.resources.bls.activeTasks, 0);
    assert.equal(d.pendingBody, 0); assert.equal(d.readers, 0); assert.equal(d.productionAcceptanceEligible, false);
    if (["http", "network", "timeout", "mime"].includes(fault)) assert.equal(r.charset.status, "not_evaluated");
    if (fault === "utf8") assert.equal(r.strictUtf8, "invalid");
  });
test("D2d1 native launch uses unchanged OptionMap package authority, not a hand-built UA", () => {
  const metadata = require("../package.json"), identity = Harness.nativeLaunchIdentity();
  assert.deepEqual(identity, { name: metadata.name, version: metadata.version, main: "entry.cjs" });
  const original = fs.readFileSync(path.resolve(__dirname, "../scripts/marketCalendarBlsFixedAcceptance.js"), "utf8");
  assert.match(original, /name: meta\.name, version: meta\.version/);
  const current = fs.readFileSync(path.resolve(__dirname, "../scripts/marketCalendarE4eRuntimeShadow.js"), "utf8");
  assert.doesNotMatch(current, /setUserAgent|userAgentFallback\s*=|setProxy|rejectUnauthorized/);
  assert.match(current, /spawn\(require\("electron"\), \[entry, `--runtime-root=/);
  assert.doesNotMatch(current, /spawn\(require\("electron"\), \[__filename/);
});
test("D2d2 package entry is temp-only, requires existing worker once, preserves compact failure envelope", () => {
  const os = require("node:os");
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "optionmap-e4e-runtime-"));
  try {
    fs.writeFileSync(path.join(root, "isolated-only"), "fixture");
    assert.equal(Harness.prepareNativeEntry(root), root);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")), Harness.nativeLaunchIdentity());
    const entry = fs.readFileSync(path.join(root, "entry.cjs"), "utf8");
    assert.equal(entry, `require(${JSON.stringify(path.resolve(__dirname, "../scripts/marketCalendarE4eRuntimeShadow.js"))});\n`);
    assert.equal((entry.match(/require\(/g) || []).length, 1);
    assert.throws(() => Harness.prepareNativeEntry(path.dirname(root)), /temp_context_required/);
    const summary = Harness.compactSummary(null, null);
    assert.equal(summary.sourceRows.length, 12); assert.equal(summary.metricsComplete, false);
  } finally { fs.rmSync(root, { recursive: true }); }
});
