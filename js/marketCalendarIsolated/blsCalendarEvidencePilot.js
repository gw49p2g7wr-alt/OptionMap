"use strict";

const Canonical = require("../marketCalendar/marketEventCanonicalizer.js");
const Contract = require("../marketCalendarHistory/calendarPartialBootstrapContract.js");
const SourceEvidenceSet = require("../marketCalendarHistory/calendarSourceEvidenceSet.js");
const Evidence = require("../sourceEvidence/sourceEvidenceContract.js");
const Route = require("./blsFixedRoute.js");
const Assessment = require("./blsFixedAssessment.js");

const PILOT_VERSION = "optionmap-bls-calendar-evidence-pilot-v1";
const TRANSPORT_VERSION = "bls-fixed-four-page-v2";
const DIAGNOSTICS = Object.freeze(["evidence_saved", "evidence_duplicate_content",
  "source_evidence_write_failed", "evidence_invalid", "parser_rejected",
  "formal_write_aborted"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
function freeze(value) {
  if (value && typeof value === "object" && !ArrayBuffer.isView(value) &&
      !(value instanceof ArrayBuffer) && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function fail(reason) { throw new Error(reason); }

function createBlsCalendarEvidencePolicy() {
  return Evidence.createSourcePolicy({ sourceFamily: "market_calendar", sourceId: Route.SOURCE_ID,
    allowedMediaTypes: ["text/html"], allowedEncodings: ["utf-8"], maxBytes: Route.MAX_BYTES });
}
function acceptedAcquisition(acquisition) {
  if (acquisition?.sourceId !== Route.SOURCE_ID || acquisition.outcome !== "complete" ||
      !timestamp(acquisition.fetchedAt) || !Array.isArray(acquisition.documents) ||
      acquisition.documents.length !== Route.ROLES.length) return false;
  return acquisition.documents.every((document, index) => {
    const route = Route.ROLES[index], bytes = document?.parserInput;
    return document?.role === route.role && document.requestedUrl === route.url &&
      document.fetchOutcome === "success" && document.reason == null &&
      document.httpStatus === 200 && document.mime === "text/html" &&
      /^text\/html(?:\s*;|\s*$)/i.test(document.contentType || "") &&
      Array.isArray(document.redirects) && document.redirects.length === 0 &&
      bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= Route.MAX_BYTES &&
      document.byteCount === bytes.byteLength && document.contentSha256 === Route.hash(bytes);
  });
}
function createEvidenceInputs(acquisition, acquisitionContext) {
  if (!acceptedAcquisition(acquisition) ||
      !Evidence.ACQUISITION_CONTEXTS.includes(acquisitionContext))
    fail("bls_calendar_evidence_acquisition_invalid");
  const policy = createBlsCalendarEvidencePolicy(), acquisitionRunId =
    `bls-calendar-acquisition|sha256:${Evidence.sha256Canonical({ sourceId: Route.SOURCE_ID,
      fetchedAt: acquisition.fetchedAt, documents: acquisition.documents.map(document => ({
        role: document.role, requestedUrl: document.requestedUrl,
        contentSha256: document.contentSha256, byteCount: document.byteCount })) })}`;
  const inputs = acquisition.documents.map((document, index) => {
    const route = Route.ROLES[index], contentObject = Evidence.createContentObject({
      bytes: document.parserInput, mediaType: document.mime, encoding: "utf-8", policy });
    if (contentObject.sha256 !== document.contentSha256 ||
        contentObject.byteLength !== document.byteCount) fail("bls_calendar_content_identity_mismatch");
    const occurrence = Evidence.createAcquisitionOccurrence({ sourceFamily: "market_calendar",
      sourceId: Route.SOURCE_ID, initialUrl: route.url, sourceUrl: route.url,
      fetchedAt: acquisition.fetchedAt, httpStatus: document.httpStatus, contentObject,
      transportVersion: TRANSPORT_VERSION, publishedAt: null, requestRole: route.role,
      redirectHops: [], sourceDocumentRole: route.role, runId: acquisitionRunId,
      acquisitionContext }, policy);
    return freeze({ bytes: document.parserInput, contentObject, occurrence, policy });
  });
  return freeze({ acquisitionRunId, inputs });
}
function sourceResultFor(assessment, generationIdentity, sourceEvidenceSet) {
  return freeze({ sourceId: Route.SOURCE_ID,
    routeIdentity: Contract.expectedRouteIdentity(Route.SOURCE_ID), generationIdentity,
    acquisitionOutcome: "complete", candidateStatus: "available", formalEligible: true,
    candidateIdentity: assessment.candidateIdentity, canonicalRecords: assessment.canonicalRecords,
    parserStatus: "success", structureGuardStatus: "passed",
    canonicalizationStatus: "success", parserDiagnostics: [], canonicalDiagnostics: [],
    failedRoles: [], ambiguityCount: 0, duplicateCount: 0, identityCollisionCount: 0,
    absenceAuthority: "none", coverage: { state: assessment.coverageState,
      roleCoverage: assessment.roleCoverage }, documentHealth: Route.ROLES.map(route => ({
      role: route.role, fetchOutcome: "success", parseOutcome: "success" })), sourceEvidenceSet });
}
function createPilotRuntime({ acquisition, vault, formal } = {}) {
  if (!acquisition || typeof acquisition.acquire !== "function" || !vault ||
      typeof vault.storeAcceptedEvidence !== "function" || typeof vault.verifyOccurrence !== "function" ||
      !formal || typeof formal.commit !== "function" || typeof formal.readSnapshot !== "function")
    fail("bls_calendar_evidence_runtime_input_invalid");
  async function acquireAndCommit(input = {}) {
    if (!exact(input, ["assessmentDateJst", "acceptedAt", "generationIdentity",
      "acquisitionContext"]) || !/^20\d{2}-\d{2}-\d{2}$/.test(input.assessmentDateJst || "") ||
      !timestamp(input.acceptedAt) || !/^[0-9a-f]{64}$/.test(input.generationIdentity || "") ||
      !Evidence.ACQUISITION_CONTEXTS.includes(input.acquisitionContext))
      fail("bls_calendar_evidence_run_input_invalid");
    const acquired = await acquisition.acquire({ sourceId: Route.SOURCE_ID });
    if (!acceptedAcquisition(acquired)) return freeze({ status: "failed",
      diagnostic: "evidence_invalid", reason: acquired?.reason || "acquisition_invalid",
      evidenceTransactionCount: 0, formalTransactionCount: 0, semanticWrites: 0,
      sourceEvidenceSet: null });
    let generated, documents, sourceEvidenceSet;
    const stored = [];
    try {
      generated = createEvidenceInputs(acquired, input.acquisitionContext);
      for (const evidenceInput of generated.inputs)
        stored.push(vault.storeAcceptedEvidence(evidenceInput));
      documents = generated.inputs.map((evidenceInput, index) => {
        const evidenceRef = Evidence.createSourceEvidenceRef({ state: "available",
          occurrence: evidenceInput.occurrence, policy: evidenceInput.policy });
        if (vault.verifyOccurrence(evidenceRef.occurrenceId).status !== "valid")
          fail("bls_calendar_evidence_readback_invalid");
        return { role: Route.ROLES[index].role, sourceUrl: Route.ROLES[index].url,
          byteLength: evidenceInput.contentObject.byteLength,
          mediaType: evidenceInput.contentObject.mediaType,
          encoding: evidenceInput.contentObject.encoding, evidenceRef };
      });
      sourceEvidenceSet = SourceEvidenceSet.createSourceEvidenceSet({
        acquisitionRunId: generated.acquisitionRunId, documents });
    } catch (error) {
      return freeze({ status: "failed", diagnostic: "source_evidence_write_failed",
        reason: error.message, evidenceTransactionCount: stored.reduce((sum, value) =>
          sum + value.occurrenceWriteCount, 0), formalTransactionCount: 0,
        semanticWrites: 0, sourceEvidenceSet: null });
    }
    const assessment = await Assessment.assess({ acquisitionResult: acquired,
      assessmentDateJst: input.assessmentDateJst });
    if (assessment.outcome !== "complete" || assessment.completeDocumentSet !== true ||
        assessment.failedRoles.length || !assessment.canonicalRecords.length)
      return freeze({ status: "failed", diagnostic: "parser_rejected",
        reason: assessment.reason || assessment.outcome, evidenceTransactionCount: stored.reduce(
          (sum, value) => sum + value.occurrenceWriteCount, 0), formalTransactionCount: 0,
        semanticWrites: 0, sourceEvidenceSet });
    let committed;
    try {
      for (const document of sourceEvidenceSet.documents)
        if (vault.verifyOccurrence(document.evidenceRef.occurrenceId).status !== "valid")
          fail("bls_calendar_evidence_precommit_invalid");
      committed = await formal.commit({ sourceResult: sourceResultFor(assessment,
        input.generationIdentity, sourceEvidenceSet), acceptedAt: input.acceptedAt,
      generationIdentity: input.generationIdentity });
      if (!committed || !["committed", "unchanged", "already_committed"].includes(committed.status))
        fail(committed?.reason || "formal_commit_failed");
    } catch (error) {
      return freeze({ status: "failed", diagnostic: "formal_write_aborted",
        reason: error.message, evidenceTransactionCount: stored.reduce((sum, value) =>
          sum + value.occurrenceWriteCount, 0), formalTransactionCount: 0, semanticWrites: 0,
        acquisitionRunId: generated.acquisitionRunId, sourceEvidenceSet });
    }
    const evidenceTransactionCount = stored.reduce((sum, value) =>
      sum + value.occurrenceWriteCount, 0), duplicate = stored.every(value =>
      value.contentClassification === "verified_reuse");
    return freeze({ status: committed.status, diagnostic: duplicate ?
      "evidence_duplicate_content" : "evidence_saved", reason: null,
      evidenceTransactionCount, formalTransactionCount: committed.transactionCount || 0,
      semanticWrites: committed.semanticWrites || 0,
      acquisitionRunId: generated.acquisitionRunId, sourceEvidenceSet });
  }
  return freeze({ pilotVersion: PILOT_VERSION, acquireAndCommit,
    readSnapshot: formal.readSnapshot,
    resolveRunEvidence: run => SourceEvidenceSet.resolveRunEvidence({ run, vault }),
    resolveRevisionEvidence: revisionKey => formal.readSnapshot().then(result =>
      SourceEvidenceSet.resolveRevisionEvidence({ snapshot: result.snapshot, vault, revisionKey })) });
}

module.exports = freeze({ PILOT_VERSION, TRANSPORT_VERSION, DIAGNOSTICS,
  createBlsCalendarEvidencePolicy, acceptedAcquisition, createEvidenceInputs,
  sourceResultFor, createPilotRuntime });
