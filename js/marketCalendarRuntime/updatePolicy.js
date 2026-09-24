"use strict";

const registry = require("../marketCalendar/sourceRegistry.js");
const stateApi = require("./sourceUpdateState.js");

const POLICY_VERSION = 1;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const TRIGGERS = Object.freeze(["bootstrap", "startup", "manual", "retry", "scheduler"]);
const DECISIONS = Object.freeze(["update", "skip", "cooldown", "retry", "blocked"]);
const REASONS = Object.freeze(["input_invalid", "source_not_eligible", "trigger_invalid",
  "requested_at_invalid", "policy_unsupported", "formal_state_shape_invalid",
  "formal_state_value_invalid", "formal_last_accepted_invalid", "formal_state_inconsistent",
  "security_violation", "schema_mismatch", "schema_status_ambiguous", "session_state_invalid",
  "runtime_state_shape_invalid", "runtime_source_identity_mismatch", "runtime_state_value_invalid",
  "lastAttemptAt_invalid", "lastSuccessAt_invalid", "retryAfter_invalid", "last_http_status_invalid",
  "diagnostic_class_invalid", "last_success_after_attempt", "retry_after_before_attempt",
  "success_state_inconsistent", "failure_state_inconsistent", "empty_state_inconsistent",
  "retry_state_ambiguous", "future_state_evidence", "scheduler_not_implemented",
  "session_attempt_limit_reached", "manual_diagnostic_retry", "retry_cooldown_active",
  "retry_window_reached", "retry_without_failure", "manual_daily_override",
  "already_succeeded_today", "bootstrap_database_absent", "formal_database_absent",
  "source_cursor_absent", "previous_jst_day_success", "source_never_succeeded",
  "automatic_retry_disabled_http_404", "automatic_retry_disabled_parser_structure_change",
  "automatic_retry_disabled_mime_mismatch"]);
const DEFAULT_POLICY = Object.freeze({ policyVersion: POLICY_VERSION, jstOffsetMinutes: 540,
  networkRetryMinutes: 60, offlineRetryMinutes: 30, startupSessionMaxAttempts: 2 });
const FORMAL_FIELDS = Object.freeze(["databaseStatus", "lastAcceptedAt", "schemaStatus",
  "securityStatus", "sourceCursorStatus"]);
const SESSION_FIELDS = Object.freeze(["attemptCount"]);
const instant = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const date = value => new Date(Date.parse(value) + JST_OFFSET_MS).toISOString().slice(0, 10);
const exactKeys = (value, fields) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("|") === [...fields].sort().join("|");
const frozen = value => Object.freeze(value);

function result(base, decision, reason, values = {}) {
  return frozen({ sourceId: base.sourceId || null, trigger: base.trigger || null, decision, reason,
    eligible: decision === "update" || decision === "retry", retryable: values.retryable === true,
    retryAfter: values.retryAfter || null, attemptCount: values.attemptCount ?? null,
    jstDate: values.jstDate || null, policyVersion: POLICY_VERSION });
}
function blocked(input, reason, values = {}) { return result(input || {}, "blocked", reason, values); }

function validateFormal(value) {
  if (!exactKeys(value, FORMAL_FIELDS)) return "formal_state_shape_invalid";
  if (!["available", "absent"].includes(value.databaseStatus) ||
      !["compatible", "mismatch", "unknown"].includes(value.schemaStatus) ||
      !["available", "absent"].includes(value.sourceCursorStatus) ||
      !["clear", "violation"].includes(value.securityStatus)) return "formal_state_value_invalid";
  if (value.lastAcceptedAt !== null && !instant(value.lastAcceptedAt)) return "formal_last_accepted_invalid";
  if (value.databaseStatus === "absent" && (value.sourceCursorStatus !== "absent" || value.lastAcceptedAt !== null))
    return "formal_state_inconsistent";
  if (value.sourceCursorStatus === "absent" && value.lastAcceptedAt !== null)
    return "formal_state_inconsistent";
  if (value.sourceCursorStatus === "available" && value.lastAcceptedAt === null)
    return "formal_state_inconsistent";
  return null;
}

