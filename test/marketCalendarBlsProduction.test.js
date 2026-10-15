"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"),
  fs = require("node:fs"), path = require("node:path");
const { IDBFactory } = require("fake-indexeddb");
const A = require("../js/marketCalendarRuntime/calendarRouteAuthority.js");
const S = require("../js/storage/marketCalendarRuntimeStateStore.js");
const E = require("../js/marketCalendarRuntime/blsRuntimeStateElectron.js");
const L = require("../js/marketCalendarRuntime/blsProductionCheck.js");
const F = require("./fixtures/marketCalendar/blsFixedFixture.js");
const Integration = require("../js/marketCalendarRuntime/calendarRuntimeStateIntegration.js");
const ID = L.ID, AT = "2026-09-28T03:00:00.000Z";
test("partial retains three roles only in memory; persisted record stays exact v2", async () => {
  const f = await setup({ failedRole: "jolts" }), r = await f.service.check({ sourceIds: [ID] });
  assert.equal(r.state, "failed");
  assert.equal(r.sources[0].acquisitionStatus, "partial");
  const a = r.blsAudit.find(x => x.phase === "acquisition");
  assert.deepEqual(a.failedRoles, ["jolts"]);
  assert.equal(a.canonicalRecords.length, 10);
  assert.equal(a.absenceAuthority, "none"); assert.equal(a.disappearance, "not_evaluated");
  const state = (await f.store.read()).value;
  assert.equal(state.lastOutcome, "failure");
  assert.equal(state.lastDiagnosticClass, "http_404");
  assert.equal(state.lastSuccessAt, null);
  assert.equal(Object.hasOwn(state, "failedRoles"), false);
});
test("encoding failure rejects role without hiding successful candidates", async () => {
  const f = await setup({ encodingRole: "ppi" }), r = await f.service.check({ sourceIds: [ID] });
  assert.equal(r.state, "failed"); assert.equal(f.requests(), 4);
  const a = r.blsAudit.find(x => x.phase === "acquisition");
  assert.deepEqual(a.failedRoles, ["ppi"]); assert.ok(a.canonicalRecords.length > 0);
  assert.equal((await f.store.read()).value.lastDiagnosticClass, "security_violation");
});
test("CPI and Labor production binding pins unchanged", () => {
  const P = require("../js/marketCalendarRuntime/routeReevaluationPolicy.js");
  for (const id of ["jp-stat-cpi", "jp-stat-labor"]) {
    const selected = A.selectRoute({ sourceId: id, operation: "source-document-set" }, A.PRODUCTION_AUTHORITY);
    assert.equal(selected.activationState, "alternative_active");
    assert.deepEqual(P.binding(selected), P.APPROVALS[id].targetBinding);
  }
});
const old = sourceId => ({ sourceId, lastAttemptAt: "2026-09-27T03:00:00.000Z", lastSuccessAt: null,
  lastOutcome: "failure", retryAfter: "2026-09-27T04:00:00.000Z", lastDiagnosticClass: "network_failure", lastHttpStatus: null, coordinatorVersion: 1 });
