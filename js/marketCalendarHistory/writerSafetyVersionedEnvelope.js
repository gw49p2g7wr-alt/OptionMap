"use strict";

// E4f-0 isolated contract. Legacy validation and production policy remain unchanged.
const A = require("./formalWriterAuthorityV2.js"), S = require("./formalWriterSafetyEvaluator.js");
const Legacy = require("./writerSafetyFileSchema.js");
const SOURCE = "jp-esri-machinery-orders-calendar", VERSION = 2;
// Historical validation must not follow a later production-default authority.
const LEGACY_POLICY = A.createIsolatedPolicy({ targetEnvironment: "isolated_test", state: "disabled",
  authorityVersion: 2, permissionVersion: 1, permittedSources: [SOURCE] });
// Hypothetical fixed ceiling only, not a production activation configuration.
const CANARY_CANDIDATE = A.createIsolatedPolicy({ targetEnvironment: "isolated_test", state: "active",
  authorityVersion: 3, permissionVersion: 1, permittedSources: [SOURCE] });
const PHASES = Object.freeze(["prepared", "formal_write_started", "commit_observed", "readback_verified"]);
const COUNTS = A.freeze({ eventEntryCreate: 0, eventEntryUpdate: 4, semanticRevisionCreate: 0,
  semanticRevisionClose: 0, evidenceCreate: 4, observationCreate: 4, sourceRunCreate: 1, sourceCursorUpdate: 1 });
