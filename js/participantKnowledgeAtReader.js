"use strict";

const Schema = require("./formalArchive/participantFormalArchiveSchema.js");
const Binding = require("./participantFormalEvidenceBinding.js");
const EvidenceSet = require("./participantEvidenceSetContract.js");
const P1 = require("./participantAcquisitionAuthorityContract.js");
const MimePolicy = require("./participantXlsxMimePolicy.js");

const CONTRACT_VERSION = "participants-knowledge-at-reader-v1";
const ORDER = "source_date_ascending";
const PAGE_SIZE = 500;
const MAX_ENTRIES = 10_000;
const MAX_RANGE_DAYS = 3_660;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const clone = value => value == null ? value : structuredClone(value);

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function canonicalTimestamp(value) {
  return typeof value === "string" &&
    /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function sourceDate(value) {
  return typeof value === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) &&
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function response(status, reason, request, records = [], diagnostics = {}) {
  return freeze({ contractVersion: CONTRACT_VERSION, status, reason,
    mode: request?.mode || null, knowledgeAt: request?.knowledgeAt || null, order: ORDER,
    records: clone(records), diagnostics: { authority: "participant_formal_archive",
      acquisitionCount: 0, formalWriteCount: 0, vaultWriteCount: 0,
      legacyHistoryReadCount: 0, ...clone(diagnostics) } });
}

function validateRequest(request) {
  if (!object(request) || !canonicalTimestamp(request.knowledgeAt)) return "invalid_timestamp";
  if (request.mode === "exact_source_date")
    return exact(request, ["mode", "knowledgeAt", "sourceDate"]) && sourceDate(request.sourceDate)
      ? null : "source_date_not_found";
  if (request.mode === "latest_known")
    return exact(request, ["mode", "knowledgeAt"]) ? null : "source_date_not_found";
  if (request.mode === "range") {
    if (!exact(request, ["mode", "knowledgeAt", "fromSourceDate", "toSourceDate"]) ||
        !sourceDate(request.fromSourceDate) || !sourceDate(request.toSourceDate) ||
        request.fromSourceDate > request.toSourceDate) return "source_date_not_found";
    const span = (Date.parse(`${request.toSourceDate}T00:00:00.000Z`) -
      Date.parse(`${request.fromSourceDate}T00:00:00.000Z`)) / 86_400_000;
    return span <= MAX_RANGE_DAYS ? null : "source_date_not_found";
  }
  return "source_date_not_found";
}

function validateChain(sourceDateValue, revisions) {
  if (!Array.isArray(revisions) || revisions.length === 0)
    return { valid: true, revisions: [] };
  const ordered = revisions.map(clone).sort((left, right) =>
    String(left.confirmedAt).localeCompare(String(right.confirmedAt)) ||
    String(left.revisionKey).localeCompare(String(right.revisionKey)));
  for (const revision of ordered) {
    if (!Schema.validateRevision(revision) || revision.sourceDate !== sourceDateValue ||
        !canonicalTimestamp(revision.confirmedAt) ||
        revision.replacedAt !== null && !canonicalTimestamp(revision.replacedAt) ||
        revision.replacedAt !== null && revision.replacedAt <= revision.confirmedAt)
      return { valid: false, reason: "malformed_revision_interval" };
  }
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const current = ordered[index], next = ordered[index + 1];
    if (current.replacedAt === null || current.replacedAt > next.confirmedAt)
      return { valid: false, reason: "overlapping_revision_interval" };
  }
  return { valid: true, revisions: ordered };
}

function selectAt(chain, knowledgeAt) {
  const matches = chain.filter(revision => revision.confirmedAt <= knowledgeAt &&
    (revision.replacedAt === null || knowledgeAt < revision.replacedAt));
  if (matches.length > 1) return { reason: "overlapping_revision_interval", revision: null };
  return { reason: matches.length === 0 ? "no_revision_known_at_time" : null,
    revision: matches[0] || null };
}

