"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Execution = require("../js/marketCalendarRuntime/updateExecutionCoordinator.js");
const Flights = require("../js/marketCalendarRuntime/sourceSingleFlight.js");
const Pool = require("../js/marketCalendarRuntime/boundedTaskPool.js");

const requestedAt = "2026-09-24T00:00:00.000Z";
const request = (extra = {}) => ({ trigger: "startup", requestedAt, ...extra });
const success = sourceId => ({ success: true, reason: null, retryable: false, sourceId,
  operation: Flights.OPERATION, requestedAt, fetchedAt: "2026-09-24T00:00:01.000Z",
  documents: [{ role: "primary", originalOfficialUrl: "https://example.invalid/official",
    finalUrl: "https://example.invalid/final", redirects: [], httpStatus: 200,
    mime: "text/html", encoding: { encoding: "utf-8" }, workbook: null,
    byteCount: 10, contentSha256: "a".repeat(64), parserInputSha256: "b".repeat(64),
    parserInput: new Uint8Array([1, 2, 3]) }], diagnostics: [] });
const failure = reason => ({ success: false, reason, retryable: true,
  documents: [], diagnostics: [{ stage: "acquisition", reason, retryable: true }] });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve }; };

test.afterEach(() => {
  assert.equal(Flights.getFlightDiagnostics().activeFlightCount, 0);
  assert.deepEqual(Pool.getTaskPoolDiagnostics(), { activePoolCount: 0, activeTaskCount: 0,
    queuedTaskCount: 0, unresolvedTaskCount: 0 });
});

test("1 source successはB2a→B2c→B2b→Phase A adapter順で集約", async () => {
  const calls = [];
  const coordinator = Execution.createUpdateExecutionCoordinator({ acquire: async value => {
    calls.push(value); return success(value.sourceId);
  } });
  const result = await coordinator.requestUpdate(request({ sourceIds: ["jp-boj-calendar"] }));
  assert.deepEqual(calls, [{ sourceId: "jp-boj-calendar", operation: "source-document-set" }]);
  assert.equal(result.overallOutcome, "success");
  assert.equal(result.sourceResults[0].planningDecision, "update");
  assert.equal(result.sourceResults[0].acquisitionStatus, "succeeded");
  assert.equal(result.sourceResults[0].parserStatus, "not_attempted");
  assert.equal(result.sourceResults[0].commitOutcome, "writer_disabled");
  assert.equal("parserInput" in result.sourceResults[0].acquisition.documents[0], false);
});

test("multiple source successはplanning canonical orderを維持", async () => {
  const coordinator = Execution.createUpdateExecutionCoordinator({ acquire: async value =>
    success(value.sourceId) });
  const result = await coordinator.requestUpdate(request({ sourceIds: ["us-bls-calendar",
    "jp-boj-calendar", "jp-stat-cpi"] }));
  assert.deepEqual(result.sourceResults.map(item => item.sourceId),
    ["jp-boj-calendar", "jp-stat-cpi", "us-bls-calendar"]);
  assert.equal(result.summary.successfulSourceCount, 3);
});

test("skip・cooldown・blockedはacquisition 0", async () => {
  let calls = 0; const acquire = async () => { calls += 1; return failure("must_not_run"); };
  const coordinator = Execution.createUpdateExecutionCoordinator({ acquire });
  const skip = await coordinator.requestUpdate(request({ sourceIds: ["jp-boj-calendar"],
    formalStates: { "jp-boj-calendar": { databaseStatus: "available", schemaStatus: "compatible",
      sourceCursorStatus: "available", lastAcceptedAt: requestedAt, securityStatus: "clear" } } }));
  const cooldown = await coordinator.requestUpdate(request({ sourceIds: ["jp-boj-calendar"],
    runtimeStates: { "jp-boj-calendar": { sourceId: "jp-boj-calendar",
      lastAttemptAt: "2026-09-23T23:30:00.000Z", lastSuccessAt: null,
      lastOutcome: "failure", retryAfter: "2026-09-24T00:30:00.000Z", lastHttpStatus: null,
      lastDiagnosticClass: "timeout", coordinatorVersion: 1 } } }));
  const blocked = await coordinator.requestUpdate(request({ sourceIds: ["jp-boj-calendar"],
    sessionStates: { "jp-boj-calendar": { attemptCount: 2 } } }));
  assert.equal(calls, 0);
  assert.deepEqual([skip.overallOutcome, cooldown.overallOutcome, blocked.overallOutcome],
    ["skipped", "skipped", "skipped"]);
  assert.deepEqual([skip, cooldown, blocked].map(item => item.sourceResults[0].acquisitionStatus),
    ["not_attempted", "not_attempted", "not_attempted"]);
});

