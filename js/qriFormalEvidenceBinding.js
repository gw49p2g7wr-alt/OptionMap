"use strict";

const { TextDecoder } = require("node:util");
const Qri = require("./qriAcquisitionAuthorityContract.js");
const QriEvidence = require("./qriEvidenceVaultShadow.js");
const History = require("./qriOptionsHistory.js");
const Evidence = require("./sourceEvidence/sourceEvidenceContract.js");

const BINDING_VERSION = History.FORMAL_EVIDENCE_VERSION;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const clone = value => value == null ? value : structuredClone(value);

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function rejected(reason) {
  return freeze({ accepted: false, reason, candidate: null, diagnostics: {
    formalTransactionCount: 0, formalWriteCount: 0, retryCount: 0
  } });
}

function createBinding(receipt) {
  return freeze({ contractVersion: BINDING_VERSION, status: "available",
    receipt: clone(receipt) });
}

function decodeRaw(bytes, encoding) {
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch (_error) { return null; }
}

function createQriFormalEvidenceBinding(options) {
  if (!exact(options, ["authority", "vault", "historyStore"]) ||
      !options.authority || !options.vault || !options.historyStore ||
      typeof options.vault.verifyContent !== "function" ||
      typeof options.vault.verifyOccurrence !== "function" ||
      typeof options.vault.readOccurrence !== "function" ||
      typeof options.vault.readRawBytes !== "function" ||
      typeof options.historyStore.persistCandidate !== "function") {
    throw new TypeError("qri_formal_evidence_binding_options_invalid");
  }

  function verifyReceiptVault(receipt) {
    if (receipt?.contractVersion !== Qri.RECEIPT_V3_VERSION ||
        !Qri.validateAcquisitionReceipt(receipt, options.authority)) {
      return { accepted: false, reason: "receipt_invalid" };
    }
    const evidence = receipt.evidenceStatus;
    let occurrence, rawBytes;
    try {
      const content = options.vault.verifyContent(evidence.contentSha256);
      const occurrenceStatus = options.vault.verifyOccurrence(evidence.occurrenceId);
      occurrence = options.vault.readOccurrence(evidence.occurrenceId);
      rawBytes = options.vault.readRawBytes(evidence.contentSha256);
      const bytes = Evidence.verifyContentBytes(rawBytes, evidence.contentSha256,
        receipt.transportIdentity.byteLength);
      if (content.status !== "valid" || occurrenceStatus.status !== "valid" || !bytes.valid ||
          !QriEvidence.validateOccurrenceAgainstReceipt(receipt, occurrence, options.authority)) {
        return { accepted: false, reason: "vault_evidence_invalid" };
      }
    } catch (_error) { return { accepted: false, reason: "vault_evidence_invalid" }; }
    return { accepted: true, reason: null, occurrence, rawBytes };
  }

  async function prepareFormalCandidate(input) {
    if (!exact(input, ["cache", "receipt", "parserInput", "parserResult"])) {
      return rejected("formal_binding_input_invalid");
    }
    const verified = verifyReceiptVault(input.receipt);
    if (!verified.accepted) return rejected(verified.reason);
    if (!Qri.validateDecodedParserInputAgainstReceipt(input.receipt,
      input.parserInput, options.authority)) return rejected("parser_input_mismatch");
    const parserBinding = Qri.validateParserResultAgainstReceipt(input.receipt,
      input.parserResult, options.authority);
    if (!parserBinding.accepted) return rejected(`parser_result_${parserBinding.reason}`);
    if (Qri.stable(input.parserResult.canonical) !== Qri.stable(input.cache?.canonical)) {
      return rejected("parser_result_cache_mismatch");
    }
    let historyCandidate;
    try { historyCandidate = await History.createHistoryCandidate(clone(input.cache)); }
    catch (_error) { return rejected("history_candidate_invalid"); }
    if (!historyCandidate.ok) return rejected(historyCandidate.reason || "history_candidate_invalid");
    const candidate = { ...historyCandidate.candidate,
      sourceEvidence: createBinding(input.receipt) };
    if (!History.validateFormalEvidenceBinding(candidate.sourceEvidence, candidate)) {
      return rejected("formal_evidence_invalid");
    }
    return freeze({ accepted: true, reason: null, candidate, diagnostics: {
      formalTransactionCount: 0, formalWriteCount: 0, retryCount: 0,
      vaultReadback: "verified", parserBinding: "verified"
    } });
  }

  async function persistFormalCandidate(input) {
    if (!exact(input, ["cache", "receipt", "parserInput", "parserResult", "confirmedAt"])) {
      return rejected("formal_binding_input_invalid");
    }
    const prepared = await prepareFormalCandidate({ cache: input.cache, receipt: input.receipt,
      parserInput: input.parserInput, parserResult: input.parserResult });
    if (!prepared.accepted) return prepared;
    let stored;
    try { stored = await options.historyStore.persistCandidate(prepared.candidate,
      { confirmedAt: input.confirmedAt }); }
    catch (_error) { return rejected("formal_persistence_failed"); }
    const unchanged = stored?.outcome === "same_version";
    if (!stored?.saved && !unchanged) return rejected(stored?.outcome || "formal_persistence_failed");
    return freeze({ accepted: true, reason: null, status: unchanged ? "unchanged" : "saved",
      outcome: stored.outcome, candidate: prepared.candidate, diagnostics: {
        formalTransactionCount: unchanged ? 0 : 1, formalWriteCount: unchanged ? 0 : 1,
        retryCount: 0, vaultReadback: "verified", parserBinding: "verified"
      } });
  }

  function resolveRevisionEvidence(revision) {
    if (!object(revision) || !Object.hasOwn(revision, "sourceEvidence")) {
      return freeze({ status: "unavailable", reason: "pre_activation", receipt: null,
        occurrence: null, rawBytes: null, parserInput: null });
    }
    if (!History.validateFormalEvidenceBinding(revision.sourceEvidence, revision)) {
      return freeze({ status: "invalid", reason: "formal_evidence_invalid", receipt: null,
        occurrence: null, rawBytes: null, parserInput: null });
    }
    const receipt = revision.sourceEvidence.receipt, verified = verifyReceiptVault(receipt);
    if (!verified.accepted) return freeze({ status: "invalid", reason: verified.reason,
      receipt: null, occurrence: null, rawBytes: null, parserInput: null });
    const parserInput = decodeRaw(verified.rawBytes, receipt.transportIdentity.encoding);
    if (parserInput === null || !Qri.validateDecodedParserInputAgainstReceipt(receipt,
      parserInput, options.authority)) return freeze({ status: "invalid",
      reason: "parser_input_mismatch", receipt: null, occurrence: null,
      rawBytes: null, parserInput: null });
    return freeze({ status: "available", reason: null, receipt: clone(receipt),
      occurrence: clone(verified.occurrence), rawBytes: Buffer.from(verified.rawBytes), parserInput });
  }

  return Object.freeze({ prepareFormalCandidate, persistFormalCandidate,
    resolveRevisionEvidence });
}

module.exports = Object.freeze({ BINDING_VERSION, createBinding,
  createQriFormalEvidenceBinding });
