"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Fixtures = require("./fixtures/marketCalendar/sourceFixtures.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Transition = require("../js/marketCalendarHistory/transitionPlanner.js");
const Mapper = require("../js/marketCalendarHistory/storageRecordMapper.js");
const Compare = require("../js/marketCalendarRuntime/formalExactComparison.js");
const Authority = require("../js/marketCalendarHistory/formalWriterAuthority.js");
const Shadow = require("../js/marketCalendarHistory/formalShadowWritePlan.js");

const FETCHED = "2026-09-15T00:00:00.000Z", OLD = "2026-09-28T00:00:00.000Z",
  NOW = "2026-09-29T00:00:00.000Z", SOURCE = "jp-esri-machinery-orders-calendar";
const empty = () => ({ entries: [], revisions: [], evidence: [], observations: [], runs: [], cursors: [] });
async function event(sourceId = SOURCE, overrides = {}) {
  const source = Registry.getSource(sourceId), result = await Canonicalizer.canonicalize({
    ...Fixtures.record(sourceId), ...overrides, sourceId, fetchedAt: FETCHED,
    parserId: source.parserId, parserVersion: source.parserVersion,
    rawContentHash: "a".repeat(64) });
  assert.equal(result.ok, true, result.reason);
  return structuredClone(result.event);
}
async function withEvidence(record, sourceUrl) {
  const acquisitionEvidence = { ...record.acquisitionEvidence, sourceUrl },
    acquisitionEvidenceHash = await Canonicalizer.sha256(acquisitionEvidence);
  return { ...record, source: acquisitionEvidence, acquisitionEvidence,
    acquisitionEvidenceHash,
    acquisitionEvidenceKey: `${acquisitionEvidence.sourceId}|sha256:${acquisitionEvidenceHash}` };
}
async function snapshot(records = [], sourceId = SOURCE) {
  if (!records.length) return empty();
  const run = { sourceId, runId: "baseline", acceptedAt: OLD,
    fetchedAt: [FETCHED], status: "accepted",
    semanticSetHash: await Canonicalizer.sha256(records.map(r => r.revisionKey).sort()) };
  const planned = Transition.planTransition({ snapshot: empty(), run,
    canonicalSet: records });
  assert.equal(planned.ok, true, planned.errors?.join(","));
  const mapped = Mapper.mapPlan(planned.plan);
  return { entries: mapped.appendEntries, revisions: mapped.appendRevisions,
    evidence: mapped.appendEvidence, observations: mapped.appendObservations,
    runs: mapped.appendRuns, cursors: mapped.updateCursors };
}
const health = sourceId => sourceId === "us-bls-calendar" ?
  ["cpi", "ppi", "employment_situation", "jolts"].map(role =>
    ({ role, fetchOutcome: "success", parseOutcome: "success" })) :
  [{ role: "primary", fetchOutcome: "success", parseOutcome: "success" }];
async function build({ sourceId = SOURCE, records, formalSnapshot = empty(), outcome = "complete",
  candidateStatus = "available", documentHealth = health(sourceId), runId = "current",
  runAcceptedAt = NOW, suppliedComparison = null, sourceOverride = {}, runOverride = {} } = {}) {
  const sourceResult = { sourceId, canonicalRecords: records, acquisitionOutcome: outcome,
    candidateStatus, documentHealth, failedRoles: outcome === "complete" ? [] : ["primary"],
    absenceAuthority: "none", ...sourceOverride };
  const sourceResults = Compare.SOURCE_IDS.map(id => id === sourceId ? sourceResult :
    { sourceId: id, canonicalRecords: [], acquisitionOutcome: "not_attempted",
      candidateStatus: "unavailable", absenceAuthority: "none" });
  const comparison = suppliedComparison || await Compare.compare({ sourceResults, formalSnapshot });
  const run = { sourceId, runId, acceptedAt: runAcceptedAt, fetchedAt: [FETCHED], status: "accepted",
    semanticSetHash: await Canonicalizer.sha256(records.map(r => r.revisionKey).sort()),
    ...runOverride };
  return Shadow.buildSourceShadowPlan({ sourceId, sourceResult, comparison, formalSnapshot,
    schemaFingerprint: Schema.EXPECTED_FINGERPRINT, run });
}

