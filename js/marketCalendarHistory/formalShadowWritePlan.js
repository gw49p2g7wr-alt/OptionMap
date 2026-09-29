"use strict";

// E2a is a pure, memory-only projection. It cannot open IndexedDB or invoke a writer.
const Registry = require("../marketCalendar/sourceRegistry.js");
const Canonicalizer = require("../marketCalendar/marketEventCanonicalizer.js");
const Schema = require("./productionSchemaV1.js");
const Contract = require("./historyContract.js");
const Transition = require("./transitionPlanner.js");
const Mapper = require("./storageRecordMapper.js");
const Compare = require("../marketCalendarRuntime/formalExactComparison.js");
const Authority = require("./formalWriterAuthority.js");

const PLAN_VERSION = 1;
const HASH = /^[0-9a-f]{64}$/;
const FIELDS = Object.freeze({ appendEntries: "eventKey", updateEntries: "eventKey",
  closeRevisions: "revisionKey", appendRevisions: "revisionKey",
  appendEvidence: "evidenceLinkKey", appendObservations: "observationKey",
  appendRuns: "runKey", updateCursors: "sourceId" });
const SNAPSHOT_FIELDS = Object.freeze({ entries: "eventKey", revisions: "revisionKey",
  evidence: "evidenceLinkKey", observations: "observationKey", runs: "runKey",
  cursors: "sourceId" });
const clone = value => structuredClone(value);
const frozen = value => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(frozen); Object.freeze(value);
  }
  return value;
};
const sorted = (values, key) => [...values].sort((a, b) =>
  String(a[key]).localeCompare(String(b[key])));
const same = (left, right) => Canonicalizer.stable(left) === Canonicalizer.stable(right);
const emptyMutations = () => Object.fromEntries(Object.keys(FIELDS).map(field => [field, []]));
function containsRawPayload(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return false;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, item]) =>
    /^(rawBody|responseBody|rawHtml|rawXml|body|bytes|html|xml|blob|contentBytes)$/i.test(key) ||
    containsRawPayload(item, seen));
}
const countsFor = mutations => ({ eventEntryCreate: mutations.appendEntries.length,
  eventEntryUpdate: mutations.updateEntries.length,
  semanticRevisionCreate: mutations.appendRevisions.length,
  semanticRevisionClose: mutations.closeRevisions.length,
  evidenceCreate: mutations.appendEvidence.length,
  observationCreate: mutations.appendObservations.length,
  sourceRunCreate: mutations.appendRuns.length,
  sourceCursorUpdate: mutations.updateCursors.length });
