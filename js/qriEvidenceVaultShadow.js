"use strict";

const Qri = require("./qriAcquisitionAuthorityContract.js");
const Evidence = require("./sourceEvidence/sourceEvidenceContract.js");
const RawShadow = require("./qriRawTransportShadow.js");

const SHADOW_VERSION = "qri-evidence-vault-shadow-v1";
const TRANSPORT_VERSION = "qri-raw-transport-v1";
const ACQUISITION_CONTEXT = "live_original_acquisition";
const POLICY = Evidence.createSourcePolicy({ sourceFamily: Qri.SOURCE_FAMILY,
  sourceId: Qri.SOURCE_ID, allowedMediaTypes: [RawShadow.ACCEPTED_MEDIA_TYPE],
  allowedEncodings: ["shift_jis", "utf-8"], maxBytes: RawShadow.MAX_RESPONSE_BYTES });

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));

function frozen(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) Object.freeze(value);
  return value;
}

function failure(reason, diagnostics = {}) {
  return frozen({ contractVersion: SHADOW_VERSION, status: "unavailable", reason,
    receipt: null, parserInput: null, diagnostics: frozen(diagnostics) });
}

function vaultFailureReason(error) {
  const crashPoint = typeof error?.crashPoint === "string" ? error.crashPoint : "";
  const reason = typeof error?.message === "string" ? error.message : "";
  return /occurrence/i.test(crashPoint) || /occurrence|before_occurrence|after_occurrence/i.test(reason)
    ? "evidence_occurrence_persistence_failed" : "evidence_content_persistence_failed";
}

function finalRawUrl(rawFacts, canonicalUrl) {
  const hops = rawFacts?.redirectHops;
  return Array.isArray(hops) && hops.length ? hops.at(-1).toUrl : canonicalUrl;
}

function occurrenceRedirects(rawFacts) {
  return rawFacts.redirectHops.map(hop => ({ status: hop.status, url: hop.toUrl }));
}

function validateOccurrenceAgainstReceipt(receipt, occurrence, authority) {
  if (!Qri.validateAcquisitionReceipt(receipt, authority) ||
      receipt.contractVersion !== Qri.RECEIPT_V3_VERSION ||
      !Evidence.validateAcquisitionOccurrence(occurrence, POLICY)) return false;
  const active = receipt.role === "active";
  return occurrence.sourceFamily === Qri.SOURCE_FAMILY && occurrence.sourceId === Qri.SOURCE_ID &&
    occurrence.runId === receipt.acquisitionId && occurrence.requestRole === receipt.role &&
    occurrence.sourceDocumentRole === receipt.evidenceStatus.contextIdentity &&
    occurrence.contentSha256 === receipt.evidenceStatus.contentSha256 &&
    occurrence.occurrenceId === receipt.evidenceStatus.occurrenceId &&
    occurrence.byteLength === receipt.transportIdentity.byteLength &&
    occurrence.httpStatus === receipt.transportIdentity.httpStatus &&
    occurrence.mediaType === receipt.transportIdentity.mediaType &&
    occurrence.encoding === receipt.transportIdentity.encoding &&
    occurrence.fetchedAt === receipt.fetchedAt && occurrence.transportVersion === TRANSPORT_VERSION &&
    occurrence.acquisitionContext === ACQUISITION_CONTEXT &&
    Qri.canonicalQriUrl(occurrence.initialUrl, { active }) === receipt.acceptedInitialUrl &&
    Qri.canonicalQriUrl(occurrence.sourceUrl, { active }) === receipt.acceptedFinalUrl;
}

