"use strict";

const Canonical = require("./economicValueCanonical.js");
const Acquisition = require("./beaPceAcquisition.js");
const Pce = require("./beaPceFormal.js");
const Store = require("./economicValueFormalStore.js");
const Resolver = require("./economicValueEvidenceResolver.js");
const Evidence = require("../sourceEvidence/sourceEvidenceContract.js");
const Vault = require("../sourceEvidence/sourceEvidenceVault.js");

const PILOT_VERSION = "optionmap-bea-pce-evidence-pilot-v1";
const TRANSPORT_VERSION = "bea-release-specific-pio-v1";
const DIAGNOSTICS = Object.freeze(["evidence_saved", "evidence_duplicate_content",
  "evidence_unavailable_pre_activation", "evidence_write_failed", "evidence_invalid",
  "formal_write_aborted"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
function fail(reason) { throw new Error(reason); }

function createPceEvidencePolicy() {
  return Evidence.createSourcePolicy({ sourceFamily: "economic_values", sourceId: Pce.SOURCE_ID,
    allowedMediaTypes: ["application/xhtml+xml", "text/html"], allowedEncodings: ["utf-8"],
    maxBytes: Acquisition.MAX_BYTES });
}

function acceptedAcquisition(acquisition) {
  const document = acquisition?.document;
  return acquisition?.success === true && acquisition.sourceId === Pce.SOURCE_ID &&
    Canonical.month(acquisition.referencePeriod) && Canonical.date(acquisition.releaseDate) &&
    Canonical.timestamp(acquisition.fetchedAt) && document?.role === "official_release" &&
    Acquisition.validateUrl(document.sourceUrl, acquisition.referencePeriod,
      acquisition.releaseDate) === document.sourceUrl &&
    Acquisition.validateUrl(document.finalUrl, acquisition.referencePeriod,
      acquisition.releaseDate) === document.finalUrl &&
    ["text/html", "application/xhtml+xml"].includes(document.mime) &&
    document.httpMetadata?.encoding === "utf-8" &&
    Number.isSafeInteger(document.byteCount) && document.byteCount > 0 &&
    document.byteCount <= Acquisition.MAX_BYTES && Canonical.hash(document.rawContentHash) &&
    (Buffer.isBuffer(document.parserInput) || document.parserInput instanceof Uint8Array) &&
    document.parserInput.byteLength === document.byteCount &&
    Number.isInteger(document.httpMetadata.httpStatus) &&
    document.httpMetadata.httpStatus >= 200 && document.httpMetadata.httpStatus <= 299 &&
    document.httpMetadata.mimeType === document.mime &&
    document.httpMetadata.contentLength === document.byteCount &&
    document.httpMetadata.redirectCount === 0 &&
    document.httpMetadata.releasePath === Acquisition.pathFor(acquisition.referencePeriod,
      acquisition.releaseDate);
}

function createRawContentIdentity(acquisition) {
  if (!acceptedAcquisition(acquisition)) fail("pce_raw_identity_acquisition_invalid");
  const policy = createPceEvidencePolicy(), contentObject = Evidence.createContentObject({
    bytes: acquisition.document.parserInput, mediaType: acquisition.document.mime,
    encoding: "utf-8", policy });
  if (contentObject.sha256 !== acquisition.document.rawContentHash ||
      contentObject.byteLength !== acquisition.document.byteCount) fail("pce_raw_identity_mismatch");
  return Canonical.freeze({ contentObject, policy });
}

function createEvidenceInput(acquisition, candidate, acquisitionContext) {
  if (!acceptedAcquisition(acquisition) || !candidate || candidate.sourceId !== Pce.SOURCE_ID ||
      candidate.document.rawContentHash !== acquisition.document.rawContentHash ||
      candidate.document.byteCount !== acquisition.document.byteCount ||
      candidate.document.sourceDocumentKey !== candidate.release.sourceDocumentKey ||
      !Evidence.ACQUISITION_CONTEXTS.includes(acquisitionContext))
    fail("pce_evidence_acquisition_invalid");
  const { policy, contentObject } = createRawContentIdentity(acquisition), occurrence =
    Evidence.createAcquisitionOccurrence({ sourceFamily: "economic_values", sourceId: Pce.SOURCE_ID,
      initialUrl: acquisition.document.sourceUrl, sourceUrl: acquisition.document.finalUrl,
      fetchedAt: acquisition.fetchedAt, httpStatus: acquisition.document.httpMetadata.httpStatus,
      contentObject, transportVersion: TRANSPORT_VERSION, publishedAt: candidate.release.publishedAt,
      requestRole: "official_release", redirectHops: [], sourceDocumentRole: candidate.document.role,
      runId: candidate.runId, acquisitionContext }, policy);
  return Canonical.freeze({ bytes: acquisition.document.parserInput, contentObject, occurrence, policy });
}

function resolvePceEvidence({ snapshot, vault, sourceDocumentKey } = {}) {
  return Resolver.resolveSourceDocument({ snapshot, vault, sourceId: Pce.SOURCE_ID,
    sourceDocumentKey, expectedEncoding: () => "utf-8",
    validateSourceUrl: (value, _document, release) => Acquisition.validateUrl(value,
      release?.referencePeriod, release?.officialReleaseDate) });
}
function resolvePceRevision({ snapshot, vault, revisionKey } = {}) {
  return Resolver.resolveRevision({ snapshot, vault, sourceId: Pce.SOURCE_ID,
    seriesDefinitionKeys: Pce.SERIES.map(value => value.seriesDefinitionKey), revisionKey,
    expectedEncoding: () => "utf-8", validateSourceUrl: (value, _document, release) =>
      Acquisition.validateUrl(value, release?.referencePeriod, release?.officialReleaseDate) });
}

function sameCanonicalFacts(snapshot, candidate) {
  const revisionKeys = new Set(snapshot.revisions.map(value => value.revisionKey));
  return candidate.values.every(value => revisionKeys.has(value.revisionKey));
}
function sameRawIsConsistent(snapshot, candidate) {
  const documents = snapshot.documents.filter(value => value.sourceId === Pce.SOURCE_ID &&
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
    fail("pce_evidence_runtime_input_invalid");
  const formal = Store.createFormalRuntime({ indexedDB, faultAt: formalFaultAt,
    requiredEvidenceSourceIds: [Pce.SOURCE_ID] });
  async function acquireAndCommit(input = {}) {
    if (!exact(input, ["referencePeriod", "releaseDate", "acceptedAt", "calendarEventKey",
        "acquisitionContext"]) || !Canonical.month(input.referencePeriod) ||
        !Canonical.date(input.releaseDate) || !Canonical.timestamp(input.acceptedAt) ||
        input.calendarEventKey !== null && typeof input.calendarEventKey !== "string" ||
        !Evidence.ACQUISITION_CONTEXTS.includes(input.acquisitionContext))
      fail("pce_evidence_run_input_invalid");
    const acquired = await acquisition.acquire({ referencePeriod: input.referencePeriod,
      releaseDate: input.releaseDate });
    if (!acceptedAcquisition(acquired)) return Canonical.freeze({ status: "failed",
      diagnostic: "evidence_invalid", reason: acquired?.reason || "acquisition_invalid",
      evidenceTransactionCount: 0, formalTransactionCount: 0, semanticWrites: 0 });
    let rawIdentity, initial, evidenceInput, stored, reference, candidate, before;
    try {
      rawIdentity = createRawContentIdentity(acquired);
      initial = Pce.createAcceptedCandidate({ acquisition: acquired, acceptedAt: input.acceptedAt,
        calendarEventKey: input.calendarEventKey });
      before = await formal.readSnapshot();
      if (!sameRawIsConsistent(before.snapshot, initial)) fail("pce_same_raw_canonical_inconsistent");
      evidenceInput = createEvidenceInput(acquired, initial, input.acquisitionContext);
      if (Canonical.stable(rawIdentity.contentObject) !== Canonical.stable(evidenceInput.contentObject))
        fail("pce_raw_identity_drift");
      stored = vault.storeAcceptedEvidence(evidenceInput);
      reference = Evidence.createSourceEvidenceRef({ state: "available",
        occurrence: evidenceInput.occurrence, policy: evidenceInput.policy });
      candidate = Pce.bindSourceEvidence(initial, reference);
      if (vault.verifyOccurrence(reference.occurrenceId).status !== "valid")
        fail("pce_evidence_readback_invalid");
    } catch (error) {
      return Canonical.freeze({ status: "failed", diagnostic: error.message ===
        "pce_same_raw_canonical_inconsistent" ? "evidence_invalid" : "evidence_write_failed",
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
        fail("pce_evidence_precommit_invalid");
      const ticket = await formal.registerAcceptedRelease(candidate);
      committed = await formal.commitAcceptedRelease(ticket);
    } catch (error) {
      return Canonical.freeze({ status: "failed", diagnostic: "formal_write_aborted",
        reason: error.message, evidenceTransactionCount: stored.occurrenceWriteCount,
        formalTransactionCount: 0, semanticWrites: 0,
        occurrenceId: reference.occurrenceId, contentSha256: reference.contentSha256 });
    }
    const after = await formal.readSnapshot(), resolved = resolvePceEvidence({
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
      .then(result => resolvePceEvidence({ snapshot: result.snapshot, vault, sourceDocumentKey })),
    resolveRevision: revisionKey => formal.readSnapshot().then(result =>
      resolvePceRevision({ snapshot: result.snapshot, vault, revisionKey })) });
}

function createProductionPilot(authority) {
  if (!exact(authority, ["getUserDataPath", "indexedDB"]) ||
      typeof authority.getUserDataPath !== "function" || !authority.indexedDB)
    fail("pce_evidence_production_authority_invalid");
  return createPilotRuntime({ acquisition: Acquisition.createBeaPceAcquisition(),
    vault: Vault.createProductionVault({ getUserDataPath: authority.getUserDataPath }),
    indexedDB: authority.indexedDB, formalFaultAt: null });
}

module.exports = Canonical.freeze({ PILOT_VERSION, TRANSPORT_VERSION, DIAGNOSTICS,
  createPceEvidencePolicy, acceptedAcquisition, createRawContentIdentity, createEvidenceInput,
  resolvePceEvidence, resolvePceRevision, sameRawIsConsistent,
  createPilotRuntime, createProductionPilot });
