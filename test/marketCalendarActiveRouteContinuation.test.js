"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm");
const { IDBFactory } = require("fake-indexeddb");
const A = require("../js/marketCalendarRuntime/calendarRouteAuthority.js");
const P = require("../js/marketCalendarRuntime/routeReevaluationPolicy.js");
const S = require("../js/storage/marketCalendarRuntimeStateStore.js");
const F = require("./fixtures/marketCalendar/estatHtmlFixture.js");
const B = require("./fixtures/marketCalendar/blsFixedFixture.js");
const Flights = require("../js/marketCalendarRuntime/sourceSingleFlight.js");
const DAY1 = "2026-09-28T03:00:00.000Z", DAY2 = "2026-09-29T03:00:00.000Z";
async function setup(name) {
  const id = name === "bls" ? "us-bls-calendar" : "jp-stat-" + name, cap = name[0].toUpperCase() + name.slice(1);
  const factory = new IDBFactory(), seed = S.createRuntimeStateStore({ indexedDB: factory, targetEnvironment: "isolated_test" });
  await seed.write(id, { sourceId: id, lastAttemptAt: "2026-09-27T03:00:00.000Z", lastSuccessAt: null,
    lastOutcome: "failure", retryAfter: name === "bls" ? "2026-09-27T04:00:00.000Z" : null,
    lastDiagnosticClass: name === "bls" ? "network_failure" : "http_404",
    lastHttpStatus: name === "bls" ? null : 404, coordinatorVersion: 1 });
  let at = DAY1, failure = null, gate = null, requests = 0, authority = A.PRODUCTION_AUTHORITY;
  const context = vm.createContext({ indexedDB: factory, document: {}, structuredClone, setTimeout, clearTimeout, console, Date, URL });
  context.window = context;
  const store = require("../js/marketCalendarRuntime/" + name + "RuntimeStateElectron.js")["create" + cap + "RuntimeStateElectron"]({
    getAuthority: () => authority, webContents: { executeJavaScriptInIsolatedWorld: async (_, scripts) =>
      structuredClone(await vm.runInContext(scripts[0].code, context)) } });
  const create = () => require("../js/marketCalendarRuntime/" + name + "ProductionCheck.js")["create" + cap + "ProductionCheck"]({
    store, now: () => at, getAuthority: () => authority,
    legacyService: { check: async request => ({ sources: request.sourceIds.map(sourceId => ({ sourceId, status: "success" })) }) },
    fetchImpl: async url => {
      requests++; if (gate) await gate;
      if (failure === "network") throw Error("fixture");
      if (failure === "404" || failure === "partial" && url.endsWith("/jolts.htm"))
        return new Response("missing", { status: 404, headers: { "content-type": "text/html" } });
      let body;
      if (name === "bls") {
        const role = require("../js/marketCalendarIsolated/blsFixedRoute.js").ROLES.find(r => r.url === url).role;
        body = B.html(role, [...B.rows[role], ...(role === "employment_situation" ?
          [["November 2026", "Dec. 04, 2026", "08:30 AM"]] : [])]);
      } else body = F.page(id, (name === "cpi" ? ["national", "tokyo"] : ["basic"]).flatMap(lane =>
        ["08", "09", "10"].map((month, i) => F.monthly(id, lane, "2026-" + month, "2026-" + ["09", "10", "11"][i] + "-15"))));
      return new Response(body, { headers: { "content-type": "text/html; charset=UTF-8" } });
    } });
  const service = create(), read = async () => (await store.read()).value;
  const check = (trigger = "startup", target = service) => target.check({ sourceIds: [id], trigger });
  const audit = () => store.diagnostics().reduce((a, d) => ({
    writes: a.writes + d.successfulWrites, reservations: a.reservations + d.successfulReservations,
    completions: a.completions + d.completionCommits }), { writes: 0, reservations: 0, completions: 0 });
  return { id, store, factory, create, check, read, audit, requests: () => requests,
    date: value => { at = value; }, fail: value => { failure = value; }, gate: value => { gate = value; },
    authority: value => { authority = value; } };
}
for (const name of ["cpi", "labor", "bls"]) {
  test(name + ": initial activation, same-day skip, next-day and manual normal continuation", async () => {
    const f = await setup(name), first = await f.check();
    assert.equal(first.sources[0].acquisitionMode, "initial_reevaluation");
    assert.equal(first.state, "success");
    const before = await f.read(), a = f.audit(), n = f.requests();
    const skipped = await f.check();
    assert.equal(skipped.sources[0].planningDecision, "skip");
    assert.equal(skipped.successfulSourceCount, 1);
    assert.equal(f.requests(), n); assert.deepEqual(f.audit(), a); assert.deepEqual(await f.read(), before);
    f.date(DAY2);
    const next = await f.check("startup", f.create());
    assert.equal(next.state, "success");
    assert.equal(next.sources[0].acquisitionMode, "normal_active_route");
    assert.equal(next.sources[0].planningDecision, "update");
    const saved = await f.read();
    assert.equal(saved.lastSuccessAt, DAY2); assert.equal(saved.retryAfter, null);
    assert.deepEqual(saved.reevaluation, before.reevaluation); assert.deepEqual(saved.routeBinding, before.routeBinding);
    const manual = await f.check("manual");
    assert.equal(manual.state, "success"); assert.equal(manual.sources[0].planningDecision, "update");
    assert.equal(manual.sources[0].acquisitionMode, "normal_active_route");
    assert.deepEqual(f.audit(), { writes: 4, reservations: 1, completions: 1 });
    assert.ok(f.store.diagnostics().every(d => d.openHandles === 0));
    assert.deepEqual(await f.factory.databases(), [{ name: S.DATABASE_NAME, version: 1 }]);
  });
  test(name + ": interrupted reservation is blocked with no additional network/write", async () => {
    const f = await setup(name);
    await f.store.reserveReevaluation({ sourceId: f.id, requestedAt: DAY1 });
    const a = f.audit(), r = await f.check();
    assert.equal(r.sources[0].planningDecision, "blocked");
    assert.equal(r.sources[0].reasonClass, "reevaluation_interrupted");
    assert.equal(f.requests(), 0); assert.deepEqual(f.audit(), a);
  });
  test(name + ": normal retryable failure, cooldown, retry, and nonretryable startup block use B1", async () => {
    const f = await setup(name); await f.check(); const original = await f.read();
    f.date(DAY2); f.fail("network");
    assert.equal((await f.check("startup", f.create())).state, "failed");
    let saved = await f.read();
    assert.equal(saved.lastOutcome, "failure"); assert.equal(saved.lastSuccessAt, DAY1);
    assert.equal(saved.lastDiagnosticClass, "network_failure"); assert.ok(saved.retryAfter);
    assert.deepEqual(saved.reevaluation, original.reevaluation);
    const n = f.requests(), a = f.audit();
    for (const trigger of ["startup", "manual"]) {
      const r = await f.check(trigger, f.create());
      assert.equal(r.sources[0].planningDecision, "cooldown");
      assert.equal(r.sources[0].reasonClass, "retry_cooldown_active");
    }
    assert.equal(f.requests(), n); assert.deepEqual(f.audit(), a);
    f.date(saved.retryAfter); f.fail(null);
    assert.equal((await f.check("startup", f.create())).sources[0].planningDecision, "retry");
    f.date(new Date(Date.parse(saved.retryAfter) + 1000).toISOString());
    f.fail("404"); assert.equal((await f.check("manual")).state, "failed");
    saved = await f.read(); assert.equal(saved.lastDiagnosticClass, "http_404");
    const r = await f.check("startup", f.create());
    assert.equal(r.sources[0].planningDecision, "blocked");
    assert.equal(r.sources[0].reasonClass, "automatic_retry_disabled_http_404");
    assert.equal(f.audit().reservations, 1);
  });
  test(name + ": separate services join normal startup/manual source flight", async () => {
    const f = await setup(name); await f.check(); f.date(DAY2);
    let release; f.gate(new Promise(resolve => { release = resolve; }));
    const before = f.requests(), a = f.check("startup", f.create()), b = f.check("manual", f.create());
    await new Promise(resolve => setTimeout(resolve, 20)); release();
    const results = await Promise.all([a, b]);
    assert.ok(results.every(r => r.state === "success"));
    assert.equal(f.requests() - before, name === "bls" ? 4 : 1);
    assert.equal(f.audit().writes, 3);
    assert.equal(Flights.getFlightDiagnostics().activeFlightCount, 0);
  });
  test(name + ": normal completion rejects stale state, route change and cross-source input", async () => {
    const f = await setup(name); await f.check(); const expectedState = await f.read();
    const input = { sourceId: f.id, expectedState, completedAt: DAY2,
      result: { lastAttemptAt: DAY2, lastOutcome: "success", lastHttpStatus: 200, lastDiagnosticClass: null } };
    assert.equal((await f.store.completeActiveAcquisition(input)).status, "ok");
    assert.equal((await f.store.completeActiveAcquisition(input)).reason, "stale_route_result");
    assert.equal((await f.store.completeActiveAcquisition({ ...input, sourceId: "us-bea-calendar" })).reason, "source_out_of_scope");
    f.authority(A.createAuthoritySnapshot({ [f.id]: { activationState: "alternative_active", activationVersion: 3 } }));
    assert.equal((await f.store.completeActiveAcquisition({ ...input, expectedState: await f.read() })).reason, "stale_route_result");
    assert.equal(f.audit().writes, 3);
  });
}
test("BLS normal partial preserves candidates in memory, no role fields in storage", async () => {
  const f = await setup("bls"); await f.check(); f.date(DAY2); f.fail("partial");
  const r = await f.check("startup", f.create()), source = r.sources[0];
  assert.equal(source.status, "failed"); assert.equal(source.acquisitionStatus, "partial");
  assert.ok(source.recordCount > 0); assert.deepEqual(source.failedRoles, ["jolts"]);
  assert.equal(source.absenceAuthority, "none"); assert.equal(source.disappearance, "not_evaluated");
  const saved = await f.read(); assert.equal(saved.lastOutcome, "failure");
  assert.equal(saved.lastSuccessAt, DAY1); assert.equal(Object.hasOwn(saved, "failedRoles"), false);
  assert.equal(f.audit().reservations, 1);
});
test("duplicate one-shot guard remains a guard after normal continuation", async () => {
  const f = await setup("cpi"); await f.check(); f.date(DAY2); await f.check("manual");
  const a = f.audit(), state = await f.read();
  assert.equal(P.evaluate({ sourceId: f.id, state, requestedAt: DAY2, authority: A.PRODUCTION_AUTHORITY }).reason,
    "reevaluation_already_completed");
  assert.deepEqual(f.audit(), a);
});
test("state time validation preserves initial completion ordering without rewriting transition history", async () => {
  const f = await setup("labor"); await f.check(); const state = await f.read();
  const State = require("../js/marketCalendarRuntime/sourceUpdateState.js");
  assert.equal(State.validateCompatibleRuntimeState({ ...state, lastAttemptAt: DAY2, lastSuccessAt: DAY2 }, f.id).valid, true);
  assert.equal(State.validateCompatibleRuntimeState({ ...state, reevaluation: {
    ...state.reevaluation, completedAt: "2026-09-27T00:00:00.000Z" } }, f.id).valid, false);
  const reserved = { ...state, lastOutcome: "none", lastAttemptAt: null, lastSuccessAt: null,
    lastHttpStatus: null, reevaluation: { ...state.reevaluation, status: "reserved", completedAt: null } };
  assert.equal(P.completeState({ state: reserved, token: P.reservationToken(reserved),
    authority: A.PRODUCTION_AUTHORITY, completedAt: DAY1, result: {
      lastAttemptAt: DAY2, lastOutcome: "success", lastHttpStatus: 200, lastDiagnosticClass: null } }).valid, false);
});
test("startup attempt limit does not limit explicit manual override; shadow delegates legacy", async () => {
  const f = await setup("cpi");
  await f.check(); f.date(DAY2); await f.check();
  f.date("2026-09-30T03:00:00.000Z");
  const blocked = await f.check();
  assert.equal(blocked.sources[0].reasonClass, "session_attempt_limit_reached");
  assert.equal((await f.check("manual")).state, "success");
  f.authority(A.DEFAULT_AUTHORITY);
  const n = f.requests(), a = f.audit();
  assert.equal((await f.check()).sources[0].status, "success");
  assert.equal(f.requests(), n); assert.deepEqual(f.audit(), a);
});
