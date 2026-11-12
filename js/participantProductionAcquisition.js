"use strict";

const crypto = require("node:crypto");
const P1 = require("./participantAcquisitionAuthorityContract.js");
const P2 = require("./participantRawTransportShadow.js");
const Binding = require("./participantFormalEvidenceBinding.js");
const ParticipantData = require("./participantData.js");
const Backfill = require("./backfill/adapters/participantBackfillAdapter.js");

const CONTRACT_VERSION = "participants-production-acquisition-v1";
const MAX_DISCOVERY_BYTES = 1_000_000;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const clone = value => value == null ? value : structuredClone(value);

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function unavailable(reason, diagnostics = {}) {
  return freeze({ contractVersion: CONTRACT_VERSION, status: "unavailable", reason,
    sourceDate: diagnostics.sourceDate || null, completeSet: null, classification: null,
    formalWriteCount: 0, diagnostics: { stage: diagnostics.stage || null,
      retainedLastValid: true, rawPayloadExposed: false, storageLocationExposed: false } });
}

function validateRendererIntent(value) {
  try {
    const intent = P1.createAcquisitionIntent(value);
    if (intent.requestKind === "historical_backfill_range" &&
        (Date.parse(`${intent.endDate}T00:00:00.000Z`) -
          Date.parse(`${intent.startDate}T00:00:00.000Z`)) / 86_400_000 > 366) return null;
    return intent;
  } catch (_error) { return null; }
}

function jstDate(now) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric",
    month: "2-digit", day: "2-digit" }).format(now);
}

function previousWeekday(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  do date.setUTCDate(date.getUTCDate() - 1);
  while ([0, 6].includes(date.getUTCDay()));
  return date.toISOString().slice(0, 10);
}

async function boundedResponse(response, acceptedMime, maximum = MAX_DISCOVERY_BYTES) {
  if (!response?.ok || response.status !== 200) throw new Error("discovery_http_status");
  const mime = String(response.headers?.get?.("content-type") || "").split(";", 1)[0]
    .trim().toLowerCase();
  if (!acceptedMime.includes(mime)) throw new Error("discovery_mime_invalid");
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength === 0 || buffer.byteLength > maximum)
    throw new Error("discovery_body_invalid");
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function hrefsFromHtml(html) {
  const values = [];
  for (const match of String(html).matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi))
    values.push(match[1]);
  return values;
}

function createProductionDiscovery(options = {}) {
  if (!exact(options, ["fetchImpl", "now", "createId"]) ||
      typeof options.fetchImpl !== "function" || typeof options.now !== "function" ||
      typeof options.createId !== "function")
    throw new TypeError("participants_production_discovery_options_invalid");
  async function fetchJson(url) {
    const response = await options.fetchImpl(url, { method: "GET", redirect: "error",
      credentials: "omit", cache: "no-store", headers: { accept: "application/json" } });
    return JSON.parse(await boundedResponse(response, ["application/json", "text/json"]));
  }
  async function latestFacts() {
    const response = await options.fetchImpl(P1.CURRENT_INDEX_URL, { method: "GET",
      redirect: "error", credentials: "omit", cache: "no-store",
      headers: { accept: "text/html" } });
    const html = await boundedResponse(response, ["text/html"]);
    return { indexUrl: P1.CURRENT_INDEX_URL, hrefs: hrefsFromHtml(html),
      discoveryRequestId: options.createId("index") };
  }
  async function rangeDates(startDate, endDate) {
    const result = await Backfill.enumerateCandidates({ startDate, endDate, fetchJson });
    return { dates: result.candidates.map(candidate => candidate.sourceDate),
      failureCount: result.failures.length, unavailableMonthCount: result.unavailableMonths.length };
  }
  function probeStartDate() { return previousWeekday(jstDate(options.now())); }
  return freeze({ latestFacts, rangeDates, probeStartDate });
}

