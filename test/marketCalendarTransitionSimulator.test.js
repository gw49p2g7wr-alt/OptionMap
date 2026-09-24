"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Simulator = require("../js/marketCalendarRuntime/calendarTransitionSimulator.js");
const Fixtures = require("./fixtures/marketCalendar/sourceFixtures.js");

const T1 = "2026-09-24T00:00:00.000Z", T2 = "2026-09-24T01:00:00.000Z";
async function event(sourceId, overrides = {}, fetchedAt = T1) {
  const source = Registry.getSource(sourceId), record = { ...Fixtures.record(sourceId),
    sourceId, sourceUrl: source.canonicalUrl, fetchedAt,
    parserId: source.parserId, parserVersion: source.parserVersion,
    rawContentHash: "a".repeat(64), requestId: null, runId: null,
    httpMetadata: { httpStatus: 200 }, ...overrides }, value = await Canonicalizer.canonicalize(record);
  assert.equal(value.ok, true, value.reason); return value.event;
}
async function candidate(sourceId, records, overrides = {}) {
  const source = Registry.getSource(sourceId), semanticSetHash = await Canonicalizer.sha256(
    records.map(value => value.revisionKey).sort()), sourceIdentity = { sourceId,
    parserId: source.parserId, parserVersion: source.parserVersion, candidateSchemaVersion: 1,
    semanticSetHash }, candidateIdentity = await Canonicalizer.sha256({ sourceId,
    parserId: source.parserId, parserVersion: source.parserVersion, candidateSchemaVersion: 1,
    revisionKeys: records.map(value => value.revisionKey).sort() });
  return { sourceId, candidateStatus: "available", formalEligible: true, candidateIdentity,
    recordCount: records.length, canonicalRecords: records, parserStatus: "success",
    canonicalizationStatus: "success", parserDiagnostics: [], canonicalDiagnostics: [],
    encodingEvidence: [], sourceIdentity, ...overrides };
}
function previous(sourceId, records, overrides = {}) { const source = Registry.getSource(sourceId);
  return { sourceId, schemaVersion: 1, contractVersion: 1, parserIdentity: { sourceId,
    parserId: source.parserId, parserVersion: source.parserVersion }, entries: records.map(value => ({
    eventKey: value.eventKey, sourceId, activeRevisionKey: value.revisionKey,
    firstKnownAt: T1, lastObservedAt: T1 })), revisions: records.map(value => ({ ...value,
    validFrom: T1, validTo: null, revisionOrigin: "initial_observation" })), runs: [],
    cursors: [{ sourceId, acceptedAt: T1, runId: "previous-run" }], ...overrides }; }
const simulate = (sourceId, value, previousState = null, coveragePolicy = null) =>
  Simulator.simulateCalendarTransition({ sourceId, candidate: value, previousState, coveragePolicy });

test("empty valid previous + candidateはnew", async () => {
  const sourceId = "jp-boj-calendar", value = await candidate(sourceId, [await event(sourceId)]),
    result = await simulate(sourceId, value);
  assert.equal(result.simulationStatus, "new");
  assert.equal(result.summary.newCount, 1);
  assert.equal(result.commitOutcome, "writer_disabled");
});

test("same event / same semanticはunchanged", async () => {
  const sourceId = "jp-boj-calendar", old = await event(sourceId), value =
    await candidate(sourceId, [await event(sourceId, {}, T2)]), result =
    await simulate(sourceId, value, previous(sourceId, [old]));
  assert.equal(result.simulationStatus, "unchanged");
  assert.equal(result.summary.unchangedCount, 1);
});

test("same eventの時刻・日付・official cancellationはchanged", async () => {
  const sourceId = "us-bls-calendar", old = await event(sourceId);
  for (const overrides of [{ sourceLocalSchedule: { ...Fixtures.record(sourceId).sourceLocalSchedule,
    startTime: "09:30" } }, { sourceLocalSchedule: { ...Fixtures.record(sourceId).sourceLocalSchedule,
    startDate: "2026-09-12" } }, { sourceStatus: "cancelled" }]) {
    const value = await candidate(sourceId, [await event(sourceId, overrides)]), result =
      await simulate(sourceId, value, previous(sourceId, [old]));
    assert.equal(result.simulationStatus, "changed");
  }
});

