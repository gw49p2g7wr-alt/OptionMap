"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Policy = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");
const Builder = require("../js/marketCalendarRuntime/calendarCandidateBuilder.js");
const Simulator = require("../js/marketCalendarRuntime/calendarTransitionSimulator.js");
const Flights = require("../js/marketCalendarRuntime/sourceSingleFlight.js");
const Pool = require("../js/marketCalendarRuntime/boundedTaskPool.js");
const Gate = require("../scripts/marketCalendarGateBIntegratedShadowAcceptance.js");

const requestedAt = "2026-09-24T00:00:00.000Z";
const BOJ = '<h2 id="p02">次回</h2><p>2026年9月17日（木）、18日（金）</p>' +
  '<h2 id="p03">会見</h2><p>2026年9月18日（金）15:30～（ライブ配信予定）</p>';
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
function bojEnvelope(html = BOJ) { const parserInput = new TextEncoder().encode(html),
  url = "https://www.boj.or.jp/about/calendar/"; return { success: true, sourceId:
  "jp-boj-calendar", operation: Policy.OPERATION, requestedAt, fetchedAt: requestedAt,
  documents: [{ role: "primary", originalOfficialUrl: url, finalUrl: url, redirects: [],
    httpStatus: 200, mime: "text/html", encoding: { encoding: "utf-8", evidence: {
      httpCharset: "utf-8", bom: null, html5MetaCharset: null, legacyMetaCharset: null,
      resolvedEncoding: "utf-8", resolutionPolicyVersion: 1, resolutionBasis: "fixture" },
    warnings: [] }, workbook: null, byteCount: parserInput.byteLength,
    contentSha256: hash(parserInput), parserInputSha256: hash(parserInput), parserInput }],
  diagnostics: [] }; }
const failure = reason => ({ success: false, reason, retryable: true,
  documents: [], diagnostics: [{ stage: "acquisition", reason, retryable: true }] });
const request = extra => ({ trigger: "startup", requestedAt, ...extra });

test.afterEach(() => {
  assert.equal(Flights.getFlightDiagnostics().activeFlightCount, 0);
  assert.deepEqual(Pool.getTaskPoolDiagnostics(), { activePoolCount: 0, activeTaskCount: 0,
    queuedTaskCount: 0, unresolvedTaskCount: 0 });
});

test("updateはacquisition→candidate→synthetic transitionをwriterなしで完走", async () => {
  const runner = Gate.createIntegratedShadowRunner({ acquire: async () => bojEnvelope() }),
    result = await runner.run(request({ sourceIds: ["jp-boj-calendar"] })), source =
    result.sourceResults[0];
  assert.equal(result.overallOutcome, "success");
  assert.equal(source.planningDecision, "update");
  assert.equal(source.acquisitionStatus, "succeeded");
  assert.equal(source.candidateStatus, "available");
  assert.equal(source.simulationStatus, "unchanged");
  assert.equal(source.transitionSummary.unchangedCount, 3);
  assert.equal(source.commitOutcome, "writer_disabled");
  for (const identity of [source.acquisitionIdentity, source.candidateIdentity,
    source.previousStateIdentity, source.simulationIdentity]) assert.match(identity, /^[0-9a-f]{64}$/);
});

test("skip・cooldown・blocked・invalid・schedulerはdownstream 0", async () => {
  let calls = 0; const runner = Gate.createIntegratedShadowRunner({ acquire: async () => {
    calls += 1; return bojEnvelope();
  } }), sourceIds = ["jp-boj-calendar"], skip = await runner.run(request({ sourceIds,
    formalStates: { "jp-boj-calendar": { databaseStatus: "available", schemaStatus: "compatible",
      sourceCursorStatus: "available", lastAcceptedAt: requestedAt, securityStatus: "clear" } } })),
    cooldown = await runner.run(request({ sourceIds, runtimeStates: { "jp-boj-calendar": {
      sourceId: "jp-boj-calendar", lastAttemptAt: "2026-09-23T23:30:00.000Z",
      lastSuccessAt: null, lastOutcome: "failure", retryAfter: "2026-09-24T00:30:00.000Z",
      lastHttpStatus: null, lastDiagnosticClass: "timeout", coordinatorVersion: 1 } } })),
    blocked = await runner.run(request({ sourceIds,
      sessionStates: { "jp-boj-calendar": { attemptCount: 2 } } })),
    invalid = await runner.run(request({ sourceIds: ["unknown"] })),
    scheduler = await runner.run(request({ sourceIds, trigger: "scheduler" }));
  assert.equal(calls, 0);
  for (const result of [skip, cooldown, blocked, invalid, scheduler]) {
    assert.equal(result.overallOutcome, "skipped");
    assert.equal(result.sourceResults[0].candidateStatus, "not_attempted");
  }
});

