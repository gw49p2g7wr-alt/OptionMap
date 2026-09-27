"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const A = require("../js/marketCalendarRuntime/calendarRouteAuthority.js");
const D = require("../js/marketCalendarRuntime/calendarRouteAdapter.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js"), Policy = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");
const ER = require("../js/marketCalendarIsolated/estatRoute.js"), BR = require("../js/marketCalendarIsolated/blsFixedRoute.js");
const EF = require("./fixtures/marketCalendar/estatHtmlFixture.js"), BF = require("./fixtures/marketCalendar/blsFixedFixture.js");
const request = sourceId => ({ sourceId, operation: "source-document-set" });
const alternatives = ["jp-stat-cpi", "jp-stat-labor", "us-bls-calendar"];
const snapshot = (id, activationState, activationVersion = 1) => A.createAuthoritySnapshot({ [id]: { activationState, activationVersion } });
const options = extra => ({ fetchImpl: async () => { throw Error("unexpected_fetch"); }, assessmentDateJst: "2026-09-28", ...extra });
function response(url, failRole) {
  const bls = BR.ROLES.find(r => r.url === url);
  if (bls) return new Response(bls.role === failRole ? "not found" : BF.html(bls.role), {
    status: bls.role === failRole ? 404 : 200, headers: { "content-type": "text/html" } });
  const id = Object.keys(ER.ROUTES).find(id => ER.ROUTES[id].url === url);
  assert.ok(id, "fixed URL only");
  const rows = (id === "jp-stat-cpi" ? ["national", "tokyo"] : ["basic"]).flatMap(lane =>
    ["08", "09", "10"].map((month, i) => EF.monthly(id, lane, `2026-${month}`, `2026-${["09", "10", "11"][i]}-15`)));
  return new Response(EF.page(id, rows), { headers: { "content-type": "text/html; charset=UTF-8" } });
}
test("fixed 12-source manifest: three shadow, nine legacy, no missing/duplicate/unknown", () => {
  const m = A.DEFAULT_AUTHORITY;
  assert.equal(m.entries.length, 12); assert.equal(new Set(m.entries.map(e => e.sourceId)).size, 12);
  assert.deepEqual(m.entries.map(e => e.sourceId), Object.keys(Registry.SOURCES).sort());
  assert.deepEqual(m.entries.filter(e => e.activationState === "alternative_shadow").map(e => e.sourceId).sort(), [...alternatives].sort());
  assert.equal(m.entries.filter(e => e.activationState === "legacy_active").length, 9);
  assert.equal(A.validateAuthority(m).valid, true);
});
for (const [i, id] of alternatives.entries()) test(`A${i + 1} ${id} shadow delegates only legacy`, async () => {
  let legacyCalls = 0, fetchCalls = 0;
  const selected = A.selectRoute(request(id)); assert.equal(selected.routeKind, "legacy");
  const d = D.createRouteAdapter(options({ fetchImpl: async () => { fetchCalls++; },
    legacyAcquire: async r => { legacyCalls++; assert.deepEqual(r, request(id)); return { success: false, reason: "fixture_failure" }; } }));
  const r = await d.acquire(request(id));
  assert.equal(r.routeIdentity, selected.routeIdentity); assert.equal(r.acquisitionOutcome, "failed");
  assert.equal(legacyCalls, 1); assert.equal(fetchCalls, 0);
  assert.equal(d.diagnostics().estat.requestCount + d.diagnostics().bls.requestCount, 0);
});
test("A4 hypothetical alternative active uses existing parsers and security transports", async () => {
  for (const id of alternatives) {
    let count = 0;
    const d = D.createRouteAdapter(options({ getAuthority: () => snapshot(id, "alternative_active"),
      fetchImpl: async (url, init) => { count++; assert.equal(init.redirect, "manual"); assert.equal(init.credentials, "omit");
        assert.deepEqual(Object.keys(init.headers), ["accept"]); return response(url); },
      legacyAcquire: async () => { assert.fail("no legacy"); } }));
    const r = await d.acquire(request(id));
    assert.equal(r.acquisitionOutcome, "complete"); assert.equal(r.candidateEnvelope.candidateStatus, "available");
    assert.ok(r.candidateEnvelope.recordCount > 0); assert.equal(r.sourceContractVersion, 2);
    assert.equal(r.writerEnabled, false); assert.equal(r.absenceAuthority, "none");
    assert.equal(count, id === "us-bls-calendar" ? 4 : 1);
    assert.equal(r.coverage.absenceAuthority, "none");
    assert.doesNotMatch(JSON.stringify(r), /parserInput|<table|"rawBody"|"rawContent"/);
    assert.equal(d.diagnostics().estat.activeTasks + d.diagnostics().bls.activeTasks, 0);
  }
});
test("A5 suspended never starts acquisition", async () => {
  let calls = 0;
  const d = D.createRouteAdapter(options({ getAuthority: () => snapshot("jp-stat-cpi", "suspended"),
    fetchImpl: async () => { calls++; }, legacyAcquire: async () => { calls++; } }));
  const a = await d.acquire(request("jp-stat-cpi"));
  assert.equal(a.acquisitionOutcome, "suspended"); assert.deepEqual(a.diagnostics, ["source_suspended"]);
  assert.deepEqual(await d.acquire(request("jp-stat-cpi")), a); assert.equal(calls, 0);
});
test("A6 unknown/blocked/replaced source and wrong operation fail closed", () => {
  for (const id of ["unknown", "__proto__", "constructor", ...Object.keys(Registry.BLOCKED_SOURCES), ...Object.keys(Registry.REPLACED_SOURCES)])
    assert.equal(A.selectRoute(request(id)).acquisitionAllowed, false);
  assert.equal(A.selectRoute({ ...request(alternatives[0]), operation: "fetch-anything" }).valid, false);
});
test("A7 malformed or forged authority fail closed without acquisition", async () => {
  const variants = [null, {}, { ...A.DEFAULT_AUTHORITY, authorityVersion: 2 }];
  for (const mutate of [m => m.entries.pop(), m => m.entries[1] = m.entries[0],
    m => m.entries[0].routeIdentity = "a".repeat(64), m => m.entries[0].sourceContractVersion = 999,
    m => m.entries[0].url = "https://evil.test", m => m.entries[0].activationVersion = 0]) {
    const m = structuredClone(A.DEFAULT_AUTHORITY); mutate(m); variants.push(m);
  }
  for (const m of variants) {
    const d = D.createRouteAdapter(options({ getAuthority: () => m, legacyAcquire: async () => assert.fail("acquisition forbidden") }));
    assert.equal((await d.acquire(request("jp-stat-cpi"))).acquisitionOutcome, "rejected");
  }
  assert.throws(() => snapshot("jp-boj-calendar", "alternative_active"));
  assert.throws(() => A.createAuthoritySnapshot({ unknown: { activationState: "legacy_active", activationVersion: 1 } }));
});
test("A8 deterministic identities independent of object ordering and runtime time", () => {
  const first = A.createAuthoritySnapshot(), second = A.createAuthoritySnapshot();
  assert.deepEqual(first, second);
  const reversed = { authorityIdentity: first.authorityIdentity, entries: [...first.entries].reverse().map(e =>
    Object.fromEntries(Object.entries(e).reverse())), authorityVersion: first.authorityVersion };
  assert.deepEqual(A.validateAuthority(reversed).snapshot, first);
  assert.equal(Object.isFrozen(first.entries[0]), true);
  assert.throws(() => { first.entries[0].routeKind = "estat_release_calendar"; });
  assert.throws(() => A.createAuthoritySnapshot({ "jp-stat-cpi": { activationState: "alternative_active", activationVersion: 1, activatedAt: Date.now() } }));
});
test("A9 activation generation affects authority identity, not delivery route identity", () => {
  const a = A.selectRoute(request("jp-stat-cpi"), snapshot("jp-stat-cpi", "alternative_active", 1)),
    b = A.selectRoute(request("jp-stat-cpi"), snapshot("jp-stat-cpi", "alternative_active", 2)),
    legacy = A.selectRoute(request("jp-stat-cpi"));
  assert.equal(a.routeIdentity, b.routeIdentity); assert.notEqual(a.authorityIdentity, b.authorityIdentity);
  assert.notEqual(a.routeIdentity, legacy.routeIdentity);
});
test("A10 in-flight request holds original authority when supplier changes", async () => {
  let current = snapshot("jp-stat-cpi", "alternative_active"), release, started;
  const gate = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
  const expected = A.selectRoute(request("jp-stat-cpi"), current);
  const d = D.createRouteAdapter(options({ getAuthority: () => current,
    fetchImpl: async url => { started(); await gate; return response(url); } }));
  const pending = d.acquire(request("jp-stat-cpi")); await began;
  current = snapshot("jp-stat-cpi", "suspended", 2); release();
  const result = await pending;
  assert.equal(result.routeIdentity, expected.routeIdentity); assert.equal(result.authorityIdentity, expected.authorityIdentity);
  assert.equal(result.acquisitionOutcome, "complete"); assert.equal((await d.acquire(request("jp-stat-cpi"))).acquisitionOutcome, "suspended");
});
test("A11 alternative failure never falls back to legacy", async () => {
  for (const id of alternatives) {
    let legacyCalls = 0, networkCalls = 0;
    const d = D.createRouteAdapter(options({ getAuthority: () => snapshot(id, "alternative_active"),
      fetchImpl: async () => { networkCalls++; throw Error("secret /Users/private/file"); },
      legacyAcquire: async () => { legacyCalls++; } }));
    const r = await d.acquire(request(id)); assert.equal(r.acquisitionOutcome, "failed"); assert.equal(legacyCalls, 0);
    assert.equal(networkCalls, id === BR.SOURCE_ID ? 4 : 1);
    assert.doesNotMatch(JSON.stringify(r), /secret|\/Users|stack/);
  }
});
test("A12 renderer-style route/URL/version/fallback/authority override rejected", async () => {
  let calls = 0;
  const d = D.createRouteAdapter(options({ fetchImpl: async () => { calls++; }, legacyAcquire: async () => { calls++; } }));
  for (const key of ["routeKind", "url", "headers", "contractVersion", "fallback", "authoritySnapshot", "activationState", "assessmentDateJst"])
    assert.equal((await d.acquire({ ...request("jp-stat-cpi"), [key]: "override" })).acquisitionOutcome, "rejected");
  assert.equal(calls, 0);
});
test("BLS partial retains successful roles, failed role health and no absence authority", async () => {
  const d = D.createRouteAdapter(options({ getAuthority: () => snapshot(BR.SOURCE_ID, "alternative_active"),
    fetchImpl: async url => response(url, "jolts") }));
  const r = await d.acquire(request(BR.SOURCE_ID)); assert.equal(r.acquisitionOutcome, "partial");
  assert.equal(r.candidateEnvelope.candidateStatus, "partial"); assert.equal(r.candidateEnvelope.formalEligible, false);
  assert.equal(r.candidateEnvelope.recordCount, 9); assert.deepEqual(r.failedRoles, ["jolts"]);
  assert.equal(r.documentHealth.find(d => d.role === "jolts").httpStatus, 404);
  assert.equal(r.coverage.coverageState, "partial"); assert.equal(r.absenceAuthority, "none");
  assert.equal(r.disappearance, "not_evaluated");
});
test("existing nine delegate unchanged sourceId/operation and never call alternatives", async () => {
  const seen = [];
  const d = D.createRouteAdapter(options({ legacyAcquire: async r => { seen.push(r); return { success: false, reason: "fixture_failure" }; } }));
  for (const id of A.SOURCE_IDS.filter(id => !alternatives.includes(id))) {
    const r = await d.acquire(request(id)); assert.equal(r.routeKind, "legacy");
    assert.equal(r.sourceId, id); assert.equal(A.selectRoute(request(id)).activationState, "legacy_active");
  }
  assert.deepEqual(seen, A.SOURCE_IDS.filter(id => !alternatives.includes(id)).map(request));
  assert.equal(d.diagnostics().estat.requestCount + d.diagnostics().bls.requestCount, 0);
});
test("legacy BOJ default service and Candidate Builder preserve canonical success", async () => {
  const html = '<h2 id="p02">次回</h2><p>2026年9月17日（木）、18日（金）</p>' +
    '<h2 id="p03">会見</h2><p>2026年9月18日（金）15:30～（ライブ配信予定）</p>';
  let calls = 0;
  const d = D.createRouteAdapter(options({ fetchImpl: async url => {
    calls++; assert.equal(url, Policy.getPolicy("jp-boj-calendar").documents[0].url);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }); } }));
  const r = await d.acquire(request("jp-boj-calendar")); assert.equal(r.candidateEnvelope.recordCount, 3);
  assert.equal(r.candidateEnvelope.candidateStatus, "available"); assert.equal(calls, 1);
});
test("route/activation identity never added to semantic records", async () => {
  const results = [];
  for (const activationVersion of [1, 2]) {
    const d = D.createRouteAdapter(options({ getAuthority: () => snapshot(BR.SOURCE_ID, "alternative_active", activationVersion), fetchImpl: async url => response(url) }));
    results.push(await d.acquire(request(BR.SOURCE_ID)));
  }
  assert.notEqual(results[0].authorityIdentity, results[1].authorityIdentity);
  const identities = r => r.candidateEnvelope.canonicalRecords.map(e => [e.eventKey, e.revisionKey, e.canonicalContentHash]);
  assert.deepEqual(identities(results[0]), identities(results[1]));
  assert.doesNotMatch(JSON.stringify(results[0].candidateEnvelope.canonicalRecords), /routeIdentity|activationVersion|routeContractVersion/);
});
test("infrastructure importable only from main-side modules; no startup/manual/IPC wiring", () => {
  for (const file of ["main.js", "preload.js", "index.html", "js/marketCalendar/sourceRegistry.js",
    "js/marketCalendarRuntime/calendarAcquisitionService.js", "js/marketCalendarRuntime/calendarManualCheckService.js",
    "js/marketCalendarRuntime/calendarStartupRuntime.js"])
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), /calendarRouteAuthority|calendarRouteAdapter/);
  for (const file of ["calendarRouteAuthority.js", "calendarRouteAdapter.js"])
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../js/marketCalendarRuntime", file), "utf8"),
      /require\([^)]*(?:marketCalendarHistory|\/storage\/|sourceUpdateState|updatePolicy|calendarRuntimeStateIntegration)/);
  assert.equal(Object.hasOwn(require("../js/marketCalendarRuntime/calendarRouteAdapter.js"), "createRouteAdapter"), true);
});
