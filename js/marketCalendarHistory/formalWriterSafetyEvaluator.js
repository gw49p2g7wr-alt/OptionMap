"use strict";

// Pure E4e-2a model. Safety values are memory inputs, never loaded or persisted here.
const A = require("./formalWriterAuthorityV2.js");
const CATEGORIES = Object.freeze(["acquisition_failure", "route_mismatch", "stale"]);
const THRESHOLD = 3;
const LOCAL = Object.freeze({ network_failure: "acquisition_failure", timeout: "acquisition_failure",
  partial: "acquisition_failure", http_failure: "acquisition_failure", acquisition_failure: "acquisition_failure",
  route_mismatch: "route_mismatch", stale_precondition: "stale" });
const SOURCE = Object.freeze(["unsupported_changed", "source_identity_conflict", "source_security_rejection",
  "encoding_rejection", "parser_rejection"]);
const GLOBAL = Object.freeze(["schema_mismatch", "db_integrity_failure", "duplicate_active", "multiple_active_revision",
  "orphan", "cross_source_mutation", "actual_mutation_mismatch", "commit_ambiguous", "readback_mismatch",
  "readback_incomplete", "malformed_safety_state", "interrupted_pending_fence", "safety_version_mismatch",
  "safety_state_missing", "safety_validation_failed", "writer_authority_v2_invalid", "unknown_failure_code"]);
