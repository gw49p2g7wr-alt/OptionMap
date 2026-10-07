"use strict";

// Pure historical fixture, never accesses a production profile/state/DB.
const A = require("../../../js/marketCalendarHistory/formalWriterAuthorityV2.js");
const S = require("../../../js/marketCalendarHistory/formalWriterSafetyEvaluator.js");
const File = require("../../../js/marketCalendarHistory/writerSafetyFileSchema.js");
const E = require("../../../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js");
const Auth = require("../../../js/marketCalendarHistory/formalWriterAuthorizationV2.js");
const H = label => A.hash({ fixture: label }), GATE = H("G1.4a-explicit-isolated-source-set-gate");
function candidate(record, label = "candidate", sourceId = E.SOURCE, operation = "startup") {
  const policy = E.policyFor(3), cycleIdentity = H("cycle-" + label);
  return { policy, safety: E.safetyInput(record.safety), sourceId, operation, cycleIdentity,
    context: A.createMainContextCandidate({ operation, cycleIdentity, attemptIdentity: H("attempt-" + label) }),
    acquisition: { outcome: "complete", failedRoles: [] }, routeIdentity: H("route"), expectedRouteIdentity: H("route"),
    schemaFingerprint: policy.global.schemaFingerprint, integrityValid: true, changed: 0, planValid: true,
    revisionTransitionCount: 0, absenceAuthority: "none", acquisitionIdentity: H("acquisition"), candidateIdentity: H("candidate"),
    comparisonIdentity: H("comparison"), formalPrecondition: H("precondition"), planIdentity: H("plan"), mutationCeiling: E.COUNTS };
}
function historical({ cycles = 0, failureCycles = 0, suspendSource = false, globalSuspend = false } = {}) {
  let safety = S.createMemorySafety(), legacy = File.build(null, safety, null, "provision_disabled", A.PRODUCTION_POLICY);
  const id = "jp-stat-cpi";
  for (let n = 1; n <= cycles; n++) {
    const signal = { sourceId: id, category: "acquisition_failure", outcome: "success", reason: null,
      cycleOrdinal: n, cycleIdentity: H("historic-" + n) };
    safety = S.reduceSafetySignal({ state: safety, signal }).state;
    legacy = File.build(legacy, safety, null, "evaluated_success", A.PRODUCTION_POLICY);
  }
  for (let n = 1; n <= failureCycles; n++) {
    const signal = { sourceId: id, category: "acquisition_failure", outcome: "failure", reason: "network_failure",
      cycleOrdinal: cycles + n, cycleIdentity: H("historic-failure-" + n) };
    safety = S.reduceSafetySignal({ state: safety, signal }).state;
    legacy = File.build(legacy, safety, null, "network_failure", A.PRODUCTION_POLICY);
  }
  if (suspendSource || globalSuspend) {
    const signal = { sourceId: id, category: null, outcome: "failure", reason: globalSuspend ? "orphan" : "unsupported_changed",
      cycleOrdinal: cycles + failureCycles + 1, cycleIdentity: H("historic-suspend") };
    safety = S.reduceSafetySignal({ state: safety, signal }).state;
    legacy = File.build(legacy, safety, null, signal.reason, A.PRODUCTION_POLICY);
  }
  let record = E.migrate(legacy, GATE);
  if (!globalSuspend) record = E.append(record, { type: "authority_transition", expectedAuthorityVersion: 2,
    nextAuthorityVersion: 3, approvedSourceCeiling: [E.SOURCE],
    suspendedSourceSet: safety.sources.filter(s => s.suspended).map(s => s.sourceId).sort() }, GATE);
  return record;
}
function pending(record) {
  const issued = Auth.issueAuthorizationCandidate(candidate(record));
  if (!issued.valid) throw Error("fixture_authorization_failed");
  return E.append(record, { type: "fence_created", binding: issued.binding }, GATE);
}
function complete(record, identity) {
  record = pending(record); const f = record.safety.pendingFence;
  const base = { sourceId: E.SOURCE, attemptIdentity: f.attemptIdentity, authorizationIdentity: f.authorizationIdentity,
    committed: true, mutationCounts: E.COUNTS };
  const advance = (phase, proof) => { record = E.append(record, { type: "fence_advanced", attemptIdentity: f.attemptIdentity,
    authorizationIdentity: f.authorizationIdentity, phase, proof }, GATE); };
  advance("formal_write_started", null); advance("commit_observed", { ...base, kind: "commit" });
  const proof = { ...base, kind: "readback", freshReadonly: true, integrityValid: true, otherSourcesUnchanged: true,
    expectedIdentity: identity, observedIdentity: identity };
  advance("readback_verified", proof);
  return E.append(record, { type: "fence_completed", attemptIdentity: f.attemptIdentity,
    authorizationIdentity: f.authorizationIdentity, proof }, GATE);
}
module.exports = Object.freeze({ H, GATE, historical, candidate, pending, complete });
