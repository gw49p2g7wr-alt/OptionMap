"use strict";

// G1.4a pure, isolated candidate contract. The historical authority is not
// reissued: its identity/ceiling stays v3/p1; this is a separate stop-only layer.
const A = require("./formalWriterAuthorityV2.js");
const S = require("./formalWriterSafetyEvaluator.js");
const Auth = require("./formalWriterAuthorizationV2.js");
const Historical = require("./writerSafetyVersionedEnvelope.js");
const MOF = "jp-mof-jgb-auction-calendar", SOURCE_SET_VERSION = 2, PERMISSION_VERSION = 2;
const HISTORICAL_IDS = A.freeze([...A.SOURCE_IDS]);
const SOURCE_IDS = A.freeze([...HISTORICAL_IDS, MOF].sort());
const material = { contractVersion: 3, sourceSetVersion: SOURCE_SET_VERSION, permissionVersion: PERMISSION_VERSION,
  entries: SOURCE_IDS.map(sourceId => ({ sourceId, permission: sourceId === MOF ? "not_approved" :
    Historical.policyFor(3).permissions.entries.find(e => e.sourceId === sourceId).permission })) };
const PERMISSIONS = A.freeze({ ...material, identity: A.hash(material) });
const tokens = new WeakMap();
function emptySource() {
  return { sourceId: MOF, suspended: false, reason: null, counters: Object.fromEntries(S.CATEGORIES.map(k =>
    [k, { count: 0, cycleOrdinal: 0, cycleIdentity: null, outcome: null }])) };
}
function evaluate(input = {}) {
  const stop = reason => A.freeze({ writeAllowed: false, executionAllowed: false, reason });
  try {
    const E = require("./writerSafetySourceSetEnvelope.js");
    if (!E.validate(input.record).valid || input.record.schemaVersion !== E.VERSION) return stop("source_set_safety_invalid");
    if (!SOURCE_IDS.includes(input.sourceId)) return stop("source_unknown");
    if (input.policy !== undefined && input.policy !== Historical.policyFor(3)) return stop("authority_override_rejected");
    const permission = PERMISSIONS.entries.find(e => e.sourceId === input.sourceId).permission;
    if (permission === "not_approved") return stop("unavailable_not_approved");
    // Project only for historical evaluation, never rewrite persisted state or
    // reinterpret the old receipt. New permission/sequence remain binding below.
    const { sourceSetVersion: _, safetyEnvelopeVersion: __, validationIdentity: ___, ...old } = input.record.safety;
    old.sourcePermissionVersion = 1; old.sourcePermissionIdentity = Historical.policyFor(3).permissions.identity;
    old.sources = old.sources.filter(s => s.sourceId !== MOF);
    return S.evaluate({ ...input, policy: Historical.policyFor(3), safety: S.sealSafetyMaterial(old) });
  } catch (_) { return stop("source_set_safety_invalid"); }
}
function bindingMaterial(input) {
  if (!evaluate(input).writeAllowed || !A.exact(input.mutationCeiling, Auth.CEILING_FIELDS) ||
    A.hash(input.mutationCeiling) !== A.hash(Historical.COUNTS)) return null;
  const { sourceSetVersion: _, safetyEnvelopeVersion: __, validationIdentity: ___, ...old } = input.record.safety;
  old.sourcePermissionVersion = 1; old.sourcePermissionIdentity = Historical.policyFor(3).permissions.identity;
  old.sources = old.sources.filter(s => s.sourceId !== MOF);
  const binding = Auth.bindingMaterial({ ...input, policy: Historical.policyFor(3), safety: S.sealSafetyMaterial(old) });
  if (!binding) return null;
  const { authorizationIdentity: ____, ...base } = binding;
  const value = { ...base, bindingContractVersion: 3, safetyEnvelopeVersion: 3, sourceSetVersion: SOURCE_SET_VERSION,
    sourcePermissionVersion: PERMISSION_VERSION, sourcePermissionIdentity: PERMISSIONS.identity,
    safetyIdentity: input.record.safety.validationIdentity };
  return A.freeze({ ...value, authorizationIdentity: A.hash(value) });
}
function issueAuthorizationCandidate(input) {
  const binding = bindingMaterial(input);
  if (!binding || !A.issueContext(input.context)) return A.freeze({ valid: false, reason: "authorization_candidate_rejected" });
  const authorization = Object.freeze(Object.create(null));
  tokens.set(authorization, { context: input.context, binding, consumed: false });
  return Object.freeze({ valid: true, binding, authorization, executionAllowed: false });
}
function validateAuthorizationCandidate(authorization, input = {}) {
  const saved = tokens.get(authorization), fresh = bindingMaterial(input);
  return A.freeze({ valid: !!(saved && !saved.consumed && saved.context === input.context && fresh &&
    saved.binding.authorizationIdentity === fresh.authorizationIdentity), executionAllowed: false });
}
function consumeAuthorizationCandidate(authorization, input) {
  const saved = tokens.get(authorization), valid = validateAuthorizationCandidate(authorization, input).valid;
  if (saved) { saved.consumed = true; if (!A.consumeContext(saved.context)) return A.freeze({ valid: false, executionAllowed: false }); }
  return A.freeze({ valid, executionAllowed: false });
}
module.exports = Object.freeze({ MOF, HISTORICAL_IDS, SOURCE_IDS, SOURCE_SET_VERSION, PERMISSION_VERSION,
  PERMISSIONS, emptySource, evaluate, bindingMaterial, issueAuthorizationCandidate,
  validateAuthorizationCandidate, consumeAuthorizationCandidate });