function evaluateSourceUpdate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return blocked({}, "input_invalid");
  const base = { sourceId: input.sourceId, trigger: input.trigger };
  const source = registry.getSource(input.sourceId);
  if (!source || source.formalEligible !== true) return blocked(base, "source_not_eligible");
  if (!TRIGGERS.includes(input.trigger)) return blocked(base, "trigger_invalid");
  if (!instant(input.requestedAt)) return blocked(base, "requested_at_invalid");
  const jstDate = date(input.requestedAt);
  if (input.policy !== undefined && JSON.stringify(input.policy) !== JSON.stringify(DEFAULT_POLICY))
    return blocked(base, "policy_unsupported", { jstDate });
  const formalError = validateFormal(input.formalState);
  if (formalError) return blocked(base, formalError, { jstDate });
  if (input.formalState.securityStatus === "violation")
    return blocked(base, "security_violation", { jstDate });
  if (input.formalState.schemaStatus === "mismatch")
    return blocked(base, "schema_mismatch", { jstDate });
  if (input.formalState.schemaStatus === "unknown" && input.formalState.databaseStatus === "available")
    return blocked(base, "schema_status_ambiguous", { jstDate });
  if (!exactKeys(input.sessionState, SESSION_FIELDS) || !Number.isInteger(input.sessionState.attemptCount) ||
      input.sessionState.attemptCount < 0)
    return blocked(base, "session_state_invalid", { jstDate });
  const attemptCount = input.sessionState.attemptCount;
  const checked = stateApi.validateRuntimeState(input.runtimeState, input.sourceId);
  if (!checked.valid) return blocked(base, checked.reason, { attemptCount, jstDate });
  const runtime = checked.state;
  for (const value of [input.formalState.lastAcceptedAt, runtime?.lastAttemptAt,
    runtime?.lastSuccessAt])
    if (value && Date.parse(value) > Date.parse(input.requestedAt))
      return blocked(base, "future_state_evidence", { attemptCount, jstDate });
  if (input.trigger === "scheduler")
    return blocked(base, "scheduler_not_implemented", { attemptCount, jstDate });
  if (attemptCount >= DEFAULT_POLICY.startupSessionMaxAttempts)
    return blocked(base, "session_attempt_limit_reached", { attemptCount, jstDate });
  if (runtime?.lastOutcome === "failure") {
    const classification = stateApi.classifyDiagnostic(runtime.lastDiagnosticClass);
    if (!classification || ["security_violation", "schema_mismatch"].includes(runtime.lastDiagnosticClass))
      return blocked(base, runtime.lastDiagnosticClass || "diagnostic_class_invalid",
        { attemptCount, jstDate });
    if (!classification.retryable) {
      if (input.trigger === "manual" && classification.manualCandidate)
        return result(base, "update", "manual_diagnostic_retry", { attemptCount, jstDate });
      return blocked(base, `automatic_retry_disabled_${runtime.lastDiagnosticClass}`,
        { attemptCount, jstDate });
    }
    if (!runtime.retryAfter) return blocked(base, "retry_state_ambiguous", { attemptCount, jstDate });
    if (Date.parse(input.requestedAt) < Date.parse(runtime.retryAfter))
      return result(base, "cooldown", "retry_cooldown_active", { retryable: true,
        retryAfter: runtime.retryAfter, attemptCount, jstDate });
    return result(base, "retry", "retry_window_reached", { retryable: true,
      retryAfter: runtime.retryAfter, attemptCount, jstDate });
  }
  if (input.trigger === "retry")
    return blocked(base, "retry_without_failure", { attemptCount, jstDate });
  const lastSuccessAt = runtime?.lastSuccessAt || input.formalState.lastAcceptedAt;
  if (lastSuccessAt && date(lastSuccessAt) === jstDate) {
    if (input.trigger === "manual")
      return result(base, "update", "manual_daily_override", { attemptCount, jstDate });
    return result(base, "skip", "already_succeeded_today", { attemptCount, jstDate });
  }
  if (input.formalState.databaseStatus === "absent")
    return result(base, "update", input.trigger === "bootstrap" ? "bootstrap_database_absent" :
      "formal_database_absent", { attemptCount, jstDate });
  if (input.formalState.sourceCursorStatus === "absent")
    return result(base, "update", "source_cursor_absent", { attemptCount, jstDate });
  return result(base, "update", lastSuccessAt ? "previous_jst_day_success" : "source_never_succeeded",
    { attemptCount, jstDate });
}

module.exports = Object.freeze({ POLICY_VERSION, TRIGGERS, DECISIONS, REASONS, DEFAULT_POLICY,
  evaluateSourceUpdate });
