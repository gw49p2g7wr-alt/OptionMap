"use strict";

const Contract = require("../marketCalendarHistory/calendarPartialBootstrapContract.js");
const SourceEvidenceSet = require("../marketCalendarHistory/bojCalendarSourceEvidenceSet.js");
const Evidence = require("../sourceEvidence/sourceEvidenceContract.js");
const Registry = require("../marketCalendar/sourceRegistry.js");
const Network = require("../marketCalendarRuntime/calendarNetworkPolicy.js");

const PILOT_VERSION = "optionmap-boj-calendar-evidence-pilot-v1";
const TRANSPORT_VERSION = "calendar-boj-fixed-four-document-v1";
const WORKBOOK_SAFETY_VERSION = "calendar-workbook-safety-v1";
const ROLE_TRANSPORT_VERSIONS = Object.freeze({
  primary: "calendar-boj-primary-html-v1",
  speeches: "calendar-boj-speeches-html-v1",
  tankan: "calendar-boj-tankan-xlsx-v1",
  meeting_publications: "calendar-boj-meeting-publications-html-v1"
});
const DIAGNOSTICS = Object.freeze(["evidence_saved", "evidence_duplicate_content",
  "primary_parser_rejected", "speeches_parser_rejected", "tankan_transport_rejected",
  "tankan_workbook_rejected", "meeting_publications_parser_rejected",
  "source_evidence_set_invalid", "source_evidence_write_failed", "formal_write_aborted"]);
