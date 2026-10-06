"use strict";

// Main-only memory projection: no DB, transport, executor or activation imports.
const Compare = require("./formalExactComparison.js");
const Routes = require("./calendarRouteAuthority.js");
const Network = require("./calendarNetworkPolicy.js");
const Gate = require("./formalShadowReadOnlyGate.js");
const Shadow = require("../marketCalendarHistory/formalShadowWritePlan.js");
const Writer = require("../marketCalendarHistory/formalWriterAuthority.js");
const Schema = require("../marketCalendarHistory/productionSchemaV1.js");
const Canonical = require("../marketCalendar/marketEventCanonicalizer.js");
const Cycle = require("./formalShadowCycle.js");

const INTERNAL_SHADOW = Object.freeze({ version: 1, mode: "internal_shadow",
  writeAllowed: false, futureWriteRequiresFreshPlan: true });
const emptyCounts = () => Object.fromEntries(Gate.FIELDS.map(key => [key, 0]));
const copy = value => structuredClone(value);
const same = (a, b) => Canonical.stable(a) === Canonical.stable(b);
const safe = reason => typeof reason === "string" && /^[a-z0-9_:-]{1,120}$/.test(reason)
  ? reason : "shadow_failure";
const noResult = sourceId => ({ sourceId, canonicalRecords: [], candidateStatus: "unavailable",
  acquisitionOutcome: "not_attempted", documentHealth: [], failedRoles: [], absenceAuthority: "none" });