const SAME = (a, b) => A.hash(a) === A.hash(b);
const fail = reason => { throw Error(reason); };
function policyFor(version) {
  if (version === 2) return LEGACY_POLICY;
  if (version === 3) return CANARY_CANDIDATE;
  return fail("envelope_authority_unknown");
}
function sealCurrent(value) {
  const { validationIdentity: _, ...material } = structuredClone(value);
  return A.freeze({ ...material, validationIdentity: A.hash(material) });
}
function safetyInput(current) {
  const { safetyEnvelopeVersion: _, validationIdentity: __, ...material } = structuredClone(current);
  if (material.pendingFence) {
    const f = material.pendingFence;
    material.pendingFence = { sourceId: f.sourceId, attemptIdentity: f.attemptIdentity, cycleIdentity: f.cycleIdentity,
      phase: f.phase === "prepared" ? "prepared" : f.phase === "formal_write_started" ? "transaction_started" : "committed_unverified" };
  }
  return S.sealSafetyMaterial(material);
}
function validCurrent(current) {
  if (!A.exact(current, ["safetyEnvelopeVersion", "safetyContractVersion", "persistedAuthorityVersion",
    "persistedAuthorityIdentity", "sourcePermissionVersion", "sourcePermissionIdentity", "sequence", "globalSuspend",
    "pendingFence", "sources", "validationIdentity"]) || current.safetyEnvelopeVersion !== VERSION ||
    !S.validateSafety(safetyInput(current), policyFor(current.persistedAuthorityVersion)).valid ||
    !SAME(current, sealCurrent(current))) fail("envelope_current_invalid");
}
function bindingValid(b, current) {
  const fields = ["bindingContractVersion", "globalAuthorityVersion", "globalAuthorityIdentity", "sourcePermissionVersion",
    "sourcePermissionIdentity", "safetySequence", "safetyIdentity", "pendingAttemptIdentity", "sourceId", "trustedOperation",
    "trustedContextIdentity", "cycleIdentity", "schemaFingerprint", "routeIdentity", "acquisitionIdentity", "candidateIdentity",
    "comparisonIdentity", "formalPrecondition", "planIdentity", "mutationCeiling", "authorizationIdentity"];
  if (!A.exact(b, fields)) fail("envelope_authorization_invalid");
  const { authorizationIdentity, ...material } = b, policy = policyFor(current.persistedAuthorityVersion);
  if (current.persistedAuthorityVersion !== 3 || b.bindingContractVersion !== 2 || b.sourceId !== SOURCE ||
    b.globalAuthorityVersion !== policy.global.authorityVersion || b.globalAuthorityIdentity !== policy.global.identity ||
    b.sourcePermissionVersion !== policy.permissions.permissionVersion || b.sourcePermissionIdentity !== policy.permissions.identity ||
    b.safetySequence !== current.sequence || b.safetyIdentity !== safetyInput(current).validationIdentity ||
    b.trustedOperation !== "startup" || b.schemaFingerprint !== policy.global.schemaFingerprint ||
    !SAME(b.mutationCeiling, COUNTS) || authorizationIdentity !== A.hash(material) ||
    ["safetyIdentity", "pendingAttemptIdentity", "trustedContextIdentity", "cycleIdentity", "routeIdentity", "acquisitionIdentity",
      "candidateIdentity", "comparisonIdentity", "formalPrecondition", "planIdentity", "authorizationIdentity"].some(k => !A.isHash(b[k])))
    fail("envelope_authorization_invalid");
}
function proofValid(proof, fence, readback) {
  const keys = ["kind", "sourceId", "attemptIdentity", "authorizationIdentity", "committed", "mutationCounts"];
  if (readback) keys.push("freshReadonly", "integrityValid", "otherSourcesUnchanged", "expectedIdentity", "observedIdentity");
  if (!A.exact(proof, keys) || proof.kind !== (readback ? "readback" : "commit") || proof.sourceId !== SOURCE ||
    proof.attemptIdentity !== fence.attemptIdentity || proof.authorizationIdentity !== fence.authorizationIdentity ||
    proof.committed !== true || !SAME(proof.mutationCounts, COUNTS) || readback &&
    (proof.freshReadonly !== true || proof.integrityValid !== true || proof.otherSourcesUnchanged !== true ||
      !A.isHash(proof.expectedIdentity) || proof.expectedIdentity !== proof.observedIdentity)) fail("envelope_receipt_invalid");
}
function ready(current) {
  if (current.globalSuspend.suspended || current.sources.find(s => s.sourceId === SOURCE).suspended)
    fail("envelope_writer_suspended");
}
// Pure deterministic replay of dedicated events, never an arbitrary state patch.
function applyEvent(previous, event, usedAttempts) {
  const next = structuredClone(previous); next.sequence++;
  if (!A.integer(next.sequence)) fail("envelope_sequence_invalid");
  if (event.type === "migration") {
    if (!A.exact(event, ["type", "legacyChecksum", "migrationIdentity"]) || previous.safetyEnvelopeVersion !== 2)
      fail("envelope_migration_invalid");
  } else if (event.type === "authority_transition") {
    if (!A.exact(event, ["type", "expectedAuthorityVersion", "nextAuthorityVersion", "approvedSourceCeiling", "suspendedSourceSet"]) ||
      event.expectedAuthorityVersion !== previous.persistedAuthorityVersion || previous.persistedAuthorityVersion !== 2 ||
      event.nextAuthorityVersion !== 3 || !SAME(event.approvedSourceCeiling, [SOURCE]) ||
      !SAME(event.suspendedSourceSet, previous.sources.filter(s => s.suspended).map(s => s.sourceId).sort()) || previous.pendingFence)
      fail("envelope_authority_transition_invalid");
    ready(previous);
    const p = policyFor(3);
    next.persistedAuthorityVersion = 3; next.persistedAuthorityIdentity = p.global.identity;
    next.sourcePermissionVersion = p.permissions.permissionVersion; next.sourcePermissionIdentity = p.permissions.identity;
  } else if (event.type === "fence_created") {
    if (!A.exact(event, ["type", "binding"]) || previous.pendingFence) fail("envelope_fence_create_invalid");
    ready(previous); bindingValid(event.binding, previous);
    const b = event.binding;
    if (usedAttempts.has(b.pendingAttemptIdentity)) fail("envelope_attempt_replayed");
    usedAttempts.add(b.pendingAttemptIdentity);
    next.pendingFence = { attemptIdentity: b.pendingAttemptIdentity, cycleIdentity: b.cycleIdentity, sourceId: SOURCE,
      authorityVersion: b.globalAuthorityVersion, sourcePermissionVersion: b.sourcePermissionVersion,
      safetySequence: next.sequence, authorizationIdentity: b.authorizationIdentity, operation: "startup", phase: "prepared" };
  } else if (event.type === "fence_advanced") {
    if (!A.exact(event, ["type", "attemptIdentity", "authorizationIdentity", "phase", "proof"])) fail("envelope_fence_phase_invalid");
    ready(previous); const f = previous.pendingFence;
    if (!f || f.attemptIdentity !== event.attemptIdentity || f.authorizationIdentity !== event.authorizationIdentity ||
      PHASES.indexOf(event.phase) !== PHASES.indexOf(f.phase) + 1) fail("envelope_fence_phase_invalid");
    if (event.phase === "formal_write_started") {
      if (event.proof !== null) fail("envelope_receipt_invalid");
    } else proofValid(event.proof, f, event.phase === "readback_verified");
    next.pendingFence.phase = event.phase;
  } else if (event.type === "fence_completed") {
    if (!A.exact(event, ["type", "attemptIdentity", "authorizationIdentity", "proof"])) fail("envelope_completion_invalid");
    ready(previous); const f = previous.pendingFence;
    if (!f || f.phase !== "readback_verified" || event.attemptIdentity !== f.attemptIdentity ||
      event.authorizationIdentity !== f.authorizationIdentity) fail("envelope_completion_invalid");
    proofValid(event.proof, f, true); next.pendingFence = null;
  } else fail("envelope_event_unknown");
  return sealCurrent(next);
}
function row(previous, next, event, reasonCode, gateIdentity, previousAuditIdentity) {
  const material = { previousAuthorityVersion: previous.persistedAuthorityVersion, nextAuthorityVersion: next.persistedAuthorityVersion,
    previousPermissionVersion: previous.sourcePermissionVersion, nextPermissionVersion: next.sourcePermissionVersion,
    previousSafetySequence: previous.sequence, nextSafetySequence: next.sequence, reasonCode,
    activatedSources: event.type === "authority_transition" ? [SOURCE] : [],
    suspendedSources: next.sources.filter(s => s.suspended).map(s => s.sourceId).sort(), gateIdentity,
    previousAuditIdentity, event: structuredClone(event) };
  return A.freeze({ ...material, auditIdentity: A.hash(material) });
}
const REASONS = Object.freeze({ migration: "explicit_envelope_migration", authority_transition: "machinery_startup_canary_gate",
  fence_created: "authorization_bound_pending", fence_advanced: "pending_phase_advanced", fence_completed: "verified_fence_completion" });
