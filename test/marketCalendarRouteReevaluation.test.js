"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { IDBFactory } = require("fake-indexeddb");
const Store = require("../js/storage/marketCalendarRuntimeStateStore.js");
const State = require("../js/marketCalendarRuntime/sourceUpdateState.js");
const A = require("../js/marketCalendarRuntime/calendarRouteAuthority.js");
const P = require("../js/marketCalendarRuntime/routeReevaluationPolicy.js");
const Runner = require("../js/marketCalendarRuntime/routeReevaluationRunner.js");
const Integration = require("../js/marketCalendarRuntime/calendarRuntimeStateIntegration.js");
const Flights = require("../js/marketCalendarRuntime/sourceSingleFlight.js");
const CPI = "jp-stat-cpi", LABOR = "jp-stat-labor", BLS = "us-bls-calendar";
const OLD = "2026-09-28T00:00:00.000Z", AT = "2026-09-28T01:00:00.000Z", END = "2026-09-28T01:01:00.000Z";
const contexts = [], stores = [], audit = { creates: 0, opens: 0, readonlyTransactions: 0, readwriteTransactions: 0,
  committedTransactions: 0, abortedTransactions: 0, committedRecordWrites: 0, reopenCycles: 0,
  mockAcquisitions: 0, manualActions: 0, joinedFlights: 0 };
function active(overrides = {}) { return A.createAuthoritySnapshot(Object.fromEntries([CPI, LABOR, BLS].map(id => [id,
  overrides[id] || { activationState: "alternative_active", activationVersion: 2 }]))); }
function legacy(id = CPI, changes = {}) { const cls = id === BLS ? "network_failure" : "http_404";
  return { sourceId: id, lastAttemptAt: OLD, lastSuccessAt: "2026-09-27T23:00:00.000Z",
    lastOutcome: "failure", retryAfter: State.retryAfterFor(cls, OLD), lastHttpStatus: cls === "http_404" ? 404 : null,
    lastDiagnosticClass: cls, coordinatorVersion: 1, ...changes }; }
function binding(id, authority) { return P.binding(A.selectRoute({ sourceId: id, operation: "source-document-set" }, authority)); }
function v2(id = CPI, changes = {}) { return { ...legacy(id), runtimeStateContractVersion: 2,
  routeBinding: binding(id, A.DEFAULT_AUTHORITY), reevaluation: null, ...changes }; }
function outcome(cls = null) { return { lastAttemptAt: AT, lastOutcome: cls ? "failure" : "success",
  lastHttpStatus: cls === "http_404" ? 404 : cls ? null : 200, lastDiagnosticClass: cls }; }
function instance(ctx) { const store = Runner.createIsolatedReevaluationStore({ indexedDB: ctx.factory,
  targetEnvironment: "isolated_test", getRouteAuthority: () => ctx.authority }); stores.push(store); return store; }
