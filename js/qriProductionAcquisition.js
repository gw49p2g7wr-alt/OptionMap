"use strict";

const { isDeepStrictEqual } = require("node:util");
const Qri = require("./qriAcquisitionAuthorityContract.js");
const MajorSq = require("./qriOptionsMajorSqAcquisition.js");

const SERVICE_VERSION = "qri-production-acquisition-v1";
const MAX_PENDING = 32;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const clone = value => value == null ? value : structuredClone(value);

function activeContractIdentityFromParserInput(parserInput) {
  if (typeof parserInput !== "string") throw new TypeError("qri_active_contract_input_invalid");
  const matches = [...parserInput.replace(/&amp;/gi, "&")
    .matchAll(/[?&]gengetsu=(20\d{4})(?:&|["'])/gi)].map(match => match[1]);
  if (!matches.length) throw new Error("qri_active_contract_identity_missing");
  const first = matches[0];
  return Qri.createContractIdentity(`${first.slice(0, 4)}-${first.slice(4)}`);
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function unavailable(reason, diagnostics = {}) {
  return freeze({ contractVersion: SERVICE_VERSION, success: false, status: "unavailable",
    reason, parserInput: null, receipt: null, parentManifest: null,
    diagnostics: { retryCount: 0, oldTransportFallbackCount: 0, ...diagnostics } });
}

function validRendererRequest(request) {
  if (exact(request, ["requestKind"]) && request.requestKind === "active") return true;
  return exact(request, ["requestKind", "role", "parentAcquisitionId", "listedContractId"]) &&
    request.requestKind === "listed_reference" && Qri.REFERENCE_ROLES.includes(request.role) &&
    /^qri-acquisition-v1\|sha256:[0-9a-f]{64}$/.test(request.parentAcquisitionId || "") &&
    /^qri-listed-contract-v1\|sha256:[0-9a-f]{64}$/.test(request.listedContractId || "");
}

function manifestEntries(canonical) {
  if (!Array.isArray(canonical?.availableContracts)) return [];
  const entries = [];
  const identities = new Set();
  const inferContract = item => {
    if (/^20\d{2}-(0[1-9]|1[0-2])$/.test(item?.contract || "")) return item.contract;
    const match = /^([1-9]|1[0-2])月限$/.exec(item?.label || "");
    const active = /^(20\d{2})-(0[1-9]|1[0-2])$/.exec(canonical?.contract || "");
    if (!match || !active) return null;
    const month = Number(match[1]), activeMonth = Number(active[2]);
    if (month === activeMonth) return null;
    const year = Number(active[1]) + (month < activeMonth ? 1 : 0);
    return `${year}-${String(month).padStart(2, "0")}`;
  };
  const activeIndex = canonical.availableContracts.findIndex(item => item?.active === true &&
    item.contract === canonical.contract);
  const nextContract = activeIndex < 0 ? null : canonical.availableContracts.slice(activeIndex + 1)
    .map(inferContract).find(Boolean) || null;
  const majorSqContract = MajorSq.nextMajorSqContract(canonical.contract);
  for (const item of canonical.availableContracts) {
    const listedContract = inferContract(item);
    if (item?.active === true || !listedContract) continue;
    const canonicalUrl = Qri.canonicalQriUrl(item.url);
    if (!canonicalUrl) continue;
    const identity = `${listedContract}|${canonicalUrl}`;
    if (identities.has(identity)) continue;
    const allowedRoles = [];
    if (listedContract === nextContract) allowedRoles.push("next");
    if (listedContract === majorSqContract) allowedRoles.push("major_sq");
    if (!allowedRoles.length) continue;
    identities.add(identity);
    entries.push({ contractIdentity: Qri.createContractIdentity(listedContract), canonicalUrl,
      allowedRoles });
  }
  return entries;
}

function createQriProductionAcquisition(options) {
  if (!exact(options, ["authority", "evidenceAcquirer", "formalBinding", "parseCanonical",
    "validateCanonical", "createRunId", "createRequestId"]) ||
      typeof options.evidenceAcquirer?.acquire !== "function" ||
      typeof options.formalBinding?.prepareFormalCandidate !== "function" ||
      typeof options.parseCanonical !== "function" || typeof options.validateCanonical !== "function" ||
      typeof options.createRunId !== "function" || typeof options.createRequestId !== "function") {
    throw new TypeError("qri_production_acquisition_options_invalid");
  }
  const pending = new Map();
  const parents = new Map();
  const bound = (map, maximum) => { while (map.size > maximum) map.delete(map.keys().next().value); };

  async function acquire(request) {
    if (!validRendererRequest(request)) return unavailable("intent_rejected");
    let intent, authorityContext;
    try {
      if (request.requestKind === "active") {
        intent = Qri.createAcquisitionIntent({ requestKind: "active" });
        authorityContext = {};
      } else {
        const parent = parents.get(request.parentAcquisitionId);
        if (!parent) return unavailable("parent_manifest_unavailable");
        intent = Qri.createAcquisitionIntent({ requestKind: "listed_reference", role: request.role,
          parentAcquisitionId: request.parentAcquisitionId,
          listedContractId: request.listedContractId });
        authorityContext = { parentManifest: parent.manifest, parentReceipt: parent.receipt,
          authority: options.authority };
      }
    } catch (_error) { return unavailable("intent_rejected"); }
    let result;
    try {
      result = await options.evidenceAcquirer.acquire({ intent, authorityContext,
        runId: options.createRunId(), requestId: options.createRequestId() });
    } catch (_error) { return unavailable("evidence_acquisition_failed"); }
    if (result?.status !== "available" ||
        result.receipt?.contractVersion !== Qri.RECEIPT_V3_VERSION ||
        !Qri.validateAcquisitionReceipt(result.receipt, options.authority) ||
        !Qri.validateDecodedParserInputAgainstReceipt(result.receipt,
          result.parserInput, options.authority)) {
      return unavailable(result?.reason || "evidence_acquisition_failed",
        { vaultWriteCount: result?.diagnostics?.vaultWriteCount || 0 });
    }
    let canonical;
    try { canonical = options.parseCanonical(result.parserInput, result.receipt.acceptedFinalUrl); }
    catch (_error) { return unavailable("main_parser_rejected", { evidenceRetained: true }); }
    if (!options.validateCanonical(canonical) ||
        canonical.contract !== result.receipt.contractIdentity.contract ||
        canonical.sourceUrl !== result.receipt.acceptedFinalUrl) {
      return unavailable("main_parser_identity_mismatch", { evidenceRetained: true });
    }
    let parentManifest = null;
    if (request.requestKind === "active") {
      const entries = manifestEntries(canonical);
      if (entries.length) {
        try { parentManifest = Qri.createParentManifest({ parentReceipt: result.receipt,
          entries }, options.authority); }
        catch (_error) { return unavailable("parent_manifest_creation_failed",
          { evidenceRetained: true }); }
        parents.set(result.receipt.acquisitionId, { receipt: result.receipt,
          manifest: parentManifest });
        bound(parents, 8);
      }
    }
    pending.set(result.receipt.acquisitionId, { receipt: result.receipt,
      parserInput: result.parserInput, canonical: clone(canonical) });
    bound(pending, MAX_PENDING);
    return freeze({ contractVersion: SERVICE_VERSION, success: true, status: "available",
      reason: null, parserInput: result.parserInput, receipt: clone(result.receipt),
      parentManifest: clone(parentManifest), diagnostics: {
        retryCount: 0, oldTransportFallbackCount: 0, evidence: "verified",
        contentClassification: result.diagnostics?.contentClassification || null,
        occurrenceClassification: result.diagnostics?.occurrenceClassification || null,
        rawPayloadExposed: false, storageLocationExposed: false
      } });
  }

  async function finalize(input) {
    if (!exact(input, ["acquisitionId", "canonical", "cache", "ivCanonical"]) ||
        typeof input.acquisitionId !== "string" || !object(input.canonical) ||
        (input.cache !== null && !object(input.cache)) ||
        (input.ivCanonical !== null && !object(input.ivCanonical))) {
      return unavailable("parser_result_envelope_invalid");
    }
    const acquisition = pending.get(input.acquisitionId);
    if (!acquisition) return unavailable("acquisition_not_pending");
    if (!isDeepStrictEqual(input.canonical, acquisition.canonical)) {
      return unavailable("main_parser_canonical_mismatch",
        { evidenceRetained: true, formalWriteCount: 0 });
    }
    const receipt = acquisition.receipt;
    const parserResult = { canonical: clone(input.canonical), acquisitionBinding: {
      acquisitionId: receipt.acquisitionId, role: receipt.role,
      parentAcquisitionId: receipt.parentAcquisitionId } };
    const parserBinding = Qri.validateParserResultAgainstReceipt(receipt,
      parserResult, options.authority);
    if (!parserBinding.accepted) return unavailable(`parser_${parserBinding.reason}`,
      { evidenceRetained: true, formalWriteCount: 0 });
    let ivInheritance = null;
    if (input.ivCanonical !== null) {
      const inherited = Qri.createIvReceiptInheritanceV2(receipt,
        input.ivCanonical, options.authority);
      if (!inherited.accepted) return unavailable(inherited.reason,
        { evidenceRetained: true, formalWriteCount: 0 });
      ivInheritance = inherited.inheritance;
    }
    let formalCandidate = null;
    if (input.cache !== null) {
      const prepared = await options.formalBinding.prepareFormalCandidate({ cache: input.cache,
        receipt, parserInput: acquisition.parserInput, parserResult });
      if (!prepared.accepted) return unavailable(prepared.reason,
        { evidenceRetained: true, formalWriteCount: 0 });
      formalCandidate = prepared.candidate;
    }
    pending.delete(input.acquisitionId);
    return freeze({ contractVersion: SERVICE_VERSION, success: true, status: "accepted",
      reason: null, formalCandidate: clone(formalCandidate),
      ivInheritance: clone(ivInheritance), parserBinding: clone(parserBinding.binding),
      diagnostics: { evidenceRetained: true, formalWriteCount: 0,
        rawPayloadExposed: false, storageLocationExposed: false } });
  }

  return Object.freeze({ acquire, finalize, diagnostics: () => freeze({
    pendingAcquisitionCount: pending.size, parentManifestCount: parents.size,
    oldTransportFallbackCount: 0 }) });
}

module.exports = Object.freeze({ SERVICE_VERSION, MAX_PENDING, validRendererRequest,
  activeContractIdentityFromParserInput, manifestEntries, createQriProductionAcquisition });
