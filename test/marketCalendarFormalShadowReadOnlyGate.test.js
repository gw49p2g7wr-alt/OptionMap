"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Fixtures = require("./fixtures/marketCalendar/sourceFixtures.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Transition = require("../js/marketCalendarHistory/transitionPlanner.js");
const Mapper = require("../js/marketCalendarHistory/storageRecordMapper.js");
const Compare = require("../js/marketCalendarRuntime/formalExactComparison.js");
const Gate = require("../js/marketCalendarRuntime/formalShadowReadOnlyGate.js");

const FETCHED = "2026-09-15T00:00:00.000Z", OLD = "2026-09-28T00:00:00.000Z",
  NOW = "2026-09-30T00:00:00.000Z";
const empty = () => ({ entries: [], revisions: [], evidence: [], observations: [], runs: [], cursors: [] });
async function record(sourceId, override = {}) {
  const source = Registry.getSource(sourceId), value = await Canonicalizer.canonicalize({
    ...Fixtures.record(sourceId), ...override, sourceId, fetchedAt: FETCHED,
    parserId: source.parserId, parserVersion: source.parserVersion,
    rawContentHash: "a".repeat(64) });
  assert.equal(value.ok, true, value.reason);
  return { ...structuredClone(value.event), sourceId };
}
async function formal(records) {
  const result = empty();
  for (const value of records) {
    const run = { sourceId: value.sourceId, runId: "baseline", acceptedAt: OLD,
      fetchedAt: [FETCHED], status: "accepted", semanticSetHash: await Canonicalizer.sha256(
        [value.revisionKey]) }, planned = Transition.planTransition({ snapshot: empty(), run,
        canonicalSet: [value] });
    assert.equal(planned.ok, true, `${value.sourceId}: ${JSON.stringify(planned.errors || planned.outcome)}`);
    const mapped = Mapper.mapPlan(planned.plan);
    for (const [field, key] of [["entries", "appendEntries"], ["revisions", "appendRevisions"],
      ["evidence", "appendEvidence"], ["observations", "appendObservations"],
      ["runs", "appendRuns"], ["cursors", "updateCursors"]]) result[field].push(...mapped[key]);
  }
  return result;
}
const health = sourceId => sourceId === "us-bls-calendar" ?
  ["cpi", "ppi", "employment_situation", "jolts"].map(role =>
    ({ role, fetchOutcome: "success", parseOutcome: "success" })) :
  [{ role: "primary", fetchOutcome: "success", parseOutcome: "success" }];
