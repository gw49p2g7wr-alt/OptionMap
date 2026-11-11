"use strict";

const P1 = require("./participantAcquisitionAuthorityContract.js");
const P2 = require("./participantRawTransportShadow.js");
const Evidence = require("./sourceEvidence/sourceEvidenceContract.js");

const SET_VERSION = "participants-source-evidence-set-v1";
const SET_ID_PREFIX = "participants-evidence-set-v1";
const TRANSPORT_VERSION = P2.TRANSPORT_RESULT_VERSION;
const ACQUISITION_CONTEXT = "live_original_acquisition";
const POLICY = Evidence.createSourcePolicy({ sourceFamily: P1.SOURCE_FAMILY,
  sourceId: P1.SOURCE_ID, allowedMediaTypes: [P2.MIME], allowedEncodings: [],
  maxBytes: P2.MAX_BYTES });

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const identity = (value, prefix) => typeof value === "string" &&
  new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|sha256:[0-9a-f]{64}$`)
    .test(value);

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value) || ArrayBuffer.isView(value))
    return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

const clone = value => value == null ? value : structuredClone(value);

function lineageIdentity(acquisition, transportResult) {
  if (!acquisition || !transportResult) return null;
  return `participants-p1|sha256:${P1.sha256({ acquisitionId: acquisition.acquisitionId,
    routeIdentity: acquisition.routeIdentity, parserAuthority: P1.PARSER_AUTHORITY,
    parserPreviewSha256: transportResult.parserPreviewSha256 })}`;
}

function occurrenceRedirects(transportResult) {
  if (transportResult.initialUrl === transportResult.finalUrl) return [];
  return transportResult.redirects.map(hop => ({ status: hop.status, url: hop.to }));
}

function createOccurrence({ transportResult, acquisition, contentObject } = {}) {
  if (!transportResult || !acquisition || !Evidence.validateContentObject(contentObject))
    throw new TypeError("participants_evidence_occurrence_input_invalid");
  return Evidence.createAcquisitionOccurrence({ sourceFamily: P1.SOURCE_FAMILY,
    sourceId: P1.SOURCE_ID, initialUrl: transportResult.initialUrl,
    sourceUrl: transportResult.finalUrl, fetchedAt: transportResult.fetchedAt,
    httpStatus: transportResult.status, contentObject, transportVersion: TRANSPORT_VERSION,
    publishedAt: null, requestRole: transportResult.role,
    redirectHops: occurrenceRedirects(transportResult),
    sourceDocumentRole: lineageIdentity(acquisition, transportResult),
    runId: transportResult.runId, acquisitionContext: ACQUISITION_CONTEXT }, POLICY);
}

function validateOccurrenceBinding(occurrence, transportResult, acquisition) {
  return Evidence.validateAcquisitionOccurrence(occurrence, POLICY) &&
    occurrence.sourceFamily === P1.SOURCE_FAMILY && occurrence.sourceId === P1.SOURCE_ID &&
    occurrence.runId === transportResult.runId && occurrence.requestRole === transportResult.role &&
    occurrence.sourceDocumentRole === lineageIdentity(acquisition, transportResult) &&
    occurrence.initialUrl === transportResult.initialUrl &&
    occurrence.sourceUrl === transportResult.finalUrl &&
    occurrence.fetchedAt === transportResult.fetchedAt &&
    occurrence.httpStatus === transportResult.status && occurrence.mediaType === transportResult.mime &&
    occurrence.encoding === null && occurrence.byteLength === transportResult.byteLength &&
    occurrence.contentSha256 === transportResult.rawSha256 &&
    occurrence.transportVersion === TRANSPORT_VERSION &&
    occurrence.acquisitionContext === ACQUISITION_CONTEXT;
}

const ENTRY_FIELDS = Object.freeze(["role", "acquisitionId", "transportResultId",
  "occurrenceId", "contentSha256", "byteLength", "parserBindingId"]);

function validateEntry(value) {
  return exact(value, ENTRY_FIELDS) && P1.ROLE_ORDER.includes(value.role) &&
    identity(value.acquisitionId, "participants-workbook-acquisition-v1") &&
    identity(value.transportResultId, "participants-raw-transport-result-v1") &&
    identity(value.occurrenceId, "source-occurrence-v1") && digest(value.contentSha256) &&
    Number.isSafeInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= P2.MAX_BYTES &&
    identity(value.parserBindingId, "participants-parser-binding-v1");
}

const SET_FIELDS = Object.freeze(["contractVersion", "evidenceSetId", "sourceFamily", "sourceId",
  "sourceDate", "runId", "manifestId", "completeSetIdentity", "transportSetId", "roles",
  "authorityKeyId", "setHash", "authoritySignature"]);

function setMaterial(value) {
  return Object.fromEntries(SET_FIELDS.filter(field =>
    !["evidenceSetId", "setHash", "authoritySignature"].includes(field))
    .map(field => [field, clone(value[field])]));
}

function validateEvidenceSet(value, authority) {
  if (!exact(value, SET_FIELDS) || value.contractVersion !== SET_VERSION ||
      !identity(value.evidenceSetId, SET_ID_PREFIX) || value.sourceFamily !== P1.SOURCE_FAMILY ||
      value.sourceId !== P1.SOURCE_ID || !P1.sourceDate(value.sourceDate) ||
      !identity(value.runId, "participants-run-v1") ||
      !identity(value.manifestId, "participants-manifest-v1") ||
      !identity(value.completeSetIdentity, "participants-acquisition-set-v1") ||
      !identity(value.transportSetId, "participants-raw-transport-set-v1") ||
      !Array.isArray(value.roles) || value.roles.length !== P1.ROLE_ORDER.length ||
      value.roles.some((entry, index) => entry.role !== P1.ROLE_ORDER[index] ||
        !validateEntry(entry)) || new Set(value.roles.map(entry => entry.role)).size !==
        P1.ROLE_ORDER.length || value.authorityKeyId !== authority?.keyId ||
      typeof authority?.verify !== "function" || !digest(value.setHash) ||
      !digest(value.authoritySignature)) return false;
  const setHash = P1.sha256(setMaterial(value));
  return value.setHash === setHash &&
    value.evidenceSetId === `${SET_ID_PREFIX}|sha256:${setHash}` &&
    authority.verify("participants_evidence_set", setHash, value.authoritySignature);
}

function parserResult(manifest, transportSet, acquisition, transportResult) {
  return { manifestId: manifest.manifestId, setIdentity: transportSet.completeSetIdentity,
    acquisitionId: acquisition.acquisitionId, runId: manifest.runId,
    sourceFamily: P1.SOURCE_FAMILY, sourceId: P1.SOURCE_ID, sourceDate: manifest.sourceDate,
    role: acquisition.role, sourceUrl: acquisition.canonicalUrl,
    parserId: P1.PARSER_AUTHORITY.parserId,
    parserVersion: P1.PARSER_AUTHORITY.parserVersion,
    spreadsheetLibrary: P1.PARSER_AUTHORITY.spreadsheetLibrary,
    spreadsheetLibraryVersion: P1.PARSER_AUTHORITY.spreadsheetLibraryVersion,
    sheetSelection: P1.PARSER_AUTHORITY.sheetSelection,
    columnMappingVersion: P1.PARSER_AUTHORITY.columnMappingVersion,
    canonicalSha256: transportResult.parserPreviewSha256 };
}

function createEvidenceSet({ manifest, transportSet, acquisitions, occurrences } = {}, authority) {
  if (!P1.validateAcquisitionManifest(manifest, authority) ||
      !P2.validateTransportSet(transportSet, manifest, acquisitions, authority) ||
      !Array.isArray(occurrences) || occurrences.length !== P1.ROLE_ORDER.length)
    throw new TypeError("participants_evidence_set_input_invalid");
  const completeSet = P1.createCompleteSet({ manifest, acquisitions }, authority), byRole = new Map();
  for (const occurrence of occurrences) {
    const role = occurrence?.requestRole;
    if (!P1.ROLE_ORDER.includes(role) || byRole.has(role))
      throw new TypeError("participants_evidence_set_roles_invalid");
    byRole.set(role, occurrence);
  }
  const roles = P1.ROLE_ORDER.map((role, index) => {
    const acquisition = acquisitions[index], transportResult = transportSet.results[index],
      occurrence = byRole.get(role);
    if (!occurrence || !validateOccurrenceBinding(occurrence, transportResult, acquisition))
      throw new TypeError("participants_evidence_occurrence_binding_invalid");
    const binding = P1.bindParserResult({ manifest, completeSet,
      result: parserResult(manifest, transportSet, acquisition, transportResult) }, authority);
    if (!binding.accepted) throw new TypeError("participants_evidence_parser_binding_invalid");
    return { role, acquisitionId: acquisition.acquisitionId,
      transportResultId: transportResult.transportResultId,
      occurrenceId: occurrence.occurrenceId, contentSha256: occurrence.contentSha256,
      byteLength: occurrence.byteLength, parserBindingId: binding.binding.bindingId };
  });
  const result = { contractVersion: SET_VERSION, evidenceSetId: "",
    sourceFamily: P1.SOURCE_FAMILY, sourceId: P1.SOURCE_ID,
    sourceDate: manifest.sourceDate, runId: manifest.runId, manifestId: manifest.manifestId,
    completeSetIdentity: transportSet.completeSetIdentity,
    transportSetId: transportSet.transportSetId, roles, authorityKeyId: authority.keyId,
    setHash: "", authoritySignature: "" };
  result.setHash = P1.sha256(setMaterial(result));
  result.evidenceSetId = `${SET_ID_PREFIX}|sha256:${result.setHash}`;
  result.authoritySignature = authority.sign("participants_evidence_set", result.setHash);
  if (!validateEvidenceSet(result, authority))
    throw new TypeError("participants_evidence_set_invalid");
  return freeze(result);
}

function validateEvidenceSetAgainstVault(value, vault, authority) {
  if (!validateEvidenceSet(value, authority) || !vault ||
      typeof vault.verifyOccurrence !== "function" || typeof vault.readOccurrence !== "function" ||
      typeof vault.verifyContent !== "function" || typeof vault.readRawBytes !== "function") return false;
  for (const entry of value.roles) {
    const occurrenceStatus = vault.verifyOccurrence(entry.occurrenceId),
      contentStatus = vault.verifyContent(entry.contentSha256);
    if (occurrenceStatus.status !== "valid" || contentStatus.status !== "valid") return false;
    let occurrence, bytes;
    try { occurrence = vault.readOccurrence(entry.occurrenceId);
      bytes = vault.readRawBytes(entry.contentSha256); } catch (_error) { return false; }
    if (!occurrence || occurrence.sourceFamily !== P1.SOURCE_FAMILY ||
        occurrence.sourceId !== P1.SOURCE_ID || occurrence.runId !== value.runId ||
        occurrence.requestRole !== entry.role || occurrence.contentSha256 !== entry.contentSha256 ||
        occurrence.initialUrl !== P1.canonicalWorkbookUrl(entry.role, value.sourceDate) ||
        occurrence.sourceUrl !== P1.canonicalWorkbookUrl(entry.role, value.sourceDate) ||
        occurrence.httpStatus !== 200 || occurrence.mediaType !== P2.MIME ||
        occurrence.encoding !== null || occurrence.transportVersion !== TRANSPORT_VERSION ||
        occurrence.acquisitionContext !== ACQUISITION_CONTEXT ||
        !identity(occurrence.sourceDocumentRole, "participants-p1") ||
        occurrence.byteLength !== entry.byteLength || bytes?.byteLength !== entry.byteLength ||
        Evidence.sha256Bytes(bytes) !== entry.contentSha256) return false;
  }
  return true;
}

module.exports = freeze({ SET_VERSION, SET_ID_PREFIX, TRANSPORT_VERSION,
  ACQUISITION_CONTEXT, POLICY, ENTRY_FIELDS, SET_FIELDS, lineageIdentity,
  createOccurrence, validateOccurrenceBinding, parserResult, createEvidenceSet,
  validateEvidenceSet, validateEvidenceSetAgainstVault });
