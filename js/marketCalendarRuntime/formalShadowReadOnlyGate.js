"use strict";

// E2c evaluates current acquisition against a read-only Formal snapshot.
// No storage, writer, Electron, startup or IPC dependencies belong here.
const Schema = require("../marketCalendarHistory/productionSchemaV1.js");
const Compare = require("./formalExactComparison.js");
const Shadow = require("../marketCalendarHistory/formalShadowWritePlan.js");
const Authority = require("../marketCalendarHistory/formalWriterAuthority.js");
const Canonicalizer = require("../marketCalendar/marketEventCanonicalizer.js");

const FIELDS = Object.freeze(["eventEntryCreate", "eventEntryUpdate",
  "semanticRevisionCreate", "semanticRevisionClose", "evidenceCreate",
  "observationCreate", "sourceRunCreate", "sourceCursorUpdate"]);
const SNAPSHOT = Object.freeze({ entries: "eventKey", revisions: "revisionKey",
  evidence: "evidenceLinkKey", observations: "observationKey", runs: "runKey",
  cursors: "sourceId" });
function snapshotMaterial(snapshot) {
  return Object.fromEntries(Object.entries(SNAPSHOT).map(([field, key]) =>
    [field, [...snapshot[field]].sort((a, b) =>
      String(a[key]).localeCompare(String(b[key])))]));
}
async function formalPreconditionIdentity(snapshot, schemaFingerprint) {
  return Canonicalizer.sha256({ schemaFingerprint, formalSnapshot: snapshotMaterial(snapshot) });
}
function sourceHealthy(value) {
  return value.acquisitionOutcome === "complete" && value.candidateStatus === "available" &&
    value.failedRoles?.length === 0 && Array.isArray(value.canonicalRecords) &&
    value.canonicalRecords.length > 0 && Array.isArray(value.documentHealth) &&
    value.documentHealth.length > 0 && value.documentHealth.every(role =>
      role.fetchOutcome === "success" && role.parseOutcome === "success");
}
function acceptedTime(source, snapshot, completedAt) {
  const times = [completedAt, ...source.canonicalRecords.map(value =>
    value.acquisitionEvidence?.fetchedAt).filter(Boolean)], prior = snapshot.cursors.find(value =>
    value.sourceId === source.sourceId)?.acceptedAt;
  if (prior) times.push(new Date(Date.parse(prior) + 1).toISOString());
  if (times.some(value => !Number.isFinite(Date.parse(value)))) return null;
  return new Date(Math.max(...times.map(value => Date.parse(value)))).toISOString();
}
async function acquisitionRun(source, snapshot, completedAt) {
  const acceptedAt = acceptedTime(source, snapshot, completedAt), fetchedAt = [...new Set(
    source.canonicalRecords.map(value => value.acquisitionEvidence?.fetchedAt))].sort();
  if (!acceptedAt || fetchedAt.some(value => !value)) return null;
  const semanticSetHash = await Canonicalizer.sha256(source.canonicalRecords.map(value =>
    value.revisionKey).sort());
  const identity = await Canonicalizer.sha256({ sourceId: source.sourceId,
    routeIdentity: source.routeIdentity || null, candidateIdentity: source.candidateIdentity || null,
    semanticSetHash, fetchedAt, acceptedAt });
  return { sourceId: source.sourceId, runId: `e2c-shadow-${identity}`, acceptedAt,
    fetchedAt, status: "accepted", semanticSetHash };
}
const zeroCounts = () => Object.fromEntries(FIELDS.map(field => [field, 0]));
const totalCounts = plans => plans.reduce((result, plan) => {
  for (const field of FIELDS) result[field] += plan.counts?.[field] || 0;
  return result;
}, zeroCounts());
async function buildReadOnlyShadowReport({ formalSnapshot, sourceResults, schemaFingerprint,
  completedAt, startingPreconditionIdentity, endingPreconditionIdentity } = {}) {
  if (schemaFingerprint !== Schema.EXPECTED_FINGERPRINT ||
      !Array.isArray(sourceResults) || sourceResults.length !== Compare.SOURCE_IDS.length ||
      sourceResults.some((value, index) => !value ||
        value.sourceId !== Compare.SOURCE_IDS[index]) ||
      !formalSnapshot || Object.keys(SNAPSHOT).some(field => !Array.isArray(formalSnapshot[field])))
    return { status: "rejected", reason: "shadow_input_invalid" };
  const currentIdentity = await formalPreconditionIdentity(formalSnapshot, schemaFingerprint);
  if (currentIdentity !== startingPreconditionIdentity ||
      currentIdentity !== endingPreconditionIdentity)
    return { status: "rejected", reason: "stale_readonly_shadow" };
  const comparison = await Compare.compare({ sourceResults, formalSnapshot });
  if (comparison.status !== "compared") return { status: "rejected", reason: comparison.reason };
  const plans = [], rows = [];
  for (const source of sourceResults) {
    const run = sourceHealthy(source) ? await acquisitionRun(source, formalSnapshot, completedAt) : null;
    if (sourceHealthy(source) && !run)
      return { status: "rejected", reason: "acquisition_run_invalid", sourceId: source.sourceId };
    const plan = await Shadow.buildSourceShadowPlan({ sourceId: source.sourceId,
      sourceResult: source, comparison, formalSnapshot, schemaFingerprint, run });
    if (plan.planStatus === "planned" && !(await Shadow.validateShadowPlan(plan)).valid)
      return { status: "rejected", reason: "shadow_plan_invalid", sourceId: source.sourceId };
    const summary = comparison.summaries.find(value => value.sourceId === source.sourceId);
    plans.push(plan);
    rows.push({ sourceId: source.sourceId, candidate: summary.candidate,
      formalActive: summary.formalActive, unchanged: summary.unchanged,
      changed: summary.changed, new: summary.new, notEvaluated: summary.notEvaluated,
      evidenceOnly: summary.evidenceOnly, sourceHealthy: sourceHealthy(source),
      planStatus: plan.planStatus, reason: plan.reason || null,
      writeEligible: plan.planStatus === "planned" && source.sourceId !== Authority.BOJ_SOURCE_ID,
      counts: plan.counts, planIdentity: plan.planIdentity || null,
      preconditionIdentity: plan.preconditionIdentity || null,
      activeFormalIdentity: plan.activeFormalIdentity || null,
      candidateSetIdentity: plan.candidateSetIdentity || null,
      acquisitionIdentity: plan.acquisitionIdentity || null,
      comparisonIdentity: plan.comparisonIdentity || null,
      runId: run?.runId || null });
  }
  const first = rows.find(value => value.sourceId === Authority.FIRST_WRITE_SOURCE_ID),
    identityAudit = { candidateDuplicate: 0, semanticConflict: 0,
      duplicateRevision: 0, formalAmbiguity: comparison.ambiguityCount },
    allHealthy = rows.every(value => value.sourceHealthy),
    firstWriteCandidateEligible = Boolean(first && first.sourceHealthy &&
      first.planStatus === "planned" && first.changed === 0 && first.new === 0 &&
      first.evidenceOnly === 0 && first.notEvaluated === 0 &&
      first.candidate === first.formalActive && first.unchanged === first.candidate),
    unexpectedIneligible = rows.some(value => value.sourceId !== Authority.BOJ_SOURCE_ID &&
      value.sourceHealthy && value.planStatus !== "planned"),
    firstLiveWriteEligible = allHealthy && comparison.totals.changed === 0 &&
      comparison.ambiguityCount === 0 && !unexpectedIneligible && firstWriteCandidateEligible;
  return { status: "evaluated", reason: null, schemaFingerprint,
    formalPreconditionIdentity: currentIdentity, comparison: { status: comparison.status,
      totals: comparison.totals, changed: comparison.differences.filter(value =>
        value.status === "changed"), formalOnly: comparison.differences.filter(value =>
        value.status === "formal_only_not_evaluated") },
    sourceRows: rows, aggregatePlannedCounts: totalCounts(plans), identityAudit,
    sourceSuccessCount: rows.filter(value => value.sourceHealthy).length,
    firstWriteCandidateEligible, firstLiveWriteEligible,
    firstWrite: first || null, writerAuthorityState:
      Authority.selectWriterState(Authority.FIRST_WRITE_SOURCE_ID).state,
    writerExecution: 0 };
}

module.exports = Object.freeze({ FIELDS, formalPreconditionIdentity,
  buildReadOnlyShadowReport });