test("mixed new・unchanged・changedを分類", async () => {
  const sourceId = "jp-boj-calendar", unchanged = await event(sourceId), changedOld = await event(sourceId, {
    eventType: "BOJ_POLICY_DECISION", sourceTitle: "Decision", titleJa: "Decision",
    referencePeriod: "2026-10-meeting" }), changedNew = await event(sourceId, {
    eventType: "BOJ_POLICY_DECISION", sourceTitle: "Decision", titleJa: "Decision",
    referencePeriod: "2026-10-meeting", sourceLocalSchedule: { ...Fixtures.record(sourceId)
      .sourceLocalSchedule, startDate: "2026-09-19" } }), added = await event(sourceId, {
    eventType: "BOJ_GOVERNOR_PRESS_CONFERENCE", sourceTitle: "Press", titleJa: "Press",
    referencePeriod: "2026-11-meeting" }), value = await candidate(sourceId,
      [added, changedNew, unchanged]), result = await simulate(sourceId, value,
      previous(sourceId, [unchanged, changedOld]));
  assert.deepEqual(result.summary, { unchangedCount: 1, changedCount: 1, newCount: 1,
    notEvaluatedCount: 0, unobservedCount: 0, rejectedCount: 0 });
});

test("acquisition metadataだけの変更はunchanged", async () => {
  const sourceId = "us-census-calendar", old = await event(sourceId), refetched = await event(sourceId,
    { rawContentHash: "b".repeat(64), requestId: "new-request",
      httpMetadata: { httpStatus: 200, redirects: [{ status: 301 }] } }, T2), value =
    await candidate(sourceId, [refetched]), result = await simulate(sourceId, value,
      previous(sourceId, [old]));
  assert.equal(result.transitions[0].status, "unchanged");
});

test("missing + coverage unknownはnot_evaluated", async () => {
  const sourceId = "us-fed-fomc-calendar", old = await event(sourceId), added = await event(sourceId, {
    referencePeriod: "2026-10-meeting" }), value = await candidate(sourceId, [added]), result =
    await simulate(sourceId, value, previous(sourceId, [old]));
  assert.equal(result.summary.notEvaluatedCount, 1);
  assert.equal(result.summary.unobservedCount, 0);
});

test("掲載window外・temporary omissionは明示coverageなしではnot_evaluated", async () => {
  const sourceId = "us-bls-calendar", old = await event(sourceId), added = await event(sourceId, {
    referencePeriod: "2026-09" }), value = await candidate(sourceId, [added]);
  for (const _case of ["outside_listing_window", "temporary_omission"]) {
    const result = await simulate(sourceId, value, previous(sourceId, [old]));
    assert.equal(result.transitions.find(item => item.eventKey === old.eventKey).status,
      "not_evaluated");
  }
});

test("explicit full coverage policyだけがmissingをunobservedにする", async () => {
  const sourceId = "jp-jpx-market-holidays", old = await event(sourceId), added = await event(sourceId, {
    referencePeriod: "2026-10-01", sourceLocalSchedule: { ...Fixtures.record(sourceId)
      .sourceLocalSchedule, startDate: "2026-10-01" } }), value = await candidate(sourceId, [added]),
    source = Registry.getSource(sourceId), policy = { policyVersion: 1, sourceId,
      mode: "explicit_event_keys", allowUnobserved: true, eventKeys: [old.eventKey],
      parserId: source.parserId, parserVersion: source.parserVersion }, result =
      await simulate(sourceId, value, previous(sourceId, [old]), policy);
  assert.equal(result.summary.unobservedCount, 1);
  assert.equal(result.summary.notEvaluatedCount, 0);
});

