"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"),
  fs = require("node:fs"), path = require("node:path");
const { IDBFactory } = require("fake-indexeddb");
const A = require("../js/marketCalendarRuntime/calendarRouteAuthority.js");
const S = require("../js/storage/marketCalendarRuntimeStateStore.js");
const E = require("../js/marketCalendarRuntime/cpiRuntimeStateElectron.js");
const L = require("../js/marketCalendarRuntime/cpiProductionCheck.js");
const F = require("./fixtures/marketCalendar/estatHtmlFixture.js");
const Integration = require("../js/marketCalendarRuntime/calendarRuntimeStateIntegration.js");
const PROTECTED = ["jp-stat-labor", "us-bls-calendar"];
const ID = L.ID, AT = "2026-09-28T03:00:00.000Z";
const old = sourceId => ({ sourceId, lastAttemptAt: "2026-09-27T03:00:00.000Z", lastSuccessAt: null,
  lastOutcome: "failure", retryAfter: null, lastDiagnosticClass: "http_404", lastHttpStatus: 404, coordinatorVersion: 1 });
async function setup({ factory = new IDBFactory(), gate, failure = false, missingLane = null, seedAbsent = true } = {}) {
  const seed = S.createRuntimeStateStore({ indexedDB: factory, targetEnvironment: "isolated_test" });
  if (seedAbsent && !(await factory.databases()).length) for (const id of [ID, ...PROTECTED]) await seed.write(id, old(id));
  let authority = A.PRODUCTION_AUTHORITY, requests = 0;
  const context = vm.createContext({ indexedDB: factory, document: {}, structuredClone, setTimeout, clearTimeout,
    console, Date, URL }); context.window = context;
  const store = E.createCpiRuntimeStateElectron({ getAuthority: () => authority, webContents: {
    executeJavaScriptInIsolatedWorld: async (world, scripts) => {
      assert.equal(world, 1741); return structuredClone(await vm.runInContext(scripts[0].code, context));
    }
  } });
  const legacyRequests = [], create = () => L.createCpiProductionCheck({ store, now: () => AT,
    getAuthority: () => authority, legacyService: { check: async r => {
      legacyRequests.push(r); return { sources: r.sourceIds.map(sourceId => ({ sourceId, status: "success", acquisitionStatus: "not_attempted" })) };
    } }, fetchImpl: async (url, options) => {
      requests++; assert.equal(url, "https://www.e-stat.go.jp/release-calendar/statistics/00200573");
      assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "manual");
      assert.deepEqual(Object.keys(options.headers), ["accept"]);
      const saved = (await store.read()).value; assert.equal(saved.reevaluation.status, "reserved");
      if (gate) await gate;
      const body = F.page(ID, ["national", "tokyo"].filter(lane => lane !== missingLane).flatMap(lane =>
        ["08", "09", "10"].map((month, i) => F.monthly(ID, lane, `2026-${month}`, `2026-${["09", "10", "11"][i]}-15`))));
      return new Response(failure ? "not found" : body, { status: failure ? 404 : 200,
        headers: { "content-type": "text/html; charset=UTF-8" } });
    } });
  return { factory, seed, store, create, legacyRequests, service: create(), requests: () => requests,
    authority: value => { authority = value; } };
}
test("CPI activation matches generation 2 approval while Labor binding is unchanged", () => {
  for (const id of A.SOURCE_IDS) {
    const current = A.selectRoute({ sourceId: id, operation: "source-document-set" }, A.PRODUCTION_AUTHORITY);
    if (id === ID) { assert.equal(current.activationState, "alternative_active"); assert.equal(current.activationVersion, 2); }
    else if (id === "jp-stat-labor") { assert.equal(current.activationVersion, 2); assert.equal(current.routeIdentity, "f54eded9b30e759a8b85c850d9819ea24c944a6ad771ab477f9b60e543c2913e"); }
    else if (id !== "us-bls-calendar") assert.deepEqual(current.routeIdentity, A.selectRoute({ sourceId: id, operation: "source-document-set" }).routeIdentity);
  }
});
test("actual isolated-world storage bridge reserves old 404 before acquire and completes new route", async () => {
  const f = await setup(), r = await f.service.check({ sourceIds: [ID], trigger: "startup" });
  assert.equal(r.state, "success"); assert.equal(f.requests(), 1); assert.equal(r.sources[0].recordCount, 6);
  const state = (await f.store.read()).value;
  assert.equal(state.lastOutcome, "success"); assert.equal(state.lastSuccessAt, AT); assert.equal(state.retryAfter, null);
  assert.equal(state.reevaluation.status, "completed"); assert.equal(state.routeBinding.routeKind, "estat_release_calendar");
  assert.equal(state.reevaluation.previousRouteSummary.lastDiagnosticClass, "http_404");
  assert.ok(f.store.diagnostics().every(d => d.openHandles === 0 && d.databaseCreateAttempts === 0));
});
test("same-day reopened service skips with zero further acquisition and state writes", async () => {
  const f = await setup(); await f.service.check({ sourceIds: [ID], trigger: "startup" });
  const before = (await f.store.read()).value;
  const second = await setup({ factory: f.factory });
  const r = await second.service.check({ sourceIds: [ID], trigger: "startup" });
  assert.equal(r.sources[0].planningDecision, "skip"); assert.equal(second.requests(), 0);
  assert.equal(r.checkedAt, before.lastSuccessAt);
  assert.deepEqual((await second.store.read()).value, before);
  assert.ok(second.store.diagnostics().every(d => d.successfulWrites === 0));
});
test("startup/manual join one Promise; one reservation/acquisition/completion", async () => {
  let release; const gate = new Promise(r => { release = r; }), f = await setup({ gate });
  const a = f.service.check({ sourceIds: [ID], trigger: "startup" });
  const b = f.service.check({ sourceIds: [ID], trigger: "manual" }); assert.equal(a, b);
  release(); await a; assert.equal(f.requests(), 1);
  assert.equal(f.store.diagnostics().reduce((n, d) => n + d.successfulReservations, 0), 1);
});
test("Labor/BLS records unchanged by CPI and passed only to existing service", async () => {
  const f = await setup(); const before = (await f.seed.readAll()).states;
  await f.service.check({ trigger: "startup" });
  for (const id of PROTECTED) assert.deepEqual((await f.seed.read(id)).value, before[id]);
  assert.equal(f.legacyRequests[0].sourceIds.length, 11);
  assert.ok(f.legacyRequests[0].sourceIds.every(id => id !== ID));
  assert.equal(f.requests(), 1);
});
test("authority generation change during acquisition rejects late completion", async () => {
  let release; const gate = new Promise(r => { release = r; }), f = await setup({ gate });
  const pending = f.service.check({ sourceIds: [ID], trigger: "startup" });
  for (let i = 0; !f.requests() && i < 100; i++) await new Promise(r => setImmediate(r));
  assert.equal(f.requests(), 1);
  f.authority(A.createAuthoritySnapshot({ [ID]: { activationState: "alternative_active", activationVersion: 3 } }));
  release(); const r = await pending;
  assert.equal(r.sources[0].reasonClass, "stale_route_result");
  assert.equal((await f.store.read()).value.reevaluation.status, "reserved");
});
test("absent or interrupted state cannot acquire/create or automatically retry", async () => {
  const f = await setup(); await f.store.reserveReevaluation({ sourceId: ID, requestedAt: AT });
  assert.equal((await f.service.check({ sourceIds: [ID] })).sources[0].reasonClass, "reevaluation_interrupted");
  assert.equal(f.requests(), 0);
});
test("failure completes new route once without fallback or automatic recovery", async () => {
  const f = await setup({ failure: true }); const r = await f.service.check({ sourceIds: [ID], trigger: "startup" });
  assert.equal(r.state, "failed"); const saved = (await f.store.read()).value;
  assert.equal(saved.lastOutcome, "failure"); assert.equal(saved.reevaluation.status, "completed");
  assert.equal(saved.lastHttpStatus, 404); assert.equal(saved.lastDiagnosticClass, "http_404");
  await f.service.check({ sourceIds: [ID], trigger: "startup" }); assert.equal(f.requests(), 1); assert.equal(f.legacyRequests.length, 0);
});
test("renderer route/approval/URL overrides rejected before DB/network", async () => {
  const f = await setup(); for (const key of ["routeIdentity", "approvalId", "url", "activationVersion"])
    assert.equal((await f.service.check({ [key]: "bad" })).reasonClass, "invalid_argument");
  assert.equal(f.requests(), 0); assert.equal(f.store.diagnostics().length, 0);
});
test("production store rejects non-Cpi reservation/completion and never creates Formal DB", async () => {
  const f = await setup();
  assert.equal((await f.store.reserveReevaluation({ sourceId: PROTECTED[0], requestedAt: AT })).reason, "source_out_of_scope");
  assert.equal((await f.store.completeReevaluation({ token: { sourceId: PROTECTED[1] } })).reason, "source_out_of_scope");
  assert.deepEqual(await f.factory.databases(), [{ name: S.DATABASE_NAME, version: 1 }]);
});
test("DB absent fails closed without create or network", async () => {
  const f = await setup({ seedAbsent: false });
  assert.equal((await f.service.check({ sourceIds: [ID] })).sources[0].reasonClass, "runtime_state_invalid");
  assert.equal(f.requests(), 0); assert.deepEqual(await f.factory.databases(), []);
});
test("existing renderer integration does not overwrite main-managed v2 CPI or Labor/BLS", async () => {
  const f = await setup(), before = f.seed.diagnostics().successfulWrites;
  const runtime = Integration.createRuntimeStateIntegration({ service: f.service, store: f.seed, targetEnvironment: "isolated_test" });
  await runtime.startup(); assert.equal(f.seed.diagnostics().successfulWrites, before);
  assert.equal((await f.store.read()).value.reevaluation.status, "completed");
});
test("Cpi production dependency graph has no Formal writer/reader and browser capabilities remain eight", () => {
  const visited = new Set(); function visit(file) {
    if (visited.has(file)) return; visited.add(file);
    if (file.includes("/marketCalendarHistory/"))
      assert.ok(["historyContract.js", "transitionPlanner.js", "planCanonicalizer.js"].includes(path.basename(file)),
        "only pure contracts/planning, never Formal storage reader/writer");
    for (const m of fs.readFileSync(file, "utf8").matchAll(/require\(["'](\.[^"']+)["']\)/g))
      visit(path.resolve(path.dirname(file), m[1]));
  }
  visit(path.join(__dirname, "../js/marketCalendarRuntime/cpiProductionCheck.js"));
  visit(path.join(__dirname, "../js/marketCalendarRuntime/cpiRuntimeStateElectron.js"));
  const source = fs.readFileSync(path.join(__dirname, "../preload.js"), "utf8");
  assert.equal([...source.matchAll(/^  \w+: \(\.\.\.args\)/gm)].length, 8);
  assert.doesNotMatch(source, /cpiRuntimeStateElectron|routeReevaluationPolicy/);
});

