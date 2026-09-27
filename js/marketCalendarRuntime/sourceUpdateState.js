(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports && !root?.document) module.exports = api;
  if (root) root.OptionMapCalendarSourceUpdateState = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
"use strict";

const RUNTIME_STATE_FIELDS = Object.freeze(["coordinatorVersion", "lastAttemptAt",
  "lastDiagnosticClass", "lastHttpStatus", "lastOutcome", "lastSuccessAt", "retryAfter", "sourceId"]);
const OUTCOMES = Object.freeze(["none", "success", "failure"]);
const DIAGNOSTIC_CLASSES = Object.freeze(["network_failure", "http_5xx", "timeout", "offline",
  "http_404", "parser_structure_change", "mime_mismatch", "schema_mismatch", "security_violation"]);
const RETRY_CLASSIFICATION = Object.freeze({
  network_failure: Object.freeze({ retryable: true, delayMinutes: 60, automatic: true }),
  http_5xx: Object.freeze({ retryable: true, delayMinutes: 60, automatic: true }),
  timeout: Object.freeze({ retryable: true, delayMinutes: 60, automatic: true }),
  offline: Object.freeze({ retryable: true, delayMinutes: 30, automatic: true }),
  http_404: Object.freeze({ retryable: false, delayMinutes: null, automatic: false, manualCandidate: true }),
  parser_structure_change: Object.freeze({ retryable: false, delayMinutes: null,
    automatic: false, manualCandidate: true }),
  mime_mismatch: Object.freeze({ retryable: false, delayMinutes: null,
    automatic: false, manualCandidate: true }),
  schema_mismatch: Object.freeze({ retryable: false, delayMinutes: null, automatic: false }),
  security_violation: Object.freeze({ retryable: false, delayMinutes: null, automatic: false })
});
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
function deepFreeze(value) {
  if (value && typeof value === "object") for (const child of Object.values(value)) deepFreeze(child);
  return value && typeof value === "object" ? Object.freeze(value) : value;
}
const freeze = value => deepFreeze(clone(value));
const instant = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));

function classifyDiagnostic(value) { return RETRY_CLASSIFICATION[value] || null; }
function retryAfterFor(diagnosticClass, failedAt) {
  const classification = classifyDiagnostic(diagnosticClass);
  if (!classification?.retryable || !instant(failedAt)) return null;
  return new Date(Date.parse(failedAt) + classification.delayMinutes * 60_000).toISOString();
}

function validateRuntimeState(value, sourceId = null) {
  if (value === null || value === undefined) return freeze({ valid: true, reason: null, state: null });
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("|") !== [...RUNTIME_STATE_FIELDS].sort().join("|"))
    return freeze({ valid: false, reason: "runtime_state_shape_invalid", state: null });
  if (typeof value.sourceId !== "string" || (sourceId && value.sourceId !== sourceId))
    return freeze({ valid: false, reason: "runtime_source_identity_mismatch", state: null });
  if (!OUTCOMES.includes(value.lastOutcome) || !Number.isInteger(value.coordinatorVersion) ||
      value.coordinatorVersion < 1)
    return freeze({ valid: false, reason: "runtime_state_value_invalid", state: null });
  for (const field of ["lastAttemptAt", "lastSuccessAt", "retryAfter"])
    if (value[field] !== null && !instant(value[field]))
      return freeze({ valid: false, reason: `${field}_invalid`, state: null });
  if (value.lastHttpStatus !== null && (!Number.isInteger(value.lastHttpStatus) ||
      value.lastHttpStatus < 100 || value.lastHttpStatus > 599))
    return freeze({ valid: false, reason: "last_http_status_invalid", state: null });
  if (value.lastDiagnosticClass !== null && !DIAGNOSTIC_CLASSES.includes(value.lastDiagnosticClass))
    return freeze({ valid: false, reason: "diagnostic_class_invalid", state: null });
  if (value.lastAttemptAt && value.lastSuccessAt && Date.parse(value.lastSuccessAt) > Date.parse(value.lastAttemptAt))
    return freeze({ valid: false, reason: "last_success_after_attempt", state: null });
  if (value.retryAfter && (!value.lastAttemptAt || Date.parse(value.retryAfter) < Date.parse(value.lastAttemptAt)))
    return freeze({ valid: false, reason: "retry_after_before_attempt", state: null });
  if (value.lastOutcome === "success" && (!value.lastSuccessAt || value.lastDiagnosticClass || value.retryAfter))
    return freeze({ valid: false, reason: "success_state_inconsistent", state: null });
  if (value.lastOutcome === "failure" && (!value.lastAttemptAt || !value.lastDiagnosticClass || value.lastSuccessAt &&
      Date.parse(value.lastSuccessAt) === Date.parse(value.lastAttemptAt)))
    return freeze({ valid: false, reason: "failure_state_inconsistent", state: null });
  if (value.lastOutcome === "none" && [value.lastAttemptAt, value.lastSuccessAt, value.retryAfter,
      value.lastHttpStatus, value.lastDiagnosticClass].some(item => item !== null))
    return freeze({ valid: false, reason: "empty_state_inconsistent", state: null });
  const classification = classifyDiagnostic(value.lastDiagnosticClass);
  if (value.lastOutcome === "failure" && classification?.retryable !== Boolean(value.retryAfter))
    return freeze({ valid: false, reason: "retry_state_ambiguous", state: null });
  return freeze({ valid: true, reason: null, state: value });
}