test("retry decisionもdownstreamへ進む", async () => {
  const runner = Gate.createIntegratedShadowRunner({ acquire: async () => bojEnvelope() }), result =
    await runner.run(request({ sourceIds: ["jp-boj-calendar"], runtimeStates: {
      "jp-boj-calendar": { sourceId: "jp-boj-calendar",
        lastAttemptAt: "2026-09-23T22:00:00.000Z", lastSuccessAt: null,
        lastOutcome: "failure", retryAfter: "2026-09-23T23:00:00.000Z",
        lastHttpStatus: null, lastDiagnosticClass: "timeout", coordinatorVersion: 1 } } }));
  assert.equal(result.sourceResults[0].planningDecision, "retry");
  assert.equal(result.sourceResults[0].simulationStatus, "unchanged");
});

test("integration pathのsame-source重複はPhase A call 1でjoin", async () => {
  let calls = 0, release; const gate = new Promise(resolve => { release = resolve; }), runner =
    Gate.createIntegratedShadowRunner({ acquire: async () => { calls += 1; await gate;
      return bojEnvelope(); } }), startup = runner.run(request({ sourceIds:
      ["jp-boj-calendar"] })), manual = runner.run(request({ sourceIds: ["jp-boj-calendar"],
      trigger: "manual" }));
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  assert.equal(calls, 1); release();
  const results = await Promise.all([startup, manual]);
  assert.deepEqual(results.map(value => value.sourceResults[0].joinedExistingFlight).sort(),
    [false, true]);
});

test("failure isolationはpartial・failed・timeoutを保持", async () => {
  const builder = { buildCalendarCandidate: async ({ sourceId }) => ({ sourceId,
    candidateStatus: "available", formalEligible: true, candidateIdentity: "a".repeat(64),
    recordCount: 1, canonicalRecords: [{ acquisitionEvidence: { fetchedAt: requestedAt } }],
    parserStatus: "success",
    canonicalizationStatus: "success", sourceIdentity: { parserId: "fixture", parserVersion: 1 } }) },
    simulator = { simulateCalendarTransition: async () => ({ simulationStatus: "unchanged",
      previousStateIdentity: "b".repeat(64), simulationIdentity: "c".repeat(64),
      summary: { unchangedCount: 1 }, commitOutcome: "writer_disabled" }) }, success = sourceId => ({
      ...bojEnvelope(), sourceId }), partial = Gate.createIntegratedShadowRunner({ builder, simulator,
      acquire: async ({ sourceId }) => sourceId === "jp-stat-cpi"
        ? failure("request_timeout") : success(sourceId) }), allFailed =
    Gate.createIntegratedShadowRunner({ acquire: async () => failure("network_failed") });
  assert.equal((await partial.run(request({ sourceIds: ["jp-boj-calendar", "jp-stat-cpi"] })))
    .overallOutcome, "partial");
  assert.equal((await allFailed.run(request({ sourceIds: ["jp-boj-calendar",
    "jp-stat-cpi"] }))).overallOutcome, "failed");
});

