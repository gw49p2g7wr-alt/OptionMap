"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Coordinator = require("../js/marketCalendarRuntime/updateCoordinator.js");
const State = require("../js/marketCalendarRuntime/sourceUpdateState.js");

const at = "2026-09-24T00:00:00.000Z";
const formal = (extra = {}) => ({ databaseStatus: "available", schemaStatus: "compatible",
  sourceCursorStatus: "available", lastAcceptedAt: "2026-09-23T00:00:00.000Z",
  securityStatus: "clear", ...extra });
const runtime = (sourceId, extra = {}) => ({ sourceId, lastAttemptAt: null, lastSuccessAt: null,
  lastOutcome: "none", retryAfter: null, lastHttpStatus: null, lastDiagnosticClass: null,
  coordinatorVersion: 1, ...extra });
const request = (extra = {}) => ({ trigger: "startup", requestedAt: at, ...extra });

test("sourceIds省略はregistry正式順のactive 12 sourceをplanする", () => {
  const plan = Coordinator.planUpdate(request());
  assert.equal(plan.sourceResults.length, 12);
  assert.deepEqual(plan.sourceResults.map(item => item.sourceId), Coordinator.ACTIVE_SOURCE_IDS);
  assert.equal(plan.summary.requestedSourceCount, 12);
  assert.equal(plan.summary.validSourceCount, 12);
  assert.equal(plan.summary.acquisitionCandidateCount, 12);
});

test("subsetとduplicateをregistry順へdeterministicに正規化する", () => {
  const ids = ["us-bls-calendar", "jp-boj-calendar", "us-bls-calendar"];
  const one = Coordinator.planUpdate(request({ sourceIds: ids }));
  const two = Coordinator.planUpdate(request({ sourceIds: [...ids].reverse() }));
  assert.deepEqual(one.sourceResults.map(item => item.sourceId), ["jp-boj-calendar", "us-bls-calendar"]);
  assert.deepEqual(one.sourceResults, two.sourceResults);
  assert.equal(one.summary.requestedSourceCount, 3);
  assert.equal(one.summary.validSourceCount, 2);
});

test("B1 updateとretryだけをacquisition candidateへ分類する", () => {
  const retryAfter = State.retryAfterFor("timeout", "2026-09-23T23:00:00.000Z");
  const plan = Coordinator.planUpdate(request({ sourceIds: ["jp-boj-calendar", "us-bls-calendar"],
    runtimeStates: { "us-bls-calendar": runtime("us-bls-calendar", {
      lastAttemptAt: "2026-09-23T23:00:00.000Z", lastOutcome: "failure",
      retryAfter, lastDiagnosticClass: "timeout" }) }, trigger: "retry" }));
  assert.equal(plan.sourceResults[0].decision, "blocked");
  assert.equal(plan.sourceResults[0].reason, "retry_without_failure");
  assert.equal(plan.sourceResults[1].decision, "retry");
  assert.deepEqual(plan.acquisitionCandidates.map(item => item.sourceId), ["us-bls-calendar"]);
});

test("skip・cooldown・blockedをno acquisitionとして保持する", () => {
  const sourceIds = ["jp-boj-calendar", "jp-stat-cpi", "jp-stat-labor"];
  const plan = Coordinator.planUpdate(request({ sourceIds,
    formalStates: { "jp-boj-calendar": formal({ lastAcceptedAt: at }) },
    runtimeStates: { "jp-stat-cpi": runtime("jp-stat-cpi", {
      lastAttemptAt: "2026-09-23T23:30:00.000Z", lastOutcome: "failure",
      retryAfter: "2026-09-24T00:30:00.000Z", lastDiagnosticClass: "timeout" }) },
    sessionStates: { "jp-stat-labor": { attemptCount: 2 } } }));
  assert.deepEqual(plan.sourceResults.map(item => item.decision), ["skip", "cooldown", "blocked"]);
  assert.equal(plan.acquisitionCandidates.length, 0);
  assert.equal(plan.nonAcquisitionResults.length, 3);
  assert.deepEqual(plan.summary, { requestedSourceCount: 3, validSourceCount: 3,
    acquisitionCandidateCount: 0, skipCount: 1, cooldownCount: 1, blockedInvalidCount: 1 });
});

test("unknown・blocked・replaced・malformed sourceを黙って捨てない", () => {
  const plan = Coordinator.planUpdate(request({ sourceIds: ["unknown", "jp-meti-calendar",
    "jp-esri-calendar", null, "jp-boj-calendar"] }));
  const reasons = plan.sourceResults.map(item => item.reason);
  assert.deepEqual(reasons, ["formal_database_absent", "malformed_source_id", "replaced_source",
    "blocked_source", "unknown_source"]);
  assert.equal(plan.summary.validSourceCount, 1);
  assert.equal(plan.summary.blockedInvalidCount, 4);
  assert.equal(plan.nonAcquisitionResults.length, 4);
});

