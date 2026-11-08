"use strict";

const Contract = require("../marketCalendarHistory/calendarPartialBootstrapContract.js");
const SourceEvidenceSet = require("../marketCalendarHistory/jpxDerivativesCalendarSourceEvidenceSet.js");
const Evidence = require("../sourceEvidence/sourceEvidenceContract.js");
const Registry = require("../marketCalendar/sourceRegistry.js");
const Network = require("../marketCalendarRuntime/calendarNetworkPolicy.js");
const Builder = require("../marketCalendarRuntime/calendarCandidateBuilder.js");

const PILOT_VERSION = "optionmap-jpx-derivatives-calendar-evidence-pilot-v1";
const TRANSPORT_VERSION = "calendar-jpx-derivatives-landing-workbook-v1";
const DISCOVERY_VERSION = "jpx-workbook-discovery-v1";
const WORKBOOK_SAFETY_VERSION = "calendar-workbook-safety-v1";
const ROLE_TRANSPORT_VERSIONS = Object.freeze({
  landing: "calendar-jpx-derivatives-landing-discovery-v1",
  workbook: "calendar-jpx-derivatives-workbook-safety-v1"
});
const DIAGNOSTICS = Object.freeze(["evidence_saved", "evidence_duplicate_content",
  "landing_discovery_rejected", "workbook_transport_rejected", "workbook_safety_rejected",
  "source_run_consistency_rejected", "source_evidence_write_failed", "parser_rejected",
  "formal_write_aborted"]);
