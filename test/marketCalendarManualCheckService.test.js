"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Service = require("../js/marketCalendarRuntime/calendarManualCheckService.js");
const Flights = require("../js/marketCalendarRuntime/sourceSingleFlight.js");
const Pool = require("../js/marketCalendarRuntime/boundedTaskPool.js");

const AT = "2026-09-25T05:32:00.000Z", successEnvelope = sourceId => ({ success: true,
  sourceId, operation: "source-document-set", requestedAt: AT, fetchedAt: AT,
  documents: [], diagnostics: [] }), failedEnvelope = (sourceId, reason = "request_timeout") => ({
  success: false, sourceId, reason, retryable: true, documents: [], diagnostics: [] });
const builder = { buildCalendarCandidate: async ({ sourceId, acquisitionResult }) =>
  acquisitionResult.success ? { sourceId, candidateStatus: "available", formalEligible: true,
    candidateIdentity: "a".repeat(64), recordCount: 1, canonicalRecords: [],
    parserStatus: "success", canonicalizationStatus: "success", sourceIdentity: {
      sourceId, parserId: `${sourceId}-parser`, parserVersion: 1, candidateSchemaVersion: 1,
      semanticSetHash: "b".repeat(64) } } : { sourceId, candidateStatus: "unavailable",
    formalEligible: false, reason: acquisitionResult.reason } };
const simulator = { simulateCalendarTransition: async ({ sourceId }) => ({ sourceId,
  simulationStatus: "new", commitOutcome: "writer_disabled", diagnostics: [] }) };
function service(acquire) { return Service.createCalendarManualCheckService({ acquire, builder,
  simulator, now: () => AT }); }

test.afterEach(() => {
  assert.equal(Flights.getFlightDiagnostics().activeFlightCount, 0);
  assert.deepEqual(Pool.getTaskPoolDiagnostics(), { activePoolCount: 0, activeTaskCount: 0,
    queuedTaskCount: 0, unresolvedTaskCount: 0 });
});

test("manual 12/12 successはwriter-disabled previewを返す", async () => {
  let calls = 0; const result = await service(async ({ sourceId }) => { calls += 1;
    return successEnvelope(sourceId); }).check();
  assert.equal(result.state, "success"); assert.equal(result.mode, "writer_disabled");
  assert.equal(result.successfulSourceCount, 12); assert.equal(result.failedSourceCount, 0);
  assert.equal(result.sources.every(source => source.commitOutcome === "writer_disabled"), true);
  assert.equal(calls, 12); assert.equal(result.peakSourceConcurrency <= 3, true);
});

test("10/12 partialと12/12 failureはsource identityとsanitized reasonを保持", async () => {
  const ids = Object.keys(Registry.SOURCES), partial = await service(async ({ sourceId }) =>
    ids.slice(-2).includes(sourceId) ? failedEnvelope(sourceId) : successEnvelope(sourceId)).check(),
    failed = await service(async ({ sourceId }) => failedEnvelope(sourceId, "network_failed")).check();
  assert.equal(partial.state, "partial"); assert.equal(partial.successfulSourceCount, 10);
  assert.deepEqual(partial.failedSourceIds, ids.slice(-2));
  assert.equal(partial.sources.at(-1).reasonClass, "network_failed" ===
    partial.sources.at(-1).reasonClass ? "network_failed" : "request_timeout");
  assert.equal(failed.state, "failed"); assert.equal(failed.failedSourceCount, 12);
});

test("repeated manual actionはrequest Promiseを共有しsource acquisitionを重複しない", async () => {
  let calls = 0, release; const gate = new Promise(resolve => { release = resolve; }), instance =
    service(async ({ sourceId }) => { calls += 1; await gate; return successEnvelope(sourceId); }),
    first = instance.check({ sourceIds: ["jp-boj-calendar"] }), second =
    instance.check({ sourceIds: ["jp-boj-calendar"] });
  assert.equal(first, second); for (let index = 0; index < 8; index += 1) await Promise.resolve();
  assert.equal(calls, 1); release(); await Promise.all([first, second]);
  assert.deepEqual(instance.diagnostics(), { logicalRequestCount: 2, joinedRequestCount: 1,
    activeRequestCount: 0, mode: "writer_disabled" });
});

test("failure subset retryはregistry順へ正規化しdaily policyをmanualで迂回", async () => {
  const calls = [], instance = service(async ({ sourceId }) => { calls.push(sourceId);
    return successEnvelope(sourceId); }), selected = ["us-bls-calendar", "jp-boj-calendar"];
  const result = await instance.check({ sourceIds: selected });
  assert.equal(result.state, "success");
  assert.deepEqual(calls, Object.keys(Registry.SOURCES).filter(id => selected.includes(id)));
});

test("serviceはDB・writer・persistent state・raw outputへ接続しない", () => {
  const source = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarRuntime/calendarManualCheckService.js"), "utf8");
  assert.doesNotMatch(source, /bootstrap(?:FirstSource|Coordinator)|existingDbControlledWriter|indexedDB|localStorage/);
  assert.doesNotMatch(source, /EventEntry|SemanticRevision|SourceCursor|parserInput|raw(?:Html|Xml|Body)/i);
  assert.match(source, /trigger: "manual"/); assert.match(source, /commitOutcome: MODE/);
});
