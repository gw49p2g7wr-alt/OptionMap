"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Policy = require("../js/marketCalendarRuntime/updatePolicy.js");
const State = require("../js/marketCalendarRuntime/sourceUpdateState.js");

const formal = (extra = {}) => ({ databaseStatus: "available", schemaStatus: "compatible",
  sourceCursorStatus: "available", lastAcceptedAt: "2026-09-23T00:00:00.000Z",
  securityStatus: "clear", ...extra });
const session = attemptCount => ({ attemptCount });
const runtime = (extra = {}) => ({ sourceId: "jp-boj-calendar", lastAttemptAt: null,
  lastSuccessAt: null, lastOutcome: "none", retryAfter: null, lastHttpStatus: null,
  lastDiagnosticClass: null, coordinatorVersion: 1, ...extra });
const input = (extra = {}) => ({ trigger: "startup", sourceId: "jp-boj-calendar",
  requestedAt: "2026-09-24T00:00:00.000Z", formalState: formal(), runtimeState: null,
  sessionState: session(0), ...extra });
const decide = extra => Policy.evaluateSourceUpdate(input(extra));

test("JST daily policyは当日skip・前日以前update・未取得update", () => {
  assert.equal(decide({ formalState: formal({ lastAcceptedAt: "2026-09-24T00:00:00.000Z" }) }).decision,
    "skip");
  assert.equal(decide({ formalState: formal({ lastAcceptedAt: "2026-09-23T14:59:59.999Z" }) }).decision,
    "update");
  assert.equal(decide({ formalState: formal({ lastAcceptedAt: "2026-09-22T00:00:00.000Z" }) }).decision,
    "update");
  assert.equal(decide({ formalState: formal({ sourceCursorStatus: "absent", lastAcceptedAt: null }) }).reason,
    "source_cursor_absent");
  assert.equal(decide({ trigger: "bootstrap", formalState: formal({ databaseStatus: "absent",
    schemaStatus: "unknown", sourceCursorStatus: "absent", lastAcceptedAt: null }) }).reason,
  "bootstrap_database_absent");
});

test("JST 23:59/00:00とhost timezone表現に依存せず同じinstantを判定する", () => {
  const before = decide({ requestedAt: "2026-09-24T14:59:59.000Z",
    formalState: formal({ lastAcceptedAt: "2026-09-24T14:00:00.000Z" }) });
  const after = decide({ requestedAt: "2026-09-24T15:00:00.000Z",
    formalState: formal({ lastAcceptedAt: "2026-09-24T14:00:00.000Z" }) });
  assert.equal(before.jstDate, "2026-09-24"); assert.equal(before.decision, "skip");
  assert.equal(after.jstDate, "2026-09-25"); assert.equal(after.decision, "update");
  const utc = decide({ requestedAt: "2026-09-24T15:00:00.000Z" });
  const offset = decide({ requestedAt: "2026-09-25T00:00:00.000+09:00" });
  assert.deepEqual(utc, offset);
});

for (const [diagnostic, minutes] of [["timeout", 60], ["offline", 30], ["http_5xx", 60]])
  test(`${diagnostic}はcooldown境界でretryへ移る`, () => {
    const lastAttemptAt = "2026-09-24T00:00:00.000Z", retryAfter =
      State.retryAfterFor(diagnostic, lastAttemptAt), failed = runtime({ lastAttemptAt,
        lastOutcome: "failure", lastDiagnosticClass: diagnostic, retryAfter,
        lastHttpStatus: diagnostic === "http_5xx" ? 503 : null });
    const before = Policy.evaluateSourceUpdate(input({ trigger: "retry", requestedAt:
      new Date(Date.parse(retryAfter) - 1).toISOString(), runtimeState: failed }));
    const at = Policy.evaluateSourceUpdate(input({ trigger: "retry", requestedAt: retryAfter,
      runtimeState: failed }));
    assert.equal(before.decision, "cooldown"); assert.equal(before.retryable, true);
    assert.equal(at.decision, "retry"); assert.equal(at.retryable, true);
    assert.equal(Date.parse(retryAfter) - Date.parse(lastAttemptAt), minutes * 60_000);
  });

test("startup session attempt limitはattempt 1を許可し2で停止する", () => {
  assert.equal(decide({ sessionState: session(1) }).decision, "update");
  const limited = decide({ sessionState: session(2) });
  assert.equal(limited.decision, "blocked"); assert.equal(limited.reason, "session_attempt_limit_reached");
});