const SOURCE_ID = SourceEvidenceSet.SOURCE_ID;
const source = Registry.getSource(SOURCE_ID), routes = Network.getPolicy(SOURCE_ID).documents;
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
function documentTransportValid(document, route) {
  const initial = Network.validateUrl(SOURCE_ID, route, document?.originalOfficialUrl),
    final = Network.validateUrl(SOURCE_ID, route, document?.finalUrl),
    mime = Network.validateMime(route, document?.mime);
  return initial.valid && final.valid && mime.valid && document.httpStatus === 200 &&
    redirectsValid(document);
}
function assessAcquisition(acquisition) {
  if (acquisition?.success !== true || acquisition.sourceId !== SOURCE_ID ||
      acquisition.operation !== Network.OPERATION || !timestamp(acquisition.fetchedAt))
    return freeze({ valid: false, reason: acquisition?.reason || "acquisition_identity_invalid" });
  const documents = orderedDocuments(acquisition);
  if (!documents) return freeze({ valid: false, reason: "source_document_set_incomplete" });
  const [landing, workbook] = documents, landingBytes = bytes(landing.parserInput);
  if (!documentTransportValid(landing, routes[0]) || !landingBytes ||
      !landing.encoding || landing.encoding.evidence?.resolutionPolicyVersion !== 1 ||
      !["utf-8", "windows-1252"].includes(landing.encoding.encoding) ||
      landing.byteCount !== landingBytes.byteLength ||
      landing.contentSha256 !== Evidence.sha256Bytes(landingBytes) ||
      landing.parserInputSha256 !== landing.contentSha256)
    return freeze({ valid: false, reason: "landing_transport_invalid" });
  const discovery = SourceEvidenceSet.discoverWorkbookAuthority(landingBytes,
    landing.encoding.encoding, acquisition.fetchedAt, landing.finalUrl);
  if (!discovery.valid) return freeze({ valid: false, reason: discovery.reason });
  if (!documentTransportValid(workbook, routes[1]) ||
      workbook.originalOfficialUrl !== discovery.url || workbook.encoding !== null)
    return freeze({ valid: false, reason: "workbook_transport_invalid" });
  const parserBytes = bytes(workbook.parserInput), originalBytes =
    bytes(workbook.evidenceInput) || parserBytes;
  if (!parserBytes || !originalBytes || originalBytes.byteLength > routes[1].maxBytes ||
      workbook.byteCount !== originalBytes.byteLength ||
      workbook.contentSha256 !== Evidence.sha256Bytes(originalBytes) ||
      workbook.parserInputSha256 !== Evidence.sha256Bytes(parserBytes))
    return freeze({ valid: false, reason: "workbook_raw_identity_invalid" });
  if (workbook.workbook?.valid !== true ||
      typeof workbook.workbook.sanitized !== "boolean" ||
      workbook.workbook.inspection?.valid !== true)
    return freeze({ valid: false, reason: "workbook_safety_invalid" });
  if (workbook.workbook.sanitized === true && (!bytes(workbook.evidenceInput) ||
      !["external_relationship_forbidden", "unsafe_external_reference"]
        .includes(workbook.workbook.originalReason)))
    return freeze({ valid: false, reason: "workbook_original_bytes_missing" });
  if (workbook.workbook.sanitized === false &&
      workbook.contentSha256 !== workbook.parserInputSha256)
    return freeze({ valid: false, reason: "workbook_unsanitized_identity_mismatch" });
  return freeze({ valid: true, reason: null, documents, discovery });
}
function diagnosticFor(reason) {
  if (/^(?:workbook_not_discovered|workbook_discovery_)/.test(reason || ""))
    return "landing_discovery_rejected";
  if (/^workbook_(?:transport|raw_identity)/.test(reason || ""))
    return "workbook_transport_rejected";
  if (/^workbook_(?:safety|original_bytes|unsanitized)/.test(reason || ""))
    return "workbook_safety_rejected";
  return "source_run_consistency_rejected";
}
function createJpxDerivativesEvidencePolicy() {
  return Evidence.createSourcePolicy({ sourceFamily: "market_calendar", sourceId: SOURCE_ID,
    allowedMediaTypes: [...new Set(routes.flatMap(route => route.allowedMime))],
    allowedEncodings: [null, "utf-8", "windows-1252"],
    maxBytes: Math.max(...routes.map(route => route.maxBytes)) });
}
function createEvidenceInputs(acquisition, acquisitionContext) {
  const assessed = assessAcquisition(acquisition);
  if (!assessed.valid || !Evidence.ACQUISITION_CONTEXTS.includes(acquisitionContext))
    fail(assessed.reason || "jpx_derivatives_evidence_acquisition_invalid");
  const policy = createJpxDerivativesEvidencePolicy(), acquisitionRunId =
    `jpx-derivatives-calendar-acquisition|sha256:${Evidence.sha256Canonical({
      sourceId: SOURCE_ID, parserId: source.parserId, parserVersion: source.parserVersion,
      discoveryVersion: DISCOVERY_VERSION, workbookSafetyVersion: WORKBOOK_SAFETY_VERSION,
      fetchedAt: acquisition.fetchedAt, discoveredWorkbook: assessed.discovery.url,
      workbookSafety: assessed.documents[1].workbook,
      documents: assessed.documents.map(document => ({ role: document.role,
        initialUrl: document.originalOfficialUrl, sourceUrl: document.finalUrl,
        contentSha256: document.contentSha256, parserInputSha256: document.parserInputSha256,
        byteCount: document.byteCount })) })}`,
    inputs = assessed.documents.map((document, index) => {
      const route = routes[index], raw = route.role === "workbook"
        ? bytes(document.evidenceInput) || bytes(document.parserInput) : bytes(document.parserInput),
        encoding = route.role === "workbook" ? null : document.encoding.encoding,
        contentObject = Evidence.createContentObject({ bytes: raw, mediaType: document.mime,
          encoding, policy });
      if (contentObject.sha256 !== document.contentSha256 ||
          contentObject.byteLength !== document.byteCount)
        fail("jpx_derivatives_content_identity_mismatch");
      const occurrence = Evidence.createAcquisitionOccurrence({ sourceFamily: "market_calendar",
        sourceId: SOURCE_ID, initialUrl: document.originalOfficialUrl,
        sourceUrl: document.finalUrl, fetchedAt: acquisition.fetchedAt,
        httpStatus: document.httpStatus, contentObject,
        transportVersion: ROLE_TRANSPORT_VERSIONS[route.role],
        publishedAt: null, requestRole: route.role,
        redirectHops: document.redirects.map(hop => ({ status: hop.status, url: hop.to })),
        sourceDocumentRole: route.role, runId: acquisitionRunId, acquisitionContext }, policy);
      return freeze({ bytes: raw, contentObject, occurrence, policy });
    });
  return freeze({ acquisitionRunId, discovery: assessed.discovery, inputs });
}
function sourceResultFor(candidate, acquisition, generationIdentity, sourceEvidenceSet) {
  const documents = orderedDocuments(acquisition);
  return freeze({ sourceId: SOURCE_ID, routeIdentity: Contract.expectedRouteIdentity(SOURCE_ID),
    generationIdentity, acquisitionOutcome: "complete", candidateStatus: "available",
    formalEligible: true, candidateIdentity: candidate.candidateIdentity,
    canonicalRecords: candidate.canonicalRecords, parserStatus: "success",
    structureGuardStatus: "passed", canonicalizationStatus: "success",
    parserDiagnostics: [], canonicalDiagnostics: [], failedRoles: [], ambiguityCount: 0,
    duplicateCount: 0, identityCollisionCount: 0, absenceAuthority: "none", coverage: null,
    documentHealth: documents.map(document => ({ role: document.role,
      httpStatus: document.httpStatus, redirectCount: document.redirects.length,
      fetchOutcome: "success", parseOutcome: "success" })), sourceEvidenceSet });
}
function createPilotRuntime({ acquisition, vault, formal, builder = Builder } = {}) {
  if (!acquisition || typeof acquisition.acquire !== "function" || !vault ||
      typeof vault.storeAcceptedEvidence !== "function" ||
      typeof vault.verifyOccurrence !== "function" || !formal ||
      typeof formal.commit !== "function" || typeof formal.readSnapshot !== "function" ||
      !builder || typeof builder.buildCalendarCandidate !== "function")
    fail("jpx_derivatives_evidence_runtime_input_invalid");
  async function acquireAndCommit(input = {}) {
    if (!exact(input, ["acceptedAt", "generationIdentity", "acquisitionContext"]) ||
        !timestamp(input.acceptedAt) || !/^[0-9a-f]{64}$/.test(input.generationIdentity || "") ||
        !Evidence.ACQUISITION_CONTEXTS.includes(input.acquisitionContext))
      fail("jpx_derivatives_evidence_run_input_invalid");
    const acquired = await acquisition.acquire({ sourceId: SOURCE_ID,
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
          fail("jpx_derivatives_evidence_readback_invalid");
        return { role: routes[index].role, sourceUrl: evidenceInput.occurrence.sourceUrl,
          byteLength: evidenceInput.contentObject.byteLength,
          mediaType: evidenceInput.contentObject.mediaType,
          encoding: evidenceInput.contentObject.encoding, evidenceRef };
      });
      sourceEvidenceSet = SourceEvidenceSet.createSourceEvidenceSet({
        acquisitionRunId: generated.acquisitionRunId, documents,
        workbookInitialUrl: generated.inputs[1].occurrence.initialUrl });
    } catch (error) {
      return freeze({ status: "failed", diagnostic: "source_evidence_write_failed",
        reason: error.message, evidenceTransactionCount: stored.reduce((sum, value) =>
          sum + value.occurrenceWriteCount, 0), formalTransactionCount: 0,
        semanticWrites: 0, sourceEvidenceSet: null });
    }
    const candidate = await builder.buildCalendarCandidate({ sourceId: SOURCE_ID,
      acquisitionResult: acquired });
    if (candidate.candidateStatus !== "available" || candidate.formalEligible !== true ||
        candidate.parserStatus !== "success" || candidate.canonicalizationStatus !== "success" ||
        !candidate.canonicalRecords.length)
      return freeze({ status: "failed", diagnostic: "parser_rejected",
        reason: candidate.reason || candidate.parserDiagnostics?.[0] || "parser_rejected",
        evidenceTransactionCount: stored.reduce((sum, value) =>
          sum + value.occurrenceWriteCount, 0), formalTransactionCount: 0,
        semanticWrites: 0, sourceEvidenceSet });
    let committed;
    try {
      const resolved = SourceEvidenceSet.resolveRunEvidence({ run: { sourceId: SOURCE_ID,
        sourceEvidenceSet }, vault });
      if (resolved.status !== "available") fail(resolved.reason || "jpx_derivatives_precommit_invalid");
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
  DISCOVERY_VERSION, WORKBOOK_SAFETY_VERSION, ROLE_TRANSPORT_VERSIONS,
  assessAcquisition, createJpxDerivativesEvidencePolicy, createEvidenceInputs,
  sourceResultFor, createPilotRuntime });
