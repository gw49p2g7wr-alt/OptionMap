"use strict";

// Fixed, one-document Calendar evidence flow shared by source-specific pilots.
// Source policy remains outside this module; this core owns no route discovery,
// production storage, writer authority, or Runtime State access.
const Contract = require("../marketCalendarHistory/calendarPartialBootstrapContract.js");
const Evidence = require("../sourceEvidence/sourceEvidenceContract.js");
const Registry = require("../marketCalendar/sourceRegistry.js");
const Network = require("../marketCalendarRuntime/calendarNetworkPolicy.js");
const Builder = require("../marketCalendarRuntime/calendarCandidateBuilder.js");

const CORE_VERSION = "optionmap-calendar-single-document-evidence-pilot-v1";
const TRANSPORT_VERSION = "calendar-legacy-single-document-v1";
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
function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}
function validConfiguration(value) {
  return exact(value, ["sourceId", "sourceEvidenceSet", "pilotVersion", "runIdPrefix",
    "diagnosticPrefix", "allowedEncodings"]) &&
    typeof value.sourceId === "string" && value.sourceEvidenceSet?.SOURCE_ID === value.sourceId &&
    typeof value.sourceEvidenceSet.createSourceEvidenceSet === "function" &&
    typeof value.sourceEvidenceSet.resolveRunEvidence === "function" &&
    typeof value.sourceEvidenceSet.resolveRevisionEvidence === "function" &&
    typeof value.pilotVersion === "string" && typeof value.runIdPrefix === "string" &&
    /^[a-z0-9-]+$/.test(value.runIdPrefix) && typeof value.diagnosticPrefix === "string" &&
    /^[a-z0-9_]+$/.test(value.diagnosticPrefix) && Array.isArray(value.allowedEncodings) &&
    value.allowedEncodings.length > 0 && value.allowedEncodings.every(encoding =>
      typeof encoding === "string");
}

