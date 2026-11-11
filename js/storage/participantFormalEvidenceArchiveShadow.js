"use strict";

const Schema = require("../formalArchive/participantFormalArchiveSchema.js");
const ReadStore = require("./participantFormalArchiveStore.js");
const Binding = require("../participantFormalEvidenceBinding.js");
const ParticipantData = require("../participantData.js");

const SHADOW_VERSION = "participants-formal-evidence-archive-shadow-v1";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const clone = value => value == null ? value : structuredClone(value);
const requestValue = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const transactionDone = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
  transaction.onerror = () => undefined; });

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze); return Object.freeze(value);
}

function rejected(reason) {
  return freeze({ contractVersion: SHADOW_VERSION, status: "rejected", reason,
    classification: null, revisionWriteCount: 0, transactionCount: 0, revision: null });
}

function createIsolatedParticipantFormalEvidenceArchive(options = {}) {
  if (!exact(options, ["indexedDB", "IDBKeyRange", "databaseName", "targetEnvironment",
    "authority", "vault", "setStore"]) || options.targetEnvironment !== "isolated_test" ||
      typeof options.indexedDB?.open !== "function" || typeof options.databaseName !== "string" ||
      !options.databaseName.startsWith("optionmap-participants-p4-") ||
      typeof options.authority?.sign !== "function" ||
      typeof options.vault?.verifyOccurrence !== "function" ||
      typeof options.setStore?.read !== "function")
    throw new TypeError("participants_formal_evidence_archive_options_invalid");
  const reader = ReadStore.createParticipantFormalArchiveStore({ indexedDB: options.indexedDB,
    IDBKeyRange: options.IDBKeyRange, databaseName: options.databaseName,
    validateRevisionPayload: ParticipantData.validateParticipantCache });

  async function accept(input) {
    if (!exact(input, ["completeSet", "evidenceSetId", "manifest", "transportSet",
      "acquisitions", "confirmedAt"]) || !timestamp(input.confirmedAt))
      return rejected("candidate_invalid");
    let evidenceSet, sourceEvidence;
    try {
      evidenceSet = options.setStore.read(input.evidenceSetId, options.authority);
      if (!evidenceSet) return rejected("evidence_set_missing");
      sourceEvidence = await Binding.createBinding({ completeSet: input.completeSet, evidenceSet,
        transportSet: input.transportSet, manifest: input.manifest,
        acquisitions: input.acquisitions, boundAt: input.confirmedAt, vault: options.vault },
      options.authority);
    } catch (_error) { return rejected("evidence_binding_invalid"); }
    const entryKey = Schema.entryKeyFor(input.completeSet.sourceDate),
      revisionKey = `${entryKey}|${input.completeSet.versionKey}`;
    let db;
    try { db = await reader.openArchive(); } catch (_error) { return rejected("archive_unavailable"); }
    try {
      const inspect = db.transaction([Schema.META_STORE, Schema.ENTRY_STORE,
        Schema.REVISION_STORE], "readonly"), inspectDone = transactionDone(inspect),
        metadataRequest = requestValue(inspect.objectStore(Schema.META_STORE).get(Schema.META_KEY)),
        entryRequest = requestValue(inspect.objectStore(Schema.ENTRY_STORE).get(entryKey)),
        [metadata, entry] = await Promise.all([metadataRequest, entryRequest]);
      await inspectDone;
      const activeResult = entry ? await reader.readRevision(entry.activeRevisionKey) : null,
        active = activeResult?.status === "available" ? activeResult.revision : null;
      if ((metadata && !Schema.validateMetadata(metadata)) ||
          (entry && !Schema.validateEntry(entry)) ||
          (entry && activeResult?.status !== "available") ||
          (active && !Schema.validateRevision(active)))
        return rejected("archive_state_invalid");
      if (active?.versionKey === input.completeSet.versionKey)
        return freeze({ contractVersion: SHADOW_VERSION, status: "accepted", reason: null,
          classification: "semantic_duplicate", revisionWriteCount: 0, transactionCount: 0,
          revision: clone(active) });
      const revision = { revisionKey, entryKey, sourceDate: input.completeSet.sourceDate,
        versionKey: input.completeSet.versionKey, contentSignature: input.completeSet.signature,
        signatureAlgorithm: input.completeSet.signatureAlgorithm,
        signature: input.completeSet.signature, confirmedAt: input.confirmedAt, replacedAt: null,
        revisionState: "active", completeSet: clone(input.completeSet),
        sourceEvidence: clone(sourceEvidence) };
      if (!Schema.validateRevision(revision) ||
          !Binding.validateRevisionBinding(revision, evidenceSet, options.vault, options.authority))
        return rejected("revision_invalid");
      const nextEntry = entry ? { ...clone(entry), activeRevisionKey: revisionKey,
        lastSeenAt: input.confirmedAt } : { entryKey, sourceDate: input.completeSet.sourceDate,
        activeRevisionKey: revisionKey, firstSeenAt: input.confirmedAt,
        lastSeenAt: input.confirmedAt };
      const nextMetadata = metadata ? { ...clone(metadata), updatedAt: input.confirmedAt,
        revisionCount: metadata.revisionCount + 1 } : { id: Schema.META_KEY,
        archiveSchemaVersion: Schema.ARCHIVE_SCHEMA_VERSION, dataset: Schema.DATASET,
        authorityClass: Schema.AUTHORITY_CLASS, retentionPolicy: Schema.RETENTION_POLICY,
        createdAt: input.confirmedAt, updatedAt: input.confirmedAt,
        integrityAlgorithm: "sha256", entryCount: 1, revisionCount: 1 };
      if (!entry && metadata) nextMetadata.entryCount += 1;
      if (!Schema.validateEntry(nextEntry) || !Schema.validateMetadata(nextMetadata))
        return rejected("revision_invalid");
      const transaction = db.transaction([Schema.META_STORE, Schema.ENTRY_STORE,
        Schema.REVISION_STORE], "readwrite"), revisions = transaction.objectStore(
          Schema.REVISION_STORE);
      if (active) revisions.put({ ...clone(active), revisionState: "replaced",
        replacedAt: input.confirmedAt });
      revisions.add(revision);
      transaction.objectStore(Schema.ENTRY_STORE).put(nextEntry);
      transaction.objectStore(Schema.META_STORE).put(nextMetadata);
      await transactionDone(transaction);
      const readback = await reader.readRevision(revisionKey);
      if (readback.status !== "available" || !Binding.validateRevisionBinding(readback.revision,
        evidenceSet, options.vault, options.authority))
        return rejected("revision_readback_invalid");
      return freeze({ contractVersion: SHADOW_VERSION, status: "accepted", reason: null,
        classification: active ? "same_date_correction" : "new_revision",
        revisionWriteCount: 1, transactionCount: 1, revision: readback.revision });
    } catch (_error) { return rejected("archive_write_failed"); }
  }

  async function resolveRevision(revisionKey) {
    const result = await reader.readRevision(revisionKey);
    if (result.status !== "available") return freeze({ status: result.status,
      reason: result.status === "corrupted" ? "revision_invalid" : "revision_missing",
      revision: result.revision || null, evidence: null });
    const revision = result.revision;
    if (!Object.hasOwn(revision, "sourceEvidence")) return freeze({ status: "available",
      reason: null, revision, evidence: Binding.PRE_ACTIVATION });
    let evidenceSet;
    try { evidenceSet = options.setStore.read(revision.sourceEvidence.evidenceSetId,
      options.authority); } catch (_error) { evidenceSet = null; }
    if (!evidenceSet || !Binding.validateRevisionBinding(revision, evidenceSet, options.vault,
      options.authority)) return freeze({ status: "invalid", reason: "evidence_binding_invalid",
      revision, evidence: { state: "invalid", reason: "evidence_verification_failed" } });
    const roles = evidenceSet.roles.map(entry => ({ role: entry.role,
      occurrence: options.vault.readOccurrence(entry.occurrenceId),
      contentMetadata: options.vault.readContentMetadata(entry.contentSha256) }));
    return freeze({ status: "available", reason: null, revision,
      evidence: { state: "available", evidenceSet, roles } });
  }

  async function readEntryRevisions(sourceDate) {
    const db = await reader.openArchive(), transaction = db.transaction(
      Schema.REVISION_STORE, "readonly"), done = transactionDone(transaction), values =
      await requestValue(transaction.objectStore(Schema.REVISION_STORE).index("byEntryKey")
        .getAll(Schema.entryKeyFor(sourceDate)));
    await done;
    return freeze(values.filter(Schema.validateRevision).sort((a, b) =>
      a.confirmedAt.localeCompare(b.confirmedAt)).map(clone));
  }

  async function readAsKnownAt(sourceDate, at) {
    return Binding.selectAsKnownAt(await readEntryRevisions(sourceDate), at);
  }

  return freeze({ accept, resolveRevision, readEntryRevisions, readAsKnownAt,
    close: reader.closeArchive });
}

module.exports = freeze({ SHADOW_VERSION, createIsolatedParticipantFormalEvidenceArchive });
