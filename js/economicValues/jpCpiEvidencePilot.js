"use strict";

const Canonical = require("./economicValueCanonical.js");
const Acquisition = require("./jpCpiAcquisition.js");
const JapanCpi = require("./jpCpiFormal.js");
const Encoding = require("./jpCpiEncoding.js");
const Store = require("./economicValueFormalStore.js");
const Resolver = require("./economicValueEvidenceResolver.js");
const Evidence = require("../sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../sourceEvidence/sourceEvidenceVault.js");

const PILOT_VERSION = "optionmap-japan-cpi-evidence-pilot-v1";
const TRANSPORT_VERSION = "jp-statistics-bureau-cpi-v1";
const DIAGNOSTICS = Object.freeze(["evidence_saved", "evidence_duplicate_content",
  "evidence_unavailable_pre_activation", "evidence_write_failed", "evidence_invalid",
  "formal_write_aborted"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
function fail(reason) { throw new Error(reason); }

function createJapanCpiEvidencePolicy() {
  return Evidence.createSourcePolicy({ sourceFamily: "economic_values", sourceId: JapanCpi.SOURCE_ID,
    allowedMediaTypes: ["application/xhtml+xml", "text/html"],
    allowedEncodings: ["shift_jis", "utf-8"], maxBytes: Acquisition.MAX_BYTES });
}

function acceptedAcquisition(acquisition) {
  const document = acquisition?.document, encoding = document?.httpMetadata?.encoding;
  return acquisition?.success === true && acquisition.sourceId === JapanCpi.SOURCE_ID &&
    Canonical.timestamp(acquisition.fetchedAt) && document?.role === "official_release" &&
    Acquisition.validateUrl(document.sourceUrl) === document.sourceUrl &&
    Acquisition.validateUrl(document.finalUrl) === document.finalUrl &&
    ["text/html", "application/xhtml+xml"].includes(document.mime) &&
    ["shift_jis", "utf-8"].includes(encoding) &&
    Number.isSafeInteger(document.byteCount) && document.byteCount > 0 &&
    document.byteCount <= Acquisition.MAX_BYTES && Canonical.hash(document.rawContentHash) &&
    (Buffer.isBuffer(document.parserInput) || document.parserInput instanceof Uint8Array) &&
    document.parserInput.byteLength === document.byteCount && Encoding.detect(document.parserInput) === encoding &&
    Number.isInteger(document.httpMetadata.httpStatus) &&
    document.httpMetadata.httpStatus >= 200 && document.httpMetadata.httpStatus <= 299 &&
    document.httpMetadata.mimeType === document.mime &&
    document.httpMetadata.contentLength === document.byteCount &&
    document.httpMetadata.redirectCount === 0 &&
    document.httpMetadata.statisticsCode === Acquisition.STATISTICS_CODE &&
    document.httpMetadata.eStatDatasetId === Acquisition.ESTAT_DATASET_ID;
}

function createRawContentIdentity(acquisition) {
  if (!acceptedAcquisition(acquisition)) fail("jp_cpi_raw_identity_acquisition_invalid");
  const policy = createJapanCpiEvidencePolicy(), contentObject = Evidence.createContentObject({
    bytes: acquisition.document.parserInput, mediaType: acquisition.document.mime,
    encoding: acquisition.document.httpMetadata.encoding, policy });
  if (contentObject.sha256 !== acquisition.document.rawContentHash ||
      contentObject.byteLength !== acquisition.document.byteCount)
    fail("jp_cpi_raw_identity_mismatch");
  return Canonical.freeze({ contentObject, policy });
}

function createEvidenceInput(acquisition, candidate, acquisitionContext) {
  if (!acceptedAcquisition(acquisition) || !candidate || candidate.sourceId !== JapanCpi.SOURCE_ID ||
      candidate.document.rawContentHash !== acquisition.document.rawContentHash ||
      candidate.document.byteCount !== acquisition.document.byteCount ||
      candidate.document.sourceDocumentKey !== candidate.release.sourceDocumentKey ||
      !Evidence.ACQUISITION_CONTEXTS.includes(acquisitionContext))
    fail("jp_cpi_evidence_acquisition_invalid");
  const { policy, contentObject } = createRawContentIdentity(acquisition),
    encoding = acquisition.document.httpMetadata.encoding;
  if (contentObject.sha256 !== candidate.document.rawContentHash ||
      contentObject.byteLength !== candidate.document.byteCount)
    fail("jp_cpi_evidence_content_identity_mismatch");
  const occurrence = Evidence.createAcquisitionOccurrence({ sourceFamily: "economic_values",
    sourceId: JapanCpi.SOURCE_ID, initialUrl: acquisition.document.sourceUrl,
    sourceUrl: acquisition.document.finalUrl, fetchedAt: acquisition.fetchedAt,
    httpStatus: acquisition.document.httpMetadata.httpStatus, contentObject,
    transportVersion: TRANSPORT_VERSION, publishedAt: candidate.release.publishedAt,
    requestRole: "official_release", redirectHops: [], sourceDocumentRole: candidate.document.role,
    runId: candidate.runId, acquisitionContext }, policy);
  return Canonical.freeze({ bytes: acquisition.document.parserInput, contentObject, occurrence, policy });
}

const expectedEncoding = document => ["shift_jis", "utf-8"].includes(document?.httpMetadata?.encoding) ?
  document.httpMetadata.encoding : null;
function resolveJapanCpiEvidence({ snapshot, vault, sourceDocumentKey } = {}) {
  return Resolver.resolveSourceDocument({ snapshot, vault, sourceId: JapanCpi.SOURCE_ID,
    sourceDocumentKey, expectedEncoding, validateSourceUrl: value => Acquisition.validateUrl(value) });
}
function resolveJapanCpiRevision({ snapshot, vault, revisionKey } = {}) {
  const seriesDefinitionKeys = Array.isArray(snapshot?.definitions) ? snapshot.definitions
    .filter(JapanCpi.validateDefinition).map(value => value.seriesDefinitionKey) : [];
  return Resolver.resolveRevision({ snapshot, vault, sourceId: JapanCpi.SOURCE_ID,
    seriesDefinitionKeys, revisionKey, expectedEncoding,
    validateSourceUrl: value => Acquisition.validateUrl(value) });
}

function sameCanonicalFacts(snapshot, candidate) {
  const revisionKeys = new Set(snapshot.revisions.map(value => value.revisionKey));
  return candidate.values.every(value => revisionKeys.has(value.revisionKey));
}
function sameRawIsConsistent(snapshot, candidate) {
  const documents = snapshot.documents.filter(value => value.sourceId === JapanCpi.SOURCE_ID &&
    value.rawContentHash === candidate.document.rawContentHash && value.parserId === candidate.document.parserId &&
    value.parserVersion === candidate.document.parserVersion);
  if (documents.length === 0) return true;
  const candidateKeys = candidate.values.map(value => value.revisionKey).sort().join("\n");
  return documents.every(document => snapshot.evidence.filter(value =>
    value.sourceDocumentKey === document.sourceDocumentKey).map(value => value.revisionKey)
    .sort().join("\n") === candidateKeys);
}

function createPilotRuntime({ acquisition, vault, indexedDB, formalFaultAt = null } = {}) {
  if (!acquisition || typeof acquisition.acquire !== "function" || !vault ||
      typeof vault.storeAcceptedEvidence !== "function" || !indexedDB)
    fail("jp_cpi_evidence_runtime_input_invalid");
  const formal = Store.createFormalRuntime({ indexedDB, faultAt: formalFaultAt,
    requiredEvidenceSourceIds: [JapanCpi.SOURCE_ID] });
  async function acquireAndCommit(input = {}) {
    if (!exact(input, ["acceptedAt", "calendarEventKey", "acquisitionContext"]) ||
        !Canonical.timestamp(input.acceptedAt) ||
        input.calendarEventKey !== null && typeof input.calendarEventKey !== "string" ||
        !Evidence.ACQUISITION_CONTEXTS.includes(input.acquisitionContext))
      fail("jp_cpi_evidence_run_input_invalid");
    const acquired = await acquisition.acquire();
    if (!acceptedAcquisition(acquired)) return Canonical.freeze({ status: "failed",
      diagnostic: "evidence_invalid", reason: acquired?.reason || "acquisition_invalid",
      evidenceTransactionCount: 0, formalTransactionCount: 0, semanticWrites: 0 });
    let rawIdentity, initial, evidenceInput, stored, reference, candidate, before;
    try {
      rawIdentity = createRawContentIdentity(acquired);
      initial = JapanCpi.createAcceptedCandidate({ acquisition: acquired, acceptedAt: input.acceptedAt,
        calendarEventKey: input.calendarEventKey });
      before = await formal.readSnapshot();
      if (!sameRawIsConsistent(before.snapshot, initial)) fail("jp_cpi_same_raw_canonical_inconsistent");
      evidenceInput = createEvidenceInput(acquired, initial, input.acquisitionContext);
      if (Canonical.stable(rawIdentity.contentObject) !== Canonical.stable(evidenceInput.contentObject))
        fail("jp_cpi_raw_identity_drift");
      stored = vault.storeAcceptedEvidence(evidenceInput);
      reference = Evidence.createSourceEvidenceRef({ state: "available",
        occurrence: evidenceInput.occurrence, policy: evidenceInput.policy });
      candidate = JapanCpi.bindSourceEvidence(initial, reference);
      if (vault.verifyOccurrence(reference.occurrenceId).status !== "valid")
        fail("jp_cpi_evidence_readback_invalid");
    } catch (error) {
      return Canonical.freeze({ status: "failed", diagnostic: error.message ===
        "jp_cpi_same_raw_canonical_inconsistent" ? "evidence_invalid" : "evidence_write_failed",
      reason: error.message, evidenceTransactionCount: stored?.occurrenceWriteCount || 0,
      formalTransactionCount: 0, semanticWrites: 0 });
    }
    const priorRelease = before.snapshot.releases.some(value =>
      value.releaseOccurrenceKey === candidate.release.releaseOccurrenceKey);
    if (priorRelease && sameCanonicalFacts(before.snapshot, candidate)) return Canonical.freeze({
      status: "unchanged", diagnostic: stored.contentClassification === "verified_reuse" ?
        "evidence_duplicate_content" : "evidence_saved", reason: null,
      evidenceTransactionCount: stored.occurrenceWriteCount, formalTransactionCount: 0,
      semanticWrites: 0, occurrenceId: reference.occurrenceId,
      contentSha256: reference.contentSha256, formalStatus: "unchanged" });
    let committed;
    try {
      if (vault.verifyOccurrence(reference.occurrenceId).status !== "valid")
        fail("jp_cpi_evidence_precommit_invalid");
      const ticket = await formal.registerAcceptedRelease(candidate);
      committed = await formal.commitAcceptedRelease(ticket);
    } catch (error) {
      return Canonical.freeze({ status: "failed", diagnostic: "formal_write_aborted",
        reason: error.message, evidenceTransactionCount: stored.occurrenceWriteCount,
        formalTransactionCount: 0, semanticWrites: 0,
        occurrenceId: reference.occurrenceId, contentSha256: reference.contentSha256 });
    }
    const after = await formal.readSnapshot(), resolved = resolveJapanCpiEvidence({
      snapshot: after.snapshot, vault, sourceDocumentKey: candidate.document.sourceDocumentKey });
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
      .then(result => resolveJapanCpiEvidence({ snapshot: result.snapshot, vault, sourceDocumentKey })),
    resolveRevision: revisionKey => formal.readSnapshot().then(result =>
      resolveJapanCpiRevision({ snapshot: result.snapshot, vault, revisionKey })) });
}

function createProductionPilot(authority) {
  if (!exact(authority, ["getUserDataPath", "indexedDB"]) ||
      typeof authority.getUserDataPath !== "function" || !authority.indexedDB)
    fail("jp_cpi_evidence_production_authority_invalid");
  return createPilotRuntime({ acquisition: Acquisition.createJapanCpiAcquisition(),
    vault: Vault.createProductionVault({ getUserDataPath: authority.getUserDataPath }),
    indexedDB: authority.indexedDB, formalFaultAt: null });
}

module.exports = Canonical.freeze({ PILOT_VERSION, TRANSPORT_VERSION, DIAGNOSTICS,
  createJapanCpiEvidencePolicy, acceptedAcquisition, createRawContentIdentity, createEvidenceInput,
  resolveJapanCpiEvidence, resolveJapanCpiRevision, sameRawIsConsistent,
  createPilotRuntime, createProductionPilot });
