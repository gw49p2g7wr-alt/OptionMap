"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs");
const G = require("../scripts/marketCalendarD2c3Shadow.js");
const EF = require("./fixtures/marketCalendar/estatHtmlFixture.js"), BF = require("./fixtures/marketCalendar/blsFixedFixture.js");
const ER = require("../js/marketCalendarIsolated/estatRoute.js"), C = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Legacy = require("../js/marketCalendarShadow/representativeParsers.js"), Registry = require("../js/marketCalendar/sourceRegistry.js");
const date = "2026-09-28", fetchedAt = "2026-09-28T00:00:00Z";
function estat(sourceId, rows) {
  rows ||= (sourceId === "jp-stat-cpi" ? ["national", "tokyo"] : ["basic"]).flatMap(lane =>
    ["08", "09", "10"].map((m, i) => EF.monthly(sourceId, lane, `2026-${m}`, `2026-${["09", "10", "11"][i]}-15`)));
  const parserInput = Buffer.from(EF.page(sourceId, rows));
  return { success: true, sourceId, fetchedAt, document: { finalUrl: ER.ROUTES[sourceId].url,
    httpStatus: 200, redirects: [], mime: "text/html", contentType: "text/html; charset=UTF-8",
    byteCount: parserInput.length, contentSha256: ER.hash(parserInput), parserInput } };
}
function runner(fail = [], partialBls = false, rows = {}) {
  const acquire = async ({ sourceId }) => {
    if (fail.includes(sourceId)) throw Error("mock failure");
    if (G.routeKind(sourceId) === "estat") return estat(sourceId, rows[sourceId]);
    if (G.routeKind(sourceId) === "bls_fixed") { const a = BF.acquisition(); if (partialBls) a.documents.pop(); return a; }
    return { sourceId, success: true, documents: [] };
  };
  return G.createRunner({ adapters: { estat: { acquire }, bls: { acquire }, existing: { acquire },
    // Existing builder separately covered by its fixtures/regression and live path.
    buildExisting: async ({ sourceId }) => ({ formalEligible: true, parserStatus: "success", canonicalRecords:
      [{ eventKey: sourceId, revisionKey: sourceId + "-revision", canonicalContentHash: sourceId }] }) } });
}
test("I1 twelve fixed source identities and complete aggregation, no raw body", async () => {
  const r = await runner().run({ assessmentDateJst: date });
  assert.equal(r.overallCompleteness, "complete"); assert.equal(r.observedSourceCount, 12);
  assert.equal(r.unknownSourceCount + r.duplicateSourceCount, 0);
  assert.doesNotMatch(JSON.stringify(r), /parserInput|<table/);
});
for (const [label, failures] of [["I2 CPI", ["jp-stat-cpi"]], ["I3 Labor", ["jp-stat-labor"]],
  ["I5 existing", ["jp-boj-calendar"]], ["I6 independent", ["jp-stat-cpi", "us-fed-fomc-calendar"]]])
  test(label + " failure preserves other sources", async () => {
    const r = await runner(failures).run({ assessmentDateJst: date });
    assert.equal(r.overallCompleteness, "partial"); assert.equal(r.observedSourceCount, 12);
    assert.equal(r.sourceResults.filter(s => s.candidateStatus === "available").length, 12 - failures.length);
  });