function createSingleDocumentEvidencePilot(configuration) {
  if (!validConfiguration(configuration)) fail("calendar_single_document_pilot_policy_invalid");
  const { sourceId, sourceEvidenceSet, pilotVersion, runIdPrefix, diagnosticPrefix } = configuration,
    allowedEncodings = Object.freeze([...configuration.allowedEncodings]),
    source = Registry.getSource(sourceId), sourcePolicy = Network.getPolicy(sourceId),
    route = sourcePolicy?.documents?.[0];
  if (!source || source.formalEligible !== true || sourcePolicy?.documents?.length !== 1 ||
      route?.role !== "primary" || route.url !== source.canonicalUrl)
    fail("calendar_single_document_route_policy_invalid");
  const reason = suffix => `${diagnosticPrefix}_${suffix}`;
  function createEvidencePolicy() {
    return Evidence.createSourcePolicy({ sourceFamily: "market_calendar", sourceId,
      allowedMediaTypes: route.allowedMime, allowedEncodings, maxBytes: route.maxBytes });
  }
  function acceptedAcquisition(acquisition) {
    if (acquisition?.success !== true || acquisition.sourceId !== sourceId ||
        acquisition.operation !== Network.OPERATION || !timestamp(acquisition.fetchedAt) ||
        !Array.isArray(acquisition.documents) || acquisition.documents.length !== 1) return false;
    const document = acquisition.documents[0], raw = bytes(document?.parserInput),
      initial = Network.validateUrl(sourceId, route, document?.originalOfficialUrl),
      final = Network.validateUrl(sourceId, route, document?.finalUrl),
      mime = Network.validateMime(route, document?.mime), encoding = document?.encoding?.encoding;
    return document?.role === "primary" && initial.valid && final.valid &&
      document.httpStatus === 200 && mime.valid && allowedEncodings.includes(encoding) &&
      document.encoding?.evidence?.resolutionPolicyVersion === 1 &&
      Array.isArray(document.redirects) && document.redirects.length <= Network.MAX_REDIRECTS &&
      document.redirects.every(hop => Number.isInteger(hop.status) && hop.status >= 300 &&
        hop.status <= 399 && hop.accepted === true && typeof hop.to === "string") &&
      raw instanceof Uint8Array && raw.byteLength > 0 && raw.byteLength <= route.maxBytes &&
      document.byteCount === raw.byteLength && document.contentSha256 === Evidence.sha256Bytes(raw) &&
      document.parserInputSha256 === document.contentSha256;
  }
  function createEvidenceInput(acquisition, acquisitionContext) {
    if (!acceptedAcquisition(acquisition) ||
        !Evidence.ACQUISITION_CONTEXTS.includes(acquisitionContext))
      fail(reason("evidence_acquisition_invalid"));
    const document = acquisition.documents[0], policy = createEvidencePolicy(),
      acquisitionRunId = `${runIdPrefix}|sha256:${Evidence.sha256Canonical({
        sourceId, fetchedAt: acquisition.fetchedAt, role: document.role,
        initialUrl: document.originalOfficialUrl, sourceUrl: document.finalUrl,
        contentSha256: document.contentSha256, byteCount: document.byteCount })}`,
      contentObject = Evidence.createContentObject({ bytes: document.parserInput,
        mediaType: document.mime, encoding: document.encoding.encoding, policy });
    if (contentObject.sha256 !== document.contentSha256 ||
        contentObject.byteLength !== document.byteCount)
      fail(reason("content_identity_mismatch"));
    const occurrence = Evidence.createAcquisitionOccurrence({ sourceFamily: "market_calendar",
      sourceId, initialUrl: document.originalOfficialUrl, sourceUrl: document.finalUrl,
      fetchedAt: acquisition.fetchedAt, httpStatus: document.httpStatus, contentObject,
      transportVersion: TRANSPORT_VERSION, publishedAt: null, requestRole: document.role,
      redirectHops: document.redirects.map(hop => ({ status: hop.status, url: hop.to })),
      sourceDocumentRole: document.role, runId: acquisitionRunId, acquisitionContext }, policy);
    return freeze({ acquisitionRunId,
      input: { bytes: document.parserInput, contentObject, occurrence, policy } });
  }
  function sourceResultFor(candidate, acquisition, generationIdentity, sourceEvidenceSetValue) {
    const document = acquisition.documents[0];
    return freeze({ sourceId, routeIdentity: Contract.expectedRouteIdentity(sourceId),
      generationIdentity, acquisitionOutcome: "complete", candidateStatus: "available",
      formalEligible: true, candidateIdentity: candidate.candidateIdentity,
      canonicalRecords: candidate.canonicalRecords, parserStatus: "success",
      structureGuardStatus: "passed", canonicalizationStatus: "success",
      parserDiagnostics: [], canonicalDiagnostics: [], failedRoles: [], ambiguityCount: 0,
      duplicateCount: 0, identityCollisionCount: 0, absenceAuthority: "none", coverage: null,
      documentHealth: [{ role: "primary", httpStatus: document.httpStatus,
        redirectCount: document.redirects.length, fetchOutcome: "success", parseOutcome: "success" }],
      sourceEvidenceSet: sourceEvidenceSetValue });
  }
  function createPilotRuntime({ acquisition, vault, formal, builder = Builder } = {}) {
    if (!acquisition || typeof acquisition.acquire !== "function" || !vault ||
        typeof vault.storeAcceptedEvidence !== "function" ||
        typeof vault.verifyOccurrence !== "function" || !formal ||
        typeof formal.commit !== "function" || typeof formal.readSnapshot !== "function" ||
        !builder || typeof builder.buildCalendarCandidate !== "function")
      fail(reason("evidence_runtime_input_invalid"));
    async function acquireAndCommit(input = {}) {
      if (!exact(input, ["acceptedAt", "generationIdentity", "acquisitionContext"]) ||
          !timestamp(input.acceptedAt) || !/^[0-9a-f]{64}$/.test(input.generationIdentity || "") ||
          !Evidence.ACQUISITION_CONTEXTS.includes(input.acquisitionContext))
        fail(reason("evidence_run_input_invalid"));
      const acquired = await acquisition.acquire({ sourceId, operation: Network.OPERATION });
      if (!acceptedAcquisition(acquired)) return freeze({ status: "failed",
        diagnostic: "evidence_invalid", reason: acquired?.reason || "acquisition_invalid",
        evidenceTransactionCount: 0, formalTransactionCount: 0, semanticWrites: 0,
        sourceEvidenceSet: null });
      let generated, sourceEvidenceSetValue, stored;
      try {
        generated = createEvidenceInput(acquired, input.acquisitionContext);
        stored = vault.storeAcceptedEvidence(generated.input);
        const evidenceRef = Evidence.createSourceEvidenceRef({ state: "available",
          occurrence: generated.input.occurrence, policy: generated.input.policy });
        if (vault.verifyOccurrence(evidenceRef.occurrenceId).status !== "valid")
          fail(reason("evidence_readback_invalid"));
        sourceEvidenceSetValue = sourceEvidenceSet.createSourceEvidenceSet({
          acquisitionRunId: generated.acquisitionRunId, documents: [{ role: "primary",
            sourceUrl: generated.input.occurrence.sourceUrl,
            byteLength: generated.input.contentObject.byteLength,
            mediaType: generated.input.contentObject.mediaType,
            encoding: generated.input.contentObject.encoding, evidenceRef }] });
      } catch (error) {
        return freeze({ status: "failed", diagnostic: "source_evidence_write_failed",
          reason: error.message, evidenceTransactionCount: stored?.occurrenceWriteCount || 0,
          formalTransactionCount: 0, semanticWrites: 0, sourceEvidenceSet: null });
      }
      const candidate = await builder.buildCalendarCandidate({ sourceId,
        acquisitionResult: acquired });
      if (candidate.candidateStatus !== "available" || candidate.formalEligible !== true ||
          candidate.parserStatus !== "success" || candidate.canonicalizationStatus !== "success" ||
          !candidate.canonicalRecords.length)
        return freeze({ status: "failed", diagnostic: "parser_rejected",
          reason: candidate.reason || candidate.parserDiagnostics?.[0] || "parser_rejected",
          evidenceTransactionCount: stored.occurrenceWriteCount, formalTransactionCount: 0,
          semanticWrites: 0, sourceEvidenceSet: sourceEvidenceSetValue });
      let committed;
      try {
        if (vault.verifyOccurrence(sourceEvidenceSetValue.documents[0].evidenceRef
          .occurrenceId).status !== "valid") fail(reason("evidence_precommit_invalid"));
        committed = await formal.commit({ sourceResult: sourceResultFor(candidate, acquired,
          input.generationIdentity, sourceEvidenceSetValue), acceptedAt: input.acceptedAt,
        generationIdentity: input.generationIdentity });
        if (!committed || !["committed", "unchanged", "already_committed"].includes(committed.status))
          fail(committed?.reason || "formal_commit_failed");
      } catch (error) {
        return freeze({ status: "failed", diagnostic: "formal_write_aborted",
          reason: error.message, evidenceTransactionCount: stored.occurrenceWriteCount,
          formalTransactionCount: 0, semanticWrites: 0,
          acquisitionRunId: generated.acquisitionRunId, sourceEvidenceSet: sourceEvidenceSetValue });
      }
      return freeze({ status: committed.status,
        diagnostic: stored.contentClassification === "verified_reuse" ?
          "evidence_duplicate_content" : "evidence_saved", reason: null,
        evidenceTransactionCount: stored.occurrenceWriteCount,
        formalTransactionCount: committed.transactionCount || 0,
        semanticWrites: committed.semanticWrites || 0,
        acquisitionRunId: generated.acquisitionRunId, sourceEvidenceSet: sourceEvidenceSetValue });
    }
    return freeze({ pilotVersion, acquireAndCommit,
      readSnapshot: formal.readSnapshot,
      resolveRunEvidence: run => sourceEvidenceSet.resolveRunEvidence({ run, vault }),
      resolveRevisionEvidence: revisionKey => formal.readSnapshot().then(result =>
        sourceEvidenceSet.resolveRevisionEvidence({ snapshot: result.snapshot, vault, revisionKey })) });
  }
  return freeze({ SOURCE_ID: sourceId, CORE_VERSION, PILOT_VERSION: pilotVersion,
    TRANSPORT_VERSION, DIAGNOSTICS, createEvidencePolicy, acceptedAcquisition,
    createEvidenceInput, sourceResultFor, createPilotRuntime });
}

module.exports = freeze({ CORE_VERSION, TRANSPORT_VERSION, DIAGNOSTICS,
  createSingleDocumentEvidencePilot });
