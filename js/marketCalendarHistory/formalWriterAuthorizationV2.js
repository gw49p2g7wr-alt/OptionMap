"use strict";

// Future binding candidates only: no transaction, storage, network or writer execution.
const A = require("./formalWriterAuthorityV2.js");
const Safety = require("./formalWriterSafetyEvaluator.js");
const authorizations = new WeakMap();
const IDENTITY_FIELDS = Object.freeze(["acquisitionIdentity", "candidateIdentity", "comparisonIdentity", "formalPrecondition", "planIdentity"]);
const CEILING_FIELDS = Object.freeze(["eventEntryCreate", "eventEntryUpdate", "semanticRevisionCreate", "semanticRevisionClose",
  "evidenceCreate", "observationCreate", "sourceRunCreate", "sourceCursorUpdate"]);
function bindingMaterial(input) {
  if (!input || typeof input !== "object") return null;
  if (!Safety.evaluate(input).writeAllowed || IDENTITY_FIELDS.some(key => !A.isHash(input[key])) ||
    !A.exact(input.mutationCeiling, CEILING_FIELDS) || Object.values(input.mutationCeiling).some(n => !A.integer(n)) ||
    input.mutationCeiling.semanticRevisionClose !== 0) return null;
  const c = A.contextDetails(input.context, input.cycleIdentity, input.operation), p = input.policy || A.PRODUCTION_POLICY;
  const material = { bindingContractVersion: 2, globalAuthorityVersion: p.global.authorityVersion,
    globalAuthorityIdentity: p.global.identity, sourcePermissionVersion: p.permissions.permissionVersion,
    sourcePermissionIdentity: p.permissions.identity, safetySequence: input.safety.sequence,
    safetyIdentity: input.safety.validationIdentity, pendingAttemptIdentity: c.attemptIdentity,
    sourceId: input.sourceId, trustedOperation: c.operation, trustedContextIdentity: c.contextIdentity,
    cycleIdentity: c.cycleIdentity, schemaFingerprint: input.schemaFingerprint, routeIdentity: input.routeIdentity,
    ...Object.fromEntries(IDENTITY_FIELDS.map(key => [key, input[key]])), mutationCeiling: structuredClone(input.mutationCeiling) };
  return A.freeze({ ...material, authorizationIdentity: A.hash(material) });
}
function issueAuthorizationCandidate(input) {
  const binding = bindingMaterial(input);
  if (!binding || !A.issueContext(input.context)) return A.freeze({ valid: false, reason: "authorization_candidate_rejected" });
  const authorization = Object.freeze(Object.create(null));
  authorizations.set(authorization, { binding, context: input.context, consumed: false });
  return Object.freeze({ valid: true, reason: null, authorization, binding, executionAllowed: false });
}
function validateAuthorizationCandidate(authorization, currentInput) {
  if (!currentInput || typeof currentInput !== "object")
    return A.freeze({ valid: false, reason: "authorization_stale_or_invalid" });
  const record = authorizations.get(authorization), fresh = bindingMaterial(currentInput);
  return A.freeze(record && !record.consumed && record.context === currentInput.context && fresh &&
    fresh.authorizationIdentity === record.binding.authorizationIdentity ? { valid: true, reason: null } :
    { valid: false, reason: "authorization_stale_or_invalid" });
}
function consumeAuthorizationCandidate(authorization, currentInput) {
  const record = authorizations.get(authorization);
  if (!validateAuthorizationCandidate(authorization, currentInput).valid) {
    if (record) { record.consumed = true; A.consumeContext(record.context); }
    return A.freeze({ valid: false, reason: "authorization_stale_or_invalid", executionAllowed: false });
  }
  record.consumed = true;
  if (!A.consumeContext(record.context)) return A.freeze({ valid: false, reason: "trusted_context_invalid", executionAllowed: false });
  return A.freeze({ valid: true, reason: null, binding: record.binding, executionAllowed: false });
}
module.exports = Object.freeze({ IDENTITY_FIELDS, CEILING_FIELDS, bindingMaterial, issueAuthorizationCandidate,
  validateAuthorizationCandidate, consumeAuthorizationCandidate });
