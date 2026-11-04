"use strict";

const Canonical = require("./economicValueCanonical.js");
const Acquisition = require("./blsCpiAcquisition.js");
const Cpi = require("./blsCpiFormal.js");
const Store = require("./economicValueFormalStore.js");
const Evidence = require("../sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../sourceEvidence/sourceEvidenceVault.js");

const PILOT_VERSION = "optionmap-us-cpi-evidence-pilot-v1";
const TRANSPORT_VERSION = "bls-fixed-archive-v1";
const DIAGNOSTICS = Object.freeze(["evidence_saved", "evidence_duplicate_content",
  "evidence_unavailable_pre_activation", "evidence_write_failed", "evidence_invalid",
  "formal_write_aborted"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
function fail(reason) { throw new Error(reason); }

function createCpiEvidencePolicy() {
  return Evidence.createSourcePolicy({ sourceFamily: "economic_values", sourceId: Cpi.SOURCE_ID,
    allowedMediaTypes: ["application/xhtml+xml", "text/html"], allowedEncodings: ["utf-8"],
    maxBytes: Acquisition.MAX_BYTES });
}

function acceptedAcquisition(acquisition) {
  const document = acquisition?.document;
  return acquisition?.success === true && acquisition.sourceId === Cpi.SOURCE_ID &&
    Canonical.date(acquisition.releaseDate) && Canonical.timestamp(acquisition.fetchedAt) &&
    document?.role === "official_release" &&
    Acquisition.validateUrl(document.sourceUrl, acquisition.releaseDate) === document.sourceUrl &&
    Acquisition.validateUrl(document.finalUrl, acquisition.releaseDate) === document.finalUrl &&
    ["text/html", "application/xhtml+xml"].includes(document.mime) &&
    Number.isSafeInteger(document.byteCount) && document.byteCount > 0 &&
    document.byteCount <= Acquisition.MAX_BYTES && Canonical.hash(document.rawContentHash) &&
    (Buffer.isBuffer(document.parserInput) || document.parserInput instanceof Uint8Array) &&
    document.parserInput.byteLength === document.byteCount &&
    Number.isInteger(document.httpMetadata?.httpStatus) &&
    document.httpMetadata.httpStatus >= 200 && document.httpMetadata.httpStatus <= 299 &&
    document.httpMetadata.mimeType === document.mime &&
    document.httpMetadata.contentLength === document.byteCount &&
    document.httpMetadata.redirectCount === 0;
}

function createEvidenceInput(acquisition, candidate, acquisitionContext) {
  if (!acceptedAcquisition(acquisition) || !candidate || candidate.sourceId !== Cpi.SOURCE_ID ||
      candidate.document.rawContentHash !== acquisition.document.rawContentHash ||
      candidate.document.byteCount !== acquisition.document.byteCount ||
      candidate.document.sourceDocumentKey !== candidate.release.sourceDocumentKey ||
      !Evidence.ACQUISITION_CONTEXTS.includes(acquisitionContext))
    fail("cpi_evidence_acquisition_invalid");
  const policy = createCpiEvidencePolicy(), contentObject = Evidence.createContentObject({
    bytes: acquisition.document.parserInput, mediaType: acquisition.document.mime,
    encoding: "utf-8", policy });
  if (contentObject.sha256 !== candidate.document.rawContentHash ||
      contentObject.byteLength !== candidate.document.byteCount)
    fail("cpi_evidence_content_identity_mismatch");
  const occurrence = Evidence.createAcquisitionOccurrence({
    sourceFamily: "economic_values", sourceId: Cpi.SOURCE_ID,
    initialUrl: acquisition.document.sourceUrl, sourceUrl: acquisition.document.finalUrl,
    fetchedAt: acquisition.fetchedAt, httpStatus: acquisition.document.httpMetadata.httpStatus,
    contentObject, transportVersion: TRANSPORT_VERSION,
    publishedAt: candidate.release.publishedAt, requestRole: "official_release",
    redirectHops: [], sourceDocumentRole: candidate.document.role, runId: candidate.runId,
    acquisitionContext
  }, policy);
  return Canonical.freeze({ bytes: acquisition.document.parserInput, contentObject, occurrence, policy });
}

function unavailablePreActivation(document) {
  return Evidence.createSourceEvidenceRef({ state: "unavailable", sourceFamily: "economic_values",
    sourceId: document?.sourceId || Cpi.SOURCE_ID, reason: "pre_activation" });
}

function invalid(reason) {
  return Canonical.freeze({ status: "invalid", diagnostic: "evidence_invalid", reason,
    evidenceRef: null, occurrence: null, integrityStatus: reason, parserLineage: [] });
}

function resolveCpiEvidence({ snapshot, vault, sourceDocumentKey } = {}) {
  if (!snapshot || !Array.isArray(snapshot.documents) || !vault ||
      typeof vault.verifyOccurrence !== "function" || typeof sourceDocumentKey !== "string")
    fail("cpi_evidence_reader_input_invalid");
  const document = snapshot.documents.find(value => value.sourceDocumentKey === sourceDocumentKey);
  if (!document || document.sourceId !== Cpi.SOURCE_ID) return invalid("source_document_missing");
  if (!Object.hasOwn(document, "sourceEvidence")) return Canonical.freeze({ status: "unavailable",
    diagnostic: "evidence_unavailable_pre_activation", reason: "pre_activation",
    evidenceRef: unavailablePreActivation(document), occurrence: null,
    integrityStatus: "unavailable", parserLineage: [] });
  const reference = document.sourceEvidence;
  if (!Evidence.validateSourceEvidenceRef(reference) || reference.state !== "available" ||
      reference.sourceFamily !== "economic_values" || reference.sourceId !== Cpi.SOURCE_ID ||
      reference.contentSha256 !== document.rawContentHash) return invalid("evidence_ref_invalid");
  let verified, occurrence;
  try {
    verified = vault.verifyOccurrence(reference.occurrenceId);
    if (verified.status !== "valid") return invalid(verified.status);
    occurrence = vault.readOccurrence(reference.occurrenceId);
  } catch (_error) { return invalid("vault_read_failed"); }
  if (!occurrence || occurrence.contentSha256 !== document.rawContentHash ||
      occurrence.byteLength !== document.byteCount || occurrence.sourceFamily !== "economic_values" ||
      occurrence.sourceId !== document.sourceId || occurrence.mediaType !== document.mime ||
      occurrence.sourceUrl !== document.finalUrl) return invalid("source_identity_mismatch");
  const release = snapshot.releases.find(value =>
    value.releaseOccurrenceKey === document.releaseOccurrenceKey), evidenceRecords =
    snapshot.evidence.filter(value => value.sourceDocumentKey === sourceDocumentKey);
  if (!release || evidenceRecords.length === 0 || evidenceRecords.some(value =>
    value.releaseOccurrenceKey !== release.releaseOccurrenceKey || value.sourceId !== Cpi.SOURCE_ID ||
    value.rawContentHash !== document.rawContentHash || value.parserId !== document.parserId ||
    value.parserVersion !== document.parserVersion ||
    Canonical.stable(value.sourceEvidence) !== Canonical.stable(reference)))
    return invalid("formal_lineage_mismatch");
  let parserLineage;
  try {
    parserLineage = evidenceRecords.map(value => Evidence.createParserLineage({ evidenceRef: reference,
      parserId: value.parserId, parserVersion: value.parserVersion,
      canonicalIdentity: { kind: "revision_key", value: value.revisionKey } }));
  } catch (_error) { return invalid("parser_lineage_invalid"); }
  return Canonical.freeze({ status: "available", diagnostic: "evidence_saved", reason: null,
    evidenceRef: Canonical.clone(reference), occurrence: Canonical.clone(occurrence),
    integrityStatus: "valid", parserLineage });
}

function sameCanonicalFacts(snapshot, candidate) {
  const revisionKeys = new Set(snapshot.revisions.map(value => value.revisionKey));
  return candidate.values.every(value => revisionKeys.has(value.revisionKey));
}

function createPilotRuntime({ acquisition, vault, indexedDB, formalFaultAt = null } = {}) {
  if (!acquisition || typeof acquisition.acquire !== "function" || !vault ||
      typeof vault.storeAcceptedEvidence !== "function" || !indexedDB)
    fail("cpi_evidence_runtime_input_invalid");
  const formal = Store.createFormalRuntime({ indexedDB, faultAt: formalFaultAt,
    requiredEvidenceSourceIds: [Cpi.SOURCE_ID] });
  async function acquireAndCommit(input = {}) {
    if (!exact(input, ["releaseDate", "acceptedAt", "calendarEventKey", "acquisitionContext"]) ||
        !Canonical.date(input.releaseDate) || !Canonical.timestamp(input.acceptedAt) ||
        input.calendarEventKey !== null && typeof input.calendarEventKey !== "string" ||
        !Evidence.ACQUISITION_CONTEXTS.includes(input.acquisitionContext))
      fail("cpi_evidence_run_input_invalid");
    const acquired = await acquisition.acquire({ releaseDate: input.releaseDate });
    if (!acceptedAcquisition(acquired)) return Canonical.freeze({ status: "failed",
      diagnostic: "evidence_invalid", reason: acquired?.reason || "acquisition_invalid",
      evidenceTransactionCount: 0, formalTransactionCount: 0, semanticWrites: 0 });
    let initial, evidenceInput, stored, reference, candidate;
    try {
      initial = Cpi.createAcceptedCandidate({ acquisition: acquired, acceptedAt: input.acceptedAt,
        calendarEventKey: input.calendarEventKey });
      evidenceInput = createEvidenceInput(acquired, initial, input.acquisitionContext);
      stored = vault.storeAcceptedEvidence(evidenceInput);
      reference = Evidence.createSourceEvidenceRef({ state: "available",
        occurrence: evidenceInput.occurrence, policy: evidenceInput.policy });
      candidate = Cpi.bindSourceEvidence(initial, reference);
      if (vault.verifyOccurrence(reference.occurrenceId).status !== "valid")
        fail("cpi_evidence_readback_invalid");
    } catch (error) {
      return Canonical.freeze({ status: "failed", diagnostic: "evidence_write_failed",
        reason: error.message, evidenceTransactionCount: 0, formalTransactionCount: 0,
        semanticWrites: 0 });
    }
    const before = await formal.readSnapshot(), sameDate = before.snapshot.releases.filter(value =>
      value.authority === Cpi.AUTHORITY && value.releaseProgram === Cpi.PROGRAM &&
      value.officialReleaseDate === input.releaseDate);
    if (sameDate.length && sameCanonicalFacts(before.snapshot, candidate)) return Canonical.freeze({
      status: "unchanged", diagnostic: stored.contentClassification === "verified_reuse" ?
        "evidence_duplicate_content" : "evidence_saved", reason: null,
      evidenceTransactionCount: stored.occurrenceWriteCount, formalTransactionCount: 0,
      semanticWrites: 0, occurrenceId: reference.occurrenceId,
      contentSha256: reference.contentSha256, formalStatus: "unchanged" });
    let committed;
    try {
      if (vault.verifyOccurrence(reference.occurrenceId).status !== "valid")
        fail("cpi_evidence_precommit_invalid");
      const ticket = await formal.registerAcceptedRelease(candidate);
      committed = await formal.commitAcceptedRelease(ticket);
    } catch (error) {
      return Canonical.freeze({ status: "failed", diagnostic: "formal_write_aborted",
        reason: error.message, evidenceTransactionCount: stored.occurrenceWriteCount,
        formalTransactionCount: 0, semanticWrites: 0,
        occurrenceId: reference.occurrenceId, contentSha256: reference.contentSha256 });
    }
    const after = await formal.readSnapshot(), resolved = resolveCpiEvidence({ snapshot: after.snapshot,
      vault, sourceDocumentKey: candidate.document.sourceDocumentKey });
    if (resolved.status !== "available") return Canonical.freeze({ status: "failed",
      diagnostic: "evidence_invalid", reason: resolved.reason,
      evidenceTransactionCount: stored.occurrenceWriteCount,
      formalTransactionCount: committed.transactionCount, semanticWrites: committed.semanticWrites,
      occurrenceId: reference.occurrenceId, contentSha256: reference.contentSha256 });
    return Canonical.freeze({ status: "committed",
      diagnostic: stored.contentClassification === "verified_reuse" ?
        "evidence_duplicate_content" : "evidence_saved", reason: null,
      evidenceTransactionCount: stored.occurrenceWriteCount,
      formalTransactionCount: committed.transactionCount, semanticWrites: committed.semanticWrites,
      occurrenceId: reference.occurrenceId, contentSha256: reference.contentSha256,
      formalStatus: committed.status, sourceDocumentKey: candidate.document.sourceDocumentKey });
  }
  return Canonical.freeze({ pilotVersion: PILOT_VERSION, acquireAndCommit,
    readSnapshot: formal.readSnapshot, resolveSourceDocument: sourceDocumentKey => formal.readSnapshot()
      .then(result => resolveCpiEvidence({ snapshot: result.snapshot, vault, sourceDocumentKey })) });
}

function createProductionPilot(authority) {
  if (!exact(authority, ["getUserDataPath", "indexedDB"]) ||
      typeof authority.getUserDataPath !== "function" || !authority.indexedDB)
    fail("cpi_evidence_production_authority_invalid");
  return createPilotRuntime({ acquisition: Acquisition.createBlsCpiAcquisition(),
    vault: Vault.createProductionVault({ getUserDataPath: authority.getUserDataPath }),
    indexedDB: authority.indexedDB, formalFaultAt: null });
}

module.exports = Canonical.freeze({ PILOT_VERSION, TRANSPORT_VERSION, DIAGNOSTICS,
  createCpiEvidencePolicy, acceptedAcquisition, createEvidenceInput, resolveCpiEvidence,
  createPilotRuntime, createProductionPilot });