test("one-source failureは他sourceを止めずpartial", async () => {
  const coordinator = Execution.createUpdateExecutionCoordinator({ acquire: async value =>
    value.sourceId === "jp-stat-cpi" ? failure("network_failed") : success(value.sourceId) });
  const result = await coordinator.requestUpdate(request({ sourceIds: ["jp-boj-calendar",
    "jp-stat-cpi", "us-bls-calendar"] }));
  assert.equal(result.overallOutcome, "partial");
  assert.deepEqual(result.sourceResults.map(item => item.acquisitionStatus),
    ["succeeded", "failed", "succeeded"]);
});

test("all-source failureはfailedで全source resultを保持", async () => {
  const coordinator = Execution.createUpdateExecutionCoordinator({ acquire: async () =>
    failure("request_timeout") });
  const result = await coordinator.requestUpdate(request({ sourceIds: ["jp-boj-calendar",
    "us-bls-calendar"] }));
  assert.equal(result.overallOutcome, "failed");
  assert.equal(result.summary.failedSourceCount, 2);
});

test("same-source concurrent requestはPhase A adapter call 1でjoin", async () => {
  let calls = 0; const gate = deferred();
  const coordinator = Execution.createUpdateExecutionCoordinator({ acquire: async value => {
    calls += 1; await gate.promise; return success(value.sourceId);
  } });
  const startup = coordinator.requestUpdate(request({ sourceIds: ["jp-boj-calendar"] }));
  const manual = coordinator.requestUpdate(request({ sourceIds: ["jp-boj-calendar"],
    trigger: "manual" }));
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  assert.equal(calls, 1); gate.resolve();
  const [one, two] = await Promise.all([startup, manual]);
  assert.deepEqual([one.sourceResults[0].joinedExistingFlight,
    two.sourceResults[0].joinedExistingFlight].sort(), [false, true]);
});

test("12 sourceはpeak concurrency 3以下", async () => {
  let active = 0, peak = 0;
  const coordinator = Execution.createUpdateExecutionCoordinator({ acquire: async value => {
    active += 1; peak = Math.max(peak, active); await Promise.resolve();
    active -= 1; return success(value.sourceId);
  } });
  const result = await coordinator.requestUpdate(request());
  assert.equal(result.sourceResults.length, 12);
  assert.equal(peak <= 3, true);
  assert.equal(result.summary.peakSourceConcurrency <= 3, true);
  assert.deepEqual(result.sourceResults.map(item => item.sourceId), Object.keys(Registry.SOURCES));
});

test("registry外・blocked・replacedとschedulerはPhase Aへ到達しない", async () => {
  let calls = 0;
  const coordinator = Execution.createUpdateExecutionCoordinator({ acquire: async () => {
    calls += 1; return failure("must_not_run");
  } });
  const invalid = await coordinator.requestUpdate(request({ sourceIds: ["unknown",
    "jp-meti-calendar", "jp-esri-calendar"] }));
  const scheduler = await coordinator.requestUpdate(request({ sourceIds: ["jp-boj-calendar"],
    trigger: "scheduler" }));
  assert.equal(calls, 0);
  assert.equal(invalid.overallOutcome, "skipped");
  assert.equal(scheduler.sourceResults[0].planningReason, "scheduler_not_implemented");
});

test("resultはsanitized metadataだけで未実施stageとresource cleanupを明示", async () => {
  const coordinator = Execution.createUpdateExecutionCoordinator({ acquire: async value =>
    success(value.sourceId) });
  const result = await coordinator.requestUpdate(request({ sourceIds: ["jp-boj-calendar"] }));
  const serialized = JSON.stringify(result);
  assert.equal(/credential|cookie|stack|filesystem/.test(serialized), false);
  assert.equal(serialized.includes('"parserInput":'), false);
  assert.deepEqual(result.resources, { sourceFlights: 0, activePools: 0, activeTasks: 0,
    queuedTasks: 0, unresolvedTasks: 0 });
  assert.equal(Object.isFrozen(result.sourceResults[0].acquisition.documents[0]), true);
});

test("B2d moduleはDB・storage・writer・parser・canonicalへ非接続", () => {
  const source = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarRuntime/updateExecutionCoordinator.js"), "utf8");
  assert.doesNotMatch(source, /indexedDB|localStorage|productionHistoryWriter|SourceCursor/);
  assert.doesNotMatch(source, /representativeParsers|canonicalize|candidateBuilder|transitionPlanner/);
  assert.doesNotMatch(source, /arbitraryUrl|headers|filesystemPath/);
});