const REASONS = [...Object.keys(LOCAL), ...SOURCE, ...GLOBAL];
const EMPTY = () => ({ count: 0, cycleOrdinal: 0, cycleIdentity: null, outcome: null });
function sealSafetyMaterial(material) {
  const { validationIdentity: _, ...value } = structuredClone(material);
  return A.freeze({ ...value, validationIdentity: A.hash(value) });
}
function createMemorySafety(policy = A.PRODUCTION_POLICY) {
  if (!A.validatePolicy(policy).valid) throw Error("writer_authority_v2_invalid");
  return sealSafetyMaterial({ safetyContractVersion: 1, persistedAuthorityVersion: policy.global.authorityVersion,
    persistedAuthorityIdentity: policy.global.identity, sourcePermissionVersion: policy.permissions.permissionVersion,
    sourcePermissionIdentity: policy.permissions.identity, sequence: 0,
    globalSuspend: { suspended: false, reason: null }, pendingFence: null,
    sources: A.sourceIdsForPolicy(policy).map(sourceId => ({ sourceId, suspended: false, reason: null,
      counters: Object.fromEntries(CATEGORIES.map(category => [category, EMPTY()])) })) });
}
function validateSafety(state, policy = A.PRODUCTION_POLICY) {
  const bad = reason => A.freeze({ valid: false, reason });
  if (!state) return bad("safety_state_missing");
  try {
    if (!A.validatePolicy(policy).valid || !A.exact(state, ["safetyContractVersion", "persistedAuthorityVersion",
      "persistedAuthorityIdentity", "sourcePermissionVersion", "sourcePermissionIdentity", "sequence", "globalSuspend",
      "pendingFence", "sources", "validationIdentity"]) || state.safetyContractVersion !== 1 || !A.integer(state.sequence))
      return bad("malformed_safety_state");
    if (state.persistedAuthorityVersion !== policy.global.authorityVersion || state.persistedAuthorityIdentity !== policy.global.identity ||
      state.sourcePermissionVersion !== policy.permissions.permissionVersion || state.sourcePermissionIdentity !== policy.permissions.identity)
      return bad("safety_version_mismatch");
    const latch = value => A.exact(value, ["suspended", "reason"]) && typeof value.suspended === "boolean" &&
      (value.suspended ? REASONS.includes(value.reason) : value.reason === null);
    const sourceIds = A.sourceIdsForPolicy(policy);
    if (!latch(state.globalSuspend) || !Array.isArray(state.sources) || state.sources.length !== sourceIds.length ||
      state.sources.map(s => s.sourceId).sort().join("|") !== sourceIds.join("|")) return bad("malformed_safety_state");
    for (const s of state.sources) {
      if (!A.exact(s, ["sourceId", "suspended", "reason", "counters"]) || !latch({ suspended: s.suspended, reason: s.reason }) ||
        !A.exact(s.counters, CATEGORIES)) return bad("malformed_safety_state");
      for (const c of Object.values(s.counters)) {
        if (!A.exact(c, ["count", "cycleOrdinal", "cycleIdentity", "outcome"]) || !A.integer(c.count) || c.count > THRESHOLD ||
          !A.integer(c.cycleOrdinal) || (c.cycleOrdinal === 0 ? c.cycleIdentity !== null || c.outcome !== null || c.count !== 0 :
            !A.isHash(c.cycleIdentity) || !["failure", "success"].includes(c.outcome)) ||
          c.outcome === "success" && c.count !== 0 || c.outcome === "failure" && c.count === 0)
          return bad("malformed_safety_state");
      }
      if (Object.values(s.counters).some(c => c.count === THRESHOLD) && !s.suspended)
        return bad("malformed_safety_state");
      if (s.sourceId === A.BOJ && Object.values(s.counters).some(c => c.cycleOrdinal !== 0))
        return bad("malformed_safety_state");
    }
    const f = state.pendingFence;
    if (f !== null && (!A.exact(f, ["sourceId", "attemptIdentity", "cycleIdentity", "phase"]) ||
      !A.SOURCE_IDS.includes(f.sourceId) || !A.isHash(f.attemptIdentity) || !A.isHash(f.cycleIdentity) ||
      !["prepared", "transaction_started", "committed_unverified"].includes(f.phase))) return bad("malformed_safety_state");
    const { validationIdentity, ...material } = state;
    if (!A.isHash(validationIdentity) || A.hash(material) !== validationIdentity) return bad("safety_validation_failed");
    return A.freeze({ valid: true, reason: null });
  } catch (_) { return bad("malformed_safety_state"); }
}
function classifyFailure(reason, consecutiveCount = 1) {
  if (!A.integer(consecutiveCount) || consecutiveCount < 1) return A.freeze({ action: "global_suspend", reason: "unknown_failure_code", category: null });
  if (LOCAL[reason]) return A.freeze({ action: consecutiveCount >= THRESHOLD ? "source_suspend" : "skip",
    reason, category: LOCAL[reason] });
  if (SOURCE.includes(reason)) return A.freeze({ action: "source_suspend", reason, category: null });
  return A.freeze({ action: "global_suspend", reason: GLOBAL.includes(reason) ? reason : "unknown_failure_code", category: null });
}
function reduceSafetySignal(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return A.freeze({ valid: false, state: null, action: "global_suspend", reason: "malformed_safety_state" });
  const { policy = A.PRODUCTION_POLICY, state, signal } = input;
  const checked = validateSafety(state, policy);
  if (!checked.valid) return A.freeze({ valid: false, state: null, action: "global_suspend", reason: checked.reason });
  if (!A.exact(signal, ["sourceId", "category", "outcome", "reason", "cycleOrdinal", "cycleIdentity"]) ||
    !A.SOURCE_IDS.includes(signal.sourceId) || !A.integer(signal.cycleOrdinal) || signal.cycleOrdinal < 1 ||
    !A.isHash(signal.cycleIdentity) || !["failure", "success", "skip", "cooldown", "not_evaluated"].includes(signal.outcome) ||
    signal.category !== null && !CATEGORIES.includes(signal.category) ||
    signal.outcome !== "failure" && (signal.reason !== null || signal.category === null))
    return A.freeze({ valid: false, state, action: "global_suspend", reason: "unknown_failure_code" });
  if (["skip", "cooldown", "not_evaluated"].includes(signal.outcome))
    return A.freeze({ valid: true, state, action: "no_change", reason: null });
  const failure = signal.outcome === "failure" ? classifyFailure(signal.reason) : null;
  if (failure && failure.category !== signal.category) return A.freeze({ valid: false, state,
    action: "global_suspend", reason: "unknown_failure_code" });
  const next = structuredClone(state), own = next.sources.find(s => s.sourceId === signal.sourceId);
  let action = failure?.action || "no_change";
  if (state.globalSuspend.suspended) return A.freeze({ valid: true, state, action: "no_change", reason: "global_write_stopped" });
  if (action !== "global_suspend" && (signal.sourceId === A.BOJ || own.suspended))
    return A.freeze({ valid: true, state, action: "no_change", reason: "source_write_stopped" });
  if (signal.category) {
    const c = own.counters[signal.category];
    if (signal.cycleOrdinal < c.cycleOrdinal) return A.freeze({ valid: true, state, action: "no_change", reason: "stale_signal" });
    if (signal.cycleOrdinal === c.cycleOrdinal) {
      if (signal.cycleIdentity !== c.cycleIdentity || signal.outcome !== c.outcome) {
        own.suspended = true; own.reason = "source_identity_conflict"; next.sequence++;
        return A.freeze({ valid: true, state: sealSafetyMaterial(next), action: "source_suspend", reason: own.reason });
      }
      return A.freeze({ valid: true, state, action: "no_change", reason: "duplicate_signal" });
    }
    c.count = signal.outcome === "success" ? 0 : Math.min(THRESHOLD, c.count + 1);
    c.cycleOrdinal = signal.cycleOrdinal; c.cycleIdentity = signal.cycleIdentity; c.outcome = signal.outcome;
    if (failure) action = classifyFailure(signal.reason, c.count).action;
  }
  if (action === "global_suspend") next.globalSuspend = { suspended: true, reason: failure.reason };
  if (action === "source_suspend") { own.suspended = true; own.reason = failure.reason; }
  if (!A.integer(state.sequence + 1)) return A.freeze({ valid: false, state, action: "global_suspend", reason: "malformed_safety_state" });
  next.sequence++;
  return A.freeze({ valid: true, state: sealSafetyMaterial(next), action, reason: failure?.reason || null });
}
function evaluate(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return A.freeze({ writeAllowed: false, candidateEligible: false, effectiveState: "suspended",
      scope: "global", reason: "writer_input_invalid", shadowAllowed: true });
  const policy = input.policy || A.PRODUCTION_POLICY;
  const stop = (reason, effectiveState = "suspended", scope = "global") => A.freeze({ writeAllowed: false,
    candidateEligible: false, effectiveState, scope, reason, shadowAllowed: true });
  if (!A.validatePolicy(policy).valid) return stop("writer_authority_v2_invalid");
  if (!A.SOURCE_IDS.includes(input.sourceId)) return stop("source_unknown");
  const permission = policy.permissions.entries.find(e => e.sourceId === input.sourceId).permission;
  const checked = validateSafety(input.safety, policy);
  if (!checked.valid) return stop(checked.reason);
  if (input.safety.globalSuspend.suspended) return stop(input.safety.globalSuspend.reason);
  if (input.safety.pendingFence) return stop("interrupted_pending_fence");
  if (permission === "writer_ineligible") return stop("writer_ineligible_identity_transition", "writer_ineligible", "source");
  if (permission === "suspended" || input.safety.sources.find(s => s.sourceId === input.sourceId).suspended)
    return stop("source_suspended", "suspended", "source");
  if (policy.global.state !== "active") return stop(`writer_${policy.global.state}`, policy.global.state);
  if (!policy.global.permittedSources.includes(input.sourceId)) return stop("source_outside_activation_scope", "disabled", "source");
  const context = A.contextDetails(input.context, input.cycleIdentity, input.operation);
  if (!context) return stop("trusted_context_invalid");
  if (context.operation !== "startup") return stop("manual_writer_disabled", "disabled", "source");
  if (!A.exact(input.acquisition, ["outcome", "failedRoles"]) || input.acquisition.outcome !== "complete" ||
      !Array.isArray(input.acquisition.failedRoles) || input.acquisition.failedRoles.length)
    return stop("source_acquisition_incomplete", "skip", "source");
  if (!A.isHash(input.routeIdentity) || !A.isHash(input.expectedRouteIdentity) || input.routeIdentity !== input.expectedRouteIdentity)
    return stop("route_mismatch", "skip", "source");
  if (input.schemaFingerprint !== policy.global.schemaFingerprint) return stop("schema_mismatch");
  if (input.integrityValid !== true) return stop("db_integrity_failure");
  if (!A.integer(input.changed) || input.changed > 0) return stop("unsupported_changed", "suspended", "source");
  if (input.planValid !== true || input.revisionTransitionCount !== 0 || input.absenceAuthority !== "none")
    return stop("plan_invalid", "suspended", "source");
  return A.freeze({ writeAllowed: true, candidateEligible: true, effectiveState: "active", scope: "source",
    reason: null, shadowAllowed: true, executionAllowed: false }); // Candidate only; no executor in E4e-2a.
}
function validateSuspendTransition(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return A.freeze({ valid: false, reason: "safety_transition_invalid", mutationAllowed: false });
  const { policy = A.PRODUCTION_POLICY, previousSafety, nextSafety, signal } = input;
  const expected = reduceSafetySignal({ policy, state: previousSafety, signal });
  const valid = expected.valid && validateSafety(nextSafety, policy).valid &&
    nextSafety.validationIdentity === expected.state.validationIdentity;
  return A.freeze({ valid: !!valid, reason: valid ? null : "safety_transition_invalid", mutationAllowed: false });
}
function validateResumeTransition(input = {}) {
  const fail = () => A.freeze({ valid: false, reason: "resume_gate_required" });
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail();
  const { previousPolicy, nextPolicy, previousSafety, diagnosisReceipt,
    resumeGateIdentity, pendingFence, freshIntegrityValid, sourceId = null, reasonCode } = input;
  if (!A.validatePolicy(previousPolicy).valid || !A.validatePolicy(nextPolicy).valid ||
    !validateSafety(previousSafety, previousPolicy).valid || previousSafety.pendingFence || pendingFence !== null ||
    !A.isHash(diagnosisReceipt) || !A.isHash(resumeGateIdentity) || freshIntegrityValid !== true || reasonCode !== "explicit_resume_gate") return fail();
  const global = sourceId === null;
  if (nextPolicy.global.authorityVersion < previousPolicy.global.authorityVersion ||
    nextPolicy.permissions.permissionVersion < previousPolicy.permissions.permissionVersion ||
    !global && nextPolicy.global.state !== previousPolicy.global.state) return fail();
  if (global ? !(previousPolicy.global.state === "suspended" || previousSafety.globalSuspend.suspended) ||
      nextPolicy.global.authorityVersion <= previousPolicy.global.authorityVersion || nextPolicy.global.state !== "active" :
    !A.SOURCE_IDS.includes(sourceId) || sourceId === A.BOJ ||
      !(previousPolicy.permissions.entries.find(e => e.sourceId === sourceId).permission === "suspended" ||
        previousSafety.sources.find(e => e.sourceId === sourceId).suspended) ||
      previousSafety.globalSuspend.suspended || nextPolicy.permissions.permissionVersion <= previousPolicy.permissions.permissionVersion ||
      nextPolicy.permissions.entries.find(e => e.sourceId === sourceId).permission !== "approved") return fail();
  if (nextPolicy.global.permittedSources.some(id => !previousPolicy.global.permittedSources.includes(id)) ||
    nextPolicy.permissions.entries.some(e => e.sourceId !== sourceId &&
      e.permission !== previousPolicy.permissions.entries.find(old => old.sourceId === e.sourceId).permission)) return fail();
  return A.freeze({ valid: true, reason: null, mutationAllowed: false, auditMaterial: {
    previousAuthorityVersion: previousPolicy.global.authorityVersion, nextAuthorityVersion: nextPolicy.global.authorityVersion,
    previousPermissionVersion: previousPolicy.permissions.permissionVersion, nextPermissionVersion: nextPolicy.permissions.permissionVersion,
    reasonCode, diagnosisReceipt, resumeGateIdentity, sourceId,
    approvedSourceSet: nextPolicy.permissions.entries.filter(e => e.permission === "approved" &&
      (!previousSafety.sources.find(s => s.sourceId === e.sourceId).suspended || e.sourceId === sourceId)).map(e => e.sourceId),
    suspendedSourceSet: nextPolicy.permissions.entries.filter(e => e.permission === "suspended" ||
      previousSafety.sources.find(s => s.sourceId === e.sourceId).suspended && e.sourceId !== sourceId).map(e => e.sourceId) } });
}
module.exports = Object.freeze({ CATEGORIES, THRESHOLD, createMemorySafety, sealSafetyMaterial,
  validateSafety, classifyFailure, reduceSafetySignal, evaluate, validateSuspendTransition, validateResumeTransition });