const SOURCE_ID = SourceEvidenceSet.SOURCE_ID;
const source = Registry.getSource(SOURCE_ID), routes = Network.BOJ_COVERAGE_V3.documents;
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
function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}
function orderedDocuments(acquisition) {
  if (!Array.isArray(acquisition?.documents) || acquisition.documents.length !== routes.length)
    return null;
  const ordered = [];
  for (const route of routes) {
    const matches = acquisition.documents.filter(document => document?.role === route.role);
    if (matches.length !== 1) return null;
    ordered.push(matches[0]);
  }
  return ordered;
}
function redirectsValid(document) {
  return Array.isArray(document?.redirects) && document.redirects.length <= Network.MAX_REDIRECTS &&
    document.redirects.every(hop => Number.isInteger(hop.status) && hop.status >= 300 &&
      hop.status <= 399 && hop.accepted === true && typeof hop.to === "string");
}
function transportValid(document, route) {
  return Network.validateUrl(SOURCE_ID, route, document?.originalOfficialUrl).valid &&
    Network.validateUrl(SOURCE_ID, route, document?.finalUrl).valid &&
    Network.validateMime(route, document?.mime).valid && document.httpStatus === 200 &&
    redirectsValid(document);
}
function assessAcquisition(acquisition) {
  if (acquisition?.success !== true || acquisition.sourceId !== SOURCE_ID ||
      acquisition.operation !== Network.OPERATION || acquisition.bojCoverageVersion !== 3 ||
      !timestamp(acquisition.fetchedAt)) {
    const failedRole = acquisition?.diagnostics?.[0]?.role, reason =
      acquisition?.reason || "acquisition_identity_invalid";
    return freeze({ valid: false, reason: failedRole ? `${failedRole}_${reason}` : reason });
  }
  const documents = orderedDocuments(acquisition);
  if (!documents) return freeze({ valid: false, reason: "source_document_set_incomplete" });
  for (const [index, document] of documents.entries()) {
    const route = routes[index], parserBytes = bytes(document.parserInput), rawBytes =
      route.kind === "xlsx" ? bytes(document.evidenceInput) || parserBytes : parserBytes;
    if (!transportValid(document, route)) return freeze({ valid: false,
      reason: `${route.role}_transport_invalid` });
    if (!parserBytes || !rawBytes || rawBytes.byteLength < 1 ||
        rawBytes.byteLength > route.maxBytes || document.byteCount !== rawBytes.byteLength ||
        document.contentSha256 !== Evidence.sha256Bytes(rawBytes) ||
        document.parserInputSha256 !== Evidence.sha256Bytes(parserBytes))
      return freeze({ valid: false, reason: `${route.role}_raw_identity_invalid` });
    if (route.kind === "xlsx") {
      if (document.encoding !== null || document.workbook?.valid !== true ||
          document.workbook.sanitized !== false || document.contentSha256 !==
          document.parserInputSha256)
        return freeze({ valid: false, reason: "tankan_workbook_invalid" });
    } else if (!document.encoding ||
        !["utf-8", "windows-1252"].includes(document.encoding.encoding) ||
        document.encoding.evidence?.resolutionPolicyVersion !== 1 ||
        document.contentSha256 !== document.parserInputSha256)
      return freeze({ valid: false, reason: `${route.role}_encoding_invalid` });
  }
  return freeze({ valid: true, reason: null, documents });
}
function diagnosticFor(reason) {
  if (/^tankan_workbook/.test(reason || "")) return "tankan_workbook_rejected";
  if (/^tankan_/.test(reason || "")) return "tankan_transport_rejected";
  return "source_evidence_set_invalid";
}
function parserDiagnostic(candidate) {
  const reason = candidate?.reason || candidate?.parserDiagnostics?.[0] || "parser_rejected";
  if (/speech/i.test(reason)) return { diagnostic: "speeches_parser_rejected", reason };
  if (/(?:tankan|cgpi)/i.test(reason)) return { diagnostic: "tankan_workbook_rejected", reason };
  if (/publication/i.test(reason))
    return { diagnostic: "meeting_publications_parser_rejected", reason };
  return { diagnostic: "primary_parser_rejected", reason };
}
function createBojCalendarEvidencePolicy() {
  return Evidence.createSourcePolicy({ sourceFamily: "market_calendar", sourceId: SOURCE_ID,
    allowedMediaTypes: [...new Set(routes.flatMap(route => route.allowedMime))],
    allowedEncodings: [null, "utf-8", "windows-1252"],
    maxBytes: Math.max(...routes.map(route => route.maxBytes)) });
}
function createEvidenceInputs(acquisition, acquisitionContext) {
  const assessed = assessAcquisition(acquisition);
  if (!assessed.valid || !Evidence.ACQUISITION_CONTEXTS.includes(acquisitionContext))
    fail(assessed.reason || "boj_calendar_evidence_acquisition_invalid");
  const policy = createBojCalendarEvidencePolicy(), acquisitionRunId =
    `boj-calendar-acquisition|sha256:${Evidence.sha256Canonical({ sourceId: SOURCE_ID,
      parserId: source.parserId, parserVersion: source.parserVersion,
      workbookSafetyVersion: WORKBOOK_SAFETY_VERSION, fetchedAt: acquisition.fetchedAt,
      documents: assessed.documents.map(document => ({ role: document.role,
        initialUrl: document.originalOfficialUrl, sourceUrl: document.finalUrl,
        contentSha256: document.contentSha256, parserInputSha256: document.parserInputSha256,
        byteCount: document.byteCount,
        ...(document.role === "tankan" ? { workbook: document.workbook } : {}) })) })}`,
    inputs = assessed.documents.map((document, index) => {
      const route = routes[index], raw = route.kind === "xlsx" ?
        bytes(document.evidenceInput) || bytes(document.parserInput) : bytes(document.parserInput),
        encoding = route.kind === "xlsx" ? null : document.encoding.encoding,
        contentObject = Evidence.createContentObject({ bytes: raw, mediaType: document.mime,
          encoding, policy });
      if (contentObject.sha256 !== document.contentSha256 ||
          contentObject.byteLength !== document.byteCount)
        fail("boj_calendar_content_identity_mismatch");
      const occurrence = Evidence.createAcquisitionOccurrence({ sourceFamily: "market_calendar",
        sourceId: SOURCE_ID, initialUrl: document.originalOfficialUrl,
        sourceUrl: document.finalUrl, fetchedAt: acquisition.fetchedAt,
        httpStatus: document.httpStatus, contentObject,
        transportVersion: ROLE_TRANSPORT_VERSIONS[route.role], publishedAt: null,
        requestRole: route.role, redirectHops: document.redirects.map(hop =>
          ({ status: hop.status, url: hop.to })), sourceDocumentRole: route.role,
        runId: acquisitionRunId, acquisitionContext }, policy);
      return freeze({ bytes: raw, contentObject, occurrence, policy });
    });
  return freeze({ acquisitionRunId, inputs });
}
function sourceResultFor(candidate, acquisition, generationIdentity, sourceEvidenceSet) {
  const documents = orderedDocuments(acquisition);
  return freeze({ sourceId: SOURCE_ID, routeIdentity: Contract.expectedRouteIdentity(SOURCE_ID),
    generationIdentity, acquisitionOutcome: "complete", candidateStatus: "available",
    formalEligible: true, candidateIdentity: candidate.candidateIdentity,
    canonicalRecords: candidate.canonicalRecords, parserStatus: "success",
    structureGuardStatus: "passed", canonicalizationStatus: "success",
    parserDiagnostics: [], canonicalDiagnostics: [], failedRoles: [], ambiguityCount: 0,
    duplicateCount: 0, identityCollisionCount: 0, absenceAuthority: "none",
    coverage: acquisition.coverageAudit || null,
    documentHealth: documents.map(document => ({ role: document.role,
      httpStatus: document.httpStatus, redirectCount: document.redirects.length,
      fetchOutcome: "success", parseOutcome: "success" })), sourceEvidenceSet });
}
function createPilotRuntime({ acquisition, vault, formal } = {}) {
  if (!acquisition || typeof acquisition.acquireForEvidence !== "function" || !vault ||
      typeof vault.storeAcceptedEvidence !== "function" ||
      typeof vault.verifyOccurrence !== "function" || !formal ||
      typeof formal.commit !== "function" || typeof formal.readSnapshot !== "function")
    fail("boj_calendar_evidence_runtime_input_invalid");
  async function acquireAndCommit(input = {}) {
    if (!exact(input, ["acceptedAt", "generationIdentity", "acquisitionContext"]) ||
        !timestamp(input.acceptedAt) || !/^[0-9a-f]{64}$/.test(input.generationIdentity || "") ||
        !Evidence.ACQUISITION_CONTEXTS.includes(input.acquisitionContext))
      fail("boj_calendar_evidence_run_input_invalid");
    const acquired = await acquisition.acquireForEvidence({ sourceId: SOURCE_ID,
      operation: Network.OPERATION }), assessed = assessAcquisition(acquired);
    if (!assessed.valid) return freeze({ status: "failed",
      diagnostic: diagnosticFor(assessed.reason), reason: assessed.reason,
      evidenceTransactionCount: 0, formalTransactionCount: 0, semanticWrites: 0,
      sourceEvidenceSet: null });
    let generated, sourceEvidenceSet, stored = [];
    try {
      generated = createEvidenceInputs(acquired, input.acquisitionContext);
      for (const evidenceInput of generated.inputs)
        stored.push(vault.storeAcceptedEvidence(evidenceInput));
      const documents = generated.inputs.map((evidenceInput, index) => {
        const evidenceRef = Evidence.createSourceEvidenceRef({ state: "available",
          occurrence: evidenceInput.occurrence, policy: evidenceInput.policy });
        if (vault.verifyOccurrence(evidenceRef.occurrenceId).status !== "valid")
          fail("boj_calendar_evidence_readback_invalid");
        return { role: routes[index].role, sourceUrl: evidenceInput.occurrence.sourceUrl,
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
    const candidate = acquired.candidate;
    if (candidate?.candidateStatus !== "available" || candidate.formalEligible !== true ||
        candidate.parserStatus !== "success" || candidate.canonicalizationStatus !== "success" ||
        !candidate.canonicalRecords?.length) {
      const rejected = parserDiagnostic(candidate);
      return freeze({ status: "failed", diagnostic: rejected.diagnostic,
        reason: rejected.reason, evidenceTransactionCount: stored.reduce((sum, value) =>
          sum + value.occurrenceWriteCount, 0), formalTransactionCount: 0,
        semanticWrites: 0, sourceEvidenceSet });
    }
    let committed;
    try {
      const resolved = SourceEvidenceSet.resolveRunEvidence({ run: { sourceId: SOURCE_ID,
        sourceEvidenceSet }, vault });
      if (resolved.status !== "available")
        fail(resolved.reason || "boj_calendar_precommit_invalid");
      committed = await formal.commit({ sourceResult: sourceResultFor(candidate, acquired,
        input.generationIdentity, sourceEvidenceSet), acceptedAt: input.acceptedAt,
      generationIdentity: input.generationIdentity });
      if (!committed || !["committed", "unchanged", "already_committed"].includes(committed.status))
        fail(committed?.reason || "formal_commit_failed");
    } catch (error) {
      return freeze({ status: "failed", diagnostic: "formal_write_aborted",
        reason: error.message, evidenceTransactionCount: stored.reduce((sum, value) =>
          sum + value.occurrenceWriteCount, 0), formalTransactionCount: 0,
        semanticWrites: 0, acquisitionRunId: generated.acquisitionRunId, sourceEvidenceSet });
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

module.exports = freeze({ SOURCE_ID, PILOT_VERSION, TRANSPORT_VERSION, DIAGNOSTICS,
  WORKBOOK_SAFETY_VERSION, ROLE_TRANSPORT_VERSIONS, assessAcquisition,
  createBojCalendarEvidencePolicy, createEvidenceInputs, sourceResultFor,
  createPilotRuntime });
