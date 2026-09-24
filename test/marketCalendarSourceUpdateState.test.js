"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const State = require("../js/marketCalendarRuntime/sourceUpdateState.js");

const base = (extra = {}) => ({ sourceId: "jp-boj-calendar", lastAttemptAt: null,
  lastSuccessAt: null, lastOutcome: "none", retryAfter: null, lastHttpStatus: null,
  lastDiagnosticClass: null, coordinatorVersion: 1, ...extra });

test("Runtime State contractはnon-authority factsをexact schemaで受理する", () => {
  const value = State.createRuntimeState(base());
  assert.equal(value.valid, true); assert.equal(value.state.lastOutcome, "none");
  assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.state), true);
});

test("retry classificationとretryAfterをpolicy tableから決定する", () => {
  assert.deepEqual(State.classifyDiagnostic("timeout"),
    { retryable: true, delayMinutes: 60, automatic: true });
  assert.deepEqual(State.classifyDiagnostic("offline"),
    { retryable: true, delayMinutes: 30, automatic: true });
  assert.equal(State.retryAfterFor("timeout", "2026-09-24T00:00:00.000Z"),
    "2026-09-24T01:00:00.000Z");
  assert.equal(State.retryAfterFor("http_404", "2026-09-24T00:00:00.000Z"), null);
});

test("success/failureの矛盾とreverse timestampをfail-closedにする", () => {
  assert.equal(State.validateRuntimeState(base({ lastOutcome: "success",
    lastAttemptAt: "2026-09-24T00:00:00.000Z" })).reason, "success_state_inconsistent");
  assert.equal(State.validateRuntimeState(base({ lastOutcome: "failure",
    lastAttemptAt: "2026-09-24T00:00:00.000Z", lastDiagnosticClass: "timeout" })).reason,
  "retry_state_ambiguous");
  assert.equal(State.validateRuntimeState(base({ lastOutcome: "failure",
    lastAttemptAt: "2026-09-24T01:00:00.000Z", lastDiagnosticClass: "timeout",
    retryAfter: "2026-09-24T00:59:59.999Z" })).reason, "retry_after_before_attempt");
  assert.equal(State.validateRuntimeState(base({ extra: true })).reason, "runtime_state_shape_invalid");
});

test("diagnostic taxonomyはsecurity/schemaとmanual candidateを分離する", () => {
  assert.equal(State.classifyDiagnostic("security_violation").retryable, false);
  assert.equal(State.classifyDiagnostic("schema_mismatch").manualCandidate, undefined);
  assert.equal(State.classifyDiagnostic("parser_structure_change").manualCandidate, true);
  assert.equal(State.classifyDiagnostic("mime_mismatch").automatic, false);
});

test("moduleはnetwork・IPC・storage・domain runtimeへ接続しない", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname,
    "../js/marketCalendarRuntime/sourceUpdateState.js"), "utf8");
  assert.doesNotMatch(source, /fetch\s*\(|ipcRenderer|ipcMain|indexedDB|localStorage|node:fs|productionHistoryWriter/);
  assert.doesNotMatch(source, /QRI|Weekly|Participant|Morning|Price Snapshot|Market Observation/);
});
