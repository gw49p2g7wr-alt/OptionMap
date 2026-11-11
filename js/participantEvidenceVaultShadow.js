"use strict";

const P1 = require("./participantAcquisitionAuthorityContract.js");
const P2 = require("./participantRawTransportShadow.js");
const Contract = require("./participantEvidenceSetContract.js");
const Evidence = require("./sourceEvidence/sourceEvidenceContract.js");

const SHADOW_VERSION = "participants-evidence-vault-shadow-v1";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value) || ArrayBuffer.isView(value))
    return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function failure(reason, details = {}) {
  return freeze({ contractVersion: SHADOW_VERSION, status: "unavailable", reason,
    evidenceSet: null, diagnostics: { contentWriteCount: details.contentWriteCount || 0,
      occurrenceWriteCount: details.occurrenceWriteCount || 0,
      evidenceSetWriteCount: details.evidenceSetWriteCount || 0,
      retainedOccurrenceCount: details.retainedOccurrenceCount || 0,
      formalWriteCount: 0, historyWriteCount: 0, rawPayloadExposed: false,
      storageLocationExposed: false } });
}

function validateOptions(options) {
  return exact(options, ["transportShadow", "vault", "setStore", "authority", "testHooks"]) &&
    typeof options.transportShadow?.acquireManifest === "function" &&
    typeof options.vault?.storeAcceptedEvidence === "function" &&
    typeof options.vault?.verifyContent === "function" &&
    typeof options.vault?.verifyOccurrence === "function" &&
    typeof options.vault?.readRawBytes === "function" &&
    typeof options.vault?.readOccurrence === "function" &&
    typeof options.setStore?.store === "function" && typeof options.setStore?.read === "function" &&
    typeof options.authority?.sign === "function" && typeof options.authority?.verify === "function" &&
    (options.testHooks === null || exact(options.testHooks, ["rejectParserRole"]) &&
      (options.testHooks.rejectParserRole === null ||
        P1.ROLE_ORDER.includes(options.testHooks.rejectParserRole)));
}

function createParticipantsEvidenceVaultShadow(options) {
  if (!validateOptions(options)) throw new TypeError("participants_evidence_shadow_options_invalid");

  async function capture(manifest) {
    if (!P1.validateAcquisitionManifest(manifest, options.authority))
      return failure("manifest_invalid");
    let transportSet;
    try { transportSet = await options.transportShadow.acquireManifest(manifest); }
    catch (_error) { return failure("raw_transport_failed"); }
    const acquisitions = P1.createWorkbookAcquisitions(manifest, options.authority);
    if (!transportSet?.success ||
        !P2.validateTransportSet(transportSet, manifest, acquisitions, options.authority))
      return failure(transportSet?.reason || "raw_transport_result_invalid");

    const occurrences = [];
    let contentWriteCount = 0, occurrenceWriteCount = 0;
    for (const [index, transportResult] of transportSet.results.entries()) {
      const acquisition = acquisitions[index];
      let contentObject, occurrence;
      try {
        if (!P2.validateTransportResult(transportResult, manifest, acquisition, options.authority))
          throw new Error("transport_result_invalid");
        contentObject = Evidence.createContentObject({ bytes: transportResult.bytes,
          mediaType: transportResult.mime, encoding: null, policy: Contract.POLICY });
        if (contentObject.sha256 !== transportResult.rawSha256 ||
            contentObject.byteLength !== transportResult.byteLength)
          throw new Error("raw_identity_mismatch");
        occurrence = Contract.createOccurrence({ transportResult, acquisition, contentObject });
        if (!Contract.validateOccurrenceBinding(occurrence, transportResult, acquisition))
          throw new Error("occurrence_binding_invalid");
      } catch (_error) {
        return failure("evidence_contract_invalid", { contentWriteCount, occurrenceWriteCount,
          retainedOccurrenceCount: occurrences.length });
      }
      let stored;
      try {
        stored = options.vault.storeAcceptedEvidence({ bytes: transportResult.bytes,
          contentObject, occurrence, policy: Contract.POLICY });
      } catch (_error) {
        return failure("evidence_persistence_failed", { contentWriteCount, occurrenceWriteCount,
          retainedOccurrenceCount: occurrences.length });
      }
      contentWriteCount += stored.contentWriteCount;
      occurrenceWriteCount += stored.occurrenceWriteCount;
      try {
        const content = options.vault.verifyContent(contentObject.sha256),
          occurrenceStatus = options.vault.verifyOccurrence(occurrence.occurrenceId),
          readOccurrence = options.vault.readOccurrence(occurrence.occurrenceId),
          readBytes = options.vault.readRawBytes(contentObject.sha256);
        if (content.status !== "valid" || occurrenceStatus.status !== "valid" ||
            Evidence.stable(readOccurrence) !== Evidence.stable(occurrence) ||
            !Evidence.verifyContentBytes(readBytes, contentObject.sha256,
              contentObject.byteLength).valid) throw new Error("readback_invalid");
      } catch (_error) {
        return failure("evidence_readback_failed", { contentWriteCount, occurrenceWriteCount,
          retainedOccurrenceCount: occurrences.length + 1 });
      }
      occurrences.push(occurrence);
    }

    if (options.testHooks && options.testHooks.rejectParserRole !== null) {
      return failure("parser_binding_rejected", { contentWriteCount, occurrenceWriteCount,
        retainedOccurrenceCount: occurrences.length });
    }

    let evidenceSet;
    try {
      evidenceSet = Contract.createEvidenceSet({ manifest, transportSet, acquisitions, occurrences },
        options.authority);
      if (!Contract.validateEvidenceSetAgainstVault(evidenceSet, options.vault, options.authority))
        throw new Error("evidence_set_vault_invalid");
    } catch (_error) {
      return failure("evidence_set_rejected", { contentWriteCount, occurrenceWriteCount,
        retainedOccurrenceCount: occurrences.length });
    }
    let storedSet;
    try { storedSet = options.setStore.store(evidenceSet, options.authority); }
    catch (_error) { return failure("evidence_set_persistence_failed", { contentWriteCount,
      occurrenceWriteCount, retainedOccurrenceCount: occurrences.length }); }
    let readSet;
    try {
      readSet = options.setStore.read(evidenceSet.evidenceSetId, options.authority);
      if (!readSet || Evidence.stable(readSet) !== Evidence.stable(evidenceSet) ||
          !Contract.validateEvidenceSetAgainstVault(readSet, options.vault, options.authority))
        throw new Error("set_readback_invalid");
    } catch (_error) { return failure("evidence_set_readback_failed", { contentWriteCount,
      occurrenceWriteCount, evidenceSetWriteCount: storedSet.writeCount,
      retainedOccurrenceCount: occurrences.length }); }
    return freeze({ contractVersion: SHADOW_VERSION, status: "available", reason: null,
      evidenceSet: readSet, diagnostics: { contentWriteCount, occurrenceWriteCount,
        evidenceSetWriteCount: storedSet.writeCount,
        contentClassifications: transportSet.results.map(result =>
          options.vault.readContentMetadata(result.rawSha256) ? "verified" : "missing"),
        occurrenceCount: occurrences.length, setClassification: storedSet.classification,
        formalWriteCount: 0, historyWriteCount: 0, rawPayloadExposed: false,
        storageLocationExposed: false } });
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
      evidenceSet, documents, diagnostics: { formalWriteCount: 0, historyWriteCount: 0,
        rawPayloadExposed: false, storageLocationExposed: false } });
  }

  return freeze({ capture, resolve });
}

module.exports = freeze({ SHADOW_VERSION, createParticipantsEvidenceVaultShadow });
