"use strict";

const FuturesHistory = require("./weeklyFuturesHistory.js");
const OptionsHistory = require("./weeklyOptionsHistory.js");
const WeeklyOptions = require("./weeklyOptions.js");
const Binding = require("./weeklySemanticEvidenceBinding.js");
const EvidenceSet = require("./weeklyEvidenceSetContract.js");
const Authority = require("./weeklyAcquisitionAuthorityContract.js");
const Transport = require("./weeklyRawTransportShadow.js");

const CONTRACT_VERSION = "weekly-knowledge-at-reader-v1";
const ORDER = "source_date_ascending";
const MAX_RANGE_DAYS = 3_660;
const DOMAINS = Object.freeze({
  futures: Object.freeze({ role: "weekly_futures_workbook",
    authority: "weekly_futures_revision_history", retention: "max_52_source_dates" }),
  options: Object.freeze({ role: "weekly_options_workbook",
    authority: "weekly_options_indexeddb_revision_history",
    retention: "no_automatic_pruning" })
});

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const clone = value => value == null ? value : structuredClone(value);

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value) || ArrayBuffer.isView(value))
    return value;
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

function validateRequest(request) {
  if (!object(request) || !DOMAINS[request.domain]) return "unknown_domain";
  if (!canonicalTimestamp(request.knowledgeAt)) return "invalid_timestamp";
  if (request.mode === "exact_source_date")
    return exact(request, ["domain", "mode", "knowledgeAt", "sourceDate"]) &&
      sourceDate(request.sourceDate) ? null : "source_date_not_found";
  if (request.mode === "latest_known")
    return exact(request, ["domain", "mode", "knowledgeAt"]) ? null :
      "source_date_not_found";
  if (request.mode === "range") {
    if (!exact(request, ["domain", "mode", "knowledgeAt", "fromSourceDate", "toSourceDate"]) ||
        !sourceDate(request.fromSourceDate) || !sourceDate(request.toSourceDate) ||
        request.fromSourceDate > request.toSourceDate) return "source_date_not_found";
    const days = (Date.parse(`${request.toSourceDate}T00:00:00.000Z`) -
      Date.parse(`${request.fromSourceDate}T00:00:00.000Z`)) / 86_400_000;
    return days <= MAX_RANGE_DAYS ? null : "source_date_not_found";
  }
  return "source_date_not_found";
}

async function validRevision(domain, revision, date) {
  if (domain === "futures") return FuturesHistory.validateRevision(revision, date);
  if (!object(revision) || revision.signatureAlgorithm !== "sha256" ||
      revision.parserVersion !== WeeklyOptions.PARSER_VERSION ||
      revision.schemaVersion !== WeeklyOptions.SCHEMA_VERSION ||
      revision.canonical?.sourceDate !== date ||
      !WeeklyOptions.validateWeeklyOptionsData(revision.canonical)) return false;
  const signature = await WeeklyOptions.createSignature(revision.canonical);
  return revision.signature === signature && revision.versionKey ===
    `weekly-options-v2|${date}|sha256:${signature}`;
}

async function validateChain(domain, date, revisions) {
  if (!Array.isArray(revisions) || revisions.length === 0)
    return { valid: false, reason: "malformed_revision_interval", revisions: [] };
  const ordered = revisions.map(clone).sort((left, right) =>
    Date.parse(left.confirmedAt) - Date.parse(right.confirmedAt) ||
    String(left.versionKey).localeCompare(String(right.versionKey)));
  for (const revision of ordered) {
    const confirmed = Date.parse(revision?.confirmedAt), replaced = revision?.replacedAt === null
      ? null : Date.parse(revision?.replacedAt);
    if (!(await validRevision(domain, revision, date)) || !Number.isFinite(confirmed) ||
        revision.replacedAt !== null && !Number.isFinite(replaced) ||
        replaced !== null && replaced <= confirmed)
      return { valid: false, reason: "malformed_revision_interval", revisions: [] };
  }
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const current = ordered[index], next = ordered[index + 1];
    if (current.replacedAt === null || Date.parse(current.replacedAt) > Date.parse(next.confirmedAt))
      return { valid: false, reason: "overlapping_revision_interval", revisions: [] };
  }
  return { valid: true, reason: null, revisions: ordered };
}

function selectAt(revisions, knowledgeAt) {
  const at = Date.parse(knowledgeAt), matches = revisions.filter(revision =>
    Date.parse(revision.confirmedAt) <= at && (revision.replacedAt === null ||
      at < Date.parse(revision.replacedAt)));
  if (matches.length > 1) return { reason: "overlapping_revision_interval", revision: null };
  return { reason: matches.length ? null : "no_revision_known_at_time",
    revision: matches[0] || null };
}

