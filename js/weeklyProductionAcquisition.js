"use strict";

const Authority = require("./weeklyAcquisitionAuthorityContract.js");
const Transport = require("./weeklyRawTransportShadow.js");
const FuturesHistory = require("./weeklyFuturesHistory.js");
const OptionsHistory = require("./weeklyOptionsHistory.js");
const WeeklyFutures = require("./weeklyFutures.js");
const WeeklyOptions = require("./weeklyOptions.js");

const CONTRACT_VERSION = "weekly-production-acquisition-v1";
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

function parseListingUpdatedAt(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).UpdateDate; }
  catch (_error) { return null; }
  const match = String(value || "").match(
    /^(20\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+09:00`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

async function buildCandidate(role, resolved) {
  const set = resolved?.evidenceSet;
  if (resolved?.status !== "available" || !set || !Array.isArray(resolved.documents) ||
      resolved.documents.length !== 2) throw new Error("weekly_evidence_resolution_invalid");
  const listing = resolved.documents.find(value => value.occurrence?.requestRole ===
    "official_listing"), workbook = resolved.documents.find(value =>
    value.occurrence?.requestRole === role);
  if (!listing || !workbook) throw new Error("weekly_evidence_documents_invalid");
  const acquisition = Authority.createDomainAcquisition(set.runId, role, set.sourceDate),
    preview = Transport.parseWorkbookPreview(workbook.bytes, acquisition),
    listingUpdatedAt = parseListingUpdatedAt(listing.bytes);
  if (!listingUpdatedAt) throw new Error("weekly_listing_update_time_invalid");
  const sourceUrl = Authority.canonicalWorkbookUrl(role, set.sourceDate),
    listingUrl = Authority.canonicalListingUrl(set.listingYear),
    fetchedAt = workbook.occurrence.fetchedAt;
  if (role === "weekly_futures_workbook") {
    const signature = await WeeklyFutures.createSignature(preview.canonical), candidate = {
      sourceDate: set.sourceDate, sourceUrl, fetchedAt, signature,
      versionKey: `weekly-futures-v2|${set.sourceDate}|sha256:${signature}`,
      data: clone(preview.canonical), officialMetadata: {
        origin: "jpx_open_interest_year_listing", listingUrl, listingUpdatedAt,
        tradeDate: set.sourceDate, indexFuturesUrl: sourceUrl,
        publishedDate: preview.publishedDate, currentOfficialRefetch: true,
        dateEvidence: { listingTradeDate: set.sourceDate, excelSourceDate: set.sourceDate,
          urlDate: set.sourceDate, consistent: true }
      }
    };
    return { candidate, cache: { version: 2,
      parserVersion: WeeklyFutures.PARSER_VERSION, schemaVersion: WeeklyFutures.SCHEMA_VERSION,
      brokerSetVersion: WeeklyFutures.BROKER_SET_VERSION,
      scoringVersion: WeeklyFutures.SCORING_VERSION,
      source: Authority.ROLE_AUTHORITY[role].sourceId, sourceDate: set.sourceDate,
      sourceDateKind: "jpx_open_interest_as_of", publishedDate: preview.publishedDate,
      publishedAt: null, listingUpdatedAt, listingUpdatedAtKind: "jpx_listing_updated_at",
      fetchedAt, sourceUrl, signatureAlgorithm: "sha256", signature,
      versionKey: candidate.versionKey, dateEvidence: { excelAsOf: set.sourceDate,
        listingTradeDate: set.sourceDate, urlDate: set.sourceDate, consistent: true },
      versionAssessment: "confirmed", data: clone(preview.canonical) } };
  }
  const signature = await WeeklyOptions.createSignature(preview.canonical), cache = {
    version: WeeklyOptions.CACHE_VERSION, parserVersion: WeeklyOptions.PARSER_VERSION,
    schemaVersion: WeeklyOptions.SCHEMA_VERSION,
    source: Authority.ROLE_AUTHORITY[role].sourceId, sourceDate: set.sourceDate,
    sourceDateKind: "jpx_open_interest_as_of", publishedDate: preview.publishedDate,
    publishedAt: null, listingUpdatedAt, listingUpdatedAtKind: "jpx_listing_updated_at",
    listingUrl, fetchedAt, sourceUrl, signatureAlgorithm: "sha256", signature,
    versionKey: `weekly-options-v2|${set.sourceDate}|sha256:${signature}`,
    dateEvidence: { excelAsOf: set.sourceDate, listingTradeDate: set.sourceDate,
      urlDate: set.sourceDate, consistent: true }, versionAssessment: "confirmed",
    currentOfficialRefetch: true, data: clone(preview.canonical)
  }, created = await OptionsHistory.createWeeklyOptionsHistoryCandidate(cache);
  if (!created.ok || !created.candidate) throw new Error("weekly_options_candidate_invalid");
  return { candidate: created.candidate, cache };
}

function unavailable(reason) {
  return freeze({ status: "unavailable", reason, candidate: null, cache: null, history: null,
    binding: null, evidenceSetId: null, semanticRevisionWriteCount: 0,
    bindingWriteCount: 0 });
}

function available(candidate, cache, promotion, evidenceSetId) {
  return freeze({ status: "available", reason: promotion.reason,
    candidate: clone(candidate), cache: clone(cache), history: clone(promotion.history),
    binding: promotion.binding ? clone(promotion.binding) : null, evidenceSetId,
    semanticRevisionWriteCount: promotion.diagnostics.semanticRevisionWriteCount,
    bindingWriteCount: promotion.diagnostics.bindingWriteCount });
}

function validateOptions(options) {
  return exact(options, ["authority", "evidenceShadow", "promotion", "readHistories",
    "now", "createRequestId"]) && typeof options.authority?.verify === "function" &&
    typeof options.evidenceShadow?.capture === "function" &&
    typeof options.evidenceShadow?.resolve === "function" &&
    typeof options.promotion?.promote === "function" &&
    typeof options.readHistories === "function" && typeof options.now === "function" &&
    typeof options.createRequestId === "function";
}

function createWeeklyProductionAcquisition(options = {}) {
  if (!validateOptions(options)) throw new TypeError("weekly_production_options_invalid");
  let generation = 0;

  async function acquire(input) {
    let intent;
    try { intent = Authority.createAcquisitionIntent(input); }
    catch (_error) { return freeze({ contractVersion: CONTRACT_VERSION, status: "unavailable",
      reason: "invalid_intent", requestId: null, generation: null, runs: [], diagnostics: {} }); }
    const currentGeneration = ++generation, requestId = options.createRequestId();
    let capture;
    try { capture = await options.evidenceShadow.capture({ intent, requestId }); }
    catch (_error) { capture = null; }
    if (currentGeneration !== generation) return freeze({ contractVersion: CONTRACT_VERSION,
      status: "stale", reason: "superseded_run", requestId, generation: currentGeneration,
      runs: [], diagnostics: { staleRun: true } });
    if (!capture || !Array.isArray(capture.runs) || capture.runs.length === 0)
      return freeze({ contractVersion: CONTRACT_VERSION, status: "unavailable",
        reason: capture?.reason || "acquisition_failed", requestId,
        generation: currentGeneration, runs: [], diagnostics: clone(capture?.diagnostics || {}) });
    let histories;
    try { histories = await options.readHistories(); }
    catch (_error) { histories = null; }
    if (!object(histories) || !(await FuturesHistory.validateHistory(histories.futures)) ||
        !(await OptionsHistory.validateWeeklyOptionsHistory(histories.options)).valid)
      return freeze({ contractVersion: CONTRACT_VERSION, status: "unavailable",
        reason: "history_snapshot_invalid", requestId, generation: currentGeneration,
        runs: [], diagnostics: clone(capture.diagnostics) });
    let futuresHistory = clone(histories.futures), optionsHistory = clone(histories.options);
    const runs = [];
    for (const run of capture.runs) {
      if (currentGeneration !== generation) return freeze({ contractVersion: CONTRACT_VERSION,
        status: "stale", reason: "superseded_run", requestId, generation: currentGeneration,
        runs: [], diagnostics: { staleRun: true } });
      const projections = {};
      for (const [label, role] of [["futures", "weekly_futures_workbook"],
        ["options", "weekly_options_workbook"]]) {
        if (currentGeneration !== generation) return freeze({ contractVersion: CONTRACT_VERSION,
          status: "stale", reason: "superseded_run", requestId, generation: currentGeneration,
          runs: [], diagnostics: { staleRun: true } });
        const domain = run[label];
        if (domain?.status !== "available" || !domain.evidenceSet?.evidenceSetId) {
          projections[label] = unavailable(domain?.reason || "domain_evidence_unavailable");
          continue;
        }
        try {
          const prepared = await buildCandidate(role,
            options.evidenceShadow.resolve(domain.evidenceSet.evidenceSetId)),
            promotion = await options.promotion.promote({ domainRole: role,
              history: label === "futures" ? futuresHistory : optionsHistory,
              candidate: prepared.candidate, evidenceSetId: domain.evidenceSet.evidenceSetId,
              confirmedAt: options.now().toISOString() });
          if (promotion.status !== "available") {
            projections[label] = unavailable(promotion.reason);
            continue;
          }
          if (label === "futures") futuresHistory = clone(promotion.history);
          else optionsHistory = clone(promotion.history);
          projections[label] = available(prepared.candidate, prepared.cache, promotion,
            domain.evidenceSet.evidenceSetId);
        } catch (_error) { projections[label] = unavailable("semantic_promotion_failed"); }
      }
      runs.push(freeze({ sourceDate: run.sourceDate, runId:
        run.futures?.evidenceSet?.runId || run.options?.evidenceSet?.runId || null,
        futures: projections.futures, options: projections.options }));
    }
    if (currentGeneration !== generation) return freeze({ contractVersion: CONTRACT_VERSION,
      status: "stale", reason: "superseded_run", requestId, generation: currentGeneration,
      runs: [], diagnostics: { staleRun: true } });
    const accepted = runs.flatMap(run => [run.futures, run.options])
      .filter(value => value.status === "available").length,
      expected = runs.length * 2;
    return freeze({ contractVersion: CONTRACT_VERSION,
      status: accepted === expected ? "available" : accepted > 0 ? "partial" : "unavailable",
      reason: accepted === expected ? null : accepted > 0 ? "domain_partial" :
        "domain_unavailable", requestId, generation: currentGeneration, runs,
      diagnostics: { ...clone(capture.diagnostics), staleRun: false,
        rawPayloadExposed: false, storageLocationExposed: false } });
  }

  return freeze({ acquire, getGeneration: () => generation });
}

module.exports = freeze({ CONTRACT_VERSION, parseListingUpdatedAt, buildCandidate,
  createWeeklyProductionAcquisition });
