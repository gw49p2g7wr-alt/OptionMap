"use strict";

// Trusted isolated main capability; no production issuer or renderer-controlled trigger.
const A = require("./formalWriterAuthorityV2.js"), E = require("./mofStartupCanaryEnvelope.js");
const Compare = require("../marketCalendarRuntime/formalExactComparison.js").createNormal13Comparison();
const Cycle = require("../marketCalendarRuntime/formalShadowCycle.js"), Schema = require("./productionSchemaV1.js");
const Core = require("./formalControlledWriterCore.js"), Shadow = require("./formalShadowWritePlan.js");
const Transition = require("./transitionPlanner.js"), Mapper = require("./storageRecordMapper.js");
const Writer = require("./formalWriterAuthority.js"), Integrity = require("./historyIntegrity.js");
const C = require("../marketCalendar/marketEventCanonicalizer.js"), Registry = require("../marketCalendar/sourceRegistry.js");
const Mof = require("../marketCalendarIsolated/mofJgbVariableAdapter.js"), Route = require("../marketCalendarIsolated/mofJgbSource.js");
const B1 = require("../marketCalendarRuntime/sourceUpdateState.js"), contexts = new WeakMap(), preparations = new WeakMap();
function createIsolatedStartupContext(input) {
  if (!A.exact(input, ["targetEnvironment", "cycleIdentity", "checkedAt"])) throw Error("canary_startup_context_invalid");
  const { targetEnvironment, cycleIdentity, checkedAt } = input;
  if (process.type === "renderer" || typeof window !== "undefined" && window.document || targetEnvironment !== "isolated_test" ||
      !A.isHash(cycleIdentity) || !Number.isFinite(Date.parse(checkedAt))) throw Error("canary_startup_context_invalid");
  const token = Object.freeze({}); contexts.set(token, { cycleIdentity, checkedAt, spent: false }); return token;
}
function createProductionStartupContext(proof){
  if(process.type!=="browser"||!process.versions.electron)throw Error("native_main_required");
  const binding=require("../marketCalendarRuntime/mofStartupPersistenceBridge.js").consumeProof(proof,true),token=Object.freeze({});
  contexts.set(token,{cycleIdentity:binding.cycleIdentity,checkedAt:binding.checkedAt,spent:false,persistence:binding});return token;
}
// Stop-only coordination hook for a pre-existing Machinery attempt. It never
// issues/changes Machinery authority; trusted composition must reserve the
// cycle before either source's writer. No production wiring in this Gate.
function observeExistingMachineryAttempt(context, receipt) {
  const ctx = contexts.get(context);
  if (!ctx || ctx.spent || !A.exact(receipt, ["sourceId", "cycleIdentity", "attemptIdentity"]) ||
      receipt.sourceId !== "jp-esri-machinery-orders-calendar" || receipt.cycleIdentity !== ctx.cycleIdentity || !A.isHash(receipt.attemptIdentity))
    throw Error("canary_cycle_attempt_unavailable");
  ctx.spent = true;
}
async function prepare({ context, record, source, sourceOutcome, runtimeState, snapshot }) {
  const ctx = contexts.get(context);
  if (!ctx || ctx.spent) throw Error("canary_startup_context_unknown_or_spent"); ctx.spent = true;
  record = structuredClone(record); sourceOutcome = structuredClone(sourceOutcome); runtimeState = structuredClone(runtimeState);
  // Source-local decision: aggregate BLS status is never an authority input.
  if (!E.validate(record).valid || record.lifecycleAudit.length || record.safety.pendingFence || record.safety.globalSuspend.suspended ||
      record.safety.sources.some(s => s.suspended)) throw Error("canary_safety_unavailable");
  if (sourceOutcome?.sourceId !== E.SOURCE) throw Error("canary_source_invalid");
  if (sourceOutcome.acquisitionStatus === "not_attempted" && sourceOutcome.reasonClass === "already_succeeded_today")
    return Object.freeze({ status: "skipped", reason: "already_succeeded_today", writerAttempts: 0 });
  if (sourceOutcome.status !== "success" || sourceOutcome.acquisitionStatus !== "succeeded" || sourceOutcome.planningDecision !== "update" ||
      !B1.validateCompatibleRuntimeState(runtimeState, E.SOURCE).valid || runtimeState.lastOutcome !== "success" ||
      runtimeState.lastAttemptAt !== ctx.checkedAt || runtimeState.lastSuccessAt !== ctx.checkedAt)
    throw Error("canary_fresh_normal_acquisition_required");
  source = structuredClone(source);
  if (source?.sourceId !== E.SOURCE || source.routeIdentity !== Mof.routeIdentity || source.acquisitionOutcome !== "complete" ||
      source.candidateStatus !== "available" || source.absenceAuthority !== "none" || !Array.isArray(source.failedRoles) || source.failedRoles.length ||
      !Array.isArray(source.canonicalRecords) || !source.canonicalRecords.length || !Array.isArray(source.documentHealth) ||
      source.documentHealth.filter(d => d.role === "index").length !== 1 || new Set(source.documentHealth.map(d => d.role)).size !== source.documentHealth.length ||
      source.documentHealth.some(d => d.httpStatus !== 200 || d.redirectCount !== 0 || d.fetchOutcome !== "success" || d.parseOutcome !== "success"))
    throw Error("canary_acquisition_invalid");
  const records = source.canonicalRecords, meta = Registry.getSource(E.SOURCE);
  const candidateIdentity = A.hash({ sourceId: E.SOURCE, parserId: meta.parserId, parserVersion: meta.parserVersion,
    candidateSchemaVersion: 1, revisionKeys: records.map(r => r.revisionKey).sort() });
  if (source.candidateIdentity !== candidateIdentity) throw Error("canary_candidate_identity_invalid");
  for (const r of records) {
    const ev = r.acquisitionEvidence, a = r.logical?.auctionIdentity;
    if (!a || r.logical.jurisdiction !== "JP" || r.logical.authority !== "MOF" || r.logical.eventType !== "JP_JGB_AUCTION" ||
        r.logical.authorityEventId !== null || a.authority !== "MOF" || a.eventType !== "JP_JGB_AUCTION" || a.instrumentClass !== "normal_fixed_rate_jgb" ||
        !["2Y", "5Y", "10Y", "20Y", "30Y", "40Y"].includes(a.maturity) || !Route.validDate(a.auctionDate) ||
        r.eventKey !== ["JP", "MOF", "JP_JGB_AUCTION", a.instrumentClass, a.maturity, a.auctionDate].join("|") ||
        r.logical.eventKey !== r.eventKey || r.canonicalContentHash !== A.hash(Integrity.semanticContent(r)) ||
        r.revisionKey !== `${r.eventKey}|sha256:${r.canonicalContentHash}` || r.lifecycleStatus !== "scheduled" || r.absenceAuthority !== "none" ||
        r.schedule.kind !== "date_only" || r.schedule.sourceLocal.startDate !== a.auctionDate || r.schedule.sourceLocal.startTime !== null ||
        r.schedule.sourceLocal.timeZone !== "Asia/Tokyo" || !Core.same(r.source, ev) || ev?.sourceId !== E.SOURCE ||
        ev.authority !== "MOF" || ev.parserId !== meta.parserId || ev.parserVersion !== meta.parserVersion ||
        !Route.validateUrl(ev.sourceUrl).valid || !Route.pageMonth(ev.sourceUrl) || !a.auctionDate.startsWith(Route.pageMonth(ev.sourceUrl) + "-") ||
        ev.httpMetadata?.role !== `month:${Route.pageMonth(ev.sourceUrl)}` || !A.isHash(ev.httpMetadata?.documentSetIdentity) ||
        !source.documentHealth.some(d => d.role === `month:${Route.pageMonth(ev.sourceUrl)}`) ||
        ev.httpMetadata?.httpStatus !== 200 || ev.httpMetadata?.encodingEvidence?.resolvedEncoding !== "utf-8" ||
        !A.isHash(ev.rawContentHash) || !Number.isFinite(Date.parse(ev.fetchedAt)) || Date.parse(ev.fetchedAt) > Date.parse(ctx.checkedAt) ||
        Date.parse(ctx.checkedAt) - Date.parse(ev.fetchedAt) > 300000 || A.hash(ev) !== r.acquisitionEvidenceHash ||
        r.acquisitionEvidenceKey !== `${E.SOURCE}|sha256:${r.acquisitionEvidenceHash}`) throw Error("canary_canonical_evidence_invalid");
  }
  const before = structuredClone(snapshot), cycle = Cycle.create(before, Schema.EXPECTED_FINGERPRINT);
  try {
    if(ctx.persistence&&(ctx.persistence.runtimeIdentity!==A.hash(runtimeState)||ctx.persistence.acquisitionIdentity!==
      A.hash({source,runtimeState,checkedAt:ctx.checkedAt})))throw Error("canary_persistence_binding_invalid");
    const comparison = await Compare.compare({ sourceResults: Compare.SOURCE_IDS.map(id => id === E.SOURCE ? source :
      { sourceId: id, canonicalRecords: [], acquisitionOutcome: "not_attempted", candidateStatus: "unavailable", absenceAuthority: "none" }),
      formalSnapshot: before, cycleContext: cycle });
    const own = comparison.summaries.find(s => s.sourceId === E.SOURCE);
    if (comparison.status !== "compared" || !own || own.changed || own.evidenceOnly || own.ambiguity || comparison.ambiguityCount)
      throw Error("canary_comparison_unsafe");
    if (!own.new) return A.freeze({ status: "skipped", reason: "unchanged", writerAttempts: 0, comparison: own });
    if (own.new !== 1) throw Error("canary_new_event_ceiling_exceeded");
    const key = comparison.differences.find(d => d.sourceId === E.SOURCE && d.status === "new").eventKey;
    const attemptIdentity = A.hash({ cycle: ctx.cycleIdentity, safety: record.checksum, candidateIdentity });
    const acquisitionIdentity = A.hash({ source, runtimeState, checkedAt: ctx.checkedAt });
    const run = { sourceId: E.SOURCE, runId: `mof-startup-canary-${attemptIdentity}`, acceptedAt: ctx.checkedAt,
      fetchedAt: [...new Set(records.map(r => r.acquisitionEvidence.fetchedAt))].sort(), semanticSetHash: A.hash(records.map(r => r.revisionKey).sort()), status: "accepted" };
    const transition = Transition.planTransition({ snapshot: before, run, canonicalSet: records });
    if (!transition.ok || !transition.plan) throw Error("canary_transition_invalid");
    // Plan the full source, then retain ONLY the fresh new identity. Existing
    // unchanged entries/evidence/observations are never queued for this canary.
    const mapped = Mapper.mapPlan(transition.plan);
    const mutations = { appendEntries: mapped.appendEntries, updateEntries: [], closeRevisions: [], appendRevisions: mapped.appendRevisions,
      appendEvidence: mapped.appendEvidence.filter(v => v.eventKey === key), appendObservations: mapped.appendObservations.filter(v => v.eventKey === key),
      appendRuns: mapped.appendRuns, updateCursors: mapped.updateCursors };
    if (mutations.appendEntries.length !== 1 || mutations.appendEntries[0].eventKey !== key || mutations.appendRevisions.length !== 1 ||
        mutations.appendRevisions[0].eventKey !== key || mutations.appendEvidence.length !== 1 || mutations.appendObservations.length !== 1)
      throw Error("canary_new_only_plan_invalid");
    const base = { planVersion: Shadow.PLAN_VERSION, planStatus: "planned", sourceId: E.SOURCE, sourceOutcome: "complete", writerState: "shadow",
      writeAllowed: false, authorityIdentity: Writer.SHADOW_AUTHORITY.identity, schemaFingerprint: Schema.EXPECTED_FINGERPRINT,
      preconditionIdentity: Cycle.get(cycle, before).snapshotIdentity, activeFormalIdentity: A.hash(before.entries),
      candidateSetIdentity: A.hash(records), acquisitionIdentity, comparisonIdentity: A.hash(comparison), retainedCandidateKeys: records.map(r => r.eventKey).sort(),
      mutations, counts: E.COUNTS, transactionPreparation: "all_hashes_before_transaction" };
    const plan = A.freeze({ ...base, planIdentity: A.hash(base) });
    if (!(await Shadow.validateShadowPlan(plan)).valid) throw Error("canary_shadow_plan_invalid");
    const expected = Core.applyToMemory(before, plan, Core.expectedWrites(plan, before));
    const valid = Cycle.create(expected, Schema.EXPECTED_FINGERPRINT); Cycle.close(valid);
    const token = Object.freeze({});
    const data = A.freeze({ plan, before: Core.sorted(before), expected, attemptIdentity, cycleIdentity: ctx.cycleIdentity,
      candidateIdentity, runtimeIdentity: A.hash(runtimeState), semanticPlanIdentity: A.hash({ key, hash: records.find(r => r.eventKey === key).canonicalContentHash,
        mutationClass: "new-only", counts: E.COUNTS, authority: E.AUTHORITY.identity }), acquisitionIdentity,
      comparisonIdentity: base.comparisonIdentity, formalPrecondition: base.preconditionIdentity, planIdentity: plan.planIdentity,
      safetySequence: record.safety.sequence, safetyIdentity: record.safety.validationIdentity,
      ...(ctx.persistence?{productionStartup:true,persistenceBinding:ctx.persistence}:{}) });
    preparations.set(token, { data, spent: false }); return Object.freeze({ status: "prepared", preparation: token, comparison: own });
  } finally { Cycle.close(cycle); }
}
function inspect(token) { const p = preparations.get(token); if (!p || p.spent) throw Error("canary_preparation_unknown_or_spent"); return p.data; }
function consume(token) { const d = inspect(token); preparations.get(token).spent = true; return d; }
module.exports = Object.freeze({ createIsolatedStartupContext, createProductionStartupContext, observeExistingMachineryAttempt, prepare, inspect, consume });
