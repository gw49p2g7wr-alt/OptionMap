"use strict";

// Verify underlying receipts/history; never manufacture authorization or completion.
const A = require("../marketCalendarHistory/formalWriterAuthorityV2.js");
const E = require("../marketCalendarHistory/writerSafetyVersionedEnvelope.js");
const Bootstrap = require("../marketCalendarHistory/bootstrapSchemaV1.js");
const same = (a, b) => A.hash(a) === A.hash(b);
const COUNTS = A.freeze({ entries: 4, revisions: 0, evidence: 4, observations: 4, runs: 1, cursors: 1 });
const STAGES = Object.freeze(["pending_prepared", "formal_write_started", "commit_observed", "readback_verified", "completion"]);
function validate({ before, after, runtime, storageAudits }) {
  try {
    if (!before?.available || !after?.available || !E.validateEnvelope(before.record).valid ||
        !E.validateEnvelope(after.record).valid || !A.isHash(before.contentHash) || !A.isHash(after.contentHash)) throw Error("receipt_safety_invalid");
    if (!Array.isArray(storageAudits) || storageAudits.length !== 3 || storageAudits.some(a =>
      !a || a.create !== 0 || a.upgrade !== 0 || a.marketWrites !== 0 || a.localStorageWrites !== 0 ||
      a.handles !== 0 || a.pending !== 0 || a.listeners !== 0 || !A.integer(a.opens) || !A.integer(a.readonly) ||
      !A.integer(a.readwrite) || !A.integer(a.formalWrites) ||
      !A.exact(a.perStore, Bootstrap.STORE_ORDER.map(([, name]) => name)) || Object.values(a.perStore).some(n => !A.integer(n))))
      throw Error("receipt_storage_audit_incomplete");
    const b = before.record, f = after.record, audit = runtime?.safetyAudit;
    if (!audit || audit.fileHandles !== 0 || audit.lockHandles !== 0 || audit.closed !== true || audit.busy !== false ||
        !Array.isArray(audit.states)) throw Error("receipt_cleanup_incomplete");
    const sources = runtime.acquisition?.sources;
    if (!Array.isArray(sources) || sources.length !== 12 || !same(sources.map(s => s.sourceId).sort(), A.SOURCE_IDS))
      throw Error("receipt_acquisition_incomplete");
    const own = sources.find(s => s.sourceId === E.SOURCE);
    if (runtime.status === "hold") {
      if (runtime.reason !== "same_day_skip" || own.planningDecision !== "skip" || own.planningReason !== "already_succeeded_today" ||
          own.acquisitionStatus !== "not_attempted" || runtime.writerExecution !== 0 || runtime.execution ||
          !same(b, f) || before.contentHash !== after.contentHash || audit.states.length !== 0 || audit.attempted !== false ||
          storageAudits.some(a => a.readwrite !== 0 || a.formalWrites !== 0)) throw Error("hold_receipt_mismatch");
      return A.freeze({ valid: true, status: "HOLD", reason: "already_succeeded_today", sourceId: E.SOURCE,
        authorizationCount: 0, fenceCount: 0, completionCount: 0, finalSequence: f.safety.sequence, formalWrite: 0 });
    }
    if (runtime.status !== "pass" || runtime.reason !== null || sources.some(s => s.status !== "success") ||
        own.planningDecision !== "update") throw Error(runtime.reason || "runtime_canary_failed");
    if (runtime.writerExecution !== 1 || runtime.execution?.saved !== true || runtime.execution.pendingCleared !== true ||
        runtime.execution.finalSequence !== b.safety.sequence + 5 || f.safety.sequence !== b.safety.sequence + 5 ||
        f.safety.pendingFence !== null || f.safety.persistedAuthorityVersion !== 3 || f.safety.globalSuspend.suspended ||
        f.safety.sources.some(s => s.suspended) || !same(b.legacyRecord, f.legacyRecord) ||
        !same(b.transitionAudit, f.transitionAudit.slice(0, b.transitionAudit.length))) throw Error("receipt_completion_mismatch");
    const rows = f.transitionAudit.slice(b.transitionAudit.length);
    if (rows.length !== 5 || rows[0].event.type !== "fence_created" || rows[4].event.type !== "fence_completed" ||
        rows.slice(1, 4).some((r, i) => r.event.type !== "fence_advanced" || r.event.phase !== STAGES[i + 1]))
      throw Error("receipt_fence_lifecycle_mismatch");
    const binding = rows[0].event.binding, proof = rows[4].event.proof;
    if (binding.sourceId !== E.SOURCE || binding.trustedOperation !== "startup" || binding.globalAuthorityVersion !== 3 ||
        binding.safetySequence !== b.safety.sequence || binding.safetyIdentity !== E.safetyInput(b.safety).validationIdentity ||
        binding.trustedContextIdentity !== A.hash({ operation: "startup", cycleIdentity: binding.cycleIdentity,
          attemptIdentity: binding.pendingAttemptIdentity }) || !same(binding.mutationCeiling, E.COUNTS) ||
        rows.slice(1).some(r => r.event.attemptIdentity !== binding.pendingAttemptIdentity ||
          r.event.authorizationIdentity !== binding.authorizationIdentity)) throw Error("receipt_identity_mismatch");
    const ids = runtime.fresh?.identities, row = runtime.fresh?.row;
    if (!ids || [["acquisition", "acquisitionIdentity"], ["candidate", "candidateIdentity"], ["comparison", "comparisonIdentity"],
      ["plan", "planIdentity"], ["precondition", "formalPrecondition"]].some(([a, c]) => !A.isHash(ids[a]) || ids[a] !== binding[c]) ||
      !row?.eligible || row.sourceId !== E.SOURCE || row.candidate !== 4 || row.formalActive !== 4 || row.unchanged !== 4 ||
      row.changed !== 0 || row.new !== 0 || row.evidenceOnly !== 0 || row.notEvaluated !== 0) throw Error("receipt_fresh_identity_mismatch");
    const result = runtime.execution.result, a = result?.audit;
    if (result?.status !== "verified" || result.committed !== true || !a || a.readwrite !== 1 || a.committed !== 1 ||
        a.aborted !== 0 || a.create !== 0 || a.upgrade !== 0 || a.delete !== 0 || a.openHandles !== 0 ||
        a.readbackReopens !== 1 || !same(a.committedWrites, COUNTS) || !same(a.attemptedWrites, COUNTS) ||
        result.verification?.valid !== true || !A.isHash(result.verification.expectedIdentity) ||
        result.verification.expectedIdentity !== result.verification.observedIdentity ||
        proof.expectedIdentity !== result.verification.expectedIdentity || proof.observedIdentity !== result.verification.observedIdentity)
      throw Error("receipt_mutation_or_readback_mismatch");
    if (audit.states.length !== 5 || audit.states.some((s, i) => s.stage !== STAGES[i] || s.sequence !== b.safety.sequence + i + 1 ||
        s.authorityVersion !== 3 || !A.isHash(s.contentHash) || !Number.isFinite(s.persistMs) || s.persistMs < 0) ||
        audit.states.at(-1).contentHash !== after.contentHash || audit.attempted !== true ||
        storageAudits.reduce((n, a) => n + a.readwrite, 0) !== 1 ||
        storageAudits.reduce((n, a) => n + a.formalWrites, 0) !== 14) throw Error("receipt_audit_mismatch");
    if (Bootstrap.STORE_ORDER.some(([field, name]) => storageAudits.reduce((n, a) => n + a.perStore[name], 0) !== COUNTS[field]) ||
        [runtime.timings?.safetyLoadMs, runtime.timings?.acquisitionMs, runtime.timings?.formalReadMs, runtime.timings?.planningMs,
          result.transactionMs, result.readbackMs, after.latencyMs].some(n => !Number.isFinite(n) || n < 0))
      throw Error("receipt_store_counts_or_latency_mismatch");
    return A.freeze({ valid: true, status: "PASS", reason: null, sourceId: binding.sourceId,
      cycleIdentity: binding.cycleIdentity, attemptIdentity: binding.pendingAttemptIdentity,
      authorizationIdentity: binding.authorizationIdentity, authorizationCount: 1, fenceCount: 1, completionCount: 1,
      initialSequence: b.safety.sequence, finalSequence: f.safety.sequence, mutationCounts: COUNTS, freshReadonlyReadback: true });
  } catch (e) { return A.freeze({ valid: false, status: "FAIL", reason: /^[a-z_]+$/.test(e.message) ? e.message : "receipt_invalid" }); }
}
module.exports = Object.freeze({ COUNTS, validate });