async function setup({ factory = new IDBFactory(), gate, failure = false, failedRole = null, encodingRole = null, seedAbsent = true } = {}) {
  const seed = S.createRuntimeStateStore({ indexedDB: factory, targetEnvironment: "isolated_test" });
  if (seedAbsent && !(await factory.databases()).length) for (const id of [ID, ...L.EXCLUDED]) await seed.write(id, old(id));
  let authority = A.PRODUCTION_AUTHORITY, requests = 0;
  const context = vm.createContext({ indexedDB: factory, document: {}, structuredClone, setTimeout, clearTimeout,
    console, Date, URL }); context.window = context;
  const store = E.createBlsRuntimeStateElectron({ getAuthority: () => authority, webContents: {
    executeJavaScriptInIsolatedWorld: async (world, scripts) => {
      assert.equal(world, 1741); return structuredClone(await vm.runInContext(scripts[0].code, context));
    }
  } });
  const legacyRequests = [], create = () => L.createBlsProductionCheck({ store, now: () => AT,
    getAuthority: () => authority, legacyService: { check: async r => {
      legacyRequests.push(r); return { sources: r.sourceIds.map(sourceId => ({ sourceId, status: "success", acquisitionStatus: "not_attempted" })) };
    } }, fetchImpl: async (url, options) => {
      requests++; const role = require("../js/marketCalendarIsolated/blsFixedRoute.js").ROLES.find(r => r.url === url)?.role;
      assert.ok(role);
      assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "manual");
      assert.deepEqual(Object.keys(options.headers), ["accept"]);
      const saved = (await store.read()).value; assert.equal(saved.reevaluation.status, "reserved");
      if (gate) await gate;
      const rows = [...F.rows[role], ...(role === "employment_situation" ? [["November 2026", "Dec. 04, 2026", "08:30 AM"]] : [])];
      const body = F.html(role, rows).replace('<meta charset="utf-8">', '<meta http-equiv="x-ua-compatible" content="IE=edge">');
      return new Response(encodingRole === role ? new Uint8Array([0xff, 0xfe, 0xff]) : failure || failedRole === role ? "not found" : body, { status: failure || failedRole === role ? 404 : 200,
        headers: { "content-type": "text/html" } });
    } });
  return { factory, seed, store, create, legacyRequests, service: create(), requests: () => requests,
    authority: value => { authority = value; } };
}
test("Bls production authority stays active generation 2 alongside independently approved CPI", () => {
  for (const id of A.SOURCE_IDS) {
    const current = A.selectRoute({ sourceId: id, operation: "source-document-set" }, A.PRODUCTION_AUTHORITY);
    if (id === ID) { assert.equal(current.activationState, "alternative_active"); assert.equal(current.activationVersion, 2); }
    else if (!["jp-stat-cpi", "jp-stat-labor"].includes(id)) assert.deepEqual(current.routeIdentity, A.selectRoute({ sourceId: id, operation: "source-document-set" }).routeIdentity);
  }
});
test("actual isolated-world storage bridge reserves legacy network failure before acquisition", async () => {
  const f = await setup(), r = await f.service.check({ sourceIds: [ID], trigger: "startup" });
  assert.equal(r.state, "success"); assert.equal(f.requests(), 4); assert.equal(r.sources[0].recordCount, 14);
  const state = (await f.store.read()).value;
  assert.equal(state.lastOutcome, "success"); assert.equal(state.lastSuccessAt, AT); assert.equal(state.retryAfter, null);
  assert.equal(state.reevaluation.status, "completed"); assert.equal(state.routeBinding.routeKind, "bls_fixed_schedule_pages");
  assert.equal(state.reevaluation.previousRouteSummary.lastDiagnosticClass, "network_failure");
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
  release(); await a; assert.equal(f.requests(), 4);
  assert.equal(f.store.diagnostics().reduce((n, d) => n + d.successfulReservations, 0), 1);
});
test("CPI/Labor records unchanged and delegated to existing composition", async () => {
  const f = await setup(); const before = (await f.seed.readAll()).states;
  await f.service.check({ trigger: "startup" });
  for (const id of L.EXCLUDED) assert.deepEqual((await f.seed.read(id)).value, before[id]);
  assert.equal(f.legacyRequests[0].sourceIds.length, 11);
  assert.ok(f.legacyRequests[0].sourceIds.every(id => ![ID, ...L.EXCLUDED].includes(id)));
  assert.equal(f.requests(), 4);
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
  await f.service.check({ sourceIds: [ID], trigger: "startup" }); assert.equal(f.requests(), 4); assert.equal(f.legacyRequests.length, 0);
});
test("renderer route/approval/URL overrides rejected before DB/network", async () => {
  const f = await setup(); for (const key of ["routeIdentity", "approvalId", "url", "activationVersion"])
    assert.equal((await f.service.check({ [key]: "bad" })).reasonClass, "invalid_argument");
  assert.equal(f.requests(), 0); assert.equal(f.store.diagnostics().length, 0);
});
test("production store rejects non-Bls reservation/completion and never creates Formal DB", async () => {
  const f = await setup();
  assert.equal((await f.store.reserveReevaluation({ sourceId: L.EXCLUDED[0], requestedAt: AT })).reason, "source_out_of_scope");
  assert.equal((await f.store.completeReevaluation({ token: { sourceId: L.EXCLUDED[1] } })).reason, "source_out_of_scope");
  assert.deepEqual(await f.factory.databases(), [{ name: S.DATABASE_NAME, version: 1 }]);
});
test("DB absent fails closed without create or network", async () => {
  const f = await setup({ seedAbsent: false });
  assert.equal((await f.service.check({ sourceIds: [ID] })).sources[0].reasonClass, "runtime_state_invalid");
  assert.equal(f.requests(), 0); assert.deepEqual(await f.factory.databases(), []);
});
test("existing renderer integration does not overwrite main-managed v2 Bls or CPI/BLS", async () => {
  const f = await setup(), before = f.seed.diagnostics().successfulWrites;
  const runtime = Integration.createRuntimeStateIntegration({ service: f.service, store: f.seed, targetEnvironment: "isolated_test" });
  await runtime.startup(); assert.equal(f.seed.diagnostics().successfulWrites, before);
  assert.equal((await f.store.read()).value.reevaluation.status, "completed");
});
test("Bls production dependency graph has no Calendar Formal writer/reader and browser capabilities remain ten", () => {
  const visited = new Set(); function visit(file) {
    if (visited.has(file)) return; visited.add(file);
    if (file.includes("/marketCalendarHistory/"))
      assert.ok(["historyContract.js", "transitionPlanner.js", "planCanonicalizer.js"].includes(path.basename(file)),
        "only pure contracts/planning, never Formal storage reader/writer");
    for (const m of fs.readFileSync(file, "utf8").matchAll(/require\(["'](\.[^"']+)["']\)/g))
      visit(path.resolve(path.dirname(file), m[1]));
  }
  visit(path.join(__dirname, "../js/marketCalendarRuntime/blsProductionCheck.js"));
  visit(path.join(__dirname, "../js/marketCalendarRuntime/blsRuntimeStateElectron.js"));
  const source = fs.readFileSync(path.join(__dirname, "../preload.js"), "utf8");
  assert.equal([...source.matchAll(/^  \w+: \(\.\.\.args\)/gm)].length, 11);
  assert.doesNotMatch(source, /blsRuntimeStateElectron|routeReevaluationPolicy/);
});
