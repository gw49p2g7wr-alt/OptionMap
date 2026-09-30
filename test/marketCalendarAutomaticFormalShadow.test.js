"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const Shadow = require("../js/marketCalendarRuntime/automaticFormalShadow.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const F = require("./fixtures/marketCalendar/automaticShadowFixture.js");
const SOURCE = "jp-esri-machinery-orders-calendar";
const evaluated = f => Shadow.evaluate({ sourceResults: f.sources, before: f.snapshot,
  schemaFingerprint: Schema.EXPECTED_FINGERPRINT });
const row = (r, id = SOURCE) => r.sourceRows.find(s => s.sourceId === id);
async function pipeline(f) {
  let reads = 0;
  const p = Shadow.createPipeline({ readFormal: async () => { reads++; return { status: "ok", snapshot: f.snapshot,
    schemaFingerprint: Schema.EXPECTED_FINGERPRINT }; } });
  return { p, reads: () => reads };
}
for (const trigger of ["startup", "manual"]) test(`S1/S2 ${trigger}: result reused, acquisition unaffected, no writer`, async () => {
  const f = await F.fixture(), { p, reads } = await pipeline(f), result = { state: "success", sources: [] };
  let acquisitions = 0;
  const actual = await p.check({ trigger }, async () => { acquisitions++; f.sources.forEach(s => p.capture(F.envelope(s))); return result; });
  assert.equal(actual, result); assert.equal(acquisitions, 1); assert.equal(reads(), 1);
  const report = p.diagnostics(); assert.equal(report.status, "evaluated"); assert.equal(report.eligibleCount, 11);
  assert.equal(report.writerExecution, 0); assert.equal(report.writeAllowed, false);
  assert.equal(report.readwriteTransactions, 0);
});
test("S3 same acquisition shared across startup/manual retains all identities", async () => {
  const f = await F.fixture(), { p } = await pipeline(f);
  async function invoke(trigger) { await p.check({ trigger }, async () => { f.sources.forEach(s => p.capture(F.envelope(s))); return {}; }); return p.diagnostics(); }
  const a = await invoke("startup"), b = await invoke("manual");
  for (const s of a.sourceRows) assert.deepEqual([s.acquisitionIdentity, s.candidateIdentity, s.planIdentity],
    [row(b, s.sourceId).acquisitionIdentity, row(b, s.sourceId).candidateIdentity, row(b, s.sourceId).planIdentity]);
});
test("S4 separate legitimate acquisition changes run/plan, not semantics", async () => {
  let f = await F.fixture(); const first = await evaluated(f); f = structuredClone(f);
  f.sources.find(s => s.sourceId === SOURCE).canonicalRecords[0] = await F.event(SOURCE, "2026-10-02T00:00:00.000Z",
    { referencePeriod: "2000-01" });
  const next = await evaluated(f);
  assert.equal(row(next).unchanged, 1); assert.notEqual(row(first).acquisitionIdentity, row(next).acquisitionIdentity);
  assert.notEqual(row(first).planIdentity, row(next).planIdentity);
});
test("S5 same-day skip performs no read, no network, no Run/Observation replay", async () => {
  const f = await F.fixture(), { p, reads } = await pipeline(f);
  await p.check({ trigger: "startup" }, async () => ({ state: "success", planningDecision: "skip" }));
  assert.equal(reads(), 0); assert.equal(p.diagnostics().status, "skipped");
  assert.ok(Object.values(p.diagnostics().aggregatePlannedCounts).every(n => n === 0));
});
test("S6/S7/S8/S9/S10 source independence: failed/partial/BOJ/changed do not stop others", async () => {
  const f = await F.fixture();
  const failed = f.sources.find(s => s.sourceId === "us-bea-calendar"); failed.acquisitionOutcome = "failed";
  const partial = f.sources.find(s => s.sourceId === "us-bls-calendar"); partial.acquisitionOutcome = "partial";
  partial.failedRoles = ["jolts"];
  const changed = f.sources.find(s => s.sourceId === "jp-stat-labor");
  changed.canonicalRecords[0] = await F.event(changed.sourceId, F.FRESH, { referencePeriod: "2000-01", titleJa: "changed" });
  const report = await evaluated(f);
  assert.equal(report.status, "evaluated"); assert.equal(report.failedPartialCount, 2);
  for (const id of [failed.sourceId, partial.sourceId, "jp-boj-calendar"]) {
    assert.equal(row(report, id).eligible, false); assert.ok(Object.values(row(report, id).counts).every(n => n === 0));
  }
  assert.equal(row(report, "jp-boj-calendar").reason, "writer_ineligible_identity_transition");
  assert.equal(row(report, changed.sourceId).reason, "unsupported_changed");
  assert.equal(row(report, changed.sourceId).eligible, false);
  assert.equal(row(report, changed.sourceId).counts.semanticRevisionCreate, 1);
  assert.equal(row(report, changed.sourceId).productionWriteEligible, false);
  assert.equal(row(report).eligible, true); assert.equal(row(report).counts.sourceRunCreate, 1);
  assert.deepEqual(row(report, partial.sourceId).retainedCandidateKeys, partial.canonicalRecords.map(r => r.eventKey));
});
test("S11 shadow failure never rewrites successful acquisition or Runtime State", async () => {
  const result = { state: "success", sources: [{ sourceId: SOURCE, status: "success" }] }, f = await F.fixture();
  const p = Shadow.createPipeline({ readFormal: async () => { throw Error("failure"); } });
  const actual = await p.check({}, async () => { p.capture(F.envelope(f.sources.find(s => s.sourceId === SOURCE))); return result; });
  assert.equal(actual, result); assert.equal(result.state, "success"); assert.equal(p.diagnostics().status, "unsafe");
});
test("S12/S13 runtime modules cannot reach a controlled writer or readwrite", () => {
  for (const file of ["automaticFormalShadow.js", "formalShadowElectronRead.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "../js/marketCalendarRuntime", file), "utf8");
    assert.doesNotMatch(src, /require\([^\n]*(?:[Ee]xecutor|[Cc]ontrolledWriter|productionHistoryWriter)/);
    assert.doesNotMatch(src, /transaction\([^\n]*["']readwrite["']/);
  }
});
test("S14 integrity failure is global unsafe, no plans", async () => {
  for (const fault of ["duplicate", "orphan", "active"]) {
    const f = await F.fixture();
    if (fault === "duplicate") f.snapshot.entries.push(f.snapshot.entries[0]);
    if (fault === "orphan") f.snapshot.evidence[0].revisionKey = "orphan";
    if (fault === "active") f.snapshot.entries[0].activeRevisionKey = "missing";
    const report = await evaluated(f); assert.equal(report.status, "unsafe");
    assert.equal(report.failureScope, "global_suspend_candidate"); assert.equal(report.sourceRows.length, 0);
  }
});
test("S15 malformed internal shadow authority fails closed", async () => {
  const f = await F.fixture();
  for (const internalAuthority of [{ ...Shadow.INTERNAL_SHADOW, writeAllowed: true }, null,
    { ...Shadow.INTERNAL_SHADOW, state: "active" }]) {
    const report = await Shadow.evaluate({ sourceResults: f.sources, before: f.snapshot,
      schemaFingerprint: Schema.EXPECTED_FINGERPRINT, internalAuthority });
    assert.equal(report.reason, "shadow_authority_invalid");
  }
});
test("schema mismatch is global; route mismatch and stale are source-local", async () => {
  const f = await F.fixture();
  assert.equal((await Shadow.evaluate({ sourceResults: f.sources, before: f.snapshot,
    schemaFingerprint: "forged" })).failureScope, "global_suspend_candidate");
  f.sources[0].routeIdentity = "forged";
  const after = structuredClone(f.snapshot); after.entries.find(e => e.sourceId === SOURCE).lastObservedAt = F.FRESH;
  const report = await Shadow.evaluate({ sourceResults: f.sources, before: f.snapshot, after,
    schemaFingerprint: Schema.EXPECTED_FINGERPRINT });
  assert.equal(row(report).reason, "source_stale_precondition");
  assert.equal(row(report).failureScope, "source_local");
  assert.equal(row(report, f.sources[0].sourceId).failureScope, "source_suspend_candidate");
  assert.equal(row(report, "us-bea-calendar").eligible, true);
  assert.equal(report.futureWriteRequiresFreshPlan, true);
});
for (const [label, historyRuns] of [["S16 current-size", 3], ["S17 one-year monthly history", 12]]) {
  test(label + " getAll/material/planning benchmark", async () => {
    const f = await F.fixture({ perSource: 21, historyRuns }); // 252 active events, full six-store history.
    const start = performance.now(), report = await evaluated(f), elapsedMs = performance.now() - start;
    assert.equal(report.status, "evaluated", report.reason); assert.equal(report.eligibleCount, 11);
    // Existing bounded request deadline, not an extended planner timeout.
    assert.ok(elapsedMs < 15000, `runtime integration must STOP: ${elapsedMs}ms`);
    console.log(JSON.stringify({ benchmark: label, elapsedMs, materialBytes: report.performance.snapshotBytes,
      records: report.performance.records, metrics: report.performance }));
  });
}
test("S18 one-year daily acquisition history scaling gate", async () => {
  const f = await F.fixture({ perSource: 21, historyRuns: 365 });
  const start = performance.now(), report = await evaluated(f), elapsedMs = performance.now() - start;
  console.log(JSON.stringify({ benchmark: "one-year daily", elapsedMs,
    materialBytes: report.performance?.snapshotBytes, records: report.performance?.records, metrics: report.performance }));
  assert.equal(report.status, "evaluated", report.reason);
  assert.ok(elapsedMs < 5000, `runtime integration must STOP: ${elapsedMs}ms`);
});
