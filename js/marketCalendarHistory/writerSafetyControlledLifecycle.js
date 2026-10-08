"use strict";

// Pure, exact replay of the only permitted post-migration controlled operation.
// No file IO and no arbitrary safety patch. Historical migration bytes stay pinned.
const A = require("./formalWriterAuthorityV2.js"), File = require("./writerSafetyFileSchema.js");
const Semantic = require("./mofControlledSemanticPlan.js");
const PHASES = Object.freeze(["prepared", "formal_write_started", "commit_observed", "readback_verified", "completed"]);
const BINDING_FIELDS = Object.freeze(["sourceId", "operation", "authorizationIdentity", "attemptIdentity",
  "envelopeVersion", "sourceSetVersion", "permissionVersion", "authorityVersion", "safetySequence", "safetyIdentity",
  "semanticPlanIdentity", "acquisitionIdentity", "documentSetIdentity", "documentObservationIdentity", "evidenceIdentities",
  "comparisonIdentity", "formalPrecondition", "planIdentity", "expectedFormalIdentity", "counts"]);
const same = (a, b) => A.hash(a) === A.hash(b);
function assertCapacity(record) {
  if (record.historicalRecord.legacyRecord.transitionAudit.length + record.historicalRecord.transitionAudit.length +
    record.sourceSetAudit.length + PHASES.length > File.MAX_AUDIT) throw Error("controlled_audit_capacity_reached");
}
function assertBinding(binding, base) {
  if (!A.exact(binding, BINDING_FIELDS) || binding.sourceId !== Semantic.SOURCE || binding.operation !== Semantic.OPERATION ||
    binding.envelopeVersion !== 3 || binding.sourceSetVersion !== 2 || binding.permissionVersion !== 2 || binding.authorityVersion !== 3 ||
    binding.safetySequence !== base.safety.sequence || binding.safetyIdentity !== base.safety.validationIdentity ||
    binding.semanticPlanIdentity !== Semantic.SEMANTIC_IDENTITY || !same(binding.counts, Semantic.COUNTS) ||
    !Array.isArray(binding.evidenceIdentities) || binding.evidenceIdentities.length !== 16 ||
    binding.evidenceIdentities.some(v => typeof v !== "string" || !v.startsWith(`${Semantic.SOURCE}|sha256:`)) ||
    !["authorizationIdentity", "attemptIdentity", "safetyIdentity", "semanticPlanIdentity", "acquisitionIdentity",
      "documentSetIdentity", "documentObservationIdentity", "comparisonIdentity", "formalPrecondition", "planIdentity",
      "expectedFormalIdentity"].every(k => A.isHash(binding[k]))) throw Error("controlled_binding_invalid");
}
function assertProof(phase, proof, binding) {
  if (["prepared", "formal_write_started"].includes(phase)) {
    if (proof !== null) throw Error("controlled_proof_unexpected"); return;
  }
  const common = ["sourceId", "operation", "attemptIdentity", "authorizationIdentity", "planIdentity", "counts"];
  const extra = phase === "commit_observed" ? ["readwriteTransactions", "committedTransactions", "abortedTransactions"] :
    ["freshReadonlyReopen", "integrity", "otherSourcesUnchanged", "expectedFormalIdentity", "actualFormalIdentity"];
  if (!A.exact(proof, [...common, ...extra]) || common.some(k => !same(proof[k], binding[k])))
    throw Error("controlled_receipt_invalid");
  if (phase === "commit_observed") {
    if (proof.readwriteTransactions !== 1 || proof.committedTransactions !== 1 || proof.abortedTransactions !== 0)
      throw Error("controlled_commit_not_observed");
  } else if (proof.freshReadonlyReopen !== true || proof.integrity !== true || proof.otherSourcesUnchanged !== true ||
    proof.expectedFormalIdentity !== binding.expectedFormalIdentity || proof.actualFormalIdentity !== binding.expectedFormalIdentity)
    throw Error("controlled_readback_incomplete");
}
function replay(base, audit) {
  if (!Array.isArray(audit) || !audit.length || audit.length > PHASES.length ||
    base.historicalRecord.legacyRecord.transitionAudit.length + base.historicalRecord.transitionAudit.length +
      base.sourceSetAudit.length + audit.length > File.MAX_AUDIT) throw Error("controlled_audit_invalid");
  const binding = audit[0].binding; assertBinding(binding, base);
  if (base.safety.pendingFence || base.safety.globalSuspend.suspended || base.safety.sources.some(s => s.suspended))
    throw Error("controlled_safety_unavailable");
  let previousIdentity = base.sourceSetAudit[0].auditIdentity;
  for (const [i, entry] of audit.entries()) {
    if (!A.exact(entry, ["phase", "previousSequence", "nextSequence", "previousAuditIdentity", "binding", "proof", "auditIdentity"]) ||
      entry.phase !== PHASES[i] || entry.previousSequence !== base.safety.sequence + i ||
      entry.nextSequence !== entry.previousSequence + 1 || !A.integer(entry.nextSequence) ||
      entry.previousAuditIdentity !== previousIdentity || !same(entry.binding, binding)) throw Error("controlled_audit_chain_invalid");
    const { auditIdentity, ...material } = entry;
    if (A.hash(material) !== auditIdentity) throw Error("controlled_audit_identity_invalid");
    assertProof(entry.phase, entry.proof, binding); previousIdentity = auditIdentity;
  }
  if (audit.length === PHASES.length && !same(audit[3].proof, audit[4].proof)) throw Error("controlled_completion_proof_invalid");
  const { validationIdentity: _, ...safety } = structuredClone(base.safety);
  safety.sequence += audit.length;
  safety.pendingFence = audit.length === PHASES.length ? null : { phase: PHASES[audit.length - 1], binding };
  return File.seal({ ...base, safety: { ...safety, validationIdentity: A.hash(safety) }, controlledLifecycleAudit: audit });
}
function append(base, current, phase, binding, proof = null) {
  const audit = structuredClone(current.controlledLifecycleAudit || []);
  if (phase !== PHASES[audit.length]) throw Error("controlled_phase_invalid");
  const material = { phase, previousSequence: current.safety.sequence, nextSequence: current.safety.sequence + 1,
    previousAuditIdentity: audit.at(-1)?.auditIdentity || base.sourceSetAudit[0].auditIdentity, binding, proof };
  audit.push({ ...material, auditIdentity: A.hash(material) }); return replay(base, audit);
}
function validate(base, record) { try { return same(record, replay(base, record.controlledLifecycleAudit)); } catch (_) { return false; } }
module.exports = Object.freeze({ PHASES, BINDING_FIELDS, assertBinding, assertCapacity, append, validate });