test("E2a P1 unchanged: observedAt and Observation/Run/Cursor, no new revision", async () => {
  const record = await event(), plan = await build({ records: [record],
    formalSnapshot: await snapshot([record]) });
  assert.equal(plan.planStatus, "planned", plan.reason);
  assert.deepEqual(plan.counts, { eventEntryCreate: 0, eventEntryUpdate: 1,
    semanticRevisionCreate: 0, semanticRevisionClose: 0, evidenceCreate: 0,
    observationCreate: 1, sourceRunCreate: 1, sourceCursorUpdate: 1 });
  assert.equal(plan.mutations.appendObservations[0].state, "observed");
  assert.equal((await Shadow.validateShadowPlan(plan)).valid, true);
});
test("E2a P2 evidence-only links a new Evidence to the existing revision", async () => {
  const old = await event(), next = await withEvidence(old, "https://www.esri.cao.go.jp/alternate-evidence");
  const plan = await build({ records: [next], formalSnapshot: await snapshot([old]) });
  assert.equal(plan.counts.evidenceCreate, 1);
  assert.equal(plan.counts.semanticRevisionCreate, 0);
  assert.equal(plan.mutations.appendEvidence[0].revisionKey, old.revisionKey);
});
test("E2a P3 new creates entry and initial revision", async () => {
  const record = await event(), plan = await build({ records: [record] });
  assert.equal(plan.planStatus, "planned", plan.reason);
  assert.deepEqual([plan.counts.eventEntryCreate, plan.counts.semanticRevisionCreate,
    plan.counts.evidenceCreate, plan.counts.observationCreate,
    plan.counts.sourceRunCreate, plan.counts.sourceCursorUpdate], [1, 1, 1, 1, 1, 1]);
  assert.equal(plan.mutations.appendRevisions[0].revisionOrigin, "initial_observation");
});
test("E2a P4 changed closes prior validity and creates a revision", async () => {
  const old = await event(), next = await event(SOURCE, { titleJa: "変更済み" });
  const plan = await build({ records: [next], formalSnapshot: await snapshot([old]) });
  assert.equal(plan.counts.semanticRevisionClose, 1);
  assert.equal(plan.counts.semanticRevisionCreate, 1);
  assert.equal(plan.counts.eventEntryUpdate, 1);
  assert.equal(plan.mutations.closeRevisions[0].expectedValidTo, null);
  assert.equal(plan.mutations.appendRevisions[0].revisionOrigin, "authority_semantic_change");
});
test("E2a P5 Formal-only remains not_evaluated without semantic mutation", async () => {
  const old = await event(), next = await event(SOURCE, { referencePeriod: "2026-08" });
  const plan = await build({ records: [next], formalSnapshot: await snapshot([old]) });
  assert.equal(plan.skippedNotEvaluated, 1);
  assert.equal(plan.mutations.appendObservations.find(x => x.state === "not_evaluated").eventKey,
    old.eventKey);
  assert.equal(plan.counts.semanticRevisionClose, 0);
});
for (const [label, outcome] of [["P6 partial", "partial"], ["P7 failed", "failed"]]) {
  test(`E2a ${label} retains candidates with zero Formal mutations`, async () => {
    const record = await event(), plan = await build({ records: [record], outcome,
      candidateStatus: outcome });
    assert.equal(plan.planStatus, "skipped");
    assert.equal(plan.retainedCandidateKeys.length, 1);
    assert.ok(Object.values(plan.counts).every(value => value === 0));
  });
}
test("E2a P8 conflicting and duplicate identities fail closed", async () => {
  const record = await event(), duplicate = await build({ records: [record, record] });
  assert.equal(duplicate.planStatus, "rejected");
  assert.equal(duplicate.reason, "candidate_duplicate_event");
  const plan = await build({ records: [record] }), broken = structuredClone(plan);
  broken.mutations.appendObservations.push(broken.mutations.appendObservations[0]);
  assert.equal((await Shadow.validateShadowPlan(broken)).valid, false);
});
test("E2a P9 identical inputs yield identical plan identities", async () => {
  const record = await event(), formalSnapshot = await snapshot([record]);
  const first = await build({ records: [record], formalSnapshot });
  const second = await build({ records: [record], formalSnapshot });
  assert.equal(first.planIdentity, second.planIdentity);
  assert.deepEqual(first, second);
});
test("E2a P10 candidate order does not change semantic plan", async () => {
  const a = await event(), b = await event(SOURCE, { referencePeriod: "2026-08" });
  const first = await build({ records: [a, b] });
  const second = await build({ records: [b, a] });
  assert.equal(first.planIdentity, second.planIdentity);
});
test("E2a P11 BOJ identity transition is ineligible, candidates retained", async () => {
  const old = await Promise.all(["2026-07-meeting", "2026-08-meeting", "2026-09-meeting"]
    .map(referencePeriod => event("jp-boj-calendar", { referencePeriod })));
  const next = await Promise.all(["2026-10-meeting", "2026-11-meeting", "2026-12-meeting"]
    .map(referencePeriod => event("jp-boj-calendar", { referencePeriod })));
  const plan = await build({ sourceId: "jp-boj-calendar", records: next,
    formalSnapshot: await snapshot(old, "jp-boj-calendar") });
  assert.equal(plan.reason, "writer_ineligible_identity_transition");
  assert.equal(plan.skippedNotEvaluated, 3);
  assert.equal(plan.retainedCandidateKeys.length, 3);
  assert.ok(Object.values(plan.counts).every(value => value === 0));
});
test("E2a P12 machinery orders first-write candidate plans four unchanged", async () => {
  const records = await Promise.all(["2026-05", "2026-06", "2026-07", "2026-08"]
    .map(referencePeriod => event(SOURCE, { referencePeriod })));
  const plan = await build({ records, formalSnapshot: await snapshot(records) });
  assert.equal(Authority.FIRST_WRITE_SOURCE_ID, SOURCE);
  assert.deepEqual([plan.counts.eventEntryUpdate, plan.counts.semanticRevisionCreate,
    plan.counts.observationCreate, plan.counts.sourceRunCreate,
    plan.counts.sourceCursorUpdate], [4, 0, 4, 1, 1]);
});
test("E2a P13 BLS retains four document roles and plans 47 new events", async () => {
  const records = await Promise.all(Array.from({ length: 47 }, (_, i) => {
    const month = new Date(Date.UTC(2027, i, 1)).toISOString().slice(0, 7);
    return event("us-bls-calendar", { referencePeriod: month });
  }));
  const plan = await build({ sourceId: "us-bls-calendar", records });
  assert.equal(plan.planStatus, "planned");
  assert.deepEqual([plan.counts.eventEntryCreate, plan.counts.semanticRevisionCreate,
    plan.counts.evidenceCreate, plan.counts.observationCreate,
    plan.counts.sourceRunCreate], [47, 47, 47, 47, 1]);
});
test("E2a P14 CPI and Labor plan evidence-only with no semantic revision", async () => {
  for (const sourceId of ["jp-stat-cpi", "jp-stat-labor"]) {
    const old = await event(sourceId), next = await withEvidence(old,
      `https://www.e-stat.go.jp/release-calendar/${sourceId}`);
    const plan = await build({ sourceId, records: [next],
      formalSnapshot: await snapshot([old], sourceId) });
    assert.deepEqual([plan.counts.evidenceCreate, plan.counts.semanticRevisionCreate,
      plan.counts.sourceRunCreate], [1, 0, 1]);
  }
});
test("E2a authority fails closed and production default remains disabled", () => {
  const selected = Authority.selectWriterState(SOURCE);
  assert.equal(selected.state, "disabled");
  assert.equal(Authority.selectWriterState("unknown").valid, false);
  const malformed = structuredClone(Authority.SHADOW_AUTHORITY);
  malformed.entries[0].writeEligible = true;
  assert.equal(Authority.validateAuthority(malformed).valid, false);
  assert.equal(Authority.selectWriterState(SOURCE, malformed).valid, false);
});
test("E2a raw body is not accepted", async () => {
  const record = await event(), plan = await build({ records: [record],
    sourceOverride: { rawBody: "<html>not a planning input</html>" } });
  assert.equal(plan.reason, "source_result_invalid");
});
test("E2a repeated acquisition run is an explicit no-op; conflicting replay rejects", async () => {
  const record = await event(), formalSnapshot = await snapshot([record]);
  const replay = await build({ records: [record], formalSnapshot,
    runId: "baseline", runAcceptedAt: OLD });
  assert.equal(replay.reason, "already_committed");
  assert.ok(Object.values(replay.counts).every(value => value === 0));
  const conflict = await build({ records: [record], formalSnapshot,
    runId: "baseline", runAcceptedAt: NOW });
  assert.equal(conflict.reason, "duplicate_run_conflict");
});
test("E2a stale comparison and modified plan identity reject", async () => {
  const record = await event(), formalSnapshot = await snapshot([record]);
  const plan = await build({ records: [record], formalSnapshot });
  const altered = structuredClone(plan);
  altered.counts.observationCreate += 1;
  assert.equal((await Shadow.validateShadowPlan(altered)).valid, false);
  const stale = await build({ records: [record], formalSnapshot,
    suppliedComparison: { status: "compared", summaries: [], differences: [] } });
  assert.equal(stale.reason, "comparison_identity_mismatch");
});
test("E2a BLS missing role fails closed without planned mutations", async () => {
  const record = await event("us-bls-calendar"), plan = await build({
    sourceId: "us-bls-calendar", records: [record], documentHealth: health("us-bls-calendar").slice(1) });
  assert.equal(plan.reason, "document_set_incomplete");
  assert.ok(Object.values(plan.counts).every(value => value === 0));
});
test("E2a unexpected run fields and cursor ambiguity fail closed", async () => {
  const record = await event(), invalidRun = await build({ records: [record],
    runOverride: { headers: { Authorization: "forbidden" } } });
  assert.equal(invalidRun.reason, "accepted_run_invalid");
  const formalSnapshot = await snapshot([record]);
  formalSnapshot.cursors.push(formalSnapshot.cursors[0]);
  const ambiguous = await build({ records: [record], formalSnapshot });
  assert.equal(ambiguous.planStatus, "rejected");
});
test("E2a missing existing SourceRun linkage rejects before planning", async () => {
  const record = await event(), formalSnapshot = await snapshot([record]);
  formalSnapshot.evidence[0].runId = "missing-run";
  const plan = await build({ records: [record], formalSnapshot });
  assert.equal(plan.reason, "formal_snapshot_linkage_invalid");
  assert.ok(Object.values(plan.counts).every(value => value === 0));
});
test("E2a planner imports no writer, DB, runtime state, renderer, or network service", () => {
  for (const name of ["formalWriterAuthority.js", "formalShadowWritePlan.js"]) {
    const text = fs.readFileSync(path.join(__dirname, "../js/marketCalendarHistory", name), "utf8");
    assert.doesNotMatch(text, /require\([^)]*(?:existingDbControlledWriter|productionHistoryWriter|indexedDB|runtimeStateStore|electron|calendarAcquisitionService)/i);
    assert.doesNotMatch(text, /\.transaction\s*\(|\.fetch\s*\(|\.write\s*\(/);
  }
  for (const name of ["main.js", "preload.js", "index.html",
    "js/marketCalendarRuntime/calendarStartupRuntime.js",
    "js/marketCalendarRuntime/calendarManualCheckService.js"]) {
    const text = fs.readFileSync(path.join(__dirname, "..", name), "utf8");
    assert.doesNotMatch(text, /formalWriterAuthority|formalShadowWritePlan/);
  }
});