function createParticipantProductionAcquisition(options = {}) {
  const fields = ["authority", "transportShadow", "evidenceShadow", "formalBridge", "vault",
    "setStore", "discovery", "now", "createId"];
  if (!exact(options, fields) || typeof options.authority?.sign !== "function" ||
      typeof options.transportShadow?.resolveManifest !== "function" ||
      typeof options.transportShadow?.acquireRawManifest !== "function" ||
      typeof options.transportShadow?.parseRawManifest !== "function" ||
      typeof options.transportShadow?.acquireManifest !== "function" ||
      typeof options.evidenceShadow?.captureRawResults !== "function" ||
      typeof options.evidenceShadow?.captureTransportSet !== "function" ||
      typeof options.formalBridge?.commit !== "function" ||
      typeof options.setStore?.read !== "function" ||
      typeof options.discovery?.latestFacts !== "function" ||
      typeof options.discovery?.rangeDates !== "function" ||
      typeof options.discovery?.probeStartDate !== "function" ||
      typeof options.now !== "function" || typeof options.createId !== "function")
    throw new TypeError("participants_production_acquisition_options_invalid");
  let generation = 0;

  async function acquireOne(intent, ownGeneration) {
    let resolved;
    try {
      const shared = { intent, requestId: options.createId("request"),
        discoveryRequestId: options.createId("discovery") };
      if (intent.requestKind === "latest_available") {
        let indexFacts = null;
        try { indexFacts = await options.discovery.latestFacts(); } catch (_error) {}
        resolved = await options.transportShadow.resolveManifest({ ...shared, indexFacts,
          probeStartDate: options.discovery.probeStartDate() });
      } else {
        resolved = await options.transportShadow.resolveManifest({ ...shared,
          probeStartDate: intent.targetDate });
      }
    } catch (_error) { return unavailable("discovery_failed", { stage: "discovery" }); }
    if (!resolved?.success) return unavailable(resolved?.reason === "incomplete_set" ?
      "incomplete_set" : "discovery_failed", { stage: "discovery" });
    const manifest = resolved.manifest, acquisitions = P1.createWorkbookAcquisitions(
      manifest, options.authority);
    let rawBatch;
    try { rawBatch = await options.transportShadow.acquireRawManifest(manifest); }
    catch (_error) { return unavailable("transport_failed", { stage: "transport",
      sourceDate: manifest.sourceDate }); }
    if (!rawBatch?.success) {
      const retained = await options.evidenceShadow.captureRawResults(manifest,
        Array.isArray(rawBatch?.results) ? rawBatch.results : []);
      if (retained?.status !== "available") return unavailable("evidence_failed",
        { stage: "evidence", sourceDate: manifest.sourceDate });
      return unavailable(rawBatch?.reason === "incomplete_set" ? "incomplete_set" :
        "transport_failed", { stage: "transport", sourceDate: manifest.sourceDate });
    }
    const transportSet = options.transportShadow.parseRawManifest(manifest, rawBatch);
    if (!transportSet?.success || !P2.validateTransportSet(transportSet, manifest, acquisitions,
      options.authority)) {
      if (transportSet?.reason === "workbook_parse_rejected") {
        const retained = await options.evidenceShadow.captureRawResults(manifest, rawBatch.results);
        if (retained?.status !== "available") return unavailable("evidence_failed",
          { stage: "evidence", sourceDate: manifest.sourceDate });
      }
      return unavailable(transportSet?.reason === "workbook_parse_rejected" ? "parser_failed" :
        "transport_failed", { stage: transportSet?.reason === "workbook_parse_rejected" ?
          "parser" : "transport", sourceDate: manifest.sourceDate });
    }
    const evidence = await options.evidenceShadow.captureTransportSet(manifest, transportSet);
    if (evidence?.status !== "available") return unavailable("evidence_failed",
      { stage: "evidence", sourceDate: manifest.sourceDate });
    const completeSet = await Binding.expectedCompleteSet(transportSet, manifest.sourceDate,
      transportSet.results[0].fetchedAt);
    if (!completeSet || !(await ParticipantData.validateParticipantCache(completeSet)))
      return unavailable("parser_failed", { stage: "parser", sourceDate: manifest.sourceDate });
    const confirmedAt = options.now().toISOString();
    let sourceEvidence;
    try { sourceEvidence = await Binding.createBinding({ completeSet,
      evidenceSet: evidence.evidenceSet, transportSet, manifest, acquisitions,
      boundAt: confirmedAt, vault: options.vault }, options.authority); }
    catch (_error) { return unavailable("evidence_failed", { stage: "binding",
      sourceDate: manifest.sourceDate }); }
    if (ownGeneration !== generation) return unavailable("stale_request",
      { stage: "stale", sourceDate: manifest.sourceDate });
    let formal;
    try { formal = await options.formalBridge.commit({ completeSet, sourceEvidence, confirmedAt }); }
    catch (_error) { return unavailable("formal_promotion_failed",
      { stage: "formal", sourceDate: manifest.sourceDate }); }
    if (ownGeneration !== generation || formal?.status !== "accepted" ||
        formal.revision?.versionKey !== completeSet.versionKey ||
        formal.revision?.signature !== completeSet.signature)
      return unavailable(ownGeneration !== generation ? "stale_request" :
        "formal_promotion_failed", { stage: "formal", sourceDate: manifest.sourceDate });
    const persistedSet = options.setStore.read(sourceEvidence.evidenceSetId, options.authority),
      activeSet = formal.revision.sourceEvidence ? options.setStore.read(
        formal.revision.sourceEvidence.evidenceSetId, options.authority) : null,
      evidenceValid = Boolean(persistedSet) && Binding.validateBinding(sourceEvidence,
        options.authority) && (formal.classification === "semantic_duplicate" ?
        (!formal.revision.sourceEvidence || Binding.validateRevisionBinding(formal.revision,
          activeSet, options.vault, options.authority)) :
        Binding.validateRevisionBinding(formal.revision, persistedSet, options.vault,
          options.authority));
    if (!evidenceValid) return unavailable("formal_promotion_failed",
      { stage: "readback", sourceDate: manifest.sourceDate });
    return freeze({ contractVersion: CONTRACT_VERSION, status: "available", reason: null,
      sourceDate: manifest.sourceDate, completeSet: clone(completeSet),
      classification: formal.classification, formalWriteCount: formal.revisionWriteCount,
      diagnostics: { stage: "accepted", retainedLastValid: true,
        rawPayloadExposed: false, storageLocationExposed: false } });
  }

  async function acquire(request) {
    const intent = validateRendererIntent(request);
    if (!intent) return unavailable("intent_invalid", { stage: "intent" });
    if (intent.requestKind === "historical_backfill_range") {
      try {
        const range = await options.discovery.rangeDates(intent.startDate, intent.endDate);
        return freeze({ contractVersion: CONTRACT_VERSION, status: "available", reason: null,
          sourceDate: null, completeSet: null, classification: "backfill_manifest",
          formalWriteCount: 0, candidates: range.dates.map(sourceDate => ({ sourceDate })),
          failureCount: range.failureCount,
          unavailableMonthCount: range.unavailableMonthCount,
          diagnostics: { stage: "discovery", retainedLastValid: true,
            rawPayloadExposed: false, storageLocationExposed: false } });
      } catch (_error) { return unavailable("discovery_failed", { stage: "discovery" }); }
    }
    const ownGeneration = ++generation;
    return acquireOne(intent, ownGeneration);
  }

  return freeze({ acquire });
}

module.exports = freeze({ CONTRACT_VERSION, MAX_DISCOVERY_BYTES, validateRendererIntent,
  hrefsFromHtml, createProductionDiscovery, createParticipantProductionAcquisition });