test("candidate gateはnot eligible・identity改変・collisionを拒否", async () => {
  const sourceId = "jp-boj-calendar", one = await event(sourceId), base = await candidate(sourceId, [one]);
  for (const value of [{ ...base, formalEligible: false }, { ...base,
    candidateIdentity: "0".repeat(64) }, { ...base, canonicalRecords: [one, one], recordCount: 2 }]) {
    const result = await simulate(sourceId, value);
    assert.equal(result.simulationStatus, "rejected");
  }
});

test("previous mismatch・malformed・schema mismatchをemptyへ読み替えない", async () => {
  const sourceId = "jp-boj-calendar", one = await event(sourceId), value = await candidate(sourceId, [one]),
    base = previous(sourceId, [one]);
  for (const prior of [{ ...base, sourceId: "us-bls-calendar" }, {}, { ...base, schemaVersion: 2 }]) {
    const result = await simulate(sourceId, value, prior);
    assert.equal(result.simulationStatus, "rejected"); assert.equal(result.summary.newCount, 0);
  }
});

test("multiple active revision・active missing・parser scope changeを拒否", async () => {
  const sourceId = "jp-boj-calendar", one = await event(sourceId), moved = await event(sourceId, {
    sourceLocalSchedule: { ...Fixtures.record(sourceId).sourceLocalSchedule, startDate: "2026-09-19" } }),
    value = await candidate(sourceId, [one]), base = previous(sourceId, [one]);
  const ambiguous = { ...base, revisions: [...base.revisions, { ...moved, validFrom: T1,
    validTo: null, revisionOrigin: "authority_semantic_change" }] }, missing = { ...base,
    entries: [{ ...base.entries[0], activeRevisionKey: "missing" }] }, scope = { ...base,
    parserIdentity: { ...base.parserIdentity, parserVersion: 0 } };
  for (const prior of [ambiguous, missing, scope])
    assert.equal((await simulate(sourceId, value, prior)).simulationStatus, "rejected");
});

test("invalid coverage policyはunobservedを生成せずreject", async () => {
  const sourceId = "jp-boj-calendar", one = await event(sourceId), value = await candidate(sourceId, [one]),
    result = await simulate(sourceId, value, previous(sourceId, [one]), { policyVersion: 1,
      sourceId, mode: "explicit_event_keys", allowUnobserved: true, eventKeys: ["unknown"],
      parserId: Registry.getSource(sourceId).parserId, parserVersion: 1 });
  assert.equal(result.simulationStatus, "rejected");
  assert.equal(result.summary.unobservedCount, 0);
});

test("same input・record order・runtime timestamp差は同一semantic plan", async () => {
  const sourceId = "jp-boj-calendar", first = await event(sourceId), second = await event(sourceId, {
    eventType: "BOJ_POLICY_DECISION", sourceTitle: "Decision", titleJa: "Decision",
    referencePeriod: "2026-10-meeting" }), value = await candidate(sourceId, [first, second]), prior =
    previous(sourceId, [first, second]), reordered = await candidate(sourceId, [second, first]),
    refetched = await candidate(sourceId, [await event(sourceId, {}, T2),
      await event(sourceId, { eventType: "BOJ_POLICY_DECISION", sourceTitle: "Decision",
        titleJa: "Decision", referencePeriod: "2026-10-meeting" }, T2)]),
    results = await Promise.all([value, reordered, refetched].map(item => simulate(sourceId, item, prior)));
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], results[2]);
});

test("12 source synthetic shadowはすべてunchangedをsimulation", async () => {
  for (const sourceId of Object.keys(Registry.SOURCES)) {
    const one = await event(sourceId), value = await candidate(sourceId, [one]), result =
      await simulate(sourceId, value, previous(sourceId, [one]));
    assert.equal(result.simulationStatus, "unchanged", sourceId);
    assert.equal(result.summary.unchangedCount, 1, sourceId);
  }
});

test("Simulatorはnetwork・parser・DB・writerへ接続しない", () => {
  const source = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarRuntime/calendarTransitionSimulator.js"), "utf8");
  assert.doesNotMatch(source, /fetch\(|indexedDB|localStorage|HistoryWriter|createObjectStore/);
  assert.doesNotMatch(source, /representativeParsers|representativeAdapters|CandidateBuilder/);
});
