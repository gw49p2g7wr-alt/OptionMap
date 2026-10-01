"use strict";

// Memory-only adapter. Never imports an executor or a writable safety factory.
const { randomUUID } = require("node:crypto");
const A = require("../marketCalendarHistory/formalWriterAuthorityV2.js");
const S = require("../marketCalendarHistory/formalWriterSafetyEvaluator.js");
const contexts = new WeakMap();
function createStartupContext() {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
  const token = Object.freeze(Object.create(null)); contexts.set(token, false); return token;
}
async function begin(load, token) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
  const started = performance.now(), cycleIdentity = A.hash({ cycle: randomUUID() });
  const trusted = contexts.has(token) && !contexts.get(token);
  if (trusted) contexts.set(token, true);
  const operation = trusted ? "startup" : "manual";
  const context = A.createMainContextCandidate({ operation, cycleIdentity, attemptIdentity: A.hash({ attempt: randomUUID() }) });
  let snapshot;
  try { snapshot = await load(); } catch (_) { snapshot = { status: "corrupt", reason: "safety_read_failed", safety: null }; }
  if (!snapshot || snapshot.status !== "valid" || !S.validateSafety(snapshot.safety).valid) {
    snapshot = { ...snapshot, status: snapshot?.status === "missing" ? "missing" : "corrupt",
      reason: snapshot?.reason || "malformed_safety_state", safety: null };
  }
  const loadMs = performance.now() - started, evaluatedAt = performance.now();
  const permissions = A.SOURCE_IDS.map(sourceId => ({ sourceId,
    codePermission: A.PRODUCTION_POLICY.permissions.entries.find(e => e.sourceId === sourceId).permission,
    evaluation: S.evaluate({ sourceId, safety: snapshot.safety, operation, context, cycleIdentity }) }));
  return A.freeze({ snapshot: structuredClone(snapshot), cycleIdentity, operation, context, permissions,
    trustedStartup: trusted, loadMs, initialEvaluationMs: performance.now() - evaluatedAt });
}
function failureReason(row) {
  if (row.changed > 0) return "unsupported_changed";
  const map = { source_partial: "partial", source_failure: "acquisition_failure", route_identity_mismatch: "route_mismatch",
    source_stale_precondition: "stale_precondition", formal_integrity_invalid: "db_integrity_failure" };
  return map[row.reason] || null;
}
function finish(cycle, shadow, diagnostics = []) {
  const start = performance.now(), p = A.PRODUCTION_POLICY, loaded = cycle.snapshot;
  const valid = loaded.status === "valid", state = loaded.safety;
  const rows = A.SOURCE_IDS.map(sourceId => {
    const row = shadow?.sourceRows?.find(r => r.sourceId === sourceId), d = diagnostics.find(r => r.sourceId === sourceId);
    const initial = cycle.permissions.find(e => e.sourceId === sourceId), permission = initial.codePermission;
    const own = state?.sources.find(s => s.sourceId === sourceId);
    const evaluation = initial.evaluation;
    let failure = row ? failureReason(row) : null;
    const codes = d?.diagnostics || [];
    if (codes.some(c => /security/.test(c))) failure = "source_security_rejection";
    else if (codes.some(c => /encoding|utf8/.test(c))) failure = "encoding_rejection";
    else if (d?.documentHealth?.some(h => h.fetchOutcome === "success" && h.parseOutcome !== "success")) failure = "parser_rejection";
    let classification = failure ? S.classifyFailure(failure) : null, wouldIncrement = false, wouldSuspend = false;
    if (failure && valid && permission !== "writer_ineligible") {
      const category = classification.category;
      const ordinal = Math.max(0, ...Object.values(own.counters).map(c => c.cycleOrdinal)) + 1;
      const result = S.reduceSafetySignal({ state, signal: { sourceId, category, outcome: "failure", reason: failure,
        cycleOrdinal: ordinal, cycleIdentity: cycle.cycleIdentity } });
      wouldIncrement = result.valid && category !== null && result.state.sources.find(s => s.sourceId === sourceId).counters[category].count > own.counters[category].count;
      wouldSuspend = result.valid && ["source_suspend", "global_suspend"].includes(result.action);
      classification = { ...classification, action: result.action, reason: result.reason };
    }
    return { sourceId, acquisition: row?.acquisition || "not_attempted", shadowEligibility: row?.eligible === true,
      comparison: row ? { unchanged: row.unchanged, changed: row.changed, new: row.new, notEvaluated: row.notEvaluated } : null,
      plannedCounts: row?.counts || null, codePermission: permission, persistentState: loaded.status,
      suspended: own?.suspended ?? null, counters: own?.counters || null, pendingFence: !!state?.pendingFence,
      writeAllowed: false, eligibilityCandidate: false,
      reason: permission === "writer_ineligible" ? "writer_ineligible_identity_transition" :
        !valid ? loaded.reason : state.globalSuspend.suspended ? state.globalSuspend.reason :
        state.pendingFence ? "interrupted_pending_fence" : own.suspended ? "source_suspended" :
        failure || (cycle.operation === "manual" ? "manual_writer_disabled" : evaluation.reason),
      classification, wouldIncrement, wouldSuspend, persistentWrites: 0 };
  });
  // Dispose even disabled candidates: startup provenance is cycle-local, never replayable.
  A.issueContext(cycle.context); A.consumeContext(cycle.context);
  return A.freeze({ authorityVersion: p.global.authorityVersion, authorityState: p.global.state,
    safetySequence: state?.sequence ?? null, storeStatus: loaded.status, storeReason: loaded.reason || null,
    globalSafety: !valid || state.globalSuspend.suspended || state.pendingFence || shadow?.status === "unsafe" ? "unsafe" : "safe",
    effectiveState: !valid || state.globalSuspend.suspended || state.pendingFence ? "suspended" : "disabled",
    globalSuspend: state?.globalSuspend || null, pendingFence: state?.pendingFence || null,
    globalClassification: shadow?.status === "unsafe" ? S.classifyFailure("db_integrity_failure") :
      !valid ? S.classifyFailure(loaded.status === "missing" ? "safety_state_missing" : "malformed_safety_state") : null,
    approvedSourceCount: rows.filter(r => r.codePermission === "approved").length,
    suspendedSourceCount: rows.filter(r => r.suspended).length, writerIneligibleCount: rows.filter(r => r.codePermission === "writer_ineligible").length,
    eligibleCandidateCount: 0, actualWriteExecutionCount: 0, persistentWrites: 0, sourceRows: rows,
    trustedStartup: cycle.trustedStartup, operation: cycle.operation, safetyLoadMs: cycle.loadMs,
    evaluationMs: cycle.initialEvaluationMs + performance.now() - start, storeAudit: loaded.audit || null });
}
module.exports = Object.freeze({ createStartupContext, begin, finish });