function legacyBase(record) {
  if (!Legacy.validate(record, LEGACY_POLICY).valid || record.safety.pendingFence) fail("legacy_migration_unavailable");
  return sealCurrent({ ...structuredClone(record.safety), safetyEnvelopeVersion: VERSION });
}
function append(record, event, gateIdentity) {
  const checked = validateEnvelope(record);
  if (!checked.valid || checked.kind !== "versioned") fail(checked.reason || "envelope_version_required");
  if (record.legacyRecord.transitionAudit.length + record.transitionAudit.length >= Legacy.MAX_AUDIT)
    fail("safety_audit_capacity_reached");
  if (!A.isHash(gateIdentity) || event.type === "migration") fail("envelope_gate_invalid");
  const used = new Set(record.transitionAudit.filter(r => r.event.type === "fence_created").map(r => r.event.binding.pendingAttemptIdentity));
  const next = applyEvent(record.safety, event, used);
  const result = Legacy.seal({ ...structuredClone(record), safety: next, transitionAudit: [...record.transitionAudit,
    row(record.safety, next, event, REASONS[event.type], gateIdentity, record.transitionAudit.at(-1).auditIdentity)] });
  if (!validateEnvelope(result).valid) fail("envelope_transition_invalid");
  return result;
}
function migrate(record, gateIdentity) {
  if (!A.isHash(gateIdentity)) fail("envelope_gate_invalid");
  const previous = legacyBase(record);
  if (record.transitionAudit.length >= Legacy.MAX_AUDIT) fail("safety_audit_capacity_reached");
  const migrationIdentity = A.hash({ previousSchemaVersion: 1, nextSchemaVersion: 2, legacyChecksum: record.checksum,
    previousSafetySequence: previous.sequence, nextSafetySequence: previous.sequence + 1, gateIdentity });
  const event = { type: "migration", legacyChecksum: record.checksum, migrationIdentity };
  return Legacy.seal({ schemaVersion: VERSION, safety: applyEvent(previous, event, new Set()), legacyRecord: structuredClone(record),
    migrationIdentity, transitionAudit: [row(previous, applyEvent(previous, event, new Set()), event,
      REASONS.migration, gateIdentity, record.transitionAudit.at(-1).auditIdentity)] });
}
function validateEnvelope(record) {
  try {
    if (record?.schemaVersion === 1) {
      const checked = Legacy.validate(record, LEGACY_POLICY);
      return A.freeze({ ...checked, kind: "legacy", migrationRequired: checked.valid, writeAllowed: false });
    }
    if (!A.exact(record, ["schemaVersion", "safety", "legacyRecord", "migrationIdentity", "transitionAudit", "checksum"]) ||
      record.schemaVersion !== VERSION || !SAME(record, Legacy.seal(record))) fail("envelope_shape_or_checksum_invalid");
    validCurrent(record.safety);
    let current = legacyBase(record.legacyRecord), previousIdentity = record.legacyRecord.transitionAudit.at(-1).auditIdentity;
    const rows = record.transitionAudit, used = new Set();
    if (!Array.isArray(rows) || !rows.length || rows.length + record.legacyRecord.transitionAudit.length > Legacy.MAX_AUDIT)
      fail("envelope_audit_capacity_or_shape_invalid");
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!A.isHash(r.gateIdentity) || (i === 0) !== (r.event.type === "migration")) fail("envelope_chain_invalid");
      if (i === 0) {
        const m = A.hash({ previousSchemaVersion: 1, nextSchemaVersion: 2, legacyChecksum: record.legacyRecord.checksum,
          previousSafetySequence: current.sequence, nextSafetySequence: current.sequence + 1, gateIdentity: r.gateIdentity });
        if (record.migrationIdentity !== m || r.event.migrationIdentity !== m || r.event.legacyChecksum !== record.legacyRecord.checksum)
          fail("envelope_migration_invalid");
      }
      if (r.event.type === "fence_completed" && (rows[i - 1]?.event.type !== "fence_advanced" ||
        rows[i - 1].event.phase !== "readback_verified" || !SAME(rows[i - 1].event.proof, r.event.proof)))
        fail("envelope_completion_invalid");
      const next = applyEvent(current, r.event, used);
      if (!SAME(r, row(current, next, r.event, REASONS[r.event.type], r.gateIdentity, previousIdentity))) fail("envelope_chain_invalid");
      current = next; previousIdentity = r.auditIdentity;
    }
    if (!SAME(current, record.safety)) fail("envelope_current_chain_mismatch");
    return A.freeze({ valid: true, reason: null, kind: "versioned", migrationRequired: false, writeAllowed: false });
  } catch (e) { return A.freeze({ valid: false, reason: /^[a-z_]+$/.test(e.message) ? e.message : "envelope_invalid", writeAllowed: false }); }
}
module.exports = Object.freeze({ VERSION, SOURCE, PHASES, COUNTS, CANARY_CANDIDATE, policyFor, safetyInput,
  validateEnvelope, migrate, append, proofValid });
