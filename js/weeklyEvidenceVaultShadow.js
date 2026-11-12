"use strict";

const Authority = require("./weeklyAcquisitionAuthorityContract.js");
const Contract = require("./weeklyEvidenceSetContract.js");
const Evidence = require("./sourceEvidence/sourceEvidenceContract.js");

const SHADOW_VERSION = "weekly-evidence-vault-shadow-v1";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value) || ArrayBuffer.isView(value))
    return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function diagnostics(value = {}) {
  return freeze({ contentWriteCount: value.contentWriteCount || 0,
    occurrenceWriteCount: value.occurrenceWriteCount || 0,
    evidenceSetWriteCount: value.evidenceSetWriteCount || 0,
    retainedOccurrenceCount: value.retainedOccurrenceCount || 0,
    formalWriteCount: 0, historyWriteCount: 0, rawPayloadExposed: false,
    storageLocationExposed: false });
}

function failure(reason, runs = [], counts = {}) {
  return freeze({ contractVersion: SHADOW_VERSION, status: "unavailable", reason,
    runs, diagnostics: diagnostics(counts) });
}

function validateOptions(options) {
  return exact(options, ["transportShadow", "vault", "setStore", "authority", "testHooks"]) &&
    typeof options.transportShadow?.acquireIntentForEvidence === "function" &&
    typeof options.vault?.storeAcceptedEvidence === "function" &&
    typeof options.vault?.verifyContent === "function" &&
    typeof options.vault?.verifyOccurrence === "function" &&
    typeof options.vault?.readRawBytes === "function" &&
    typeof options.vault?.readOccurrence === "function" &&
    typeof options.setStore?.store === "function" && typeof options.setStore?.read === "function" &&
    typeof options.authority?.sign === "function" && typeof options.authority?.verify === "function" &&
    (options.testHooks === null || exact(options.testHooks, ["rejectParserRole"]) &&
      [null, Contract.LISTING_ROLE, ...Contract.DOMAIN_ROLES]
        .includes(options.testHooks.rejectParserRole));
}

