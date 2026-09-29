"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Fixtures = require("./fixtures/marketCalendar/sourceFixtures.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Compare = require("../js/marketCalendarRuntime/formalExactComparison.js");
const T = "2026-09-28T00:00:00.000Z", SOURCE = "jp-stat-cpi";
const empty = () => ({ entries: [], revisions: [], evidence: [], observations: [], runs: [], cursors: [] });
async function event(sourceId = SOURCE, overrides = {}) {
  const source = Registry.getSource(sourceId), result = await Canonicalizer.canonicalize({
    ...Fixtures.record(sourceId), sourceId, sourceUrl: source.canonicalUrl,
    fetchedAt: T, parserId: source.parserId, parserVersion: source.parserVersion,
    rawContentHash: "a".repeat(64), ...overrides });
  assert.equal(result.ok, true, result.reason); return { ...structuredClone(result.event), sourceId };
}
const results = (sourceId, records, extras = {}) => Compare.SOURCE_IDS.map(id => ({
  sourceId: id, canonicalRecords: id === sourceId ? records : [],
  candidateStatus: id === sourceId ? "available" : "unavailable",
  acquisitionOutcome: id === sourceId ? "complete" : "failed", absenceAuthority: "none", ...
    (id === sourceId ? extras : {}) }));
function formal(record) {
  const snapshot = empty(); snapshot.entries.push({ eventKey: record.eventKey, sourceId: record.sourceId,
    activeRevisionKey: record.revisionKey, firstKnownAt: T, lastObservedAt: T });
  snapshot.revisions.push({ ...record, sourceId: record.sourceId, validFrom: T, validTo: null,
    calendarDateStart: "2026-09-28", calendarDateEnd: "2026-09-28",
    revisionOrigin: "initial_observation" }); return snapshot;
}
test("F1 exact unchanged and F12 same input yields same output", async () => {
  const record = await event(), input = { sourceResults: results(SOURCE, [record]), formalSnapshot: formal(record) };
  const a = await Compare.compare(input), b = await Compare.compare(input);
  assert.equal(a.status, "compared", a.reason); assert.equal(a.totals.unchanged, 1); assert.deepEqual(a, b);
});
test("F2 evidence-only change is not semantic change", async () => {
  const old = await event(), updated = { ...old, acquisitionEvidence: {
    ...old.acquisitionEvidence, sourceUrl: "https://www.e-stat.go.jp/release-calendar/statistics/00200573" } };
  const value = await Compare.compare({ sourceResults: results(SOURCE, [updated]), formalSnapshot: formal(old) });
  assert.equal(value.totals.unchanged, 1); assert.equal(value.totals.changed, 0);
  assert.equal(value.totals.evidenceOnly, 1);
});
test("F3 semantic changed reports field names", async () => {
  const old = await event(), next = await event(SOURCE, { titleJa: "改訂された名称" });
  const value = await Compare.compare({ sourceResults: results(SOURCE, [next]), formalSnapshot: formal(old) });
  assert.equal(value.totals.changed, 1); assert.deepEqual(value.differences[0].fields, ["title"]);
});
test("F4 candidate new does not authorize writing", async () => {
  const old = await event(), next = await event(SOURCE, { referencePeriod: "2026-10" });
  const value = await Compare.compare({ sourceResults: results(SOURCE, [old, next]), formalSnapshot: formal(old) });
  assert.equal(value.totals.new, 1); assert.equal(value.writerEnabled, false);
});
for (const coverage of [null, { coverageState: "sufficient", absenceAuthority: "none" }]) {
  test(`F5/F6 Formal-only is not evaluated with coverage ${coverage ? "inside" : "outside"}`, async () => {
    const old = await event(), value = await Compare.compare({ sourceResults: results(SOURCE, [], { coverage }),
      formalSnapshot: formal(old) });
    assert.equal(value.totals.notEvaluated, 1);
    assert.equal(value.differences[0].status, "formal_only_not_evaluated");
  });
}
test("F7 duplicate candidate eventKey rejects without silent deduplication", async () => {
  const record = await event(), value = await Compare.compare({ sourceResults: results(SOURCE, [record, record]),
    formalSnapshot: empty() }); assert.equal(value.reason, "candidate_duplicate_event");
});
test("F8 duplicate Formal active eventKey rejects", async () => {
  const record = await event(), snapshot = formal(record); snapshot.entries.push(snapshot.entries[0]);
  const value = await Compare.compare({ sourceResults: results(SOURCE, [record]), formalSnapshot: snapshot });
  assert.equal(value.status, "rejected");
});
test("F9 multiple active revisions reject", async () => {
  const record = await event(), other = await event(SOURCE, { titleJa: "別の名称" }), snapshot = formal(record);
  snapshot.revisions.push({ ...other, sourceId: SOURCE, validFrom: T, validTo: null,
    calendarDateStart: "2026-09-28", calendarDateEnd: "2026-09-28",
    revisionOrigin: "authority_semantic_change" });
  const value = await Compare.compare({ sourceResults: results(SOURCE, [record]), formalSnapshot: snapshot });
  assert.equal(value.status, "rejected");
});
test("F10 partial source retains success candidates and does not infer absence", async () => {
  const record = await event(), value = await Compare.compare({ sourceResults: results(SOURCE, [record], {
    acquisitionOutcome: "partial", candidateStatus: "partial", failedRoles: ["secondary"] }),
    formalSnapshot: formal(record) });
  assert.equal(value.totals.unchanged, 1); assert.equal(value.summaries.find(s => s.sourceId === SOURCE).failedRoles[0], "secondary");
  assert.equal(value.absenceAuthority, "none");
});
test("F11 candidate and source order do not change ordering", async () => {
  const record = await event(), sourceResults = results(SOURCE, [record]);
  const a = await Compare.compare({ sourceResults, formalSnapshot: formal(record) });
  const b = await Compare.compare({ sourceResults: sourceResults.reverse(), formalSnapshot: formal(record) });
  assert.deepEqual(a, b);
});
for (const sourceId of ["jp-stat-cpi", "jp-stat-labor", "us-bls-calendar"]) {
  test(`${sourceId} alternate Evidence preserves eventKey and semantic hash`, async () => {
    const old = await event(sourceId), next = { ...old, acquisitionEvidence: {
      ...old.acquisitionEvidence, sourceUrl: "https://official.example/new-delivery" } };
    const value = await Compare.compare({ sourceResults: results(sourceId, [next]), formalSnapshot: formal(old) });
    assert.equal(value.totals.unchanged, 1); assert.equal(value.totals.evidenceOnly, 1);
    assert.equal(value.differences[0].previousRevisionKey, value.differences[0].candidateRevisionKey);
  });
}
