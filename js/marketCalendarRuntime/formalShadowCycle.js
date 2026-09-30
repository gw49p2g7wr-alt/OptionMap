"use strict";

// Opaque, cycle-local read context. No writer, DB, IPC, network or persistent cache.
const { createHash } = require("node:crypto");
const Canonical = require("../marketCalendar/marketEventCanonicalizer.js");
const Integrity = require("../marketCalendarHistory/historyIntegrity.js");
const Contract = require("../marketCalendarHistory/historyContract.js");
const Schema = require("../marketCalendarHistory/productionSchemaV1.js");
const Registry = require("../marketCalendar/sourceRegistry.js");
const KEYS = Object.freeze({ entries: "eventKey", revisions: "revisionKey", evidence: "evidenceLinkKey",
  observations: "observationKey", runs: "runKey", cursors: "sourceId" });
const contexts = new WeakMap();
let activeContexts = 0;
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function digest(text) { return createHash("sha256").update(text).digest("hex"); }
function sourceHash(context, value) {
  context.metrics.sourceDerivedHashCount++;
  const material = Canonical.stable(value);
  context.metrics.peakDerivedMaterialBytes = Math.max(context.metrics.peakDerivedMaterialBytes,
    Buffer.byteLength(material));
  return digest(material);
}
function create(snapshot, schemaFingerprint) {
  if (schemaFingerprint !== Schema.EXPECTED_FINGERPRINT) throw Error("schema_fingerprint_mismatch");
  if (!snapshot || Object.keys(snapshot).sort().join("|") !== Object.keys(KEYS).sort().join("|") ||
      Object.keys(KEYS).some(k => !Array.isArray(snapshot[k]))) throw Error("formal_snapshot_invalid");
  const start = performance.now(), token = Object.freeze({}), metrics = {
    snapshotValidationCount: 1, fullSnapshotSortCount: 1, storeSortCount: 6, fullSnapshotHashCount: 0,
    sourceDerivedHashCount: 0, historicalIntegrityHashCount: 0, fullMaterialCopies: 0,
    peakCanonicalChunkBytes: 0, peakDerivedMaterialBytes: 0,
    canonicalMaterialBytes: 0, referenceArrayBytes: 0 };
  const sorted = Object.fromEntries(Object.entries(KEYS).map(([field, key]) => [field,
    [...snapshot[field]].sort((a, b) => String(a[key]).localeCompare(String(b[key])))]));
  // Records are shared by reference, never cloned per source. Freeze makes validation reusable safely.
  for (const rows of Object.values(sorted)) { metrics.referenceArrayBytes += rows.length * 8;
    rows.forEach(freeze); Object.freeze(rows); }
  Object.freeze(sorted);
  // Also lock the original containers: an await in a derived planner must not permit
  // replacing/appending rows after this cycle's validation and precondition hash.
  Object.values(snapshot).forEach(Object.freeze); Object.freeze(snapshot);
  const entryByKey = new Map(sorted.entries.map(e => [e.eventKey, e]));
  const revisionByKey = new Map(sorted.revisions.map(r => [r.revisionKey, r]));
  const runByKey = new Map(sorted.runs.map(r => [r.runKey, r]));
  const evidenceByKey = new Map(sorted.evidence.map(e => [e.evidenceLinkKey, e]));
  const evidenceUrls = new Map(), activeBySource = new Map(), latestRuns = new Map();
  const revisionsByEvent = new Map();
  if (!Integrity.auditStorageSnapshot(sorted).valid) throw Error("formal_storage_ambiguous");
  for (const run of sorted.runs) {
    if (!Registry.getSource(run.sourceId) || !Contract.validateAcceptedRun(run).valid ||
        run.runKey !== `${run.sourceId}|${run.runId}`) throw Error("formal_run_invalid");
    const old = latestRuns.get(run.sourceId);
    if (!old || run.acceptedAt > old.acceptedAt || run.acceptedAt === old.acceptedAt && run.runId > old.runId)
      latestRuns.set(run.sourceId, run);
  }
  for (const revision of sorted.revisions) {
    metrics.historicalIntegrityHashCount++;
    const hash = digest(Canonical.stable(Integrity.semanticContent(revision)));
    if (!Contract.validateRevisionShape(revision).valid ||
        revision.canonicalContentHash !== hash || revision.revisionKey !== `${revision.eventKey}|sha256:${hash}` ||
        entryByKey.get(revision.eventKey)?.sourceId !== revision.sourceId) throw Error("formal_revision_invalid");
    const own = revisionsByEvent.get(revision.eventKey) || []; own.push(revision); revisionsByEvent.set(revision.eventKey, own);
  }
  for (const entry of sorted.entries) {
    const own = (revisionsByEvent.get(entry.eventKey) || []).sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    const active = own.filter(r => r.validTo === null);
    if (active.length !== 1 || active[0].revisionKey !== entry.activeRevisionKey || active[0].sourceId !== entry.sourceId ||
        own.some((r, i) => i > 0 && own[i - 1].validTo !== r.validFrom)) throw Error("formal_active_ambiguity");
    const list = activeBySource.get(entry.sourceId) || []; list.push(active[0]); activeBySource.set(entry.sourceId, list);
  }
  for (const evidence of sorted.evidence) {
    metrics.historicalIntegrityHashCount++;
    const hash = digest(Canonical.stable(evidence.acquisitionEvidence)), revision = revisionByKey.get(evidence.revisionKey);
    if (!Contract.validateEvidenceShape(evidence).valid || evidence.acquisitionEvidenceHash !== hash ||
        evidence.acquisitionEvidenceKey !== `${evidence.sourceId}|sha256:${hash}` ||
        !revision || revision.eventKey !== evidence.eventKey || revision.sourceId !== evidence.sourceId ||
        !runByKey.has(`${evidence.sourceId}|${evidence.runId}`)) throw Error("formal_evidence_invalid");
    const urls = evidenceUrls.get(evidence.revisionKey) || new Set();
    if (evidence.acquisitionEvidence.sourceUrl) urls.add(evidence.acquisitionEvidence.sourceUrl);
    evidenceUrls.set(evidence.revisionKey, urls);
  }
  for (const observation of sorted.observations) {
    if (!Contract.validateObservation(observation).valid || entryByKey.get(observation.eventKey)?.sourceId !== observation.sourceId ||
        !runByKey.has(`${observation.sourceId}|${observation.runId}`)) throw Error("formal_observation_invalid");
  }
  for (const cursor of sorted.cursors) {
    const run = latestRuns.get(cursor.sourceId);
    if (!run || run.runKey !== cursor.runKey || run.acceptedAt !== cursor.acceptedAt)
      throw Error("formal_cursor_invalid");
  }
  // Stream the exact stable serializer grammar, including every historical record and every field.
  // Unlike stable(fullSnapshot) + TextEncoder this never holds/copies a 143MB string/buffer.
  const hash = createHash("sha256");
  let fullBytes = 0;
  function emit(text) { const bytes = Buffer.byteLength(text); fullBytes += bytes;
    metrics.peakCanonicalChunkBytes = Math.max(metrics.peakCanonicalChunkBytes, bytes); hash.update(text); }
  emit('{"formalSnapshot":{');
  for (const [i, field] of Object.keys(KEYS).sort().entries()) {
    if (i) emit(","); emit(JSON.stringify(field) + ":[");
    for (const [index, row] of sorted[field].entries()) { if (index) emit(","); emit(Canonical.stable(row)); }
    emit("]");
  }
  emit('},"schemaFingerprint":' + JSON.stringify(schemaFingerprint) + "}");
  metrics.fullSnapshotHashCount = 1;
  metrics.canonicalMaterialBytes = fullBytes - Buffer.byteLength('{"formalSnapshot":,"schemaFingerprint":' + JSON.stringify(schemaFingerprint) + "}");
  const context = { snapshot, sorted, schemaFingerprint, snapshotIdentity: hash.digest("hex"),
    entryByKey, revisionByKey, runByKey, evidenceByKey, evidenceUrls, activeBySource,
    candidateValidation: new WeakMap(), metrics };
  context.activeFormalIdentity = sourceHash(context, sorted.entries.map(e => ({ sourceId: e.sourceId,
    eventKey: e.eventKey, activeRevisionKey: e.activeRevisionKey })));
  metrics.preparationMs = performance.now() - start;
  contexts.set(token, context); activeContexts++; return token;
}
function get(token, snapshot) {
  const context = contexts.get(token);
  if (!context || context.snapshot !== snapshot) throw Error("shadow_cycle_invalid_or_closed");
  return context;
}
function close(token) {
  const context = contexts.get(token);
  if (!context) return;
  context.metrics.cacheDisposed = true; contexts.delete(token); activeContexts--;
  for (const key of ["entryByKey", "revisionByKey", "runByKey", "evidenceByKey", "evidenceUrls", "activeBySource"])
    context[key].clear();
  context.observationKeys?.clear();
  context.candidateValidation = null; context.snapshot = null; context.sorted = null;
}
module.exports = Object.freeze({ create, get, close, sourceHash, freeze,
  activeCount: () => activeContexts });
