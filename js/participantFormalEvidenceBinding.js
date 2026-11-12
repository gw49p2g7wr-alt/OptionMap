"use strict";

const P1 = require("./participantAcquisitionAuthorityContract.js");
const P2 = require("./participantRawTransportShadow.js");
const P3 = require("./participantEvidenceSetContract.js");
const ParticipantData = require("./participantData.js");
const Evidence = require("./sourceEvidence/sourceEvidenceContract.js");
const MimePolicy = require("./participantXlsxMimePolicy.js");

const BINDING_VERSION = "participants-formal-evidence-binding-v1";
const STATE_AVAILABLE = "available";
const PRE_ACTIVATION = Object.freeze({ state: "unavailable", reason: "pre_activation" });

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const identity = (value, prefix) => typeof value === "string" &&
  value.startsWith(`${prefix}|sha256:`) && digest(value.slice(`${prefix}|sha256:`.length));
const clone = value => value == null ? value : structuredClone(value);

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value) || ArrayBuffer.isView(value))
    return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

const PARSER_FIELDS = Object.freeze(["parserId", "parserVersion", "spreadsheetLibrary",
  "spreadsheetLibraryVersion", "sheetSelection", "columnMappingVersion"]);
const BINDING_FIELDS = Object.freeze(["contractVersion", "state", "evidenceSetId",
  "evidenceSetHash", "sourceFamily", "sourceId", "sourceDate", "runId",
  "semanticVersionKey", "semanticSignature", "boundAt", "parserLineage",
  "authorityKeyId", "bindingHash", "authoritySignature"]);

function bindingMaterial(value) {
  return Object.fromEntries(BINDING_FIELDS.filter(field =>
    !["bindingHash", "authoritySignature"].includes(field)).map(field => [field, clone(value[field])]));
}

function parserLineageValid(value) {
  return exact(value, PARSER_FIELDS) && PARSER_FIELDS.every(field =>
    value[field] === P1.PARSER_AUTHORITY[field]);
}

function validateBinding(value, authority) {
  if (!exact(value, BINDING_FIELDS) || value.contractVersion !== BINDING_VERSION ||
      value.state !== STATE_AVAILABLE || !identity(value.evidenceSetId, P3.SET_ID_PREFIX) ||
      !digest(value.evidenceSetHash) || value.evidenceSetId !==
        `${P3.SET_ID_PREFIX}|sha256:${value.evidenceSetHash}` ||
      value.sourceFamily !== P1.SOURCE_FAMILY || value.sourceId !== P1.SOURCE_ID ||
      !P1.sourceDate(value.sourceDate) || !identity(value.runId, "participants-run-v1") ||
      typeof value.semanticVersionKey !== "string" || !digest(value.semanticSignature) ||
      !timestamp(value.boundAt) || !parserLineageValid(value.parserLineage) ||
      value.authorityKeyId !== authority?.keyId || !digest(value.bindingHash) ||
      !digest(value.authoritySignature) || typeof authority?.verify !== "function") return false;
  const hash = P1.sha256(bindingMaterial(value));
  return value.bindingHash === hash &&
    authority.verify("participants_formal_evidence_binding", hash, value.authoritySignature);
}

function validateEvidenceSetMetadata(evidenceSet, vault, authority) {
  if (!P3.validateEvidenceSet(evidenceSet, authority) || !vault ||
      typeof vault.verifyOccurrence !== "function" || typeof vault.verifyContent !== "function" ||
      typeof vault.readOccurrence !== "function" ||
      typeof vault.readContentMetadata !== "function") return false;
  for (const entry of evidenceSet.roles) {
    if (vault.verifyOccurrence(entry.occurrenceId).status !== "valid" ||
        vault.verifyContent(entry.contentSha256).status !== "valid") return false;
    let occurrence, metadata;
    try { occurrence = vault.readOccurrence(entry.occurrenceId);
      metadata = vault.readContentMetadata(entry.contentSha256); } catch (_error) { return false; }
    if (!occurrence || !metadata || occurrence.sourceFamily !== P1.SOURCE_FAMILY ||
        occurrence.sourceId !== P1.SOURCE_ID || occurrence.runId !== evidenceSet.runId ||
        occurrence.requestRole !== entry.role || occurrence.sourceUrl !==
          P1.canonicalWorkbookUrl(entry.role, evidenceSet.sourceDate) ||
        occurrence.contentSha256 !== entry.contentSha256 || occurrence.byteLength !== entry.byteLength ||
        metadata.contentObject.sha256 !== entry.contentSha256 ||
        metadata.contentObject.byteLength !== entry.byteLength ||
        !MimePolicy.isAcceptedParticipantsXlsxMime(occurrence.mediaType) ||
        !MimePolicy.isAcceptedParticipantsXlsxMime(metadata.contentObject.mediaType) ||
        occurrence.mediaType !== metadata.contentObject.mediaType ||
        metadata.contentObject.encoding !== null)
      return false;
  }
  return true;
}