function createMetadataEvidenceVerifier(options = {}) {
  if (!exact(options, ["bindingStore", "setStore", "vault", "authority"]) ||
      typeof options.bindingStore?.readForRevision !== "function" ||
      typeof options.setStore?.read !== "function" ||
      typeof options.vault?.verifyOccurrenceMetadata !== "function" ||
      typeof options.authority?.verify !== "function")
    throw new TypeError("weekly_knowledge_evidence_verifier_options_invalid");

  function invalid() { return freeze({ state: "invalid", reason: "evidence_verification_failed" }); }

  function verifyRevision({ domain, sourceDate: date, revision } = {}) {
    const config = DOMAINS[domain];
    if (!config || !object(revision)) return invalid();
    let binding;
    try {
      binding = options.bindingStore.readForRevision(config.role, date, revision.versionKey,
        options.authority);
    } catch (_error) { return invalid(); }
    if (!binding) return freeze({ state: "unavailable_pre_activation", reason: "pre_activation",
      evidenceSetId: null, verification: "not_applicable" });
    if (!Binding.validateBinding(binding, options.authority) || binding.domainRole !== config.role ||
        binding.sourceDate !== date || binding.semanticVersionKey !== revision.versionKey ||
        binding.semanticSignature !== revision.signature) return invalid();
    let set;
    try { set = options.setStore.read(binding.evidenceSetId, options.authority); }
    catch (_error) { return invalid(); }
    if (!set || !EvidenceSet.validateEvidenceSet(set, options.authority) ||
        binding.evidenceSetId !== set.evidenceSetId || binding.evidenceSetHash !== set.setHash ||
        binding.runId !== set.runId || binding.sourceId !== set.sourceId ||
        binding.sourceDate !== set.sourceDate || binding.domainRole !== set.domainRole)
      return invalid();
    for (const entry of set.roles) {
      let checked;
      try { checked = options.vault.verifyOccurrenceMetadata(entry.occurrenceId); }
      catch (_error) { checked = null; }
      const occurrence = checked?.record?.occurrence,
        content = checked?.contentMetadata?.contentObject,
        listing = entry.role === EvidenceSet.LISTING_ROLE,
        expectedSource = listing ? EvidenceSet.LISTING_SOURCE_ID :
          EvidenceSet.DOMAIN[set.domainRole].sourceId,
        expectedUrl = listing ? Authority.canonicalListingUrl(set.listingYear) :
          Authority.canonicalWorkbookUrl(set.domainRole, set.sourceDate),
        expectedLineage = listing ? EvidenceSet.listingLineage({
          discoveryIdentity: set.discoveryIdentity, listingYear: set.listingYear,
          transportResultId: entry.transportResultId, contentSha256: entry.contentSha256
        }) : EvidenceSet.workbookLineage({ acquisitionId: entry.acquisitionId,
          transportResultId: entry.transportResultId, role: set.domainRole,
          contentSha256: entry.contentSha256,
          parserPreviewSha256: entry.parserPreviewSha256, publishedDate: entry.publishedDate }),
        policy = EvidenceSet.policyForRole(entry.role);
      if (checked?.status !== "valid" || !occurrence || !content || !policy ||
          occurrence.sourceFamily !== Authority.SOURCE_FAMILY ||
          occurrence.sourceId !== expectedSource || occurrence.runId !== set.runId ||
          occurrence.requestRole !== entry.role || occurrence.initialUrl !== expectedUrl ||
          occurrence.sourceUrl !== expectedUrl || occurrence.httpStatus !== 200 ||
          !policy.allowedMediaTypes.includes(occurrence.mediaType) ||
          occurrence.encoding !== (listing ? "utf-8" : null) ||
          occurrence.transportVersion !== Transport.SHADOW_RESULT_VERSION ||
          occurrence.acquisitionContext !== EvidenceSet.ACQUISITION_CONTEXT ||
          occurrence.sourceDocumentRole !== entry.parserLineageId ||
          occurrence.sourceDocumentRole !== expectedLineage ||
          occurrence.contentSha256 !== entry.contentSha256 ||
          occurrence.byteLength !== entry.byteLength || content.sha256 !== entry.contentSha256 ||
          content.byteLength !== entry.byteLength || content.mediaType !== occurrence.mediaType ||
          content.encoding !== occurrence.encoding) return invalid();
    }
    return freeze({ state: "verified", reason: null, evidenceSetId: set.evidenceSetId,
      bindingId: binding.bindingId, verification: "metadata_verified",
      verificationScope: "metadata_and_file_size", roleCount: set.roles.length });
  }
  return freeze({ verifyRevision });
}

function retention(domain, history) {
  const dates = history.entries.map(entry => entry.sourceDate).sort();
  if (domain === "futures") return freeze({ policy: DOMAINS.futures.retention,
    maxSourceDates: FuturesHistory.MAX_ENTRIES, retainedSourceDates: dates.length,
    earliestRetainedSourceDate: dates[0] || null,
    boundaryLimited: dates.length === FuturesHistory.MAX_ENTRIES });
  return freeze({ policy: DOMAINS.options.retention, maxSourceDates: null,
    retainedSourceDates: dates.length, earliestRetainedSourceDate: dates[0] || null,
    boundaryLimited: false });
}