test("acquisition invalid・parser blocking・canonical invalidはsimulationへ進まない", async () => {
  const cases = [failure("mime_mismatch"), bojEnvelope("<html>unexpected</html>")];
  for (const acquisition of cases) {
    const runner = Gate.createIntegratedShadowRunner({ acquire: async () => acquisition }),
      source = (await runner.run(request({ sourceIds: ["jp-boj-calendar"] }))).sourceResults[0];
    assert.notEqual(source.candidateStatus, "available");
    assert.equal(source.simulationStatus, "not_attempted");
  }
  const production = await Builder.buildCalendarCandidate({ sourceId: "jp-boj-calendar",
    acquisitionResult: bojEnvelope() }), previous = Gate.syntheticPrevious(production), invalid =
    await Simulator.simulateCalendarTransition({ sourceId: "jp-boj-calendar",
      candidate: production, previousState: { ...previous, schemaVersion: 2 } });
  assert.equal(invalid.simulationStatus, "rejected");
});

test("coverage unknown missingとexplicit coverage unobservedを区別", async () => {
  const candidate = await Builder.buildCalendarCandidate({ sourceId: "jp-boj-calendar",
    acquisitionResult: bojEnvelope() }), previous = Gate.syntheticPrevious(candidate), removed =
    structuredClone(candidate); removed.canonicalRecords.pop(); removed.recordCount -= 1;
  removed.sourceIdentity.semanticSetHash = await require("../js/marketCalendar/marketEventCanonicalizer.js")
    .sha256(removed.canonicalRecords.map(value => value.revisionKey).sort());
  removed.candidateIdentity = await require("../js/marketCalendar/marketEventCanonicalizer.js")
    .sha256({ sourceId: removed.sourceId, parserId: removed.sourceIdentity.parserId,
      parserVersion: removed.sourceIdentity.parserVersion, candidateSchemaVersion: 1,
      revisionKeys: removed.canonicalRecords.map(value => value.revisionKey).sort() });
  const missingKey = previous.entries.find(entry => !removed.canonicalRecords.some(record =>
    record.eventKey === entry.eventKey)).eventKey, unknown = await Simulator.simulateCalendarTransition({
      sourceId: removed.sourceId, candidate: removed, previousState: previous }), explicit =
    await Simulator.simulateCalendarTransition({ sourceId: removed.sourceId, candidate: removed,
      previousState: previous, coveragePolicy: { policyVersion: 1, sourceId: removed.sourceId,
        mode: "explicit_event_keys", allowUnobserved: true, eventKeys: [missingKey],
        parserId: removed.sourceIdentity.parserId,
        parserVersion: removed.sourceIdentity.parserVersion } });
  assert.equal(unknown.summary.notEvaluatedCount, 1);
  assert.equal(unknown.summary.unobservedCount, 0);
  assert.equal(explicit.summary.unobservedCount, 1);
});

test("12 source bounded integration fixtureはpeak 3以下・canonical order・cleanup", async () => {
  let active = 0, peak = 0; const builder = { buildCalendarCandidate: async ({ sourceId }) => ({
    sourceId, candidateStatus: "rejected", formalEligible: false, candidateIdentity: null,
    recordCount: 0, parserStatus: "blocked", canonicalizationStatus: "not_attempted" }) }, runner =
    Gate.createIntegratedShadowRunner({ builder, acquire: async ({ sourceId }) => {
      active += 1; peak = Math.max(peak, active); await Promise.resolve(); active -= 1;
      return { ...bojEnvelope(), sourceId };
    } }), result = await runner.run(request({}));
  assert.equal(result.sourceResults.length, 12);
  assert.equal(peak <= 3, true);
  assert.deepEqual(result.sourceResults.map(value => value.sourceId), Registry.HISTORICAL_SOURCE_ORDER);
  assert.equal(result.resources.flights.activeFlightCount, 0);
  assert.equal(result.resources.pools.activePoolCount, 0);
});

test("Acceptance専用コードはDB・writer・raw body出力へ接続しない", () => {
  const source = fs.readFileSync(path.join(__dirname,
    "../scripts/marketCalendarGateBIntegratedShadowAcceptance.js"), "utf8");
  assert.doesNotMatch(source, /require\([^\n]*(?:HistoryWriter|productionHistory|storage)/);
  assert.doesNotMatch(source, /createObjectStore|openDatabase|\.transaction\(/);
  assert.doesNotMatch(source, /parserInput\s*[,}]/);
});
