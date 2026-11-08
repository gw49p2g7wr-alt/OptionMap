"use strict";

const Contract = require("../marketCalendarHistory/calendarPartialBootstrapContract.js");
const SourceEvidenceSet = require("../marketCalendarHistory/mofCalendarSourceEvidenceSet.js");
const Evidence = require("../sourceEvidence/sourceEvidenceContract.js");
const Source = require("./mofJgbSource.js");
const Registry = require("../marketCalendar/sourceRegistry.js");
const Network = require("../marketCalendarRuntime/calendarNetworkPolicy.js");

const PILOT_VERSION = "optionmap-mof-calendar-evidence-pilot-v1";
const INDEX_TRANSPORT_VERSION = "calendar-mof-index-discovery-v1";
const MONTH_TRANSPORT_VERSION = "calendar-mof-month-page-v1";
const DIAGNOSTICS = Object.freeze(["evidence_saved", "evidence_duplicate_content",
  "index_transport_rejected", "index_parser_rejected", "discovery_manifest_rejected",
  "month_page_transport_rejected", "month_page_parser_rejected",
  "source_evidence_set_invalid", "source_evidence_write_failed", "formal_write_aborted"]);
const SOURCE_ID = SourceEvidenceSet.SOURCE_ID, source = Registry.getSource(SOURCE_ID);
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
function roleForUrl(url) {
  if (url === Source.INDEX_URL) return "index";
  const month = Source.pageMonth(url);
  return month ? `month:${month}` : null;
}
function diagnosticFor(acquisition, reason) {
  if (/^index_(?:structure|month|limit)|duplicate_month/.test(reason || ""))
    return reason === "index_structure_invalid" ? "index_parser_rejected" :
      "discovery_manifest_rejected";
  const failed = acquisition?.documents?.at(-1);
  if (failed?.requestedUrl === Source.INDEX_URL || !failed)
    return "index_transport_rejected";
  if (failed.outcome === "failed") return "month_page_transport_rejected";
  return "source_evidence_set_invalid";
}
function assessAcquisition(acquisition) {
  if (!acquisition || acquisition.sourceId !== SOURCE_ID ||
      acquisition.operation !== Network.OPERATION || !Source.validDate(acquisition.assessmentDateJst) ||
      !timestamp(acquisition.fetchedAt)) return freeze({ valid: false,
        reason: acquisition?.reason || "acquisition_identity_invalid" });
  if (acquisition.success !== true) return freeze({ valid: false,
    reason: acquisition.reason || "acquisition_incomplete" });
  if (!Array.isArray(acquisition.documents) || !Array.isArray(acquisition.discovery?.months))
    return freeze({ valid: false, reason: "source_document_set_incomplete" });
  const indexDocuments = acquisition.documents.filter(document =>
    document?.requestedUrl === Source.INDEX_URL);
  if (indexDocuments.length !== 1) return freeze({ valid: false,
    reason: "source_document_set_incomplete" });
  const index = indexDocuments[0], indexRaw = bytes(index.evidenceInput);
  if (index.outcome !== "complete" || index.finalUrl !== Source.INDEX_URL ||
      index.httpStatus !== 200 || index.mime !== "text/html" || index.encoding !== "utf-8" ||
      !indexRaw || index.byteCount !== indexRaw.byteLength ||
      index.rawContentHash !== Evidence.sha256Bytes(indexRaw) ||
      !Array.isArray(index.redirects) || index.redirects.length !== 0)
    return freeze({ valid: false, reason: "index_transport_invalid" });
  const decoded = Source.decode(indexRaw, index.contentType);
  if (!decoded.ok) return freeze({ valid: false, reason: decoded.reason || "index_decode_failed" });
  const discovery = Source.discoverMonths(decoded.text, acquisition.assessmentDateJst);
  if (!discovery.ok || discovery.duplicateCount) return freeze({ valid: false,
    reason: discovery.reason || "duplicate_month_document" });
  if (discovery.months.length < 1 ||
      discovery.months.length > SourceEvidenceSet.MAX_MONTH_ROLES)
    return freeze({ valid: false, reason: "index_month_limit_exceeded" });
  if (Evidence.sha256Canonical(discovery.months) !==
      Evidence.sha256Canonical(acquisition.discovery.months))
    return freeze({ valid: false, reason: "discovery_manifest_mismatch" });
  const expected = [{ role: "index", url: Source.INDEX_URL }, ...discovery.months.map(value =>
    ({ role: `month:${value.month}`, url: value.url }))], documents = [];
  if (acquisition.documents.length !== expected.length)
    return freeze({ valid: false, reason: "source_document_set_incomplete" });
  for (const item of expected) {
    const matches = acquisition.documents.filter(document => document?.requestedUrl === item.url);
    if (matches.length !== 1) return freeze({ valid: false, reason: "source_document_set_incomplete" });
    const document = matches[0], raw = bytes(document.evidenceInput);
    if (roleForUrl(document.requestedUrl) !== item.role || document.outcome !== "complete" ||
        document.finalUrl !== item.url || document.httpStatus !== 200 ||
        document.mime !== "text/html" || document.encoding !== "utf-8" || !raw ||
        document.byteCount !== raw.byteLength || document.rawContentHash !==
        Evidence.sha256Bytes(raw) || !Array.isArray(document.redirects) ||
        document.redirects.length !== 0)
      return freeze({ valid: false, reason: item.role === "index" ?
        "index_transport_invalid" : "month_page_transport_invalid" });
    documents.push({ role: item.role, url: item.url, document, raw });
  }
  return freeze({ valid: true, reason: null, discovery, documents });
}
function createMofCalendarEvidencePolicy() {
  return Evidence.createSourcePolicy({ sourceFamily: "market_calendar", sourceId: SOURCE_ID,
    allowedMediaTypes: ["text/html"], allowedEncodings: ["utf-8"],
    maxBytes: Source.MAX_BYTES });
}
function createEvidenceInputs(acquisition, acquisitionContext) {
  const assessed = assessAcquisition(acquisition);
  if (!assessed.valid || !Evidence.ACQUISITION_CONTEXTS.includes(acquisitionContext))
    fail(assessed.reason || "mof_calendar_evidence_acquisition_invalid");
  const policy = createMofCalendarEvidencePolicy(), manifest =
    SourceEvidenceSet.createManifest({ assessmentDateJst: acquisition.assessmentDateJst,
      documents: assessed.documents.map(value => ({ role: value.role, url: value.url })) }),
    acquisitionRunId = `mof-calendar-acquisition|sha256:${Evidence.sha256Canonical({
      sourceId: SOURCE_ID, parserId: source.parserId, parserVersion: source.parserVersion,
      fetchedAt: acquisition.fetchedAt, manifestSha256: manifest.manifestSha256,
      documents: assessed.documents.map(value => ({ role: value.role, url: value.url,
        contentSha256: value.document.rawContentHash, byteCount: value.document.byteCount })) })}`,
    roles = assessed.documents.map(value => value.role), inputs = assessed.documents.map(value => {
      const contentObject = Evidence.createContentObject({ bytes: value.raw,
        mediaType: value.document.mime, encoding: value.document.encoding, policy });
      if (contentObject.sha256 !== value.document.rawContentHash ||
          contentObject.byteLength !== value.document.byteCount)
        fail("mof_calendar_content_identity_mismatch");
      const occurrence = Evidence.createAcquisitionOccurrence({ sourceFamily: "market_calendar",
        sourceId: SOURCE_ID, initialUrl: value.url, sourceUrl: value.url,
        fetchedAt: acquisition.fetchedAt, httpStatus: value.document.httpStatus, contentObject,
        transportVersion: value.role === "index" ? INDEX_TRANSPORT_VERSION :
          MONTH_TRANSPORT_VERSION, publishedAt: null, requestRole: value.role,
        redirectHops: [], sourceDocumentRole: value.role, runId: acquisitionRunId,
        acquisitionContext }, policy);
      return freeze({ bytes: value.raw, contentObject, occurrence, policy });
    });
  return freeze({ acquisitionRunId, manifest, roles, inputs });
}
function sourceResultFor(candidate, acquisition, generationIdentity, sourceEvidenceSet) {
  const documents = sourceEvidenceSet.documents;
  return freeze({ sourceId: SOURCE_ID, routeIdentity: Contract.expectedRouteIdentity(SOURCE_ID),
    generationIdentity, acquisitionOutcome: "complete", candidateStatus: "available",
    formalEligible: true, candidateIdentity: candidate.candidateIdentity,
    canonicalRecords: candidate.canonicalRecords, parserStatus: "success",
    structureGuardStatus: "passed", canonicalizationStatus: "success",
    parserDiagnostics: [], canonicalDiagnostics: [], failedRoles: [], ambiguityCount: 0,
    duplicateCount: 0, identityCollisionCount: 0, absenceAuthority: "none",
    coverage: { coverageState: "published_months_only", absenceAuthority: "none" },
    documentHealth: documents.map(document => ({ role: document.role,
      httpStatus: 200, redirectCount: 0, fetchOutcome: "success", parseOutcome: "success" })),
    sourceEvidenceSet });
}
function createPilotRuntime({ acquisition, vault, formal } = {}) {
  if (!acquisition || typeof acquisition.acquireForEvidence !== "function" || !vault ||
      typeof vault.storeAcceptedEvidence !== "function" ||
      typeof vault.verifyOccurrence !== "function" || !formal ||
      typeof formal.commit !== "function" || typeof formal.readSnapshot !== "function")
    fail("mof_calendar_evidence_runtime_input_invalid");
  async function acquireAndCommit(input = {}) {
    if (!exact(input, ["acceptedAt", "generationIdentity", "acquisitionContext"]) ||
        !timestamp(input.acceptedAt) || !/^[0-9a-f]{64}$/.test(input.generationIdentity || "") ||
        !Evidence.ACQUISITION_CONTEXTS.includes(input.acquisitionContext))
      fail("mof_calendar_evidence_run_input_invalid");
    const acquired = await acquisition.acquireForEvidence({ sourceId: SOURCE_ID,
      operation: Network.OPERATION }), assessed = assessAcquisition(acquired);
    if (!assessed.valid) return freeze({ status: "failed",
      diagnostic: diagnosticFor(acquired, assessed.reason), reason: assessed.reason,
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
          fail("mof_calendar_evidence_readback_invalid");
        return { role: generated.roles[index], sourceUrl: evidenceInput.occurrence.sourceUrl,
          byteLength: evidenceInput.contentObject.byteLength,
          mediaType: evidenceInput.contentObject.mediaType,
          encoding: evidenceInput.contentObject.encoding, evidenceRef };
      });
      sourceEvidenceSet = SourceEvidenceSet.createSourceEvidenceSet({
        acquisitionRunId: generated.acquisitionRunId,
        assessmentDateJst: acquired.assessmentDateJst, documents });
    } catch (error) {
      return freeze({ status: "failed", diagnostic: "source_evidence_write_failed",
        reason: error.message, evidenceTransactionCount: stored.reduce((sum, value) =>
          sum + value.occurrenceWriteCount, 0), formalTransactionCount: 0,
        semanticWrites: 0, sourceEvidenceSet: null });
    }
    const candidate = acquired.candidate;
    if (candidate?.candidateStatus !== "available" || candidate.formalEligible !== true ||
        candidate.parserStatus !== "success" || candidate.canonicalizationStatus !== "success" ||
        !candidate.canonicalRecords?.length)
      return freeze({ status: "failed", diagnostic: "month_page_parser_rejected",
        reason: candidate?.parserDiagnostics?.[0] || "month_page_parser_rejected",
        evidenceTransactionCount: stored.reduce((sum, value) =>
          sum + value.occurrenceWriteCount, 0), formalTransactionCount: 0,
        semanticWrites: 0, sourceEvidenceSet });
    let committed;
    try {
      const resolved = SourceEvidenceSet.resolveRunEvidence({ run: { sourceId: SOURCE_ID,
        sourceEvidenceSet }, vault });
      if (resolved.status !== "available")
        fail(resolved.reason || "mof_calendar_precommit_invalid");
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

module.exports = freeze({ SOURCE_ID, PILOT_VERSION, INDEX_TRANSPORT_VERSION,
  MONTH_TRANSPORT_VERSION, DIAGNOSTICS, roleForUrl, assessAcquisition,
  createMofCalendarEvidencePolicy, createEvidenceInputs, sourceResultFor,
  createPilotRuntime });
