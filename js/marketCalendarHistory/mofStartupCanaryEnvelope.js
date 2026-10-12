"use strict";

// Additive contract. Historical Envelope3, authority3 and permission2 are immutable.
const A = require("./formalWriterAuthorityV2.js"), Old = require("./writerSafetySourceSetEnvelope.js");
const File = require("./writerSafetyFileSchema.js"), Historical = require("./writerSafetyVersionedEnvelope.js");
const VERSION = 4, SOURCE = "jp-mof-jgb-auction-calendar", OPERATION = "startup-canary-new-only";
const PHASES = Object.freeze(["prepared", "formal_write_started", "commit_observed", "readback_verified", "completed"]);
const COUNTS = A.freeze({ eventEntryCreate: 1, eventEntryUpdate: 0, semanticRevisionCreate: 1,
  semanticRevisionClose: 0, evidenceCreate: 1, observationCreate: 1, sourceRunCreate: 1, sourceCursorUpdate: 1 });
const material = { contractVersion: 1, authorityVersion: 1, sourceId: SOURCE, operation: OPERATION,
  trigger: "startup", mutationClass: "new-only", maxNewEvents: 1, maxAttempts: 1, manual: false, general: false,
  absenceAuthority: "none", counts: COUNTS };
const AUTHORITY = A.freeze({ ...material, identity: A.hash(material) });
const BINDING_FIELDS = Object.freeze(["sourceId", "operation", "attemptIdentity", "cycleIdentity", "authorizationIdentity",
  "envelopeVersion", "canaryAuthorityIdentity", "safetySequence", "safetyIdentity", "candidateIdentity", "runtimeIdentity",
  "semanticPlanIdentity", "acquisitionIdentity", "comparisonIdentity", "formalPrecondition", "planIdentity", "expectedFormalIdentity", "counts"]);