function createRuntimeState(value) {
  const result = validateRuntimeState(value);
  if (!result.valid) return result;
  return freeze({ valid: true, reason: null, state: result.state });
}

const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).sort().join("|") === [...keys].sort().join("|");
const positive = v => Number.isSafeInteger(v) && v > 0;
const digest = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const BINDING_FIELDS = Object.freeze(["sourceContractVersion", "routeContractVersion", "routeKind", "routeIdentity", "activationVersion"]);
const REEVALUATION_FIELDS = ["approvalId", "targetRouteIdentity", "status", "reservedAt", "completedAt", "previousRouteSummary"];
const SUMMARY_FIELDS = ["routeClass", "lastOutcome", "lastDiagnosticClass", "lastAttemptAt", "lastSuccessAt", "lastHttpStatus"];
function legacyProjection(value) { return Object.fromEntries(RUNTIME_STATE_FIELDS.map(key => [key, value[key]])); }
function validBinding(value) {
  return exact(value, BINDING_FIELDS) && positive(value.sourceContractVersion) && positive(value.routeContractVersion) &&
    positive(value.activationVersion) && digest(value.routeIdentity) &&
    ["legacy", "estat_release_calendar", "bls_fixed_schedule_pages"].includes(value.routeKind);
}
// Compatibility is explicit. B1's original exact eight-field validator remains unchanged.
function validateCompatibleRuntimeState(value, sourceId = null) {
  const invalid = () => freeze({ valid: false, reason: "runtime_state_invalid", state: null });
  if (!value || !Object.hasOwn(value, "runtimeStateContractVersion")) {
    const checked = validateRuntimeState(value, sourceId);
    return freeze({ ...checked, recordKind: "legacy", routeClass: "legacy_unknown_contract" });
  }
  if (!exact(value, [...RUNTIME_STATE_FIELDS, "runtimeStateContractVersion", "routeBinding", "reevaluation"]) ||
      value.runtimeStateContractVersion !== 2 || !validBinding(value.routeBinding) ||
      !validateRuntimeState(legacyProjection(value), sourceId).valid) return invalid();
  const r = value.reevaluation;
  if (r !== null) {
    if (!exact(r, REEVALUATION_FIELDS) || typeof r.approvalId !== "string" ||
        !/^[a-z0-9_-]{1,100}$/.test(r.approvalId) || !digest(r.targetRouteIdentity) ||
        r.targetRouteIdentity !== value.routeBinding.routeIdentity || !["reserved", "completed"].includes(r.status) ||
        !instant(r.reservedAt) || !exact(r.previousRouteSummary, SUMMARY_FIELDS)) return invalid();
    const p = r.previousRouteSummary;
    if (!["legacy_unknown_contract", "legacy"].includes(p.routeClass) || p.lastOutcome !== "failure" ||
        !DIAGNOSTIC_CLASSES.includes(p.lastDiagnosticClass) || !instant(p.lastAttemptAt) ||
        p.lastSuccessAt !== null && (!instant(p.lastSuccessAt) || Date.parse(p.lastSuccessAt) >= Date.parse(p.lastAttemptAt)) ||
        p.lastHttpStatus !== null && (!Number.isInteger(p.lastHttpStatus) || p.lastHttpStatus < 100 || p.lastHttpStatus > 599) ||
        Date.parse(p.lastAttemptAt) > Date.parse(r.reservedAt)) return invalid();
    if (r.status === "reserved" && (r.completedAt !== null || value.lastOutcome !== "none")) return invalid();
    if (r.status === "completed" && (!instant(r.completedAt) || value.lastOutcome === "none" ||
        !value.lastAttemptAt || Date.parse(value.lastAttemptAt) < Date.parse(r.reservedAt) ||
        Date.parse(r.completedAt) < Date.parse(value.lastAttemptAt))) return invalid();
  }
  return freeze({ valid: true, reason: null, state: value, recordKind: "v2", routeClass: value.routeBinding.routeKind });
}

return Object.freeze({ OUTCOMES, DIAGNOSTIC_CLASSES, RETRY_CLASSIFICATION,
  classifyDiagnostic, retryAfterFor, validateRuntimeState, createRuntimeState,
  validateCompatibleRuntimeState, legacyProjection, validBinding, BINDING_FIELDS });
});
