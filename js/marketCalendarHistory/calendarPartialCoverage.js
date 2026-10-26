"use strict";

// Pure read-only projection. Formal archive state and mutable Runtime State
// remain separate authorities in every per-source row.
const Contract = require("./calendarPartialBootstrapContract.js");
const Schema = require("./productionSchemaV1.js");

const STATES = Object.freeze(["formal_present", "formal_absent", "formal_invalid",
  "runtime_success", "runtime_failed", "runtime_not_attempted", "runtime_unknown"]);
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function runtimeProjection(value) {
  if (!value) return { state: "runtime_unknown", reason: null, authority: "runtime_state",
    lastAttemptAt: null, lastSuccessAt: null };
  const outcome = value.lastOutcome || value.status || value.acquisitionStatus;
  if (["not_attempted", "none"].includes(outcome)) return { state: "runtime_not_attempted",
    reason: value.reason || value.lastDiagnosticClass || null, authority: "runtime_state",
    lastAttemptAt: value.lastAttemptAt || null, lastSuccessAt: value.lastSuccessAt || null };
  if (["success", "available"].includes(outcome)) return { state: "runtime_success",
    reason: null, authority: "runtime_state", lastAttemptAt: value.lastAttemptAt || null,
    lastSuccessAt: value.lastSuccessAt || value.lastAttemptAt || null };
  if (["failure", "failed", "unavailable", "rejected"].includes(outcome))
    return { state: "runtime_failed", reason: value.reason || value.reasonClass ||
      value.lastDiagnosticClass || "runtime_failed", authority: "runtime_state",
    lastAttemptAt: value.lastAttemptAt || null, lastSuccessAt: value.lastSuccessAt || null };
  return { state: "runtime_unknown", reason: "runtime_state_unknown", authority: "runtime_state",
    lastAttemptAt: value.lastAttemptAt || null, lastSuccessAt: value.lastSuccessAt || null };
}
function formalProjection(sourceId, snapshot, schemaValid) {
  if (!schemaValid) return { state: "formal_invalid", reason: "schema_version_mismatch",
    authority: "formal_history", cursor: null, run: null };
  const cursors = snapshot.cursors.filter(value => value?.sourceId === sourceId),
    runs = snapshot.runs.filter(value => value?.sourceId === sourceId),
    entries = snapshot.entries.filter(value => value?.sourceId === sourceId),
    revisions = snapshot.revisions.filter(value => value?.sourceId === sourceId),
    evidence = snapshot.evidence.filter(value => value?.sourceId === sourceId),
    observations = snapshot.observations.filter(value => value?.sourceId === sourceId);
  if (!cursors.length && !runs.length && !entries.length && !revisions.length &&
      !evidence.length && !observations.length)
    return { state: "formal_absent", reason: "source_not_persisted",
      authority: "formal_history", cursor: null, run: null };
  if (cursors.length !== 1 || !entries.length || !revisions.length || !runs.length) return {
    state: "formal_invalid", reason: "formal_source_linkage_invalid", authority: "formal_history",
    cursor: clone(cursors[0] || null), run: null };
  const cursor = cursors[0], run = runs.find(value => value.runKey === cursor.runKey &&
    value.runId === cursor.runId && value.acceptedAt === cursor.acceptedAt);
  if (!run || entries.some(entry => !revisions.some(revision =>
    revision.eventKey === entry.eventKey && revision.revisionKey === entry.activeRevisionKey &&
    revision.validTo === null))) return { state: "formal_invalid",
    reason: "formal_source_linkage_invalid", authority: "formal_history",
    cursor: clone(cursor), run: clone(run || null) };
  return { state: "formal_present", reason: null, authority: "formal_history",
    cursor: clone(cursor), run: clone(run) };
}

function projectPartialCoverage({ formalSnapshot, runtimeStates = [], schemaVersion = Schema.VERSION } = {}) {
  const fields = ["entries", "revisions", "evidence", "observations", "runs", "cursors"],
    validSnapshot = formalSnapshot && fields.every(field => Array.isArray(formalSnapshot[field])),
    snapshot = validSnapshot ? formalSnapshot : Object.fromEntries(fields.map(field => [field, []])),
    runtime = Array.isArray(runtimeStates) ? runtimeStates : [], runtimeBySource = new Map(),
    duplicateRuntime = new Set();
  for (const value of runtime) {
    if (runtimeBySource.has(value?.sourceId)) duplicateRuntime.add(value.sourceId);
    else runtimeBySource.set(value?.sourceId, value);
  }
  const schemaValid = validSnapshot && schemaVersion === Schema.VERSION,
    sources = Contract.EXPECTED_SOURCE_IDS.map(sourceId => {
      const formal = formalProjection(sourceId, snapshot, schemaValid),
        runtimeState = duplicateRuntime.has(sourceId) ? { state: "runtime_unknown",
          reason: "runtime_state_duplicate", authority: "runtime_state",
          lastAttemptAt: null, lastSuccessAt: null } : runtimeProjection(runtimeBySource.get(sourceId));
      return freeze({ sourceId, expected: true, formalState: formal.state,
        runtimeState: runtimeState.state, coverageState: formal.state,
        reason: formal.reason || runtimeState.reason || null,
        formal: freeze(formal), runtime: freeze(runtimeState) });
    }), expected = new Set(Contract.EXPECTED_SOURCE_IDS), unexpectedSourceIds = [...new Set([
      ...fields.flatMap(field => snapshot[field].map(value => value?.sourceId)),
      ...runtime.map(value => value?.sourceId)
    ].filter(sourceId => typeof sourceId === "string" && !expected.has(sourceId)))].sort(),
    persistedSourceIds = sources.filter(value => value.formalState === "formal_present")
      .map(value => value.sourceId), absentSourceIds = sources.filter(value =>
      value.formalState === "formal_absent").map(value => value.sourceId),
    invalidSourceIds = [...sources.filter(value => value.formalState === "formal_invalid")
      .map(value => value.sourceId), ...unexpectedSourceIds], coverageCount = persistedSourceIds.length,
    expectedCount = Contract.EXPECTED_SOURCE_IDS.length, completeness = invalidSourceIds.length
      ? "invalid" : coverageCount === expectedCount ? "complete" : coverageCount ? "partial" : "none",
    formalAvailability = coverageCount ? "available" : invalidSourceIds.length ? "invalid" : "absent";
  return freeze({ sourceSetIdentity: Contract.SOURCE_SET_ID,
    sourceSetVersion: Contract.SOURCE_SET_VERSION,
    expectedSourceIds: [...Contract.EXPECTED_SOURCE_IDS], persistedSourceIds, absentSourceIds,
    invalidSourceIds, unexpectedSourceIds, coverageCount, expectedCount, completeness,
    formalAvailability, sources });
}

module.exports = Object.freeze({ STATES, projectPartialCoverage });