function formalLinkageValid(snapshot) {
  const entries = new Map(snapshot.entries.map(value => [value.eventKey, value]));
  const revisions = new Map(snapshot.revisions.map(value => [value.revisionKey, value]));
  const runs = new Map(snapshot.runs.map(value => [value.runKey, value]));
  if (snapshot.evidence.some(value => {
    const revision = revisions.get(value.revisionKey),
      run = runs.get(`${value.sourceId}|${value.runId}`);
    return !revision || revision.eventKey !== value.eventKey ||
      revision.sourceId !== value.sourceId || !run;
  }) || snapshot.observations.some(value => {
    const entry = entries.get(value.eventKey), run = runs.get(`${value.sourceId}|${value.runId}`);
    return !entry || entry.sourceId !== value.sourceId || !run;
  })) return false;
  for (const cursor of snapshot.cursors) {
    const own = snapshot.runs.filter(value => value.sourceId === cursor.sourceId)
      .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt) ||
        b.runId.localeCompare(a.runId));
    if (!own.length || own[0].runKey !== cursor.runKey ||
        own[0].acceptedAt !== cursor.acceptedAt) return false;
  }
  return true;
}
function rejected(sourceId, reason, retainedCandidateKeys = []) {
  const mutations = emptyMutations();
  return frozen({ planStatus: "rejected", reason, sourceId: sourceId || null,
    writerState: "shadow", writeAllowed: false, mutations,
    counts: countsFor(mutations), retainedCandidateKeys: [...retainedCandidateKeys].sort(),
    planIdentity: null });
}
async function skipped(sourceId, reason, records, comparisonSummary = null, sourceOutcome = null) {
  const mutations = emptyMutations(), retainedCandidateKeys =
    records.map(record => record.eventKey).sort();
  const base = { planVersion: PLAN_VERSION, planStatus: "skipped", sourceId,
    reason, sourceOutcome, writerState: "shadow", writeAllowed: false,
    authorityIdentity: Authority.SHADOW_AUTHORITY.identity,
    skippedNotEvaluated: comparisonSummary?.notEvaluated || 0,
    retainedCandidateKeys, mutations, counts: countsFor(mutations) };
  return frozen({ ...base, planIdentity: await Canonicalizer.sha256(base) });
}
async function validateShadowPlan(plan) {
  if (!plan || plan.planVersion !== PLAN_VERSION || plan.planStatus !== "planned" ||
      plan.writerState !== "shadow" || plan.writeAllowed !== false ||
      !Registry.getSource(plan.sourceId) ||
      plan.authorityIdentity !== Authority.SHADOW_AUTHORITY.identity ||
      plan.sourceOutcome !== "complete" ||
      ![plan.schemaFingerprint, plan.preconditionIdentity, plan.activeFormalIdentity,
        plan.candidateSetIdentity, plan.acquisitionIdentity, plan.comparisonIdentity,
        plan.planIdentity].every(value => HASH.test(value || "")) ||
      !plan.mutations || !same(Object.keys(plan.mutations).sort(), Object.keys(FIELDS).sort()) ||
      Object.entries(FIELDS).some(([field, key]) => !Array.isArray(plan.mutations[field]) ||
        plan.mutations[field].some(value => !value || typeof value[key] !== "string" || !value[key]) ||
        new Set(plan.mutations[field].map(value => value[key])).size !== plan.mutations[field].length) ||
      !same(plan.counts, countsFor(plan.mutations)) ||
      plan.mutations.appendRuns.length !== 1 || plan.mutations.updateCursors.length !== 1 ||
      plan.mutations.appendRuns[0].sourceId !== plan.sourceId ||
      plan.mutations.updateCursors[0].sourceId !== plan.sourceId ||
      plan.mutations.updateCursors[0].runKey !== plan.mutations.appendRuns[0].runKey ||
      plan.mutations.appendObservations.some(value =>
        value.sourceId !== plan.sourceId || value.runId !== plan.mutations.appendRuns[0].runId) ||
      plan.mutations.appendEvidence.some(value =>
        value.sourceId !== plan.sourceId || value.runId !== plan.mutations.appendRuns[0].runId) ||
      plan.mutations.appendEntries.some(value => plan.mutations.updateEntries.some(other =>
        other.eventKey === value.eventKey)) ||
      plan.mutations.appendRevisions.some(value => plan.mutations.closeRevisions.some(other =>
        other.revisionKey === value.revisionKey)))
    return frozen({ valid: false, reason: "shadow_plan_invalid" });
  const { planIdentity, ...material } = plan;
  if (await Canonicalizer.sha256(material) !== planIdentity)
    return frozen({ valid: false, reason: "plan_identity_mismatch" });
  return frozen({ valid: true, reason: null });
}
async function buildSourceShadowPlan(input = {}) {
  const { sourceId, sourceResult, comparison, formalSnapshot, schemaFingerprint, run } = input;
  if (!Registry.getSource(sourceId)) return rejected(sourceId, "source_unknown");
  const selected = Authority.selectWriterState(sourceId, Authority.SHADOW_AUTHORITY);
  if (!selected.valid || selected.state !== "shadow") return rejected(sourceId, "writer_authority_invalid");
  if (schemaFingerprint !== Schema.EXPECTED_FINGERPRINT)
    return rejected(sourceId, "schema_fingerprint_mismatch");
  if (!sourceResult || sourceResult.sourceId !== sourceId ||
      !Array.isArray(sourceResult.canonicalRecords) || containsRawPayload(sourceResult) ||
      containsRawPayload(run))
    return rejected(sourceId, "source_result_invalid");
  const records = sourceResult.canonicalRecords;
  if (sourceResult.acquisitionOutcome !== "complete" ||
      sourceResult.candidateStatus !== "available" ||
      sourceResult.failedRoles?.length)
    return skipped(sourceId, "source_incomplete", records, null,
      sourceResult.acquisitionOutcome || "unknown");
  if (!records.length || !Array.isArray(sourceResult.documentHealth) ||
      !sourceResult.documentHealth.length || sourceResult.documentHealth.some(role =>
        role.fetchOutcome !== "success" || role.parseOutcome !== "success"))
    return rejected(sourceId, "document_set_incomplete");
  if (sourceId === "us-bls-calendar" &&
      !same(sourceResult.documentHealth.map(role => role.role).sort(),
        ["cpi", "ppi", "employment_situation", "jolts"].sort()))
    return rejected(sourceId, "document_set_incomplete");
  if (!formalSnapshot || Object.entries(SNAPSHOT_FIELDS).some(([field]) =>
      !Array.isArray(formalSnapshot[field])) || !comparison)
    return rejected(sourceId, "comparison_or_snapshot_invalid");
  if (!formalLinkageValid(formalSnapshot))
    return rejected(sourceId, "formal_snapshot_linkage_invalid");
  if (comparison.status !== "compared")
    return rejected(sourceId, comparison.reason || "comparison_rejected");
  const allResults = Compare.SOURCE_IDS.map(id => id === sourceId ? sourceResult :
    { sourceId: id, canonicalRecords: [], acquisitionOutcome: "not_attempted",
      candidateStatus: "unavailable", absenceAuthority: "none" });
  const checked = await Compare.compare({ sourceResults: allResults, formalSnapshot });
  if (checked.status !== "compared") return rejected(sourceId, checked.reason);
  const summary = checked.summaries.find(value => value.sourceId === sourceId),
    supplied = comparison.summaries?.find(value => value.sourceId === sourceId),
    differences = checked.differences.filter(value => value.sourceId === sourceId),
    suppliedDifferences = comparison.differences?.filter(value => value.sourceId === sourceId);
  if (!same(summary, supplied) || !same(differences, suppliedDifferences))
    return rejected(sourceId, "comparison_identity_mismatch");
  if (!selected.writeEligible)
    return skipped(sourceId, selected.reason, records, summary, "complete");
  const previousRun = run && formalSnapshot.runs.find(value => value.sourceId === sourceId &&
    value.runId === run.runId);
  if (previousRun) return same(previousRun,
    { ...run, runKey: `${sourceId}|${run.runId}`, contractVersion: Contract.CONTRACT_VERSION }) ?
    skipped(sourceId, "already_committed", records, summary, "complete") :
    rejected(sourceId, "duplicate_run_conflict");
  if (!run || Object.keys(run).sort().join("|") !==
        ["sourceId", "runId", "acceptedAt", "fetchedAt", "status", "semanticSetHash"].sort().join("|") ||
      run.sourceId !== sourceId ||
      !Contract.validateAcceptedRun(run, { previousAcceptedAt:
        formalSnapshot.cursors.find(value => value.sourceId === sourceId)?.acceptedAt || null }).valid)
    return rejected(sourceId, "accepted_run_invalid");
  const semanticSetHash = await Canonicalizer.sha256(records.map(value => value.revisionKey).sort());
  if (run.semanticSetHash !== semanticSetHash)
    return rejected(sourceId, "candidate_set_identity_mismatch");
  const transition = Transition.planTransition({ snapshot: formalSnapshot, run,
    canonicalSet: sorted(records, "eventKey"), coverage: null, parserChanged: false });
  if (!transition.ok || !transition.plan)
    return rejected(sourceId, `transition_${transition.outcome}`);
  const mapped = Mapper.mapPlan(transition.plan), mutations = Object.fromEntries(
    Object.keys(FIELDS).map(field => [field, clone(mapped[field])]));
  const existingEvidence = new Map(formalSnapshot.evidence.map(value =>
    [value.evidenceLinkKey, value]));
  const filteredEvidence = [];
  for (const value of mutations.appendEvidence) {
    const prior = existingEvidence.get(value.evidenceLinkKey);
    if (!prior) filteredEvidence.push(value);
    else if (prior.revisionKey !== value.revisionKey ||
             prior.acquisitionEvidenceHash !== value.acquisitionEvidenceHash)
      return rejected(sourceId, "evidence_identity_conflict");
  }
  mutations.appendEvidence = filteredEvidence;
  for (const [field, key] of Object.entries(FIELDS)) {
    const values = mutations[field].map(value => value[key]);
    if (new Set(values).size !== values.length)
      return rejected(sourceId, `duplicate_${field}`);
  }
  if (mutations.appendObservations.some(value => formalSnapshot.observations.some(existing =>
    existing.observationKey === value.observationKey)))
    return rejected(sourceId, "observation_identity_conflict");
  const normalizedSnapshot = Object.fromEntries(Object.entries(SNAPSHOT_FIELDS).map(
    ([field, key]) => [field, sorted(formalSnapshot[field], key)]));
  const preconditionIdentity = await Canonicalizer.sha256({ schemaFingerprint,
    formalSnapshot: normalizedSnapshot });
  const activeFormalIdentity = await Canonicalizer.sha256(sorted(formalSnapshot.entries,
    "eventKey").map(value => ({ sourceId: value.sourceId, eventKey: value.eventKey,
      activeRevisionKey: value.activeRevisionKey })));
  const candidateSetIdentity = await Canonicalizer.sha256(sorted(records, "eventKey").map(value =>
    ({ eventKey: value.eventKey, revisionKey: value.revisionKey,
      acquisitionEvidenceKey: value.acquisitionEvidenceKey })));
  const acquisitionIdentity = await Canonicalizer.sha256({ run,
    documentHealth: sourceResult.documentHealth, coverage: sourceResult.coverage || null,
    absenceAuthority: sourceResult.absenceAuthority || "none" });
  const comparisonIdentity = await Canonicalizer.sha256({ summary, differences });
  const base = { planVersion: PLAN_VERSION, planStatus: "planned", sourceId,
    sourceOutcome: "complete",
    writerState: "shadow", writeAllowed: false,
    authorityIdentity: Authority.SHADOW_AUTHORITY.identity,
    schemaFingerprint, preconditionIdentity, activeFormalIdentity, candidateSetIdentity,
    acquisitionIdentity, comparisonIdentity,
    skippedNotEvaluated: summary.notEvaluated,
    retainedCandidateKeys: records.map(value => value.eventKey).sort(),
    mutations, counts: countsFor(mutations),
    transactionPreparation: "all_hashes_before_transaction" };
  const planIdentity = await Canonicalizer.sha256(base), plan = frozen({ ...base, planIdentity });
  const validation = await validateShadowPlan(plan);
  if (!validation.valid) return rejected(sourceId, validation.reason);
  return plan;
}

module.exports = Object.freeze({ PLAN_VERSION, buildSourceShadowPlan, validateShadowPlan });