test("manualはdaily skipだけを迂回しhard safetyを迂回しない", () => {
  assert.equal(decide({ trigger: "manual", formalState: formal({
    lastAcceptedAt: "2026-09-24T00:00:00.000Z" }) }).reason, "manual_daily_override");
  assert.equal(decide({ trigger: "manual", formalState: formal({ securityStatus: "violation" }) }).reason,
    "security_violation");
  assert.equal(decide({ trigger: "manual", formalState: formal({ schemaStatus: "mismatch" }) }).reason,
    "schema_mismatch");
  assert.equal(Policy.evaluateSourceUpdate(input({ trigger: "manual", sourceId: "unknown" })).reason,
    "source_not_eligible");
  assert.equal(decide({ trigger: "manual", sessionState: session(2) }).reason,
    "session_attempt_limit_reached");
});

for (const diagnostic of ["http_404", "parser_structure_change", "mime_mismatch"])
  test(`${diagnostic}はautomatic retryを止めmanual候補だけにする`, () => {
    const failed = runtime({ lastAttemptAt: "2026-09-24T00:00:00.000Z", lastOutcome: "failure",
      lastDiagnosticClass: diagnostic, lastHttpStatus: diagnostic === "http_404" ? 404 : null });
    assert.match(decide({ runtimeState: failed }).reason, /^automatic_retry_disabled_/);
    assert.equal(decide({ trigger: "manual", runtimeState: failed }).reason, "manual_diagnostic_retry");
  });

test("invalid identity/trigger/time/schema/security/unsupported combinationをfail-closed", () => {
  assert.equal(Policy.evaluateSourceUpdate(input({ sourceId: "jp-meti-calendar" })).decision, "blocked");
  assert.equal(decide({ trigger: "unknown" }).reason, "trigger_invalid");
  assert.equal(decide({ requestedAt: "09/24/2026" }).reason, "requested_at_invalid");
  assert.equal(decide({ formalState: formal({ schemaStatus: "mismatch" }) }).reason, "schema_mismatch");
  assert.equal(decide({ formalState: formal({ securityStatus: "violation" }) }).reason, "security_violation");
  assert.equal(decide({ trigger: "scheduler" }).reason, "scheduler_not_implemented");
  assert.equal(decide({ trigger: "retry" }).reason, "retry_without_failure");
  assert.equal(decide({ formalState: formal({ lastAcceptedAt: "2026-09-25T00:00:00.000Z" }) }).reason,
    "future_state_evidence");
});

test("malformed retryAfter・inconsistent attempt/success・unsupported stateをreason付き拒否", () => {
  assert.equal(decide({ runtimeState: runtime({ lastOutcome: "failure",
    lastAttemptAt: "2026-09-24T00:00:00.000Z", lastDiagnosticClass: "timeout",
    retryAfter: "bad" }) }).reason, "retryAfter_invalid");
  assert.equal(decide({ runtimeState: runtime({ lastAttemptAt: "2026-09-24T00:00:00.000Z",
    lastSuccessAt: "2026-09-24T00:00:01.000Z", lastOutcome: "success" }) }).reason,
  "last_success_after_attempt");
  assert.equal(decide({ formalState: formal({ databaseStatus: "absent" }) }).reason,
    "formal_state_inconsistent");
});

test("result contractはdeterministicでpolicyVersionと全required fieldを持つ", () => {
  const one = decide(), two = decide(); assert.deepEqual(one, two);
  assert.deepEqual(Object.keys(one).sort(), ["attemptCount", "decision", "eligible", "jstDate",
    "policyVersion", "reason", "retryAfter", "retryable", "sourceId", "trigger"].sort());
  assert.equal(one.policyVersion, 1); assert.equal(Object.isFrozen(one), true);
  assert.equal(Policy.DECISIONS.includes(one.decision), true);
  assert.equal(Policy.REASONS.includes(one.reason), true);
});

test("B1 moduleはnetwork・IPC・persistent storage・他domainへ接続しない", () => {
  for (const file of ["updatePolicy.js", "sourceUpdateState.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "../js/marketCalendarRuntime", file), "utf8");
    assert.doesNotMatch(source, /fetch\s*\(|ipcRenderer|ipcMain|indexedDB|localStorage|node:fs/);
    assert.doesNotMatch(source, /productionHistoryWriter|productionSchema|QRI|Weekly|Participant|Morning/);
  }
});