test("invalid trigger/requestedAtはB1 reasonをsource単位で保持する", () => {
  const trigger = Coordinator.planUpdate(request({ sourceIds: ["jp-boj-calendar"], trigger: "bad" }));
  const time = Coordinator.planUpdate(request({ sourceIds: ["jp-boj-calendar"], requestedAt: "bad" }));
  assert.equal(trigger.sourceResults[0].reason, "trigger_invalid");
  assert.equal(time.sourceResults[0].reason, "requested_at_invalid");
  assert.equal(trigger.sourceResults[0].classification, "no_acquisition");
});

test("runtime identity mismatchとmalformed formal/runtime/sessionをfail-closed", () => {
  const sourceIds = ["jp-boj-calendar"];
  assert.equal(Coordinator.planUpdate(request({ sourceIds, runtimeStates: {
    "jp-boj-calendar": runtime("us-bls-calendar") } })).sourceResults[0].reason,
  "runtime_source_identity_mismatch");
  assert.equal(Coordinator.planUpdate(request({ sourceIds, formalStates: {
    "jp-boj-calendar": { bad: true } } })).sourceResults[0].reason, "formal_state_shape_invalid");
  assert.equal(Coordinator.planUpdate(request({ sourceIds, runtimeStates: {
    "jp-boj-calendar": { bad: true } } })).sourceResults[0].reason, "runtime_state_shape_invalid");
  assert.equal(Coordinator.planUpdate(request({ sourceIds, sessionStates: {
    "jp-boj-calendar": { attemptCount: "one" } } })).sourceResults[0].reason,
  "session_state_invalid");
});

test("malformed state mapはsource単位invalid、malformed sourceIdsはtop-level相当invalid", () => {
  const map = Coordinator.planUpdate(request({ sourceIds: ["jp-boj-calendar"], formalStates: [] }));
  assert.equal(map.sourceResults[0].reason, "formal_states_map_invalid");
  assert.equal(map.sourceResults[0].classification, "invalid");
  const ids = Coordinator.planUpdate(request({ sourceIds: "jp-boj-calendar" }));
  assert.equal(ids.sourceResults[0].reason, "source_ids_invalid");
});

test("state map insertion orderと同一inputでresultがdeep-equal", () => {
  const sourceIds = ["jp-boj-calendar", "us-bls-calendar"];
  const a = request({ sourceIds, formalStates: { "jp-boj-calendar": formal(),
    "us-bls-calendar": formal() } });
  const b = request({ sourceIds: [...sourceIds].reverse(), formalStates: {
    "us-bls-calendar": formal(), "jp-boj-calendar": formal() } });
  assert.deepEqual(Coordinator.planUpdate(a), Coordinator.planUpdate(a));
  assert.deepEqual(Coordinator.planUpdate(a), Coordinator.planUpdate(b));
  assert.equal(Object.isFrozen(Coordinator.planUpdate(a).sourceResults[0]), true);
});

test("module reload相当でも同じplanを返す", () => {
  const modulePath = require.resolve("../js/marketCalendarRuntime/updateCoordinator.js");
  const before = Coordinator.planUpdate(request({ sourceIds: ["us-bls-calendar", "jp-boj-calendar"] }));
  delete require.cache[modulePath];
  const reloaded = require(modulePath);
  assert.deepEqual(before, reloaded.planUpdate(request({
    sourceIds: ["jp-boj-calendar", "us-bls-calendar"] })));
});

test("JST boundaryとoffset表現はhost timezoneに依存しない", () => {
  const base = { sourceIds: ["jp-boj-calendar"], formalStates: {
    "jp-boj-calendar": formal({ lastAcceptedAt: "2026-09-24T14:00:00.000Z" }) } };
  const utc = Coordinator.planUpdate(request({ ...base, requestedAt: "2026-09-24T15:00:00.000Z" }));
  const offset = Coordinator.planUpdate(request({ ...base, requestedAt: "2026-09-25T00:00:00.000+09:00" }));
  assert.deepEqual(utc.sourceResults, offset.sourceResults);
  assert.deepEqual(utc.summary, offset.summary);
  assert.equal(utc.sourceResults[0].jstDate, "2026-09-25");
});

test("Coordinatorはnetwork・IPC・storage・flight・queue・acquisitionへ接続しない", () => {
  const source = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarRuntime/updateCoordinator.js"), "utf8");
  assert.doesNotMatch(source, /fetch\s*\(|ipcRenderer|ipcMain|indexedDB|localStorage|node:fs/);
  assert.doesNotMatch(source, /calendarAcquisitionService|AbortController|Promise\.all|single.?flight/i);
  assert.doesNotMatch(source, /canonical|candidateBuilder|productionHistoryWriter|transitionPlanner/);
  assert.doesNotMatch(source, /headers|parserId|canonicalUrl|allowedHosts/);
});