for (const missingLane of ["national", "tokyo"]) test("missing " + missingLane + " lane never completes success", async () => {
  const f = await setup({ missingLane }), r = await f.service.check({ sourceIds: [ID], trigger: "startup" });
  assert.equal(r.state, "failed"); assert.equal(f.requests(), 1);
  const state = (await f.store.read()).value;
  assert.equal(state.lastOutcome, "failure"); assert.equal(state.lastSuccessAt, null);
  assert.equal(state.reevaluation.status, "completed");
  const acquisition = r.cpiAudit.find(x => x.phase === "acquisition");
  assert.equal(acquisition.candidate.laneCounts[missingLane], 0);
  assert.equal(acquisition.coverage.coverageState, "partial");
  assert.equal(acquisition.absenceAuthority, "none");
});
test("both lanes retain canonical semantics and independent sufficient coverage", async () => {
  const f = await setup(), r = await f.service.check({ sourceIds: [ID], trigger: "startup" });
  const a = r.cpiAudit.find(x => x.phase === "acquisition");
  assert.deepEqual(a.candidate.laneCounts, { national: 3, tokyo: 3 });
  assert.deepEqual(a.candidate.laneEditions, { national: ["initial"], tokyo: ["preliminary"] });
  assert.deepEqual(a.coverage.laneAssessments.map(x => [x.lane, x.coverageState]),
    [["national", "sufficient"], ["tokyo", "sufficient"]]);
  assert.equal(a.absenceAuthority, "none"); assert.deepEqual(a.candidate.canonicalDiagnostics, []);
});
test("actual CPI over Labor composition preserves completed Labor and shadow BLS", async () => {
  const f = await setup(), context = vm.createContext({ indexedDB: f.factory, document: {},
    structuredClone, setTimeout, clearTimeout, console, Date, URL }); context.window = context;
  const laborStore = require("../js/marketCalendarRuntime/laborRuntimeStateElectron.js").createLaborRuntimeStateElectron({
    webContents: { executeJavaScriptInIsolatedWorld: async (_, scripts) =>
      structuredClone(await vm.runInContext(scripts[0].code, context)) }
  });
  const reserved = await laborStore.reserveReevaluation({ sourceId: "jp-stat-labor", requestedAt: AT });
  assert.equal(reserved.networkEligible, true);
  await laborStore.completeReevaluation({ token: reserved.token, completedAt: AT, result: {
    lastAttemptAt: AT, lastOutcome: "success", lastHttpStatus: 200, lastDiagnosticClass: null } });
  const before = (await f.seed.readAll()).states;
  let laborNetwork = 0, cpiNetwork = 0;
  const labor = require("../js/marketCalendarRuntime/laborProductionCheck.js").createLaborProductionCheck({
    store: laborStore, now: () => AT, fetchImpl: async () => { laborNetwork++; throw Error("unexpected"); },
    legacyService: { check: async r => ({ sources: r.sourceIds.map(sourceId => ({
      sourceId, status: "success", acquisitionStatus: "not_attempted" })) }) }
  });
  const cpi = L.createCpiProductionCheck({ store: f.store, now: () => AT, legacyService: labor,
    fetchImpl: async () => { cpiNetwork++; return new Response(F.page(ID,
      ["national", "tokyo"].flatMap(lane => ["08", "09", "10"].map((month, i) =>
        F.monthly(ID, lane, `2026-${month}`, `2026-${["09", "10", "11"][i]}-15`)))),
      { headers: { "content-type": "text/html; charset=UTF-8" } }); } });
  const r = await cpi.check({ trigger: "startup" });
  assert.equal(r.successfulSourceCount, 11); assert.equal(r.requestedSourceCount, 12);
  assert.equal(r.sources.find(s => s.sourceId === "jp-stat-labor").planningDecision, "skip");
  assert.equal(r.sources.find(s => s.sourceId === "us-bls-calendar").acquisitionStatus, "not_attempted");
  assert.equal(laborNetwork, 0); assert.equal(cpiNetwork, 1);
  for (const id of PROTECTED) assert.deepEqual((await f.seed.read(id)).value, before[id]);
});