function createWeeklyEvidenceVaultShadow(options) {
  if (!validateOptions(options)) throw new TypeError("weekly_evidence_shadow_options_invalid");

  function createContent(event) {
    const listing = event.kind === Contract.LISTING_ROLE,
      policy = Contract.policyForRole(event.kind);
    return Evidence.createContentObject({ bytes: event.transport.bytes,
      mediaType: event.transport.mime, encoding: listing ? "utf-8" : null, policy });
  }

  function persist(event, context) {
    const contentObject = createContent(event), occurrence = event.kind === Contract.LISTING_ROLE
      ? Contract.createListingOccurrence({ event, contentObject, authority: options.authority,
        manifest: context.manifest, discovery: context.discovery,
        transportResult: context.transportResult })
      : Contract.createWorkbookOccurrence({ event, contentObject, authority: options.authority,
        manifest: context.manifest, domainResult: context.domainResult });
    const policy = Contract.policyForRole(event.kind), stored = options.vault.storeAcceptedEvidence({
      bytes: event.transport.bytes, contentObject, occurrence, policy });
    if (options.vault.verifyContent(contentObject.sha256).status !== "valid" ||
        options.vault.verifyOccurrence(occurrence.occurrenceId).status !== "valid" ||
        Evidence.stable(options.vault.readOccurrence(occurrence.occurrenceId)) !==
          Evidence.stable(occurrence) ||
        !Evidence.verifyContentBytes(options.vault.readRawBytes(contentObject.sha256),
          contentObject.sha256, contentObject.byteLength).valid)
      throw new Error("weekly_evidence_readback_invalid");
    return { occurrence, contentWriteCount: stored.contentWriteCount,
      occurrenceWriteCount: stored.occurrenceWriteCount };
  }

  function domainProjection(status, reason, evidenceSet = null) {
    return freeze({ status, reason, evidenceSet });
  }

  async function capture(input) {
    if (!exact(input, ["intent", "requestId"]) ||
        !Authority.validateAcquisitionIntent(input.intent))
      return failure("intent_invalid");
    const events = [];
    let acquisition;
    try {
      acquisition = await options.transportShadow.acquireIntentForEvidence(input,
        async event => { events.push(event); });
    } catch (_error) { return failure("raw_transport_failed"); }
    const counts = { contentWriteCount: 0, occurrenceWriteCount: 0,
      evidenceSetWriteCount: 0, retainedOccurrenceCount: 0 };
    const add = persisted => {
      counts.contentWriteCount += persisted.contentWriteCount;
      counts.occurrenceWriteCount += persisted.occurrenceWriteCount;
      counts.retainedOccurrenceCount += 1;
      return persisted.occurrence;
    };

    if (!Array.isArray(acquisition?.runs) || acquisition.runs.length === 0) {
      for (const event of events.filter(value => value.kind === Contract.LISTING_ROLE)) {
        try { add(persist(event, { manifest: null, discovery: null, transportResult: null })); }
        catch (_error) { return failure("evidence_persistence_failed", [], counts); }
      }
      return failure(acquisition?.reason || "listing_failed", [], counts);
    }

    const runs = [];
    for (const run of acquisition.runs) {
      const listingEvent = events.find(event => event.kind === Contract.LISTING_ROLE &&
        event.listingYear === run.discovery.listingYear);
      let listingOccurrence = null;
      if (!listingEvent) return failure("listing_raw_missing", runs, counts);
      try {
        listingOccurrence = add(persist(listingEvent, { manifest: run.manifest,
          discovery: run.discovery, transportResult: run.listing }));
      } catch (_error) { return failure("evidence_persistence_failed", runs, counts); }

      const projections = {};
      for (const role of Contract.DOMAIN_ROLES) {
        const label = role === "weekly_futures_workbook" ? "futures" : "options",
          domainResult = run[label], descriptor = role === "weekly_futures_workbook" ?
            run.manifest.futuresDescriptor : run.manifest.optionsDescriptor,
          event = events.find(value => value.kind === role &&
            value.acquisition?.acquisitionId === descriptor.acquisitionId);
        let workbookOccurrence = null;
        if (event) {
          try { workbookOccurrence = add(persist(event, { manifest: run.manifest, domainResult })); }
          catch (_error) { return failure("evidence_persistence_failed", runs, counts); }
        }
        const parserRejected = options.testHooks?.rejectParserRole === Contract.LISTING_ROLE ||
          options.testHooks?.rejectParserRole === role;
        if (!domainResult?.success || !workbookOccurrence || parserRejected) {
          projections[label] = domainProjection("unavailable", parserRejected ?
            "parser_binding_rejected" : domainResult?.reason || "raw_evidence_missing");
          continue;
        }
        let evidenceSet;
        try {
          evidenceSet = Contract.createEvidenceSet({ domainRole: role, manifest: run.manifest,
            discovery: run.discovery, listingResult: run.listing, domainResult,
            listingOccurrence, workbookOccurrence }, options.authority);
          if (!Contract.validateEvidenceSetAgainstVault(evidenceSet, options.vault,
            options.authority)) throw new Error("weekly_evidence_set_vault_invalid");
        } catch (_error) {
          projections[label] = domainProjection("unavailable", "evidence_set_rejected");
          continue;
        }
        let stored, readback;
        try {
          stored = options.setStore.store(evidenceSet, options.authority);
          readback = options.setStore.read(evidenceSet.evidenceSetId, options.authority);
          if (!readback || Evidence.stable(readback) !== Evidence.stable(evidenceSet) ||
              !Contract.validateEvidenceSetAgainstVault(readback, options.vault,
                options.authority)) throw new Error("weekly_evidence_set_readback_invalid");
        } catch (_error) {
          projections[label] = domainProjection("unavailable", "evidence_set_persistence_failed");
          continue;
        }
        counts.evidenceSetWriteCount += stored.writeCount;
        projections[label] = domainProjection("available", null, readback);
      }
      runs.push(freeze({ sourceDate: run.sourceDate,
        listingOccurrenceId: listingOccurrence.occurrenceId,
        futures: projections.futures, options: projections.options }));
    }
    const accepted = runs.flatMap(run => [run.futures, run.options])
      .filter(value => value.status === "available").length,
      expected = runs.length * 2;
    return freeze({ contractVersion: SHADOW_VERSION,
      status: accepted === expected ? "available" : accepted > 0 ? "partial" : "unavailable",
      reason: accepted === expected ? null : accepted > 0 ? "domain_evidence_partial" :
        "domain_evidence_unavailable", runs, diagnostics: diagnostics(counts) });
  }

  function resolve(evidenceSetId) {
    let evidenceSet;
    try { evidenceSet = options.setStore.read(evidenceSetId, options.authority); }
    catch (_error) { return failure("evidence_set_integrity_invalid"); }
    if (!evidenceSet) return failure("evidence_set_missing");
    if (!Contract.validateEvidenceSetAgainstVault(evidenceSet, options.vault, options.authority))
      return failure("evidence_set_integrity_invalid");
    const documents = [];
    try {
      for (const entry of evidenceSet.roles) documents.push({ role: entry.role,
        occurrence: options.vault.readOccurrence(entry.occurrenceId),
        bytes: options.vault.readRawBytes(entry.contentSha256) });
    } catch (_error) { return failure("evidence_set_integrity_invalid"); }
    return freeze({ contractVersion: SHADOW_VERSION, status: "available", reason: null,
      evidenceSet, documents, diagnostics: diagnostics() });
  }

  return freeze({ capture, resolve });
}

module.exports = freeze({ SHADOW_VERSION, createWeeklyEvidenceVaultShadow });