async function expectedCompleteSet(transportSet, sourceDate, fetchedAt) {
  const data = Object.fromEntries(transportSet.results.map(result =>
    [result.role, clone(result.parserPreview)])), sourceUrls = Object.fromEntries(
      transportSet.results.map(result => [result.role, result.finalUrl]));
  return ParticipantData.createCompleteCache({ data, sourceUrls, sourceDate, fetchedAt });
}

async function createBinding(input, authority) {
  if (!exact(input, ["completeSet", "evidenceSet", "transportSet", "manifest", "acquisitions",
    "boundAt", "vault"]) || !P1.validateAcquisitionManifest(input.manifest, authority) ||
      !P2.validateTransportSet(input.transportSet, input.manifest, input.acquisitions, authority) ||
      !P3.validateEvidenceSet(input.evidenceSet, authority) ||
      !validateEvidenceSetMetadata(input.evidenceSet, input.vault, authority) ||
      input.evidenceSet.sourceDate !== input.completeSet?.sourceDate ||
      input.evidenceSet.runId !== input.manifest.runId ||
      input.evidenceSet.transportSetId !== input.transportSet.transportSetId ||
      !timestamp(input.boundAt) || !(await ParticipantData.validateParticipantCache(input.completeSet)))
    throw new TypeError("participants_formal_evidence_input_invalid");
  const expected = await expectedCompleteSet(input.transportSet, input.evidenceSet.sourceDate,
    input.completeSet.fetchedAt);
  if (!expected || Evidence.stable(expected) !== Evidence.stable(input.completeSet))
    throw new TypeError("participants_formal_semantic_set_mismatch");
  const result = { contractVersion: BINDING_VERSION, state: STATE_AVAILABLE,
    evidenceSetId: input.evidenceSet.evidenceSetId, evidenceSetHash: input.evidenceSet.setHash,
    sourceFamily: P1.SOURCE_FAMILY, sourceId: P1.SOURCE_ID,
    sourceDate: input.evidenceSet.sourceDate, runId: input.evidenceSet.runId,
    semanticVersionKey: input.completeSet.versionKey,
    semanticSignature: input.completeSet.signature, boundAt: input.boundAt,
    parserLineage: clone(P1.PARSER_AUTHORITY), authorityKeyId: authority.keyId,
    bindingHash: "", authoritySignature: "" };
  result.bindingHash = P1.sha256(bindingMaterial(result));
  result.authoritySignature = authority.sign("participants_formal_evidence_binding", result.bindingHash);
  if (!validateBinding(result, authority))
    throw new TypeError("participants_formal_evidence_binding_invalid");
  return freeze(result);
}

function validateRevisionBinding(revision, evidenceSet, vault, authority) {
  const binding = revision?.sourceEvidence;
  return validateBinding(binding, authority) &&
    revision.sourceDate === binding.sourceDate && revision.versionKey === binding.semanticVersionKey &&
    revision.signature === binding.semanticSignature && evidenceSet?.evidenceSetId ===
      binding.evidenceSetId && evidenceSet.setHash === binding.evidenceSetHash &&
    evidenceSet.sourceId === binding.sourceId && evidenceSet.sourceDate === binding.sourceDate &&
    evidenceSet.runId === binding.runId && validateEvidenceSetMetadata(evidenceSet, vault, authority);
}

function evidenceState(revision) {
  return Object.hasOwn(revision || {}, "sourceEvidence") ?
    { state: revision.sourceEvidence?.state || "invalid", reason: null } : PRE_ACTIVATION;
}

function selectAsKnownAt(revisions, at) {
  if (!Array.isArray(revisions) || !timestamp(at)) return null;
  const matches = revisions.filter(revision => timestamp(revision?.confirmedAt) &&
    revision.confirmedAt <= at && (revision.replacedAt === null || at < revision.replacedAt));
  return matches.length === 1 ? freeze(clone(matches[0])) : null;
}

module.exports = freeze({ BINDING_VERSION, STATE_AVAILABLE, PRE_ACTIVATION, PARSER_FIELDS,
  BINDING_FIELDS, validateBinding, validateEvidenceSetMetadata, expectedCompleteSet,
  createBinding, validateRevisionBinding, evidenceState, selectAsKnownAt });