function createQriEvidenceVaultShadow(options) {
  if (!exact(options, ["rawTransportShadow", "vault", "authority"]) ||
      typeof options.rawTransportShadow?.acquire !== "function" ||
      !options.vault || typeof options.vault.storeAcceptedEvidence !== "function" ||
      typeof options.vault.verifyContent !== "function" ||
      typeof options.vault.verifyOccurrence !== "function" ||
      typeof options.vault.readRawBytes !== "function" ||
      typeof options.vault.readOccurrence !== "function") {
    throw new TypeError("qri_evidence_shadow_options_invalid");
  }

  async function acquire(input) {
    if (!exact(input, ["intent", "authorityContext", "runId", "requestId"])) {
      return failure("request_envelope_invalid", { vaultWriteCount: 0 });
    }
    let rawResult;
    try { rawResult = await options.rawTransportShadow.acquire(input); }
    catch (_error) { return failure("raw_transport_failed", { vaultWriteCount: 0 }); }
    if (rawResult?.status !== "available" ||
        rawResult.receipt?.contractVersion !== Qri.RECEIPT_V2_VERSION ||
        !Qri.validateAcquisitionReceipt(rawResult.receipt, options.authority) ||
        !Qri.validateDecodedParserInputAgainstReceipt(rawResult.receipt,
          rawResult.parserInput, options.authority) ||
        typeof rawResult.copyRawBytesForMainShadow !== "function") {
      return failure(rawResult?.reason || "raw_transport_result_invalid", { vaultWriteCount: 0 });
    }

    const resolution = Qri.resolveQriIntent(input.intent, input.authorityContext);
    if (!resolution.accepted) return failure(resolution.reason, { vaultWriteCount: 0 });
    const route = resolution.route;
    let acquisition;
    try {
      acquisition = Qri.createMainAcquisitionIdentity({ intent: input.intent, route,
        runId: input.runId, requestId: input.requestId }, options.authority);
    } catch (_error) { return failure("acquisition_identity_invalid", { vaultWriteCount: 0 }); }
    if (!Qri.validateAcquisitionReceipt(rawResult.receipt, options.authority,
      { acquisition, intent: input.intent, route })) {
      return failure("raw_receipt_binding_invalid", { vaultWriteCount: 0 });
    }

    const parentManifestId = route.role === "active" ? null :
      input.authorityContext.parentManifest.manifestId;
    let contextIdentity, bytes, contentObject, occurrence;
    try {
      contextIdentity = Qri.createEvidenceContextIdentity({ acquisition, intent: input.intent,
        route, parentManifestId }, options.authority);
      bytes = rawResult.copyRawBytesForMainShadow();
      contentObject = Evidence.createContentObject({ bytes,
        mediaType: rawResult.rawFacts.mediaType, encoding: rawResult.rawFacts.encoding,
        policy: POLICY });
      if (contentObject.sha256 !== rawResult.rawFacts.contentSha256 ||
          contentObject.byteLength !== rawResult.rawFacts.byteLength) {
        return failure("raw_evidence_identity_mismatch", { vaultWriteCount: 0 });
      }
      occurrence = Evidence.createAcquisitionOccurrence({ sourceFamily: Qri.SOURCE_FAMILY,
        sourceId: Qri.SOURCE_ID, initialUrl: route.canonicalUrl,
        sourceUrl: finalRawUrl(rawResult.rawFacts, route.canonicalUrl),
        fetchedAt: rawResult.receipt.fetchedAt,
        httpStatus: rawResult.rawFacts.httpStatus, contentObject,
        transportVersion: TRANSPORT_VERSION, publishedAt: null, requestRole: route.role,
        redirectHops: occurrenceRedirects(rawResult.rawFacts),
        sourceDocumentRole: contextIdentity, runId: acquisition.acquisitionId,
        acquisitionContext: ACQUISITION_CONTEXT }, POLICY);
    } catch (_error) { return failure("evidence_contract_invalid", { vaultWriteCount: 0 }); }

    let stored;
    try {
      stored = options.vault.storeAcceptedEvidence({ bytes, contentObject, occurrence, policy: POLICY });
    } catch (error) {
      return failure(vaultFailureReason(error), { vaultWriteCount: 0, retryCount: 0 });
    }

    let readOccurrence, readBytes;
    try {
      const verifiedContent = options.vault.verifyContent(contentObject.sha256);
      const verifiedOccurrence = options.vault.verifyOccurrence(occurrence.occurrenceId);
      readOccurrence = options.vault.readOccurrence(occurrence.occurrenceId);
      readBytes = options.vault.readRawBytes(contentObject.sha256);
      const checked = Evidence.verifyContentBytes(readBytes, contentObject.sha256,
        contentObject.byteLength);
      if (verifiedContent.status !== "valid" || verifiedOccurrence.status !== "valid" ||
          !checked.valid || Evidence.stable(readOccurrence) !== Evidence.stable(occurrence)) {
        throw new Error("evidence_readback_mismatch");
      }
    } catch (_error) {
      return failure("evidence_readback_failed", { vaultWriteCount: stored?.committed ? 1 : 0,
        retryCount: 0 });
    }

    let receipt;
    try {
      const sourceEvidence = Evidence.createSourceEvidenceRef({ state: "available",
        occurrence: readOccurrence, policy: POLICY });
      const evidenceStatus = Qri.createEvidenceStatus({
        contentSha256: sourceEvidence.contentSha256,
        occurrenceId: sourceEvidence.occurrenceId, role: route.role, contextIdentity,
        parentManifestId, listedContractId: route.listedContractId });
      receipt = Qri.createAcquisitionReceiptV3({ acquisition, intent: input.intent, route,
        acceptedInitialUrl: route.canonicalUrl, acceptedFinalUrl: route.canonicalUrl,
        fetchedAt: rawResult.receipt.fetchedAt,
        transportIdentity: rawResult.receipt.transportIdentity,
        parserInputIdentity: rawResult.receipt.parserInputIdentity,
        evidenceStatus, parentManifestId }, options.authority);
      if (!validateOccurrenceAgainstReceipt(receipt, readOccurrence, options.authority) ||
          !Qri.validateDecodedParserInputAgainstReceipt(receipt,
            rawResult.parserInput, options.authority)) throw new Error("receipt_readback_invalid");
    } catch (_error) {
      return failure("evidence_receipt_finalization_failed", {
        vaultWriteCount: stored?.committed ? 1 : 0, retryCount: 0 });
    }

    return frozen({ contractVersion: SHADOW_VERSION, status: "available", reason: null,
      receipt, parserInput: rawResult.parserInput, diagnostics: frozen({
        contentClassification: stored.contentClassification,
        occurrenceClassification: stored.classification,
        contentWriteCount: stored.contentWriteCount,
        occurrenceWriteCount: stored.occurrenceWriteCount,
        vaultReadback: "verified", retryCount: 0, formalWriteCount: 0,
        rawPayloadExposed: false, storageLocationExposed: false
      }) });
  }

  return Object.freeze({ acquire });
}

module.exports = Object.freeze({ SHADOW_VERSION, TRANSPORT_VERSION, ACQUISITION_CONTEXT,
  POLICY, createQriEvidenceVaultShadow, validateOccurrenceAgainstReceipt });
