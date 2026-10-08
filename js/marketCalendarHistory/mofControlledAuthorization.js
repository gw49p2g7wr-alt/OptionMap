"use strict";

// Separate main-owned capability, not a permission exception or persistent approval.
const { randomUUID } = require("node:crypto");
const A = require("./formalWriterAuthorityV2.js"), E = require("./writerSafetySourceSetEnvelope.js");
const P = require("./writerSafetySourceSetPermission.js"), Semantic = require("./mofControlledSemanticPlan.js");
const Lifecycle = require("./writerSafetyControlledLifecycle.js");
const tokens = new WeakMap();
function createControlledAuthorization({ record, preparation, sourceId = Semantic.SOURCE, operation = Semantic.OPERATION }) {
  if (process.type === "renderer" || typeof window !== "undefined" && window.document) throw Error("main_side_only");
  if (!E.validate(record).valid || record.schemaVersion !== 3 || record.controlledLifecycleAudit || record.safety.pendingFence ||
    record.safety.globalSuspend.suspended || record.safety.sources.some(s => s.suspended) ||
    record.safety.persistedAuthorityVersion !== 3 || sourceId !== Semantic.SOURCE || operation !== Semantic.OPERATION ||
    P.PERMISSIONS.entries.find(s => s.sourceId === sourceId)?.permission !== "not_approved")
    throw Error("controlled_authority_unavailable");
  Lifecycle.assertCapacity(record); // Reserve all five append-only transitions before any Formal write.
  const prepared = Semantic.inspect(preparation), nonce = randomUUID();
  const material = { sourceId, operation, attemptIdentity: prepared.attemptIdentity, envelopeVersion: 3, sourceSetVersion: 2,
    permissionVersion: 2, authorityVersion: 3, safetySequence: record.safety.sequence, safetyIdentity: record.safety.validationIdentity,
    semanticPlanIdentity: prepared.semanticPlanIdentity, acquisitionIdentity: prepared.acquisitionIdentity,
    documentSetIdentity: prepared.documentSetIdentity, documentObservationIdentity: prepared.documentObservationIdentity,
    evidenceIdentities: prepared.evidenceIdentities, comparisonIdentity: prepared.comparisonIdentity,
    formalPrecondition: prepared.formalPrecondition, planIdentity: prepared.planIdentity,
    expectedFormalIdentity: A.hash(prepared.expected), counts: Semantic.COUNTS };
  const binding = A.freeze({ ...material, authorizationIdentity: A.hash({ material, nonce }) });
  const token = Object.freeze({}); tokens.set(token, { binding, preparation }); return token;
}
function consume(token, { record, preparation, sourceId, operation }) {
  const item = tokens.get(token); tokens.delete(token); // Failures spend the capability too.
  if (!item) throw Error("controlled_authorization_spent_or_unknown");
  const p = Semantic.inspect(preparation), b = item.binding;
  if (item.preparation !== preparation || sourceId !== b.sourceId || operation !== b.operation || !E.validate(record).valid ||
    record.schemaVersion !== b.envelopeVersion || record.safety.sourceSetVersion !== b.sourceSetVersion ||
    record.safety.sourcePermissionVersion !== b.permissionVersion || record.safety.persistedAuthorityVersion !== b.authorityVersion ||
    record.safety.sequence !== b.safetySequence || record.safety.validationIdentity !== b.safetyIdentity ||
    record.safety.pendingFence || record.controlledLifecycleAudit || record.safety.globalSuspend.suspended ||
    p.acquisitionIdentity !== b.acquisitionIdentity || p.formalPrecondition !== b.formalPrecondition || p.planIdentity !== b.planIdentity)
    throw Error("controlled_authorization_binding_mismatch");
  return { binding: b, ...Semantic.take(preparation) };
}
module.exports = Object.freeze({ createControlledAuthorization, consume });