function projectAcquisition(result) {
  const candidate = result.candidateEnvelope || {};
  return copy({ sourceId: result.sourceId, routeIdentity: result.routeIdentity || null,
    canonicalRecords: candidate.canonicalRecords || [],
    candidateIdentity: candidate.candidateIdentity || null,
    candidateStatus: candidate.candidateStatus || "unavailable",
    acquisitionOutcome: result.acquisitionOutcome || "failed",
    failedRoles: result.failedRoles || [], documentHealth: (result.documentHealth || []).map(d => ({
      role: d.role, httpStatus: d.httpStatus ?? null, redirectCount: d.redirectCount ?? 0,
      fetchOutcome: d.fetchOutcome, parseOutcome: d.parseOutcome })),
    coverage: result.coverage || null, absenceAuthority: "none" });
}
async function integrity(snapshot) {
  try { const token = Cycle.create(snapshot, Schema.EXPECTED_FINGERPRINT); Cycle.close(token); return true; }
  catch (_) { return false; }
}
function failure(reason, scope = "global_suspend_candidate") {
  return { status: "unsafe", reason: safe(reason), failureScope: scope,
    writeAllowed: false, writerExecution: 0, readwriteTransactions: 0,
    futureWriteRequiresFreshPlan: true, sourceRows: [], aggregatePlannedCounts: emptyCounts() };
}
async function runFor(source, snapshot, context) {
  const fetchedAt = [...new Set(source.canonicalRecords.map(r => r.acquisitionEvidence?.fetchedAt))].sort();
  const times = fetchedAt.map(Date.parse), cursor = snapshot.cursors.find(c => c.sourceId === source.sourceId);
  if (!times.length || times.some(t => !Number.isFinite(t))) throw Error("acquisition_time_invalid");
  if (cursor) times.push(Date.parse(cursor.acceptedAt) + 1);
  const acceptedAt = new Date(Math.max(...times)).toISOString();
  const semanticSetHash = Cycle.sourceHash(context, source.canonicalRecords.map(r => r.revisionKey).sort());
  const id = Cycle.sourceHash(context, { sourceId: source.sourceId, routeIdentity: source.routeIdentity,
    candidateIdentity: source.candidateIdentity, fetchedAt, semanticSetHash, acceptedAt });
  return { sourceId: source.sourceId, runId: `automatic-shadow-${id}`, acceptedAt,
    fetchedAt, semanticSetHash, status: "accepted" };
}
async function evaluateCycle({ sourceResults, before, after = before, schemaFingerprint,
  internalAuthority = INTERNAL_SHADOW, routeAuthority = Routes.PRODUCTION_AUTHORITY } = {}, sharedCycle = null) {
  const started = performance.now();
  if (!same(internalAuthority, INTERNAL_SHADOW) ||
      !Writer.validateAuthority(Writer.PRODUCTION_AUTHORITY).valid ||
      Writer.PRODUCTION_AUTHORITY.entries.some(e => e.state !== "disabled"))
    return failure("shadow_authority_invalid");
  if (schemaFingerprint !== Schema.EXPECTED_FINGERPRINT) return failure("schema_fingerprint_mismatch");
  if (!Array.isArray(sourceResults) || new Set(sourceResults.map(r => r?.sourceId)).size !== sourceResults.length ||
      sourceResults.some(r => !Compare.SOURCE_IDS.includes(r?.sourceId))) return failure("source_set_invalid");
  let cycleContext, endingCycle, reportedPerformance;
  try {
  // One immutable acquisition binding per cycle; a new acquisition starts a new cycle.
  Cycle.freeze(sourceResults);
    cycleContext = sharedCycle || Cycle.create(before, schemaFingerprint);
    Cycle.get(cycleContext, before);
    endingCycle = after === before ? cycleContext : Cycle.create(after, schemaFingerprint);
  } catch (_) { if (cycleContext && !sharedCycle) Cycle.close(cycleContext); return failure("formal_integrity_invalid"); }
  try {
  const context = Cycle.get(cycleContext, before), ending = Cycle.get(endingCycle, after);
  const snapshotIdentity = context.snapshotIdentity, endingSnapshotIdentity = ending.snapshotIdentity;
  const all = Compare.SOURCE_IDS.map(id => sourceResults.find(s => s.sourceId === id) || noResult(id));
  const rows = [], plans = [], aggregate = emptyCounts();
  for (const source of all) {
    const localResults = Compare.SOURCE_IDS.map(id => id === source.sourceId ? source : noResult(id));
    const comparison = await Compare.compare({ sourceResults: localResults, formalSnapshot: before, cycleContext });
    const summary = comparison.summaries.find(s => s.sourceId === source.sourceId);
    const selection = Routes.selectRoute({ sourceId: source.sourceId, operation: Network.OPERATION }, routeAuthority);
    const own = snapshot => Object.fromEntries(Object.keys(before).map(k => [k,
      snapshot[k].filter(r => r.sourceId === source.sourceId)]));
    let reason = null, scope = null, plan = null;
    const attempted = source.acquisitionOutcome !== "not_attempted";
    if (!attempted) reason = "no_fresh_acquisition";
    else if (!selection.valid || !selection.acquisitionAllowed || source.routeIdentity !== selection.routeIdentity) {
      reason = "route_identity_mismatch"; scope = "source_suspend_candidate";
    } else if (after !== before && !same(own(before), own(after))) {
      reason = "source_stale_precondition"; scope = "source_local";
    } else if (source.acquisitionOutcome !== "complete" || source.candidateStatus !== "available" ||
        source.failedRoles?.length) {
      reason = source.acquisitionOutcome === "partial" ? "source_partial" : "source_failure"; scope = "source_local";
    } else if (comparison.status !== "compared") {
      reason = safe(comparison.reason); scope = "source_suspend_candidate";
    } else {
      try {
        const run = await runFor(source, before, context);
        plan = await Shadow.buildSourceShadowPlan({ sourceId: source.sourceId, sourceResult: source,
          comparison, formalSnapshot: before, schemaFingerprint, run, cycleContext });
        if (plan.planStatus === "planned" && !(await Shadow.validateShadowPlan(plan, cycleContext, before)).valid)
          return failure("shadow_plan_invalid");
        if (plan.mutations && Object.entries(plan.mutations).some(([field, values]) =>
          values.some(value => {
            const owner = value.sourceId ?? (field === "updateEntries" ?
              before.entries.find(e => e.eventKey === value.eventKey)?.sourceId :
              field === "closeRevisions" ? before.revisions.find(r => r.revisionKey === value.revisionKey)?.sourceId : null);
            return owner !== source.sourceId;
          }))) return failure("cross_source_mutation_risk");
        reason = plan.reason || null;
        if (plan.planStatus === "rejected") scope = "source_suspend_candidate";
        if (summary.changed > 0) { reason = "unsupported_changed"; scope = "source_suspend_candidate"; }
      } catch (_) { reason = "source_plan_failed"; scope = "source_local"; }
    }
    const counts = plan?.counts || emptyCounts(), eligible = plan?.planStatus === "planned" && !reason;
    for (const key of Gate.FIELDS) aggregate[key] += counts[key];
    if (plan) plans.push(plan);
    rows.push({ sourceId: source.sourceId, acquisition: source.acquisitionOutcome,
      routeIdentity: source.routeIdentity || null, candidate: source.canonicalRecords?.length || 0,
      formalActive: summary?.formalActive ?? before.entries.filter(e => e.sourceId === source.sourceId).length,
      unchanged: summary?.unchanged ?? 0, changed: summary?.changed ?? 0, new: summary?.new ?? 0,
      evidenceOnly: summary?.evidenceOnly ?? 0, notEvaluated: summary?.notEvaluated ?? 0,
      eligible, shadowPlanGenerated: plan?.planStatus === "planned", sourceWriteCandidateEligible: eligible,
      productionWriteEligible: false, writeAllowed: false, reason, failureScope: scope,
      counts, snapshotIdentity, planIdentity: plan?.planIdentity || null,
      acquisitionIdentity: plan?.acquisitionIdentity || null, candidateIdentity: plan?.candidateSetIdentity || null,
      retainedCandidateKeys: plan?.retainedCandidateKeys || source.canonicalRecords.map(r => r.eventKey),
      absenceAuthority: "none" });
  }
  reportedPerformance = { elapsedMs: performance.now() - started,
    snapshotBytes: context.metrics.canonicalMaterialBytes, ...context.metrics,
    records: Object.fromEntries(Object.keys(before).map(key => [key, before[key].length])) };
  reportedPerformance.perSourceAverageMs = reportedPerformance.elapsedMs / all.length;
  return { status: "evaluated", reason: null, mode: "internal_shadow",
    writerAuthorityState: "disabled", writeAllowed: false, writerExecution: 0, readwriteTransactions: 0,
    futureWriteRequiresFreshPlan: true, snapshotIdentity, endingSnapshotIdentity,
    readConsistency: "single_readonly_snapshot_not_current_db_write_authority",
    suspendIntegrationPoints: ["source_local_authority", "global_writer_authority", "restart_persistent_authority"],
    snapshotChanged: snapshotIdentity !== endingSnapshotIdentity, sourceRows: rows, plans,
    eligibleCount: rows.filter(r => r.eligible).length,
    ineligibleCount: rows.filter(r => !r.eligible).length,
    failedPartialCount: rows.filter(r => ["failed", "partial"].includes(r.acquisition)).length,
    aggregatePlannedCounts: aggregate, performance: reportedPerformance };
  } finally {
    if (!sharedCycle) Cycle.close(cycleContext);
    if (endingCycle !== cycleContext) Cycle.close(endingCycle);
    if (reportedPerformance) reportedPerformance.cacheDisposed = !sharedCycle;
  }
}
const evaluate = input => evaluateCycle(input);
function createPipeline({ readFormal, internalAuthority = INTERNAL_SHADOW } = {}) {
  if (typeof readFormal !== "function") throw TypeError("formal_read_required");
  let active = null, cycle = null, last = null;
  function capture(result) {
    if (!cycle) return;
    try {
      const source = projectAcquisition(result);
      if (cycle.has(source.sourceId)) throw Error("duplicate_acquisition");
      cycle.set(source.sourceId, source);
    } catch (_) { cycle.set("invalid", null); }
  }
  function check(request, execute) {
    if (active) return active;
    active = (async () => {
      cycle = new Map();
      const result = await execute();
      try {
        if (!cycle.size) last = { status: "skipped", reason: "no_fresh_acquisition",
          sourceRows: [], aggregatePlannedCounts: emptyCounts(), writeAllowed: false, writerExecution: 0 };
        else {
          const before = await readFormal(); // One consistent six-store readonly snapshot per cycle.
          if (before.status !== "ok") last = failure(before.reason || "formal_read_failed");
          else last = await evaluate({ sourceResults: [...cycle.values()], before: before.snapshot,
            schemaFingerprint: before.schemaFingerprint, internalAuthority });
        }
      } catch (_) { last = failure("shadow_evaluation_failed"); }
      return result; // No shadow diagnostic, candidate or plan is copied into IPC/presentation/Runtime State.
    })().finally(() => { active = null; cycle = null; });
    return active;
  }
  return Object.freeze({ capture, check, diagnostics: () => copy(last) });
}
module.exports = Object.freeze({ INTERNAL_SHADOW, projectAcquisition, evaluate, createPipeline, integrity,
  evaluateInIsolatedCycle: (input, token) => {
    if (!token) throw TypeError("isolated_cycle_required");
    return evaluateCycle(input, token);
  } });