test("I4 BLS role failure retains candidates without absence authority", async () => {
  const r = await runner([], true).run({ assessmentDateJst: date }), b = r.sourceResults.find(s => s.sourceId === "us-bls-calendar");
  assert.equal(r.overallCompleteness, "partial"); assert.equal(b.candidateCount, 9);
  assert.deepEqual(b.failedRoles, ["jolts"]); assert.equal(b.disappearance, "not_evaluated");
  assert.equal(b.absenceAuthority, "none"); assert.equal(b.coverage.coverageState, "partial");
});
test("I7 duplicate and unknown source identities fail closed", async () => {
  const r = await runner().run({ assessmentDateJst: date });
  assert.equal(G.aggregate([...r.sourceResults, r.sourceResults[0]], date).overallCompleteness, "invalid");
  assert.equal(G.aggregate([...r.sourceResults, { ...r.sourceResults[0], sourceId: "unknown" }], date).unknownSourceCount, 1);
});
test("I8 missing identity differs from failed source", async () => {
  const r = await runner().run({ assessmentDateJst: date });
  assert.equal(G.aggregate(r.sourceResults.slice(1), date).sourceIdentityValid, false);
});
test("I9 integrated XML and BLS semantic parity", async () => {
  const rows = {}, old = [];
  for (const [sourceId, fixture, method] of [["jp-stat-cpi", "statCpiXmlFixture", "parseStatCpiXml"],
    ["jp-stat-labor", "statLaborXmlFixture", "parseStatLaborXml"]]) {
    const r = Legacy[method](require(`./fixtures/marketCalendar/${fixture}.js`).xml, { sourceId,
      sourceUrl: Registry.getSource(sourceId).canonicalUrl, fetchedAt,
      parserId: Registry.getSource(sourceId).parserId, parserVersion: 1, rawContentHash: "a".repeat(64) });
    rows[sourceId] = r.records.map(e => EF.monthly(sourceId, e.scope, e.referencePeriod, e.sourceLocalSchedule.startDate)); old.push(...r.records);
  }
  old.push(...Legacy.parseBls(fs.readFileSync(__dirname + "/fixtures/marketCalendar/blsMonthlyCalendar.html", "utf8"), {
    sourceId: "us-bls-calendar", sourceUrl: "https://www.bls.gov/schedule/", fetchedAt,
    parserId: Registry.getSource("us-bls-calendar").parserId, parserVersion: 1, rawContentHash: "a".repeat(64) }).records);
  const r = await runner([], false, rows).run({ assessmentDateJst: date }), records = r.sourceResults.flatMap(s => s.canonicalRecords);
  for (const record of old) { const c = await C.canonicalize(record), fresh = records.find(e => e.eventKey === c.event.eventKey);
    assert.ok(fresh); assert.equal(fresh.canonicalContentHash, c.event.canonicalContentHash);
    assert.equal(fresh.revisionKey, c.event.revisionKey); assert.notEqual(fresh.acquisitionEvidenceKey, c.event.acquisitionEvidenceKey); }
});
test("I10 deterministic canonical source ordering", async () => {
  const r = await runner().run({ assessmentDateJst: date });
  assert.deepEqual(G.aggregate([...r.sourceResults].reverse(), date), r);
});
test("I11 identical input and assessment deterministic", async () => {
  assert.deepEqual(await runner().run({ assessmentDateJst: date }), await runner().run({ assessmentDateJst: date }));
});
test("I12 coverage change does not change event identity", async () => {
  const a = await runner().run({ assessmentDateJst: date }), b = await runner().run({ assessmentDateJst: "2027-01-01" });
  assert.deepEqual(a.sourceResults.map(s => s.canonicalRecords), b.sourceResults.map(s => s.canonicalRecords));
  assert.notDeepEqual(a.sourceResults.map(s => s.coverage), b.sourceResults.map(s => s.coverage));
});
test("duplicate/conflicting event and revision identities not silently deduped", async () => {
  const r = await runner().run({ assessmentDateJst: date });
  r.sourceResults[0].canonicalRecords.push({ ...r.sourceResults[0].canonicalRecords[0], canonicalContentHash: "conflict" });
  const a = G.aggregate(r.sourceResults, date);
  assert.equal(a.duplicateEventKey, 1); assert.equal(a.conflictingEventKey, 1); assert.equal(a.duplicateRevisionIdentity, 1);
  assert.equal(a.overallCompleteness, "invalid");
});
test("production entry points remain disconnected", () => {
  for (const p of ["main.js", "preload.js", "index.html", "js/marketCalendar/sourceRegistry.js",
    "js/marketCalendarRuntime/calendarAcquisitionService.js", "js/marketCalendarRuntime/calendarManualCheckService.js",
    "js/marketCalendarRuntime/calendarStartupRuntime.js"]) assert.doesNotMatch(fs.readFileSync(p, "utf8"), /D2c3Shadow|blsFixed|estatRoute/);
});
test("existing acquisition encoding warnings counted separately from blockers", async () => {
  const acquire = async ({ sourceId }) => ({ sourceId, success: true, documents: [{ role: "primary",
    encoding: { warnings: ["encoding_declaration_conflict_resolved_by_higher_precedence"] } }] });
  const r = await G.createRunner({ adapters: { estat: { acquire }, bls: { acquire }, existing: { acquire },
    buildExisting: async () => ({ formalEligible: true, parserStatus: "success", canonicalRecords: [] }) } })
    .run({ assessmentDateJst: date });
  const s = r.sourceResults.find(s => s.sourceId === "us-census-calendar");
  assert.equal(s.warningCount, 1); assert.equal(s.blockingDiagnosticCount, 0);
});
