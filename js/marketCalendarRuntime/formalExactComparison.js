"use strict";

// D2d4 read-only comparison. This module has no storage or writer dependency.
const Registry = require("../marketCalendar/sourceRegistry.js");
const Canonicalizer = require("../marketCalendar/marketEventCanonicalizer.js");
const Integrity = require("../marketCalendarHistory/historyIntegrity.js");
const ShadowCycle = require("./formalShadowCycle.js");

// D2d4/E2/E3/E4 historical comparison scope; a future scope needs a new contract.
const SOURCE_IDS = Registry.HISTORICAL_SOURCE_IDS;
const HASH = /^[0-9a-f]{64}$/;
const key = value => `${value.sourceId}\u0000${value.eventKey}`;
const ordered = values => [...values].sort((a, b) => key(a).localeCompare(key(b)));
const fail = reason => Object.freeze({ status: "rejected", reason, summaries: [], differences: [],
  totals: null, ambiguityCount: 0 });
function coverageSummary(result) {
  const value = result.coverage;
  return value && typeof value === "object" ? {
    state: value.coverageState || value.coverageStatus || null,
    from: value.operationalRequiredFrom || null, through: value.operationalRequiredThrough || null,
    absenceAuthority: value.absenceAuthority || result.absenceAuthority || "none"
  } : { state: "unknown", from: null, through: null,
    absenceAuthority: result.absenceAuthority || "none" };
}
function semanticFields(value) {
  return { title: value.title, publicationDateTime: value.schedule,
    referencePeriod: value.logical?.referencePeriod, edition: value.logical?.edition,
    scope: value.logical?.scope };
}
function differentFields(before, after) {
  const a = semanticFields(before), b = semanticFields(after);
  return Object.keys(a).filter(field => Canonicalizer.stable(a[field]) !== Canonicalizer.stable(b[field]));
}
async function compare({ sourceResults, formalSnapshot, cycleContext } = {}) {
  if (!Array.isArray(sourceResults) || sourceResults.length !== SOURCE_IDS.length ||
      new Set(sourceResults.map(r => r?.sourceId)).size !== SOURCE_IDS.length ||
      sourceResults.some(r => !SOURCE_IDS.includes(r?.sourceId) ||
        !Array.isArray(r.canonicalRecords))) return fail("source_set_invalid");
  const names = ["entries", "revisions", "evidence", "observations", "runs", "cursors"];
  if (!formalSnapshot || names.some(name => !Array.isArray(formalSnapshot[name])))
    return fail("formal_snapshot_invalid");
  let cycle = null;
  if (cycleContext) {
    try { cycle = ShadowCycle.get(cycleContext, formalSnapshot); }
    catch (_) { return fail("shadow_cycle_invalid_or_closed"); }
  }
  const storage = cycle ? { valid: true } : Integrity.auditStorageSnapshot(formalSnapshot);
  if (!storage.valid) return fail("formal_storage_ambiguous");
  const integrity = cycle ? { valid: true } : await Integrity.audit(formalSnapshot);
  if (!integrity.valid) return fail("formal_integrity_invalid");
  const active = [], revisionByKey = cycle?.revisionByKey || new Map(formalSnapshot.revisions.map(r => [r.revisionKey, r]));
  if (cycle) active.push(...[...cycle.activeBySource.values()].flat());
  else for (const entry of formalSnapshot.entries) {
    const own = formalSnapshot.revisions.filter(r => r.eventKey === entry.eventKey && r.validTo === null);
    if (own.length !== 1 || own[0].revisionKey !== entry.activeRevisionKey ||
        own[0].sourceId !== entry.sourceId) return fail("formal_active_ambiguity");
    active.push({ ...own[0], eventKey: entry.eventKey, sourceId: entry.sourceId });
  }
  if (!cycle && formalSnapshot.revisions.some(r => r.validTo === null &&
      !formalSnapshot.entries.some(e => e.eventKey === r.eventKey)))
    return fail("formal_orphan_active_revision");
  const candidates = sourceResults.flatMap(r => r.canonicalRecords.map(record =>
    ({ ...record, sourceId: r.sourceId })));
  const seenEvents = new Map(), seenRevisions = new Set();
  for (const record of candidates) {
    const original = sourceResults.find(s => s.sourceId === record.sourceId).canonicalRecords
      .find(r => r.eventKey === record.eventKey && r.revisionKey === record.revisionKey);
    const validated = cycle && cycle.candidateValidation.get(original) === record.sourceId;
    if (!validated && (!record.eventKey || !HASH.test(record.canonicalContentHash || "") ||
        record.revisionKey !== `${record.eventKey}|sha256:${record.canonicalContentHash}` ||
        record.acquisitionEvidence?.sourceId !== record.sourceId ||
        (cycle ? ShadowCycle.sourceHash(cycle, Integrity.semanticContent(record)) :
          await Canonicalizer.sha256(Integrity.semanticContent(record))) !== record.canonicalContentHash))
      return fail("candidate_identity_invalid");
    if (cycle && !validated) { ShadowCycle.freeze(original); cycle.candidateValidation.set(original, record.sourceId); }
    if (seenEvents.has(record.eventKey)) return fail(seenEvents.get(record.eventKey) === record.canonicalContentHash
      ? "candidate_duplicate_event" : "candidate_semantic_conflict");
    if (seenRevisions.has(record.revisionKey)) return fail("candidate_duplicate_revision");
    seenEvents.set(record.eventKey, record.canonicalContentHash); seenRevisions.add(record.revisionKey);
  }
  const formalByKey = new Map(ordered(active).map(r => [key(r), r]));
  const candidateByKey = new Map(ordered(candidates).map(r => [key(r), r]));
  const evidenceByRevision = cycle?.evidenceUrls || new Map();
  if (!cycle) for (const evidence of formalSnapshot.evidence) {
    if (!revisionByKey.has(evidence.revisionKey)) return fail("formal_evidence_orphan");
    const urls = evidenceByRevision.get(evidence.revisionKey) || new Set();
    if (evidence.acquisitionEvidence?.sourceUrl) urls.add(evidence.acquisitionEvidence.sourceUrl);
    evidenceByRevision.set(evidence.revisionKey, urls);
  }
  const differences = [], summaries = [];
  for (const result of [...sourceResults].sort((a, b) => a.sourceId.localeCompare(b.sourceId))) {
    const sourceId = result.sourceId, ownCandidate = ordered(candidates.filter(r => r.sourceId === sourceId)),
      ownFormal = ordered(active.filter(r => r.sourceId === sourceId));
    const summary = { sourceId, candidate: ownCandidate.length, formalActive: ownFormal.length,
      unchanged: 0, changed: 0, new: 0, notEvaluated: 0, ambiguity: 0, evidenceOnly: 0,
      acquisitionOutcome: result.acquisitionOutcome || "unknown", candidateStatus: result.candidateStatus || "unknown",
      coverage: coverageSummary(result), failedRoles: [...(result.failedRoles || [])] };
    for (const candidate of ownCandidate) {
      const previous = formalByKey.get(key(candidate)), status = !previous ? "new" :
        previous.canonicalContentHash === candidate.canonicalContentHash &&
        previous.revisionKey === candidate.revisionKey ? "unchanged" : "changed";
      summary[status]++;
      const priorUrls = previous ? evidenceByRevision.get(previous.revisionKey) || new Set() : new Set(),
        candidateUrl = candidate.acquisitionEvidence?.sourceUrl || null,
        provenanceChanged = Boolean(previous && candidateUrl && !priorUrls.has(candidateUrl));
      if (status === "unchanged" && provenanceChanged) summary.evidenceOnly++;
      differences.push({ sourceId, eventKey: candidate.eventKey, status,
        previousRevisionKey: previous?.revisionKey || null, candidateRevisionKey: candidate.revisionKey,
        fields: status === "changed" ? differentFields(previous, candidate) : [],
        provenanceChanged, formalEvidenceUrlCount: priorUrls.size,
        candidateEvidenceUrl: candidateUrl,
        coverage: status === "new" ? summary.coverage : undefined });
    }
    for (const previous of ownFormal) if (!candidateByKey.has(key(previous))) {
      summary.notEvaluated++;
      differences.push({ sourceId, eventKey: previous.eventKey, status: "formal_only_not_evaluated",
        previousRevisionKey: previous.revisionKey, candidateRevisionKey: null,
        fields: [], provenanceChanged: false, coverage: summary.coverage,
        formalEventDate: previous.calendarDateStart || null });
    }
    summaries.push(summary);
  }
  differences.sort((a, b) => a.sourceId.localeCompare(b.sourceId) ||
    a.eventKey.localeCompare(b.eventKey) || a.status.localeCompare(b.status));
  const totals = Object.fromEntries(["candidate", "formalActive", "unchanged", "changed", "new",
    "notEvaluated", "ambiguity", "evidenceOnly"].map(field =>
    [field, summaries.reduce((sum, item) => sum + item[field], 0)]));
  return Object.freeze({ status: "compared", reason: null, summaries, differences, totals,
    ambiguityCount: 0, writerEnabled: false, absenceAuthority: "none" });
}
module.exports = Object.freeze({ SOURCE_IDS, compare });