function fixture() {
  const raw = new IDBFactory(), ctx = { raw, authority: active(), abortNextWrite: false, connections: new Set(), transactions: new Set() };
  ctx.factory = { databases: () => raw.databases(), open: (...args) => {
    const request = raw.open(...args); audit.opens++;
    request.addEventListener("upgradeneeded", () => { audit.creates++; }, { once: true });
    request.addEventListener("success", () => {
      const db = request.result; ctx.connections.add(db); const original = db.transaction.bind(db);
      db.transaction = (...params) => {
        const tx = original(...params); ctx.transactions.add(tx); let writes = 0;
        audit[tx.mode === "readwrite" ? "readwriteTransactions" : "readonlyTransactions"]++;
        if (tx.mode === "readwrite") {
          const s = tx.objectStore(Store.STORE_NAME), put = s.put.bind(s);
          s.put = (...values) => { writes++; const r = put(...values);
            if (ctx.abortNextWrite) { ctx.abortNextWrite = false; tx.abort(); } return r; };
        }
        const end = event => { if (event.type === "complete") {
          audit.committedTransactions++; audit.committedRecordWrites += writes;
        } else audit.abortedTransactions++;
        tx.removeEventListener("complete", end); tx.removeEventListener("abort", end); };
        tx.addEventListener("complete", end); tx.addEventListener("abort", end); return tx;
      };
    }, { once: true }); return request;
  } };
  contexts.push(ctx); ctx.store = instance(ctx); return ctx;
}
async function rawPut(ctx, state) { // Fixture setup only, never exposed by the production store.
  await new Promise((resolve, reject) => { const r = ctx.factory.open(Store.DATABASE_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(Store.STORE_NAME, { keyPath: "sourceId" });
    r.onerror = () => reject(r.error); r.onsuccess = () => { const db = r.result, tx = db.transaction(Store.STORE_NAME, "readwrite");
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
      for (const value of Array.isArray(state) ? state : [state]) tx.objectStore(Store.STORE_NAME).put(value);
    }; });
}
async function seed(ctx, id = CPI, changes = {}) { assert.equal((await ctx.store.write(id, legacy(id, changes))).status, "ok"); }
function reserve(ctx, id = CPI) { return ctx.store.reserveReevaluation({ sourceId: id, requestedAt: AT }); }
function complete(ctx, reservation, result = outcome()) {
  return ctx.store.completeReevaluation({ token: reservation.token, result, completedAt: END });
}
function decide(state, authority, requestedAt = END) { return P.evaluateBoundUpdate({ sourceId: state.sourceId,
  runtimeState: state, trigger: "startup", requestedAt, sessionState: { attemptCount: 0 }, formalState: {
    databaseStatus: "absent", schemaStatus: "compatible", sourceCursorStatus: "absent", lastAcceptedAt: null,
    securityStatus: "clear" } }, authority); }
test.after(() => {
  const totals = stores.reduce((sum, store) => { for (const [k, v] of Object.entries(store.diagnostics())) sum[k] = (sum[k] || 0) + v; return sum; }, {});
  const handles = contexts.reduce((n, c) => n + [...c.connections].filter(d => !d._closed).length, 0);
  const unfinished = contexts.reduce((n, c) => n + [...c.transactions].filter(t => t._state !== "finished").length, 0);
  assert.equal(handles, 0); assert.equal(unfinished, 0); assert.equal(totals.openHandles, 0);
  assert.equal(Flights.getFlightDiagnostics().activeFlightCount, 0);
  console.log("D2d2b isolated audit", JSON.stringify({ fixtureDb: audit, storeOperations: totals,
    finalHandles: handles, unfinishedTransactions: unfinished }));
});

test("C1 legacy eight-field read preserves absence of version and never rewrites", async () => {
  const ctx = fixture(); await seed(ctx); const before = ctx.store.diagnostics();
  const loaded = await ctx.store.read(CPI); assert.deepEqual(loaded.value, legacy());
  assert.equal(Object.hasOwn(loaded.value, "runtimeStateContractVersion"), false);
  assert.equal(State.validateCompatibleRuntimeState(loaded.value).routeClass, "legacy_unknown_contract");
  assert.equal(ctx.store.diagnostics().successfulWrites, before.successfulWrites);
});
test("C2 v2 exact record read; unknown nested fields/versions fail closed", async () => {
  const ctx = fixture(); await rawPut(ctx, v2()); assert.deepEqual((await ctx.store.read(CPI)).value, v2());
  for (const changed of [{ ...v2(), runtimeStateContractVersion: 3 }, { ...v2(), extra: true },
    { ...v2(), routeBinding: { ...v2().routeBinding, routeIdentity: "bad" } },
    { ...v2(), routeBinding: { ...v2().routeBinding, activationVersion: 0 } },
    { ...v2(), routeBinding: { ...v2().routeBinding, url: "secret" } }])
    assert.equal(State.validateCompatibleRuntimeState(changed).valid, false);
  const reserved = await reserve(ctx); assert.equal(reserved.networkEligible, true);
  for (const changed of [{ ...reserved.state, reevaluation: { ...reserved.state.reevaluation, status: "unknown" } },
    { ...reserved.state, reevaluation: { ...reserved.state.reevaluation, rawStack: "secret" } }])
    assert.equal(State.validateCompatibleRuntimeState(changed).valid, false);
});
test("C3 mixed legacy/v2 map retains both exact records", async () => {
  const ctx = fixture(); await rawPut(ctx, [legacy(), v2(LABOR)]); const loaded = await ctx.store.readAll();
  assert.equal(loaded.status, "ok"); assert.equal(loaded.value.length, 2); assert.deepEqual(loaded.states[CPI], legacy());
  assert.deepEqual(loaded.states[LABOR], v2(LABOR)); assert.deepEqual(loaded.invalidSources, []);
});
test("C4 one malformed of twelve isolates only that source, no raw diagnostics", async () => {
  const ctx = fixture(); await rawPut(ctx, A.SOURCE_IDS.map(id => id === CPI ? { sourceId: id, rawStack: "secret/path" } : legacy(id)));
  const loaded = await ctx.store.readAll(); assert.equal(loaded.status, "ok"); assert.equal(loaded.value.length, 11);
  assert.deepEqual(loaded.invalidSources, [{ sourceId: CPI, reason: "runtime_state_invalid" }]);
  assert.equal((await ctx.store.read(CPI)).reason, "runtime_state_invalid");
  assert.equal(JSON.stringify(loaded).includes("secret/path"), false);
});
test("C5 DB unavailable stays distinct and sanitized", async () => {
  const store = Store.createRuntimeStateStore({ targetEnvironment: "isolated_test",
    indexedDB: { databases: async () => { throw Error("secret/path"); }, open() { throw Error("must not open"); } } });
  stores.push(store); const loaded = await store.readAll(); assert.equal(loaded.status, "unavailable");
  assert.equal(loaded.reason, "runtime_state_access_failed"); assert.deepEqual(loaded.states, {});
});
test("C6 absent read/reservation do not create DB; v1 schema and Formal isolation remain fixed", async () => {
  const ctx = fixture(); const before = audit.creates; assert.equal((await ctx.store.readAll()).status, "absent");
  assert.equal((await reserve(ctx)).networkEligible, false); assert.deepEqual(await ctx.factory.databases(), []);
  assert.equal(audit.creates, before); await seed(ctx); const created = audit.creates;
  await reserve(ctx); assert.equal(audit.creates, created);
  assert.deepEqual(await ctx.factory.databases(), [{ name: Store.DATABASE_NAME, version: 1 }]);
});
test("R1 CPI/Labor old 404 and known legacy binding reserve only approved new route", async () => {
  const ctx = fixture(); await seed(ctx); await rawPut(ctx, v2(LABOR));
  for (const id of [CPI, LABOR]) { const r = await reserve(ctx, id); assert.equal(r.networkEligible, true);
    assert.equal(r.state.runtimeStateContractVersion, 2); assert.equal(r.state.reevaluation.status, "reserved");
    assert.deepEqual(r.state.routeBinding, binding(id, ctx.authority)); }
});
test("R2 BLS old network cooldown is a narrowly approved exception", async () => {
  const ctx = fixture(); await seed(ctx, BLS, { retryAfter: "2026-09-28T02:00:00.000Z" });
  assert.equal((await reserve(ctx, BLS)).networkEligible, true);
});
test("R3 shadow/default, unknown approval/source and wrong generation cannot reserve", async () => {
  const ctx = fixture(); await seed(ctx); ctx.authority = A.DEFAULT_AUTHORITY;
  assert.equal((await reserve(ctx)).reason, "reevaluation_not_approved");
  ctx.authority = active({ [CPI]: { activationState: "alternative_active", activationVersion: 3 } });
  assert.equal((await reserve(ctx)).networkEligible, false);
  assert.equal((await ctx.store.reserveReevaluation({ sourceId: CPI, requestedAt: AT, approvalId: "fake" })).networkEligible, false);
  assert.equal((await reserve(ctx, "unknown")).networkEligible, false);
  assert.deepEqual((await ctx.store.read(CPI)).value, legacy());
});
test("R4 security/schema/malformed and non-approved failure classes never lift blocking", async () => {
  for (const cls of ["security_violation", "schema_mismatch", "mime_mismatch", "parser_structure_change", "timeout"]) {
    const ctx = fixture(); await seed(ctx, CPI, { lastDiagnosticClass: cls, lastHttpStatus: null,
      retryAfter: State.retryAfterFor(cls, OLD) }); assert.equal((await reserve(ctx)).networkEligible, false);
  }
  const ctx = fixture(); await rawPut(ctx, legacy(CPI, { lastDiagnosticClass: "credential_violation" }));
  assert.equal((await reserve(ctx)).reason, "runtime_state_invalid");
});
test("R5 concurrent reservations use one atomic winner across independent store instances", async () => {
  const ctx = fixture(); await seed(ctx); const other = instance(ctx);
  const results = await Promise.all([reserve(ctx), other.reserveReevaluation({ sourceId: CPI, requestedAt: AT }), reserve(ctx)]);
  assert.equal(results.filter(r => r.networkEligible).length, 1);
  assert.equal(results.filter(r => r.reason === "reevaluation_interrupted").length, 2);
});
test("R6 failed reservation put rolls back and grants zero mock network eligibility", async () => {
  const ctx = fixture(); await seed(ctx); ctx.abortNextWrite = true; let calls = 0;
  const runner = Runner.createIsolatedReevaluationRunner({ targetEnvironment: "isolated_test", store: ctx.store,
    getAuthority: () => ctx.authority, now: () => AT, acquire: async () => { calls++; return outcome(); } });
  const r = await runner.check({ sourceId: CPI, trigger: "startup" });
  assert.equal(r.executionOutcome.reason, "reservation_write_failed"); assert.equal(calls, 0);
  assert.deepEqual((await ctx.store.read(CPI)).value, legacy());
});
test("R7 crash/reopen preserves reserved and never retries automatically or via ordinary manual write", async () => {
  const ctx = fixture(); await seed(ctx); const r = await reserve(ctx);
  assert.equal(ctx.store.diagnostics().openHandles, 0); ctx.store = instance(ctx); audit.reopenCycles++;
  assert.deepEqual((await ctx.store.read(CPI)).value, r.state);
  assert.equal((await reserve(ctx)).reason, "reevaluation_interrupted");
  assert.equal(decide(r.state, ctx.authority).reason, "reevaluation_interrupted");
  assert.equal((await ctx.store.write(CPI, legacy(CPI, { lastAttemptAt: END }))).status, "unavailable");
  assert.deepEqual((await ctx.store.read(CPI)).value, r.state);
});
for (const variant of ["route", "generation", "suspended"]) test(`R8/R9/R10 late completion rejects ${variant} authority change`, async () => {
  const ctx = fixture(); await seed(ctx); const r = await reserve(ctx);
  ctx.authority = active({ [CPI]: { activationState: variant === "route" ? "legacy_active" :
    variant === "suspended" ? "suspended" : "alternative_active", activationVersion: variant === "generation" ? 3 : 2 } });
  assert.equal((await complete(ctx, r)).reason, "stale_route_result");
  assert.deepEqual((await ctx.store.read(CPI)).value, r.state);
  if (variant === "suspended") assert.equal((await reserve(ctx)).reason, "source_suspended");
});
test("completion rejects source/approval/route/generation/reservedAt token mismatch", async () => {
  const ctx = fixture(); await seed(ctx); const r = await reserve(ctx);
  for (const patch of [{ sourceId: LABOR }, { approvalId: "fake" }, { targetRouteIdentity: "a".repeat(64) },
    { activationVersion: 3 }, { reservedAt: END }])
    assert.equal((await complete(ctx, { token: { ...r.token, ...patch } })).reason, "stale_route_result");
  assert.deepEqual((await ctx.store.read(CPI)).value, r.state);
});
test("K1/K4 successful completion binds new success and same-day B1 skips", async () => {
  const ctx = fixture(); await seed(ctx); const r = await reserve(ctx), done = await complete(ctx, r);
  assert.equal(done.status, "ok"); const s = (await ctx.store.read(CPI)).value;
  assert.equal(s.lastOutcome, "success"); assert.equal(s.lastAttemptAt, AT); assert.equal(s.lastSuccessAt, AT);
  assert.equal(s.retryAfter, null); assert.equal(s.lastDiagnosticClass, null);
  assert.equal(s.reevaluation.status, "completed"); assert.equal(s.reevaluation.completedAt, END);
  assert.equal(decide(s, ctx.authority).decision, "skip");
  assert.equal((await reserve(ctx)).reason, "reevaluation_already_completed");
  assert.equal((await complete(ctx, r)).reason, "stale_route_result");
});
test("K2 new retryable failure uses new result/cooldown and never old success", async () => {
  const ctx = fixture(); await seed(ctx); const done = await complete(ctx, await reserve(ctx), outcome("network_failure"));
  assert.equal(done.status, "ok"); assert.equal(done.state.lastSuccessAt, null);
  assert.equal(done.state.retryAfter, "2026-09-28T02:00:00.000Z");
  assert.equal(done.state.reevaluation.previousRouteSummary.lastSuccessAt, legacy().lastSuccessAt);
  assert.equal(decide(done.state, ctx.authority).decision, "cooldown");
  assert.equal(decide(done.state, ctx.authority, "2026-09-28T02:00:00.000Z").decision, "retry");
});
test("K3 new nonretryable/security failure stays blocked, no repeated approval", async () => {
  for (const cls of ["http_404", "security_violation"]) {
    const ctx = fixture(); await seed(ctx); const done = await complete(ctx, await reserve(ctx), outcome(cls));
    assert.equal(done.status, "ok"); assert.equal(done.state.retryAfter, null);
    assert.equal(decide(done.state, ctx.authority).decision, "blocked");
    assert.equal((await reserve(ctx)).networkEligible, false);
  }
});
test("K5 old route same-day success cannot skip new route; legacy normal behavior unchanged", () => {
  const s = legacy(CPI, { lastOutcome: "success", lastSuccessAt: OLD, lastDiagnosticClass: null, lastHttpStatus: 200 });
  assert.equal(decide(s, A.DEFAULT_AUTHORITY).decision, "skip");
  assert.equal(decide(s, active()).reason, "route_binding_mismatch");
  assert.equal(decide(v2(CPI, { ...s }), active()).reason, "route_binding_mismatch");
  assert.equal(P.evaluate({ sourceId: CPI, state: s, authority: active(), requestedAt: AT }).eligible, false);
});
test("K6 completion transaction failure preserves reservation for explicit intervention", async () => {
  const ctx = fixture(); await seed(ctx); const r = await reserve(ctx); ctx.abortNextWrite = true;
  assert.equal((await complete(ctx, r)).reason, "completion_write_failed");
  assert.deepEqual((await ctx.store.read(CPI)).value, r.state);
});
test("malformed completion rejects raw diagnostics and contradictory timestamps", async () => {
  const ctx = fixture(); await seed(ctx); const r = await reserve(ctx);
  for (const result of [{ ...outcome(), rawStack: "secret/path" }, { ...outcome(), lastAttemptAt: OLD },
    { ...outcome(), lastDiagnosticClass: "security_violation" }, { ...outcome("timeout"), lastDiagnosticClass: "raw/path" },
    { ...outcome(), lastHttpStatus: 404 }, { ...outcome("http_404"), lastHttpStatus: 200 }])
    assert.equal((await complete(ctx, r, result)).reason, "runtime_state_invalid");
  assert.deepEqual((await ctx.store.read(CPI)).value, r.state);
});
test("startup/manual same-route joins one source flight; other sources independently reserve", async () => {
  const ctx = fixture(); await seed(ctx); await seed(ctx, LABOR);
  let release, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  const options = { targetEnvironment: "isolated_test", store: ctx.store, getAuthority: () => ctx.authority,
    now: () => AT, acquire: async () => { calls++; audit.mockAcquisitions++; await gate; return outcome(); } };
  const first = Runner.createIsolatedReevaluationRunner(options), second = Runner.createIsolatedReevaluationRunner(options);
  const a = first.check({ sourceId: CPI, trigger: "startup" }); audit.manualActions++;
  const b = second.check({ sourceId: CPI, trigger: "manual" }), c = first.check({ sourceId: LABOR, trigger: "startup" });
  release(); const results = await Promise.all([a, b, c]);
  assert.equal(results[1].joinedExistingFlight, true); audit.joinedFlights++;
  assert.equal(results.filter(r => r.executionOutcome.status === "ok").length, 3);
  assert.equal(calls, 2, "one CPI acquisition shared by startup/manual, one independent Labor acquisition");
  assert.equal(ctx.store.diagnostics().successfulReservations, 2); assert.equal(ctx.store.diagnostics().completionCommits, 2);
});
test("ineligible v2 route, caller override and future evidence cannot mint approvals", async () => {
  const ctx = fixture(); await rawPut(ctx, v2(CPI, { routeBinding: binding(CPI, active()) }));
  assert.equal((await reserve(ctx)).reason, "reevaluation_not_approved");
  await rawPut(ctx, legacy(CPI, { lastAttemptAt: END }));
  assert.equal((await reserve(ctx)).reason, "reevaluation_not_approved");
  assert.equal((await ctx.store.reserveReevaluation({ sourceId: CPI, requestedAt: AT, routeIdentity: "x" })).networkEligible, false);
  assert.equal((await ctx.store.completeReevaluation({ token: { sourceId: CPI }, result: () => {}, completedAt: END })).reason,
    "runtime_state_invalid");
});
test("reservation rejects incompatible existing schema without upgrading it", async () => {
  const ctx = fixture(); await new Promise((resolve, reject) => { const r = ctx.factory.open(Store.DATABASE_NAME, 2);
    r.onupgradeneeded = () => r.result.createObjectStore(Store.STORE_NAME, { keyPath: "sourceId" });
    r.onsuccess = () => { r.result.close(); resolve(); }; r.onerror = () => reject(r.error); });
  assert.equal((await reserve(ctx)).networkEligible, false);
  assert.deepEqual(await ctx.factory.databases(), [{ name: Store.DATABASE_NAME, version: 2 }]);
  assert.equal(ctx.store.diagnostics().readwriteTransactions, 0); assert.equal(ctx.store.diagnostics().databaseCreateAttempts, 0);
});
test("suspension immediately after committed reservation prevents even mock acquisition", async () => {
  const ctx = fixture(); await seed(ctx); let calls = 0;
  const store = { reserveReevaluation: async input => { const r = await ctx.store.reserveReevaluation(input);
    ctx.authority = active({ [CPI]: { activationState: "suspended", activationVersion: 3 } }); return r; },
    completeReevaluation: input => ctx.store.completeReevaluation(input) };
  const runner = Runner.createIsolatedReevaluationRunner({ targetEnvironment: "isolated_test", store,
    getAuthority: () => ctx.authority, now: () => AT, acquire: async () => { calls++; return outcome(); } });
  assert.equal((await runner.check({ sourceId: CPI, trigger: "startup" })).executionOutcome.reason, "stale_route_result");
  assert.equal(calls, 0); assert.equal((await ctx.store.read(CPI)).value.reevaluation.status, "reserved");
});
test("completion cannot promote a forged security-failure reservation summary", async () => {
  const ctx = fixture(); await seed(ctx); const r = await reserve(ctx), modified = structuredClone(r.state);
  modified.reevaluation.previousRouteSummary.lastDiagnosticClass = "security_violation";
  await rawPut(ctx, modified);
  assert.equal((await complete(ctx, r)).reason, "stale_route_result");
  assert.deepEqual((await ctx.store.read(CPI)).value, modified);
});
test("reopened manual cannot silently clear interrupted reservation; suspended runner never acquires", async () => {
  const ctx = fixture(); await seed(ctx); await reserve(ctx); ctx.store = instance(ctx); audit.reopenCycles++;
  let calls = 0; const runner = Runner.createIsolatedReevaluationRunner({ targetEnvironment: "isolated_test", store: ctx.store,
    getAuthority: () => ctx.authority, now: () => AT, acquire: async () => { calls++; return outcome(); } });
  audit.manualActions++; assert.equal((await runner.check({ sourceId: CPI, trigger: "manual" })).executionOutcome.reason, "reevaluation_interrupted");
  ctx.authority = active({ [CPI]: { activationState: "suspended", activationVersion: 3 } });
  assert.equal((await runner.check({ sourceId: CPI, trigger: "startup" })).reason, "source_suspended"); assert.equal(calls, 0);
});
test("source-local invalid state blocks only its B1 plan, not all-source restoration", async () => {
  const ctx = fixture(); await rawPut(ctx, [{ sourceId: CPI, invalid: true }, legacy(LABOR)]);
  let seen; const integration = Integration.createRuntimeStateIntegration({ targetEnvironment: "isolated_test", store: ctx.store,
    service: { check: async input => { seen = input; return { sources: [], checkedAt: AT }; } } });
  const output = await integration.startup(); assert.deepEqual(seen.runtimeStates[CPI], {});
  assert.deepEqual(seen.runtimeStates[LABOR], legacy(LABOR)); assert.ok(output.runtimeStateDiagnostics.includes("runtime_state_invalid"));
  const restored = await integration.restore(); assert.equal(restored.sources.length, 2);
  assert.equal(restored.sources.find(s => s.sourceId === CPI).reasonClass, "runtime_state_invalid");
});
test("fixed approval/DB authority stays main-side isolated and never changes default selection", async () => {
  for (const id of [CPI, LABOR, BLS]) {
    assert.deepEqual(P.APPROVALS[id].fromBinding, binding(id, A.DEFAULT_AUTHORITY));
    assert.deepEqual(P.APPROVALS[id].targetBinding, binding(id, active()));
  }
  assert.equal(Object.keys(P.APPROVALS).length, 3);
  for (const id of [CPI, LABOR, BLS]) {
    const s = A.selectRoute({ sourceId: id, operation: "source-document-set" });
    assert.equal(s.activationState, "alternative_shadow"); assert.equal(s.routeKind, "legacy");
  }
  assert.throws(() => Store.createRuntimeStateStore({ indexedDB: new IDBFactory(), targetEnvironment: "browser_runtime",
    getRouteAuthority: () => active() }), /isolated/);
  const ordinary = Store.createRuntimeStateStore({ indexedDB: new IDBFactory(), targetEnvironment: "isolated_test" });
  assert.equal((await ordinary.reserveReevaluation({ sourceId: CPI, requestedAt: AT })).reason, "reevaluation_disabled");
  for (const file of ["main.js", "preload.js", "js/marketCalendarRuntime/calendarStartupRuntime.js",
    "js/marketCalendarRuntime/calendarManualCheckService.js"])
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), /routeReevaluation|reserveReevaluation|completeReevaluation/);
  for (const file of ["routeReevaluationPolicy.js", "routeReevaluationRunner.js"])
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../js/marketCalendarRuntime", file), "utf8"),
      /existingDbControlledWriter|bootstrapFirstSourceWriter|localStorage|fetch\(/);
});
