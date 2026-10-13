"use strict";

const crypto = require("node:crypto");
const XLSX = require("xlsx");
const Registry = require("../marketCalendar/sourceRegistry.js");
const Policy = require("./calendarNetworkPolicy.js");
const Adapters = require("../marketCalendarShadow/representativeAdapters.js");
const Shadow = require("../marketCalendarShadow/shadowAcquisition.js");
const Canonicalizer = require("../marketCalendar/marketEventCanonicalizer.js");

const CANDIDATE_SCHEMA_VERSION = 1;
const HASH = /^[0-9a-f]{64}$/;
const adapters = [...Adapters.create({ XLSX }), Adapters.createStatCpi(),
  Adapters.createStatLabor(), Adapters.createEsriMachineryOrders(), Adapters.createEsriSna(),
  Adapters.createBea(), Adapters.createCensus(), Adapters.createJpxMarketHolidays(),
  Adapters.createNyseMarketHolidays()];
const ADAPTERS = new Map(adapters.map(adapter => [adapter.sourceId, adapter]));
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
function result(sourceId, status, reason, values = {}) {
  return freeze({ sourceId, candidateStatus: status, formalEligible: false,
    candidateIdentity: null, recordCount: 0, canonicalRecords: [], parserStatus: "not_attempted",
    canonicalizationStatus: "not_attempted", parserDiagnostics: reason ? [reason] : [],
    canonicalDiagnostics: [], encodingEvidence: [], sourceIdentity: null, ...values });
}
function bytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return null;
}
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function safeDiagnostics(values) {
  return (Array.isArray(values) ? values : []).map(value => typeof value === "string" &&
    value.length <= 500 && !/(?:file:\/\/|[A-Za-z]:\\|\/(?:Users|home|var|private)\/)/.test(value)
    ? value : "diagnostic_redacted");
}
function validateAcquisition(sourceId, acquisition, documentContract = null) {
  const source = Registry.getSource(sourceId), policy = Policy.getPolicy(sourceId, documentContract);
  if (!source || !policy || !ADAPTERS.has(sourceId)) return { valid: false, reason: "source_unknown" };
  if (!acquisition || typeof acquisition !== "object" || Array.isArray(acquisition))
    return { valid: false, reason: "acquisition_result_malformed" };
  if (acquisition.success !== true) return { valid: false, unavailable: acquisition.success === false,
    reason: acquisition.success === false && typeof acquisition.reason === "string"
      ? acquisition.reason : "acquisition_result_malformed" };
  if (acquisition.sourceId !== sourceId || acquisition.operation !== Policy.OPERATION ||
      !Number.isFinite(Date.parse(acquisition.fetchedAt)) || !Array.isArray(acquisition.documents))
    return { valid: false, reason: "acquisition_identity_invalid" };
  if (acquisition.documents.length !== policy.documents.length)
    return { valid: false, reason: "document_set_incomplete" };
  const normalized = [], seen = new Set();
  for (const documentPolicy of policy.documents) {
    const document = acquisition.documents.find(item => item?.role === documentPolicy.role);
    if (!document || seen.has(document.role)) return { valid: false, reason: "document_role_invalid" };
    seen.add(document.role);
    const input = bytes(document.parserInput), mime = Policy.validateMime(documentPolicy, document.mime);
    if (!input || input.byteLength === 0 || input.byteLength > documentPolicy.maxBytes)
      return { valid: false, reason: "parser_input_invalid" };
    if (!HASH.test(document.contentSha256 || "") || !HASH.test(document.parserInputSha256 || "") ||
        sha256(input) !== document.parserInputSha256)
      return { valid: false, reason: "parser_input_hash_mismatch" };
    if (!mime.valid) return { valid: false, reason: "mime_source_contract_mismatch" };
    const original = Policy.validateUrl(sourceId, documentPolicy, document.originalOfficialUrl);
    const final = Policy.validateUrl(sourceId, documentPolicy, document.finalUrl);
    if (!original.valid || !final.valid) return { valid: false, reason: "document_url_invalid" };
    if (documentPolicy.kind !== "xlsx" && (!document.encoding ||
        document.encoding.evidence?.resolutionPolicyVersion !== 1))
      return { valid: false, reason: "encoding_unresolved" };
    if (documentPolicy.kind === "xlsx" && (document.workbook?.valid !== true ||
        typeof document.workbook.sanitized !== "boolean"))
      return { valid: false, reason: "workbook_safety_evidence_invalid" };
    normalized.push({ ...document, parserInput: input, mime: mime.mime });
  }
  return { valid: true, source, documents: normalized };
}
function contentType(document) {
  const charset = document.encoding?.evidence?.httpCharset;
  return `${document.mime}${charset ? `; charset=${charset}` : ""}`;
}

