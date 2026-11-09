"use strict";

const Source = require("./sourceContract.js");
const Evidence = require("../sourceEvidence/sourceEvidenceContract.js");

const SOURCE_FAMILY = "jpx_daily_oi";
const TRANSPORT_VERSION = "jpx-daily-oi-workbook-v1";
const REQUEST_ROLE = "daily_open_interest_workbook";
const MAX_BYTES = 10 * 1024 * 1024;
const MEDIA_TYPES = Object.freeze([
  "application/octet-stream",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);
const ACTIVATION_FIELDS = Object.freeze([
  "acquisitionRunId", "workbookByteLength", "sourceEvidence"
]);

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = value => typeof value === "string" &&
  /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
function freeze(value) {
  if (!value || typeof value !== "object" || ArrayBuffer.isView(value) ||
      value instanceof ArrayBuffer || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}
function invalid(reason) {
  return freeze({ status: "invalid", reason, integrityStatus: reason,
    evidenceRef: null, occurrence: null, parserLineage: null, rawBytes: null });
}
function unavailable() {
  const evidenceRef = Evidence.createSourceEvidenceRef({ state: "unavailable",
    sourceFamily: SOURCE_FAMILY, sourceId: Source.SOURCE_ID, reason: "pre_activation" });
  return freeze({ status: "unavailable", reason: "pre_activation",
    integrityStatus: "unavailable", evidenceRef, occurrence: null,
    parserLineage: null, rawBytes: null });
}
function mediaType(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : null;
}
function createPolicy() {
  return Evidence.createSourcePolicy({ sourceFamily: SOURCE_FAMILY,
    sourceId: Source.SOURCE_ID, allowedMediaTypes: MEDIA_TYPES,
    allowedEncodings: [], maxBytes: MAX_BYTES });
}
function activationState(value) {
  if (!object(value)) return "invalid";
  const present = ACTIVATION_FIELDS.filter(field => Object.hasOwn(value, field));
  if (present.length === 0) return "pre_activation";
  if (present.length !== ACTIVATION_FIELDS.length ||
      typeof value.acquisitionRunId !== "string" ||
      !Number.isSafeInteger(value.workbookByteLength) || value.workbookByteLength <= 0 ||
      !Evidence.validateSourceEvidenceRef(value.sourceEvidence) ||
      value.sourceEvidence.state !== "available" ||
      value.sourceEvidence.sourceFamily !== SOURCE_FAMILY ||
      value.sourceEvidence.sourceId !== Source.SOURCE_ID ||
      value.sourceEvidence.contentSha256 !== value.workbookSha256 ||
      value.parserVersion !== Source.PARSER_VERSION)
    return "invalid";
  return "available";
}
function createCaptureInput({ bytes, workbookUrl, fetchedAt, httpMetadata,
    workbookSha256, acquisitionContext } = {}) {
  if (acquisitionContext === "historical_archive_fetch")
    throw new Error("jpx_daily_oi_historical_route_not_approved");
  if (acquisitionContext !== "live_original_acquisition" || !timestamp(fetchedAt) ||
      !object(httpMetadata) || httpMetadata.status !== 200 ||
      !MEDIA_TYPES.includes(mediaType(httpMetadata.contentType)))
    throw new Error("jpx_daily_oi_evidence_transport_invalid");
  const view = bytes instanceof Uint8Array ? bytes : bytes instanceof ArrayBuffer ?
    new Uint8Array(bytes) : ArrayBuffer.isView(bytes) ?
      new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
  if (!view || view.byteLength === 0 || view.byteLength > MAX_BYTES)
    throw new Error("jpx_daily_oi_evidence_bytes_invalid");
  if (Number.isSafeInteger(httpMetadata.contentLength) &&
      httpMetadata.contentLength !== view.byteLength)
    throw new Error("jpx_daily_oi_evidence_byte_length_mismatch");
  const policy = createPolicy(), contentObject = Evidence.createContentObject({
    bytes: view, mediaType: mediaType(httpMetadata.contentType), encoding: null, policy });
  if (contentObject.sha256 !== workbookSha256)
    throw new Error("jpx_daily_oi_evidence_sha_mismatch");
  const acquisitionRunId = `jpx-daily-oi-acquisition|sha256:${Evidence.sha256Canonical({
    sourceId: Source.SOURCE_ID, workbookUrl, fetchedAt,
    workbookSha256, workbookByteLength: view.byteLength,
    httpStatus: httpMetadata.status, mediaType: contentObject.mediaType,
    parserVersion: Source.PARSER_VERSION, transportVersion: TRANSPORT_VERSION
  })}`;
  const occurrence = Evidence.createAcquisitionOccurrence({ sourceFamily: SOURCE_FAMILY,
    sourceId: Source.SOURCE_ID, initialUrl: workbookUrl, sourceUrl: workbookUrl,
    fetchedAt, httpStatus: httpMetadata.status, contentObject,
    transportVersion: TRANSPORT_VERSION, publishedAt: null,
    requestRole: REQUEST_ROLE, redirectHops: [], sourceDocumentRole: REQUEST_ROLE,
    runId: acquisitionRunId, acquisitionContext }, policy);
  return freeze({ bytes: view, contentObject, occurrence, policy, acquisitionRunId });
}
function captureOriginalWorkbook(input, vault) {
  if (!vault || typeof vault.storeAcceptedEvidence !== "function" ||
      typeof vault.verifyOccurrence !== "function")
    throw new Error("jpx_daily_oi_evidence_vault_invalid");
  const prepared = createCaptureInput(input), stored = vault.storeAcceptedEvidence({
    bytes: prepared.bytes, contentObject: prepared.contentObject,
    occurrence: prepared.occurrence, policy: prepared.policy });
  const sourceEvidence = Evidence.createSourceEvidenceRef({ state: "available",
    occurrence: prepared.occurrence, policy: prepared.policy });
  if (vault.verifyOccurrence(sourceEvidence.occurrenceId).status !== "valid")
    throw new Error("jpx_daily_oi_evidence_readback_invalid");
  return freeze({ acquisitionRunId: prepared.acquisitionRunId,
    workbookByteLength: prepared.contentObject.byteLength, sourceEvidence,
    occurrence: prepared.occurrence, contentObject: prepared.contentObject, stored });
}
function bindAcquisitionEvidence(value, captured) {
  if (!object(value) || !captured ||
      captured.sourceEvidence?.contentSha256 !== value.workbookSha256)
    throw new Error("jpx_daily_oi_evidence_binding_invalid");
  const result = { ...value, acquisitionRunId: captured.acquisitionRunId,
    workbookByteLength: captured.workbookByteLength,
    sourceEvidence: captured.sourceEvidence };
  if (activationState(result) !== "available")
    throw new Error("jpx_daily_oi_evidence_binding_invalid");
  return freeze(result);
}
function validatePlanBinding(value, runId) {
  const state = activationState(value);
  return state === "pre_activation" || state === "available" && value.acquisitionRunId === runId;
}
function resolveEvidenceRecord({ evidenceRecord, revision, vault } = {}) {
  if (!object(evidenceRecord) || !object(evidenceRecord.evidence) ||
      !object(revision) || evidenceRecord.revisionKey !== revision.revisionKey)
    return invalid("daily_oi_formal_lineage_invalid");
  const value = evidenceRecord.evidence, state = activationState(value);
  if (state === "pre_activation") return unavailable();
  if (state !== "available" || evidenceRecord.runId !== value.acquisitionRunId ||
      revision.sourceId !== Source.SOURCE_ID || revision.canonical?.sourceId !== Source.SOURCE_ID ||
      revision.semanticIdentity !== Evidence.sha256Canonical(revision.canonical) ||
      evidenceRecord.acquisitionEvidenceIdentity !== Evidence.sha256Canonical(value) ||
      evidenceRecord.evidenceKey !== `${revision.revisionKey}|${evidenceRecord.acceptedAt}|` +
        evidenceRecord.acquisitionEvidenceIdentity)
    return invalid("daily_oi_evidence_ref_invalid");
  let verified, occurrence, rawBytes;
  try {
    verified = vault.verifyOccurrence(value.sourceEvidence.occurrenceId);
    if (verified.status !== "valid") return invalid(verified.status);
    occurrence = vault.readOccurrence(value.sourceEvidence.occurrenceId);
    rawBytes = vault.readRawBytes(value.sourceEvidence.contentSha256);
  } catch (_error) { return invalid("daily_oi_vault_read_failed"); }
  if (!occurrence || occurrence.sourceFamily !== SOURCE_FAMILY ||
      occurrence.sourceId !== Source.SOURCE_ID || occurrence.runId !== value.acquisitionRunId ||
      occurrence.initialUrl !== value.workbookUrl || occurrence.sourceUrl !== value.workbookUrl ||
      occurrence.fetchedAt !== value.acquiredAt || occurrence.httpStatus !== value.httpMetadata?.status ||
      occurrence.mediaType !== mediaType(value.httpMetadata?.contentType) ||
      occurrence.encoding !== null || occurrence.byteLength !== value.workbookByteLength ||
      occurrence.contentSha256 !== value.workbookSha256 ||
      occurrence.transportVersion !== TRANSPORT_VERSION ||
      occurrence.requestRole !== REQUEST_ROLE || occurrence.sourceDocumentRole !== REQUEST_ROLE ||
      occurrence.acquisitionContext !== "live_original_acquisition" ||
      Evidence.sha256Bytes(rawBytes) !== value.workbookSha256 ||
      rawBytes.byteLength !== value.workbookByteLength)
    return invalid("daily_oi_source_identity_mismatch");
  let parserLineage;
  try {
    parserLineage = Evidence.createParserLineage({ evidenceRef: value.sourceEvidence,
      parserId: "jpx-derivatives-open-interest-workbook",
      parserVersion: Number(Source.PARSER_VERSION),
      canonicalIdentity: { kind: "revision_key", value: revision.revisionKey } });
  } catch (_error) { return invalid("daily_oi_parser_lineage_invalid"); }
  return freeze({ status: "available", reason: null, integrityStatus: "valid",
    evidenceRef: value.sourceEvidence, occurrence, parserLineage,
    rawBytes: Uint8Array.from(rawBytes) });
}
function resolveAcquisitionEvidence({ snapshot, vault, evidenceKey } = {}) {
  const evidenceRecord = snapshot?.evidence?.find(value => value.evidenceKey === evidenceKey);
  if (!evidenceRecord) return invalid("daily_oi_evidence_record_missing");
  const revision = snapshot.revisions?.find(value => value.revisionKey === evidenceRecord.revisionKey);
  return resolveEvidenceRecord({ evidenceRecord, revision, vault });
}

module.exports = freeze({ SOURCE_FAMILY, TRANSPORT_VERSION, REQUEST_ROLE, MAX_BYTES,
  MEDIA_TYPES, ACTIVATION_FIELDS, createPolicy, activationState, createCaptureInput,
  captureOriginalWorkbook, bindAcquisitionEvidence, validatePlanBinding,
  resolveEvidenceRecord, resolveAcquisitionEvidence });