function createMetadataEvidenceVerifier(options = {}) {
  if (!exact(options, ["setStore", "vault", "authority"]) ||
      typeof options.setStore?.read !== "function" ||
      typeof options.vault?.verifyOccurrenceMetadata !== "function" ||
      typeof options.authority?.verify !== "function")
    throw new TypeError("participants_knowledge_evidence_verifier_options_invalid");
  function verifyRevision(revision) {
    if (!Schema.validateRevision(revision) || !Object.hasOwn(revision, "sourceEvidence") ||
        !Binding.validateBinding(revision.sourceEvidence, options.authority))
      return freeze({ verified: false, reason: "evidence_verification_failed" });
    let evidenceSet;
    try { evidenceSet = options.setStore.read(revision.sourceEvidence.evidenceSetId,
      options.authority); } catch (_error) { evidenceSet = null; }
    if (!evidenceSet || !EvidenceSet.validateEvidenceSet(evidenceSet, options.authority) ||
        evidenceSet.evidenceSetId !== revision.sourceEvidence.evidenceSetId ||
        evidenceSet.setHash !== revision.sourceEvidence.evidenceSetHash ||
        evidenceSet.sourceDate !== revision.sourceDate ||
        evidenceSet.runId !== revision.sourceEvidence.runId)
      return freeze({ verified: false, reason: "evidence_verification_failed" });
    for (const entry of evidenceSet.roles) {
      let checked;
      try { checked = options.vault.verifyOccurrenceMetadata(entry.occurrenceId); }
      catch (_error) { checked = null; }
      const occurrence = checked?.record?.occurrence,
        contentObject = checked?.contentMetadata?.contentObject;
      if (checked?.status !== "valid" || !occurrence || !contentObject ||
          occurrence.sourceFamily !== P1.SOURCE_FAMILY || occurrence.sourceId !== P1.SOURCE_ID ||
          occurrence.runId !== evidenceSet.runId || occurrence.requestRole !== entry.role ||
          occurrence.initialUrl !== P1.canonicalWorkbookUrl(entry.role, revision.sourceDate) ||
          occurrence.sourceUrl !== occurrence.initialUrl || occurrence.httpStatus !== 200 ||
          !MimePolicy.isAcceptedParticipantsXlsxMime(occurrence.mediaType) ||
          occurrence.encoding !== null ||
          occurrence.contentSha256 !== entry.contentSha256 ||
          occurrence.byteLength !== entry.byteLength || contentObject.sha256 !== entry.contentSha256 ||
          contentObject.byteLength !== entry.byteLength ||
          !MimePolicy.isAcceptedParticipantsXlsxMime(contentObject.mediaType) ||
          occurrence.mediaType !== contentObject.mediaType)
        return freeze({ verified: false, reason: "evidence_verification_failed" });
    }
    return freeze({ verified: true, reason: null,
      evidenceSetId: evidenceSet.evidenceSetId, roleCount: evidenceSet.roles.length,
      verificationScope: "metadata_and_file_size" });
  }
  return freeze({ verifyRevision });
}