async function fixture() {
  const records = await Promise.all(Compare.SOURCE_IDS.map(sourceId => record(sourceId))),
    formalSnapshot = await formal(records), sourceResults = records.map(value => ({
      sourceId: value.sourceId, canonicalRecords: [value], acquisitionOutcome: "complete",
      candidateStatus: "available", failedRoles: [], documentHealth: health(value.sourceId),
      absenceAuthority: "none", routeIdentity: `fixture-${value.sourceId}` })),
    precondition = await Gate.formalPreconditionIdentity(formalSnapshot, Schema.EXPECTED_FINGERPRINT);
  const input = { formalSnapshot, sourceResults, schemaFingerprint: Schema.EXPECTED_FINGERPRINT,
    completedAt: NOW, startingPreconditionIdentity: precondition,
    endingPreconditionIdentity: precondition };
  return input;
}
test("E2c 12-source unchanged shadow yields first-write candidate without writer execution", async () => {
  const input = await fixture(), report = await Gate.buildReadOnlyShadowReport(input);
  assert.equal(report.status, "evaluated", report.reason);
  assert.equal(report.sourceSuccessCount, 12);
  assert.equal(report.firstWriteCandidateEligible, true);
  assert.equal(report.firstLiveWriteEligible, true);
  assert.equal(report.firstWrite.sourceId, "jp-esri-machinery-orders-calendar");
  assert.equal(report.firstWrite.counts.semanticRevisionCreate, 0);
  assert.equal(report.firstWrite.counts.sourceRunCreate, 1);
  assert.equal(report.writerAuthorityState, "disabled");
  assert.equal(report.writerExecution, 0);
  const boj = report.sourceRows.find(value => value.sourceId === "jp-boj-calendar");
  assert.equal(boj.planStatus, "skipped");
  assert.ok(Object.values(boj.counts).every(value => value === 0));
});
test("E2c source failure retains safe plan but first-live readiness is false", async () => {
  const input = await fixture(), labor = input.sourceResults.find(value =>
    value.sourceId === "jp-stat-labor");
  labor.acquisitionOutcome = "failed"; labor.candidateStatus = "unavailable";
  labor.failedRoles = ["primary"];
  const report = await Gate.buildReadOnlyShadowReport(input), row = report.sourceRows.find(value =>
    value.sourceId === "jp-stat-labor");
  assert.equal(report.sourceSuccessCount, 11);
  assert.equal(report.firstLiveWriteEligible, false);
  assert.equal(row.planStatus, "skipped");
  assert.ok(Object.values(row.counts).every(value => value === 0));
});
test("E2c changed first source makes first-write readiness false", async () => {
  const input = await fixture(), source = input.sourceResults.find(value =>
    value.sourceId === "jp-esri-machinery-orders-calendar");
  source.canonicalRecords = [await record(source.sourceId, { titleJa: "変更" })];
  const report = await Gate.buildReadOnlyShadowReport(input);
  assert.equal(report.status, "evaluated", report.reason);
  assert.equal(report.firstWrite.changed, 1);
  assert.equal(report.firstWriteCandidateEligible, false);
  assert.equal(report.firstLiveWriteEligible, false);
});
test("E2c stale Formal snapshot identity rejects before planning", async () => {
  const input = await fixture(); input.endingPreconditionIdentity = "b".repeat(64);
  assert.deepEqual(await Gate.buildReadOnlyShadowReport(input),
    { status: "rejected", reason: "stale_readonly_shadow" });
});
test("E2c alternative evidence-only leaves existing semantic revisions untouched", async () => {
  const input = await fixture();
  for (const sourceId of ["jp-stat-cpi", "jp-stat-labor", "us-bls-calendar"]) {
    const source = input.sourceResults.find(value => value.sourceId === sourceId),
      old = source.canonicalRecords[0], acquisitionEvidence = {
        ...old.acquisitionEvidence, sourceUrl: `https://example.invalid/${sourceId}` },
      acquisitionEvidenceHash = await Canonicalizer.sha256(acquisitionEvidence);
    source.canonicalRecords = [{ ...old, acquisitionEvidence,
      acquisitionEvidenceHash,
      acquisitionEvidenceKey: `${sourceId}|sha256:${acquisitionEvidenceHash}` }];
  }
  const report = await Gate.buildReadOnlyShadowReport(input);
  assert.equal(report.status, "evaluated", report.reason);
  for (const sourceId of ["jp-stat-cpi", "jp-stat-labor", "us-bls-calendar"]) {
    const row = report.sourceRows.find(value => value.sourceId === sourceId);
    assert.equal(row.evidenceOnly, 1);
    assert.equal(row.counts.semanticRevisionCreate, 0);
    assert.equal(row.counts.evidenceCreate, 1);
  }
});
test("E2c gate and harness have no Formal writer import or activation wiring", () => {
  const gate = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarRuntime/formalShadowReadOnlyGate.js"), "utf8");
  const harness = fs.readFileSync(path.join(__dirname,
    "../scripts/marketCalendarE2cReadOnlyShadow.js"), "utf8");
  for (const content of [gate, harness])
    assert.doesNotMatch(content, /require\([^)]*(?:isolatedFormalControlledWriter|productionHistoryWriter|existingDbControlledWriter)/);
  assert.doesNotMatch(harness, /db\.transaction\([^\n]*["']readwrite["']/);
  for (const file of ["main.js", "preload.js", "index.html",
    "js/marketCalendarRuntime/calendarStartupRuntime.js",
    "js/marketCalendarRuntime/calendarManualCheckService.js"])
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
      /formalShadowReadOnlyGate/);
});
