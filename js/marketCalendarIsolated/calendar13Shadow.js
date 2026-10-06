"use strict";

// A fixture/temp snapshot only; no DB, safety store or writer execution dependency.
const Registry = require("../marketCalendar/sourceRegistry.js");
const C = require("../marketCalendar/marketEventCanonicalizer.js");
const Compare = require("../marketCalendarRuntime/formalExactComparison.js").createIsolated13Comparison();
const Automatic = require("../marketCalendarRuntime/automaticFormalShadow.js");
const Cycle = require("../marketCalendarRuntime/formalShadowCycle.js");
const Schema = require("../marketCalendarHistory/productionSchemaV1.js");
const Transition = require("../marketCalendarHistory/transitionPlanner.js");
const Mapper = require("../marketCalendarHistory/storageRecordMapper.js");
const Mof = require("./mofJgbVariableAdapter.js");
const FIELDS = require("../marketCalendarRuntime/formalShadowReadOnlyGate.js").FIELDS;
const zero = () => Object.fromEntries(FIELDS.map(f => [f, 0]));
const unsafe = reason => ({ status: "unsafe", reason, sourceRows: [], writeAllowed: false, writerExecution: 0 });
async function evaluate({ sourceResults, snapshot, schemaFingerprint = Schema.EXPECTED_FINGERPRINT } = {}) {
  const started = performance.now();
  if (!Array.isArray(sourceResults) || sourceResults.length !== 13 || new Set(sourceResults.map(s => s.sourceId)).size !== 13 ||
      sourceResults.some(s => !Compare.SOURCE_IDS.includes(s.sourceId))) return unsafe("source_set_invalid");
  let token;
  try { Cycle.freeze(sourceResults); token = Cycle.create(snapshot, schemaFingerprint); }
  catch (_) { return unsafe(schemaFingerprint === Schema.EXPECTED_FINGERPRINT ? "formal_integrity_invalid" : "schema_fingerprint_mismatch"); }
  try {
    const context = Cycle.get(token, snapshot), legacy = await Automatic.evaluateInIsolatedCycle({
      sourceResults: sourceResults.filter(s => s.sourceId !== Mof.SOURCE_ID), before: snapshot, schemaFingerprint }, token);
    if (legacy.status !== "evaluated") return legacy;
    const comparison = await Compare.compare({ sourceResults, formalSnapshot: snapshot, cycleContext: token });
    const source = sourceResults.find(s => s.sourceId === Mof.SOURCE_ID);
    const summary = comparison.summaries.find(s => s.sourceId === Mof.SOURCE_ID);
    const row = { sourceId: Mof.SOURCE_ID, acquisition: source.acquisitionOutcome, candidate: source.canonicalRecords.length,
      formalActive: summary?.formalActive || 0, unchanged: summary?.unchanged || 0, changed: summary?.changed || 0,
      new: summary?.new || 0, notEvaluated: summary?.notEvaluated || 0, evidenceOnly: summary?.evidenceOnly || 0,
      counts: zero(), writeAllowed: false, permission: "unavailable_not_approved", productionWriteEligible: false,
      eligible: false, shadowPlanGenerated: false, reason: source.reason || null, absenceAuthority: "none",
      snapshotIdentity: context.snapshotIdentity };
    let plan = null;
    if (comparison.status !== "compared") row.reason = comparison.reason;
    else if (source.routeIdentity !== Mof.routeIdentity) row.reason = "route_identity_mismatch";
    else if (source.acquisitionOutcome !== "complete" || source.candidateStatus !== "available" || source.failedRoles.length)
      row.reason ||= "source_incomplete";
    else if (summary.changed) row.reason = "unsupported_changed";
    else if (summary.formalActive) row.reason = "mof_absent_fixture_required";
    else if (!source.canonicalRecords.length) row.reason = "complete_no_event";
    else {
      const fetchedAt = [...new Set(source.canonicalRecords.map(r => r.acquisitionEvidence.fetchedAt))].sort();
      const run = { sourceId: source.sourceId, runId: "isolated13-" + Cycle.sourceHash(context, {
        candidateIdentity: source.candidateIdentity, fetchedAt }), acceptedAt: fetchedAt.at(-1), fetchedAt,
        status: "accepted", semanticSetHash: Cycle.sourceHash(context, source.canonicalRecords.map(r => r.revisionKey).sort()) };
      const transition = Transition.planTransition({ snapshot, run, canonicalSet: source.canonicalRecords });
      if (!transition.ok) row.reason = "source_plan_rejected";
      else {
        const mutations = Mapper.mapPlan(transition.plan), counts = { eventEntryCreate: mutations.appendEntries.length,
          eventEntryUpdate: mutations.updateEntries.length, semanticRevisionCreate: mutations.appendRevisions.length,
          semanticRevisionClose: mutations.closeRevisions.length, evidenceCreate: mutations.appendEvidence.length,
          observationCreate: mutations.appendObservations.length, sourceRunCreate: mutations.appendRuns.length,
          sourceCursorUpdate: mutations.updateCursors.length };
        const material = { scope: "G1.3a_isolated_only", sourceId: source.sourceId, writeAllowed: false,
          permission: "unavailable_not_approved", preconditionIdentity: context.snapshotIdentity,
          candidateIdentity: source.candidateIdentity, documentSetIdentity: source.documentSetIdentity, mutations, counts };
        plan = { ...material, planIdentity: Cycle.sourceHash(context, material) };
        row.counts = counts; row.shadowPlanGenerated = true; row.planIdentity = plan.planIdentity;
      }
    }
    const aggregate = { ...legacy.aggregatePlannedCounts };
    for (const f of FIELDS) aggregate[f] += row.counts[f];
    return { ...legacy, sourceRows: [...legacy.sourceRows, row].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
      plans: [...legacy.plans, ...(plan ? [plan] : [])], comparison, aggregatePlannedCounts: aggregate,
      eligibleCount: legacy.eligibleCount, ineligibleCount: legacy.ineligibleCount + 1,
      failedPartialCount: legacy.failedPartialCount + (source.acquisitionOutcome === "complete" ? 0 : 1),
      performance: { ...context.metrics, elapsedMs: performance.now() - started, cacheDisposed: true },
      productionScope: false, writerExecution: 0, writeAllowed: false };
  } finally { Cycle.close(token); }
}
module.exports = Object.freeze({ SOURCE_IDS: Registry.getSourceSet(2).sourceIds, evaluate });