const same = (a, b) => A.hash(a) === A.hash(b);
const fail = reason => { throw Error(reason); };
function sealSafety(s) { const { validationIdentity: _, ...m } = structuredClone(s); return { ...m, validationIdentity: A.hash(m) }; }
function activate(historicalRecord, gateIdentity) {
  if (!Old.validate(historicalRecord).valid || historicalRecord.schemaVersion !== 3 ||
      historicalRecord.controlledLifecycleAudit?.at(-1)?.phase !== "completed" || historicalRecord.safety.pendingFence ||
      historicalRecord.safety.globalSuspend.suspended || historicalRecord.safety.sources.some(s => s.suspended) ||
      historicalRecord.safety.persistedAuthorityVersion !== 3 || !A.isHash(gateIdentity)) fail("canary_activation_precondition_invalid");
  const old = historicalRecord.safety;
  if (historicalRecord.historicalRecord.legacyRecord.transitionAudit.length + historicalRecord.historicalRecord.transitionAudit.length +
      historicalRecord.sourceSetAudit.length + historicalRecord.controlledLifecycleAudit.length + 1 + PHASES.length > File.MAX_AUDIT)
    fail("canary_audit_capacity_reached");
  const activation = { gateIdentity, reason: "explicit_isolated_mof_startup_canary", previousChecksum: historicalRecord.checksum,
    previousSequence: old.sequence, nextSequence: old.sequence + 1, canaryAuthorityIdentity: AUTHORITY.identity };
  return File.seal({ schemaVersion: VERSION, historicalRecord: structuredClone(historicalRecord),
    canaryAuthority: AUTHORITY, activationAudit: { ...activation, identity: A.hash(activation) },
    safety: sealSafety({ ...old, safetyEnvelopeVersion: VERSION, sequence: old.sequence + 1 }), lifecycleAudit: [] });
}
function assertBinding(b, current) {
  if (!A.exact(b, BINDING_FIELDS) || b.sourceId !== SOURCE || b.operation !== OPERATION || b.envelopeVersion !== VERSION ||
      b.canaryAuthorityIdentity !== AUTHORITY.identity || b.safetySequence !== current.safety.sequence ||
      b.safetyIdentity !== current.safety.validationIdentity || !same(b.counts, COUNTS) ||
      BINDING_FIELDS.filter(k => !["sourceId", "operation", "envelopeVersion", "safetySequence", "counts"].includes(k))
        .some(k => !A.isHash(b[k]))) fail("canary_binding_invalid");
}
function assertProof(phase, proof, binding) {
  if (["prepared", "formal_write_started"].includes(phase)) { if (proof !== null) fail("canary_proof_unexpected"); return; }
  const common = ["sourceId", "operation", "attemptIdentity", "authorizationIdentity", "planIdentity", "counts"];
  const extra = phase === "commit_observed" ? ["readwrite", "commit", "abort"] :
    ["freshReadonlyReopen", "integrity", "otherSourcesUnchanged", "actualFormalIdentity"];
  if (!A.exact(proof, [...common, ...extra]) || common.some(k => !same(proof[k], binding[k]))) fail("canary_proof_binding_invalid");
  if (phase === "commit_observed" ? proof.readwrite !== 1 || proof.commit !== 1 || proof.abort !== 0 :
      proof.freshReadonlyReopen !== true || proof.integrity !== true || proof.otherSourcesUnchanged !== true ||
      proof.actualFormalIdentity !== binding.expectedFormalIdentity) fail("canary_proof_incomplete");
}
function replay(base, audit) {
  if (!Array.isArray(audit) || audit.length > PHASES.length) fail("canary_lifecycle_invalid");
  let current = base;
  for (const [i, entry] of audit.entries()) {
    if (!A.exact(entry, ["phase", "previousSequence", "nextSequence", "previousIdentity", "binding", "proof", "identity"]) ||
        entry.phase !== PHASES[i] || entry.previousSequence !== current.safety.sequence || entry.nextSequence !== entry.previousSequence + 1 ||
        entry.previousIdentity !== (i ? audit[i - 1].identity : base.activationAudit.identity)) fail("canary_lifecycle_chain_invalid");
    const { identity, ...m } = entry; if (!same(identity, A.hash(m))) fail("canary_lifecycle_identity_invalid");
    if (!i) assertBinding(entry.binding, base); else if (!same(entry.binding, audit[0].binding)) fail("canary_binding_changed");
    assertProof(entry.phase, entry.proof, entry.binding);
    if (entry.phase === "completed" && !same(entry.proof, audit[i - 1].proof)) fail("canary_completion_proof_invalid");
    current = File.seal({ ...base, safety: sealSafety({ ...base.safety, sequence: entry.nextSequence,
      pendingFence: entry.phase === "completed" ? null : { phase: entry.phase, binding: entry.binding } }), lifecycleAudit: audit.slice(0, i + 1) });
  }
  return current;
}
function validate(record) {
  try {
    if (!A.exact(record, ["schemaVersion", "historicalRecord", "canaryAuthority", "activationAudit", "safety", "lifecycleAudit", "checksum"]) ||
        record.schemaVersion !== VERSION || !same(record, File.seal(record))) fail("canary_envelope_invalid");
    const base = activate(record.historicalRecord, record.activationAudit.gateIdentity);
    if (!same(record, replay(base, record.lifecycleAudit))) fail("canary_history_or_current_mismatch");
    return A.freeze({ valid: true, reason: null, historicalAuthority: Historical.policyFor(3).global,
      canaryAuthority: AUTHORITY, generalWriteAllowed: false, manualWriteAllowed: false });
  } catch (e) { return A.freeze({ valid: false, reason: e.message, generalWriteAllowed: false, manualWriteAllowed: false }); }
}
function append(current, phase, binding, proof = null) {
  if (!validate(current).valid || phase !== PHASES[current.lifecycleAudit.length]) fail("canary_phase_invalid");
  const entry = { phase, previousSequence: current.safety.sequence, nextSequence: current.safety.sequence + 1,
    previousIdentity: current.lifecycleAudit.at(-1)?.identity || current.activationAudit.identity, binding, proof };
  return replay(activate(current.historicalRecord, current.activationAudit.gateIdentity),
    [...current.lifecycleAudit, { ...entry, identity: A.hash(entry) }]);
}
module.exports = Object.freeze({ VERSION, SOURCE, OPERATION, PHASES, COUNTS, AUTHORITY, BINDING_FIELDS, activate, validate, append, assertBinding });