function createWeeklyKnowledgeAtReader(options = {}) {
  if (!exact(options, ["historyReader", "evidenceVerifier"]) ||
      typeof options.historyReader?.readHistory !== "function" ||
      typeof options.evidenceVerifier?.verifyRevision !== "function")
    throw new TypeError("weekly_knowledge_reader_options_invalid");

  function response(status, reason, request, records = [], diagnostics = {}) {
    const config = DOMAINS[request?.domain];
    return freeze({ contractVersion: CONTRACT_VERSION, status, reason,
      domain: request?.domain || null, mode: request?.mode || null,
      knowledgeAt: request?.knowledgeAt || null, order: ORDER, records: clone(records),
      diagnostics: { authority: config?.authority || null, acquisitionCount: 0,
        vaultWriteCount: 0, semanticRevisionWriteCount: 0, historyWriteCount: 0,
        migrationCount: 0, backfillCount: 0, rawBodyReadCount: 0, ...clone(diagnostics) } });
  }

  async function load(domain) {
    let result;
    try { result = await options.historyReader.readHistory(domain); }
    catch (_error) { return { reason: "malformed_revision_interval" }; }
    const history = result?.history || result;
    if (!object(history) || !Array.isArray(history.entries))
      return { reason: "malformed_revision_interval" };
    const validation = domain === "futures" ? await FuturesHistory.validateHistory(history) :
      (await OptionsHistory.validateWeeklyOptionsHistory(history)).valid;
    return validation ? { history: clone(history), retention: retention(domain, history) } :
      { reason: "malformed_revision_interval" };
  }

  async function inspectEntry(domain, entry, knowledgeAt) {
    const chain = await validateChain(domain, entry.sourceDate, entry.revisions);
    return chain.valid ? selectAt(chain.revisions, knowledgeAt) : { reason: chain.reason };
  }

  async function project(domain, date, revision) {
    const evidence = await options.evidenceVerifier.verifyRevision({ domain,
      sourceDate: date, revision: clone(revision) });
    if (!evidence || evidence.state === "invalid") return null;
    return freeze({ domain, sourceDate: date, versionKey: revision.versionKey,
      semanticSignature: revision.signature, confirmedAt: revision.confirmedAt,
      replacedAt: revision.replacedAt, canonical: clone(domain === "futures" ?
        revision.data : revision.canonical), evidence: clone(evidence) });
  }

  async function read(request) {
    const failure = validateRequest(request);
    if (failure) return response("invalid", failure, request);
    const loaded = await load(request.domain);
    if (loaded.reason) return response("invalid", loaded.reason, request);
    const { history, retention: retentionState } = loaded, entries = [...history.entries]
      .sort((left, right) => left.sourceDate.localeCompare(right.sourceDate));
    if (request.domain === "futures" && retentionState.boundaryLimited &&
        (request.mode === "exact_source_date" &&
          request.sourceDate < retentionState.earliestRetainedSourceDate ||
         request.mode === "range" &&
          request.fromSourceDate < retentionState.earliestRetainedSourceDate))
      return response("unavailable", "history_retention_boundary", request, [],
        { retention: retentionState });
    let candidates = entries;
    if (request.mode === "exact_source_date")
      candidates = entries.filter(entry => entry.sourceDate === request.sourceDate);
    if (request.mode === "range") candidates = entries.filter(entry =>
      entry.sourceDate >= request.fromSourceDate && entry.sourceDate <= request.toSourceDate);
    if (candidates.length === 0) return response("unavailable", "source_date_not_found",
      request, [], { retention: retentionState });
    const records = [], gaps = [];
    for (const entry of candidates) {
      const selected = await inspectEntry(request.domain, entry, request.knowledgeAt);
      if (["malformed_revision_interval", "overlapping_revision_interval"].includes(selected.reason))
        return response("invalid", selected.reason, request, [], { retention: retentionState });
      if (!selected.revision) { gaps.push(entry.sourceDate); continue; }
      const record = await project(request.domain, entry.sourceDate, selected.revision);
      if (!record) return response("invalid", "evidence_verification_failed", request, [],
        { retention: retentionState });
      records.push(record);
    }
    if (records.length === 0) return response("unavailable", "no_revision_known_at_time",
      request, [], { retention: retentionState, sourceDatesWithoutKnownRevision: gaps });
    return response("available", null, request,
      request.mode === "latest_known" ? [records.at(-1)] : records,
      { retention: retentionState, sourceDatesWithoutKnownRevision: gaps });
  }
  return freeze({ read });
}

module.exports = freeze({ CONTRACT_VERSION, ORDER, MAX_RANGE_DAYS, DOMAINS,
  canonicalTimestamp, sourceDate, validateRequest, validateChain, selectAt,
  createMetadataEvidenceVerifier, createWeeklyKnowledgeAtReader });