function createCalendarCandidateBuilder(configuration = {}) {
  const adapterMap = configuration.adapterMap || ADAPTERS;
  const shadowApi = configuration.shadowApi || Shadow;
  async function buildCalendarCandidate(input) {
    const sourceId = typeof input?.sourceId === "string" ? input.sourceId : null;
    const checked = validateAcquisition(sourceId, input?.acquisitionResult, configuration.documentContract || null);
    if (!checked.valid) return result(sourceId, checked.unavailable ? "unavailable" : "rejected",
      checked.reason);
    const adapter = adapterMap.get(sourceId);
    if (!adapter) return result(sourceId, "rejected", "parser_adapter_unavailable");
    const acquisition = input.acquisitionResult;
    const fetcher = async (_sourceId, url) => {
      const document = checked.documents.find(item => item.originalOfficialUrl === url ||
        item.finalUrl === url);
      return document ? { status: "success", reason: null, sourceId, requestId: null,
        requestedUrl: url, finalUrl: document.finalUrl, fetchedAt: acquisition.fetchedAt,
        httpStatus: document.httpStatus, redirects: clone(document.redirects || []),
        contentType: contentType(document), contentHash: document.contentSha256,
        bytes: new Uint8Array(document.parserInput) } : { status: "failure",
        reason: "document_not_in_validated_set", sourceId, requestedUrl: url };
    };
    let shadow;
    try { shadow = await shadowApi.create({ adapters: [adapter], fetcher, runId: null }).run(); }
    catch (_error) { return result(sourceId, "rejected", "candidate_build_failed"); }
    const assessment = shadow?.sources?.[0];
    if (!assessment || assessment.sourceId !== sourceId)
      return result(sourceId, "rejected", "candidate_assessment_invalid");
    const allDiagnostics = safeDiagnostics(assessment.diagnostics), canonicalDiagnostics =
      allDiagnostics.filter(value => /^(?:contract|canonical|timezone|duplicate|identity_collision):/.test(value));
    const parserDiagnostics = allDiagnostics.filter(value => !canonicalDiagnostics.includes(value));
    const sourceIdentity = { sourceId, parserId: checked.source.parserId,
      parserVersion: checked.source.parserVersion, candidateSchemaVersion: CANDIDATE_SCHEMA_VERSION,
      semanticSetHash: assessment.semanticSetHash || null };
    const encodingEvidence = checked.documents.map(document => ({ role: document.role,
      encoding: clone(document.encoding), workbook: clone(document.workbook) }));
    if (assessment.formalEligible !== true || assessment.parserStatus !== "success" ||
        assessment.canonicalizationStatus !== "success" || assessment.duplicates !== 0 ||
        assessment.identityCollisions !== 0 || !assessment.semanticSetHash)
      return result(sourceId, "rejected", null, { parserStatus: assessment.parserStatus,
        canonicalizationStatus: assessment.canonicalizationStatus, parserDiagnostics,
        canonicalDiagnostics, encodingEvidence, sourceIdentity });
    const canonicalRecords = clone(assessment.formalCanonicalSet), candidateIdentity =
      await Canonicalizer.sha256({ sourceId, parserId: checked.source.parserId,
        parserVersion: checked.source.parserVersion, candidateSchemaVersion: CANDIDATE_SCHEMA_VERSION,
        revisionKeys: canonicalRecords.map(record => record.revisionKey).sort() });
    return result(sourceId, "available", null, { formalEligible: true, candidateIdentity,
      recordCount: canonicalRecords.length, canonicalRecords, parserStatus: assessment.parserStatus,
      canonicalizationStatus: assessment.canonicalizationStatus, parserDiagnostics,
      canonicalDiagnostics, encodingEvidence, sourceIdentity,
      ...(assessment.coverageAudit ? { coverageAudit: assessment.coverageAudit } : {}) });
  }
  return Object.freeze({ buildCalendarCandidate });
}

const defaultBuilder = createCalendarCandidateBuilder();
module.exports = Object.freeze({ CANDIDATE_SCHEMA_VERSION, createCalendarCandidateBuilder,
  buildCalendarCandidate: defaultBuilder.buildCalendarCandidate });
