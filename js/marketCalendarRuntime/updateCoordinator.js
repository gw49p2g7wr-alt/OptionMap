"use strict";

const registry = require("../marketCalendar/sourceRegistry.js");
const policy = require("./updatePolicy.js");

const CLASSIFICATIONS = Object.freeze(["acquisition_candidate", "no_acquisition", "invalid"]);
const ACTIVE_SOURCE_IDS = registry.getAcquisitionEnabledSourceIds();
const DEFAULT_FORMAL_STATE = Object.freeze({ databaseStatus: "absent", schemaStatus: "unknown",
  sourceCursorStatus: "absent", lastAcceptedAt: null, securityStatus: "clear" });
const DEFAULT_SESSION_STATE = Object.freeze({ attemptCount: 0 });

function deepClone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}
function deepFreeze(value) {
  if (value && typeof value === "object") for (const child of Object.values(value)) deepFreeze(child);
  return value && typeof value === "object" ? Object.freeze(value) : value;
}
const freeze = value => deepFreeze(deepClone(value));
const plainMap = value => value && typeof value === "object" && !Array.isArray(value);

function invalidSourceResult(sourceId, reason, trigger, requestedAt) {
  return { sourceId, decision: "blocked", reason, eligible: false, retryable: false,
    retryAfter: null, attemptCount: null, jstDate: null, policyVersion: policy.POLICY_VERSION,
    classification: "invalid", trigger, requestedAt };
}

function selectSources(sourceIds) {
  if (sourceIds === undefined) return { requestedCount: ACTIVE_SOURCE_IDS.length,
    active: [...ACTIVE_SOURCE_IDS], invalid: [] };
  if (!Array.isArray(sourceIds)) return { requestedCount: 0, active: [],
    invalid: [invalidSourceResult(null, "source_ids_invalid", null, null)] };
  const activeSet = new Set(), invalidByKey = new Map();
  for (const sourceId of sourceIds) {
    if (typeof sourceId !== "string" || sourceId.length === 0) {
      invalidByKey.set("malformed", { sourceId: null, reason: "malformed_source_id" });
    } else if (registry.SOURCES[sourceId]) {
      if (registry.isAcquisitionEnabled(sourceId)) activeSet.add(sourceId);
      else invalidByKey.set(`disabled:${sourceId}`, { sourceId, reason: "acquisition_disabled" });
    }
    else if (registry.BLOCKED_SOURCES[sourceId])
      invalidByKey.set(`blocked:${sourceId}`, { sourceId, reason: "blocked_source" });
    else if (registry.REPLACED_SOURCES[sourceId])
      invalidByKey.set(`replaced:${sourceId}`, { sourceId, reason: "replaced_source" });
    else invalidByKey.set(`unknown:${sourceId}`, { sourceId, reason: "unknown_source" });
  }
  const active = ACTIVE_SOURCE_IDS.filter(sourceId => activeSet.has(sourceId));
  const invalid = [...invalidByKey.values()].sort((a, b) => {
    const left = `${a.sourceId || ""}:${a.reason}`, right = `${b.sourceId || ""}:${b.reason}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return { requestedCount: sourceIds.length, active, invalid };
}

function sourceMap(value, name) {
  if (value === undefined) return { valid: true, value: {} };
  if (!plainMap(value)) return { valid: false, reason: `${name}_map_invalid`, value: {} };
  return { valid: true, value };
}

function planUpdate(input) {
  const request = plainMap(input) ? input : {};
  const selected = selectSources(request.sourceIds);
  const formal = sourceMap(request.formalStates, "formal_states");
  const runtime = sourceMap(request.runtimeStates, "runtime_states");
  const session = sourceMap(request.sessionStates, "session_states");
  const mapError = [formal, runtime, session].find(entry => !entry.valid);
  const sourceResults = [];

  for (const sourceId of selected.active) {
    if (mapError) {
      sourceResults.push(invalidSourceResult(sourceId, mapError.reason, request.trigger,
        request.requestedAt));
      continue;
    }
    const decision = policy.evaluateSourceUpdate({ sourceId, trigger: request.trigger,
      requestedAt: request.requestedAt,
      formalState: Object.hasOwn(formal.value, sourceId) ? formal.value[sourceId] : DEFAULT_FORMAL_STATE,
      runtimeState: Object.hasOwn(runtime.value, sourceId) ? runtime.value[sourceId] : null,
      sessionState: Object.hasOwn(session.value, sourceId) ? session.value[sourceId] : DEFAULT_SESSION_STATE });
    sourceResults.push({ ...decision, classification:
      decision.decision === "update" || decision.decision === "retry"
        ? "acquisition_candidate" : "no_acquisition" });
  }
  for (const invalid of selected.invalid) sourceResults.push(invalidSourceResult(invalid.sourceId,
    invalid.reason, request.trigger || null, request.requestedAt || null));

  const acquisitionCandidates = sourceResults.filter(result =>
    result.classification === "acquisition_candidate");
  const nonAcquisitionResults = sourceResults.filter(result =>
    result.classification !== "acquisition_candidate");
  const summary = { requestedSourceCount: selected.requestedCount,
    validSourceCount: selected.active.length,
    acquisitionCandidateCount: acquisitionCandidates.length,
    skipCount: sourceResults.filter(result => result.decision === "skip").length,
    cooldownCount: sourceResults.filter(result => result.decision === "cooldown").length,
    blockedInvalidCount: sourceResults.filter(result => result.decision === "blocked" ||
      result.classification === "invalid").length };
  return freeze({ trigger: request.trigger || null, requestedAt: request.requestedAt || null,
    policyVersion: policy.POLICY_VERSION, sourceResults, acquisitionCandidates,
    nonAcquisitionResults, summary });
}

module.exports = Object.freeze({ ACTIVE_SOURCE_IDS, CLASSIFICATIONS, planUpdate });
