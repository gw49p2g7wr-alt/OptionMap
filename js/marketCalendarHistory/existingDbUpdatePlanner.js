"use strict";

const Canonicalizer = require("../marketCalendar/marketEventCanonicalizer.js");
const Schema = require("./productionSchemaV1.js");

const PLANNER_VERSION = 1, HASH = /^[0-9a-f]{64}$/;
const clone = value => value == null ? value : structuredClone(value);
function frozen(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(frozen); return Object.freeze(value);
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value &&
  typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key =>
    [key, canonical(value[key])])) : value;
const rejected = (sourceId, reason) => frozen({ sourceId: sourceId || null,
  planStatus: "rejected", planIdentity: null, plannerVersion: PLANNER_VERSION,
  precondition: null, operations: [], summary: null, reason, writeAllowed: false });
function candidateValid(sourceId, candidate) {
  return candidate?.sourceId === sourceId && candidate.formalEligible === true &&
    candidate.candidateStatus === "available" && HASH.test(candidate.candidateIdentity || "") &&
    candidate.parserStatus === "success" && candidate.canonicalizationStatus === "success" &&
    !candidate.parserDiagnostics?.length && !candidate.canonicalDiagnostics?.length &&
    candidate.recordCount > 0 && candidate.recordCount === candidate.canonicalRecords?.length;
}
async function candidateIdentityValid(sourceId, candidate) {
  const revisionKeys = candidate.canonicalRecords.map(value => value?.revisionKey);
  if (revisionKeys.some(value => typeof value !== "string") ||
      new Set(revisionKeys).size !== revisionKeys.length ||
      candidate.sourceIdentity?.sourceId !== sourceId ||
      typeof candidate.sourceIdentity?.parserId !== "string" ||
      typeof candidate.sourceIdentity?.parserVersion !== "number" ||
      typeof candidate.sourceIdentity?.candidateSchemaVersion !== "number") return false;
  const sorted = revisionKeys.slice().sort(), semanticSetHash = await Canonicalizer.sha256(sorted),
    candidateIdentity = await Canonicalizer.sha256({ sourceId,
      parserId: candidate.sourceIdentity.parserId,
      parserVersion: candidate.sourceIdentity.parserVersion,
      candidateSchemaVersion: candidate.sourceIdentity.candidateSchemaVersion,
      revisionKeys: sorted });
  return candidate.sourceIdentity.semanticSetHash === semanticSetHash &&
    candidate.candidateIdentity === candidateIdentity;
}
function operation(type, transition, extra = {}) {
  return { type, eventKey: transition?.eventKey || null,
    previousRevisionKey: transition?.previousRevisionKey || null,
    candidateRevisionKey: transition?.candidateRevisionKey || null, ...extra };
}
async function planExistingSourceUpdate({ sourceId, currentState, candidate, simulation } = {}) {
  if (!currentState || !["valid_existing", "source_state_missing"].includes(currentState.status))
    return rejected(sourceId, currentState?.reason || "current_state_invalid");
  const state = currentState.currentState;
  if (!state || state.sourceId !== sourceId || state.schemaVersion !== Schema.VERSION ||
      !HASH.test(state.schemaFingerprint || "") || !HASH.test(state.currentStateFingerprint || ""))
    return rejected(sourceId, "current_state_identity_invalid");
  if (!candidateValid(sourceId, candidate)) return rejected(sourceId, "candidate_not_eligible");
  if (!await candidateIdentityValid(sourceId, candidate))
    return rejected(sourceId, "candidate_identity_invalid");
  if (!simulation || simulation.sourceId !== sourceId ||
      simulation.candidateIdentity !== candidate.candidateIdentity ||
      !HASH.test(simulation.simulationIdentity || "") || simulation.simulationStatus === "rejected" ||
      !Array.isArray(simulation.transitions)) return rejected(sourceId, "transition_invalid");
  const allowed = new Set(["unchanged", "changed", "new", "unobserved", "not_evaluated"]),
    transitions = simulation.transitions.slice().sort((a, b) => a.eventKey.localeCompare(b.eventKey));
  if (transitions.some(value => !allowed.has(value.status)))
    return rejected(sourceId, "transition_status_invalid");
  const active = new Map(state.activeRevisionIdentities.map(value => [value.eventKey, value.revisionKey])),
    records = new Map(candidate.canonicalRecords.map(value => [value.eventKey, value]));
  if (records.size !== candidate.recordCount) return rejected(sourceId, "candidate_identity_ambiguous");
  for (const transition of transitions) {
    const expected = active.get(transition.eventKey) || null, record = records.get(transition.eventKey);
    if (transition.previousRevisionKey !== expected ||
        (["new", "changed", "unchanged"].includes(transition.status) &&
          (!record || transition.candidateRevisionKey !== record.revisionKey)) ||
        (["unobserved", "not_evaluated"].includes(transition.status) &&
          transition.candidateRevisionKey !== null))
      return rejected(sourceId, "transition_current_state_mismatch");
  }
  const operations = [{ type: "append_source_run", sourceId }];
  for (const transition of transitions) {
    if (transition.status === "new") operations.push(operation("append_event_entry", transition),
      operation("append_semantic_revision", transition, { revisionOrigin: "initial_observation" }));
    if (transition.status === "changed") operations.push(operation("close_semantic_revision", transition),
      operation("append_semantic_revision", transition, { revisionOrigin: "authority_semantic_change" }),
      operation("update_event_entry_active_revision", transition));
    if (transition.status === "unchanged")
      operations.push(operation("update_event_entry_last_observed", transition));
    if (["new", "changed", "unchanged"].includes(transition.status))
      operations.push(operation("append_evidence", transition),
        operation("append_observation", transition, { observationState: "observed" }));
    else operations.push(operation("append_observation", transition,
      { observationState: transition.status }));
  }
  operations.push({ type: "update_source_cursor", sourceId });
  const orderedOperations = operations.sort((a, b) => a.type.localeCompare(b.type) ||
    (a.eventKey || "").localeCompare(b.eventKey || "") || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const precondition = { schemaVersion: state.schemaVersion, schemaFingerprint: state.schemaFingerprint,
    sourceId, expectedSourceCursor: clone(state.sourceCursor),
    expectedActiveRevisionIdentities: clone(state.activeRevisionIdentities),
    expectedRelevantCounts: clone(state.relevantCounts),
    currentStateFingerprint: state.currentStateFingerprint };
  const identityInput = { plannerVersion: PLANNER_VERSION, sourceId,
    currentStateFingerprint: state.currentStateFingerprint,
    candidateIdentity: candidate.candidateIdentity,
    simulationIdentity: simulation.simulationIdentity, precondition, operations: orderedOperations };
  const planIdentity = await Canonicalizer.sha256(canonical(identityInput));
  const summary = Object.fromEntries([...allowed].map(status =>
    [`${status}Count`, transitions.filter(value => value.status === status).length]));
  return frozen({ sourceId, planStatus: "planned", planIdentity,
    plannerVersion: PLANNER_VERSION, precondition, operations: orderedOperations, summary,
    reason: null, writeAllowed: false });
}
function comparePrecondition(currentState, precondition) {
  if (!currentState || !precondition) return frozen({ status: "invalid" });
  const actual = currentState.currentState || currentState;
  const same = actual.schemaVersion === precondition.schemaVersion &&
    actual.schemaFingerprint === precondition.schemaFingerprint &&
    actual.sourceId === precondition.sourceId &&
    actual.currentStateFingerprint === precondition.currentStateFingerprint &&
    JSON.stringify(canonical(actual.sourceCursor)) ===
      JSON.stringify(canonical(precondition.expectedSourceCursor)) &&
    JSON.stringify(canonical(actual.activeRevisionIdentities)) ===
      JSON.stringify(canonical(precondition.expectedActiveRevisionIdentities)) &&
    JSON.stringify(canonical(actual.relevantCounts)) ===
      JSON.stringify(canonical(precondition.expectedRelevantCounts));
  return frozen({ status: same ? "current" : "stale" });
}

module.exports = Object.freeze({ PLANNER_VERSION, planExistingSourceUpdate, comparePrecondition });