function createParticipantKnowledgeAtReader(options = {}) {
  if (!exact(options, ["archiveReader", "evidenceVerifier"]) ||
      typeof options.archiveReader?.readRange !== "function" ||
      typeof options.archiveReader?.readEntryRevisions !== "function" ||
      typeof options.evidenceVerifier?.verifyRevision !== "function")
    throw new TypeError("participants_knowledge_reader_options_invalid");

  async function allEntries(from, to) {
    const entries = [];
    let afterSourceDate = null;
    while (entries.length < MAX_ENTRIES) {
      const result = await options.archiveReader.readRange({ from, to, limit: PAGE_SIZE,
        ...(afterSourceDate ? { afterSourceDate } : {}) });
      if (result?.status === "empty") break;
      if (result?.status !== "available" || !Array.isArray(result.entries))
        return { reason: "malformed_revision_interval", entries: [] };
      entries.push(...result.entries);
      if (!result.nextCursor) break;
      if (result.nextCursor === afterSourceDate) return {
        reason: "malformed_revision_interval", entries: [] };
      afterSourceDate = result.nextCursor;
    }
    if (entries.length >= MAX_ENTRIES)
      return { reason: "malformed_revision_interval", entries: [] };
    return { reason: null, entries: entries.sort((a, b) =>
      a.sourceDate.localeCompare(b.sourceDate)) };
  }

  async function selectedForSourceDate(sourceDateValue, knowledgeAt) {
    const result = await options.archiveReader.readEntryRevisions(sourceDateValue);
    if (result?.status === "empty") return { reason: "source_date_not_found" };
    if (result?.status !== "available" || !Array.isArray(result.revisions))
      return { reason: "malformed_revision_interval" };
    const chain = validateChain(sourceDateValue, result.revisions);
    return chain.valid ? selectAt(chain.revisions, knowledgeAt) : { reason: chain.reason };
  }

  async function project(revision) {
    if (!Object.hasOwn(revision, "sourceEvidence")) return freeze({
      sourceDate: revision.sourceDate, revisionKey: revision.revisionKey,
      versionKey: revision.versionKey, semanticSignature: revision.signature,
      parserLineage: null, confirmedAt: revision.confirmedAt, replacedAt: revision.replacedAt,
      completeSet: clone(revision.completeSet), sourceEvidence: { state: "unavailable",
        reason: "pre_activation", evidenceSetId: null, verification: "not_applicable" } });
    const verified = await options.evidenceVerifier.verifyRevision(revision);
    if (verified?.verified !== true) return null;
    return freeze({ sourceDate: revision.sourceDate, revisionKey: revision.revisionKey,
      versionKey: revision.versionKey, semanticSignature: revision.signature,
      parserLineage: clone(revision.sourceEvidence.parserLineage),
      confirmedAt: revision.confirmedAt, replacedAt: revision.replacedAt,
      completeSet: clone(revision.completeSet), sourceEvidence: { state: "available", reason: null,
        evidenceSetId: revision.sourceEvidence.evidenceSetId,
        verification: "metadata_verified", verificationScope: verified.verificationScope,
        roleCount: verified.roleCount } });
  }

  async function read(request) {
    const requestFailure = validateRequest(request);
    if (requestFailure) return response("invalid", requestFailure, request);
    if (request.mode === "exact_source_date") {
      const selected = await selectedForSourceDate(request.sourceDate, request.knowledgeAt);
      if (!selected.revision) return response([
        "malformed_revision_interval", "overlapping_revision_interval"
      ].includes(selected.reason) ? "invalid" : "unavailable", selected.reason, request);
      const record = await project(selected.revision);
      return record ? response("available", null, request, [record]) :
        response("invalid", "evidence_verification_failed", request);
    }
    const from = request.mode === "range" ? request.fromSourceDate : "2000-01-01",
      to = request.mode === "range" ? request.toSourceDate : "2999-12-31",
      entryResult = await allEntries(from, to);
    if (entryResult.reason) return response("invalid", entryResult.reason, request);
    if (entryResult.entries.length === 0)
      return response("unavailable", "source_date_not_found", request);
    const records = [], gaps = [];
    for (const entry of entryResult.entries) {
      const selected = await selectedForSourceDate(entry.sourceDate, request.knowledgeAt);
      if (["malformed_revision_interval", "overlapping_revision_interval"]
        .includes(selected.reason)) return response("invalid", selected.reason, request);
      if (!selected.revision) { gaps.push(entry.sourceDate); continue; }
      const record = await project(selected.revision);
      if (!record) return response("invalid", "evidence_verification_failed", request);
      records.push(record);
    }
    if (records.length === 0)
      return response("unavailable", "no_revision_known_at_time", request, [],
        { sourceDatesWithoutKnownRevision: gaps });
    const selectedRecords = request.mode === "latest_known" ? [records.at(-1)] : records;
    return response("available", null, request, selectedRecords,
      { sourceDatesWithoutKnownRevision: gaps });
  }

  return freeze({ read });
}

module.exports = freeze({ CONTRACT_VERSION, ORDER, PAGE_SIZE, MAX_ENTRIES, MAX_RANGE_DAYS,
  canonicalTimestamp, validateRequest, validateChain, selectAt,
  createMetadataEvidenceVerifier, createParticipantKnowledgeAtReader });
