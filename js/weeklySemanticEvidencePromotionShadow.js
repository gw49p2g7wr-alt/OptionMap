"use strict";

const Contract = require("./weeklySemanticEvidenceBinding.js");
const EvidenceSet = require("./weeklyEvidenceSetContract.js");
const FuturesHistory = require("./weeklyFuturesHistory.js");
const OptionsHistory = require("./weeklyOptionsHistory.js");
const WeeklyOptions = require("./weeklyOptions.js");
const Evidence = require("./sourceEvidence/sourceEvidenceContract.js");

const SHADOW_VERSION = "weekly-semantic-evidence-promotion-shadow-v1";
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

function outcome(status, reason, history, binding = null, diagnostics = {}) {
  return freeze({ contractVersion: SHADOW_VERSION, status, reason,
    history: history == null ? null : clone(history), binding: binding == null ? null : clone(binding),
    diagnostics: { semanticRevisionWriteCount: diagnostics.semanticRevisionWriteCount || 0,
      bindingWriteCount: diagnostics.bindingWriteCount || 0,
      rawWriteCount: 0, productionWriteCount: 0, historySchemaChanged: false,
      rawPayloadExposed: false, storageLocationExposed: false } });
}

async function validateOptionsRevision(revision, sourceDate) {
  if (!object(revision) || revision.signatureAlgorithm !== "sha256" ||
      revision.parserVersion !== WeeklyOptions.PARSER_VERSION ||
      revision.schemaVersion !== WeeklyOptions.SCHEMA_VERSION ||
      revision.canonical?.sourceDate !== sourceDate ||
      !WeeklyOptions.validateWeeklyOptionsData(revision.canonical)) return false;
  const signature = await WeeklyOptions.createSignature(revision.canonical);
  return revision.signature === signature && revision.versionKey ===
    `weekly-options-v2|${sourceDate}|sha256:${signature}`;
}

function createWeeklySemanticEvidencePromotionShadow(options = {}) {
  if (!exact(options, ["vault", "evidenceSetStore", "bindingStore", "authority"]) ||
      typeof options.vault?.verifyOccurrence !== "function" ||
      typeof options.vault?.verifyContent !== "function" ||
      typeof options.vault?.readOccurrence !== "function" ||
      typeof options.vault?.readContentMetadata !== "function" ||
      typeof options.evidenceSetStore?.read !== "function" ||
      typeof options.bindingStore?.store !== "function" ||
      typeof options.bindingStore?.readForRevision !== "function" ||
      typeof options.authority?.sign !== "function" || typeof options.authority?.verify !== "function")
    throw new TypeError("weekly_semantic_promotion_options_invalid");

  function readEvidenceSet(evidenceSetId) {
    const value = options.evidenceSetStore.read(evidenceSetId, options.authority);
    if (!value || !EvidenceSet.validateEvidenceSetAgainstVault(value, options.vault,
      options.authority)) throw new Error("weekly_evidence_set_invalid");
    return value;
  }

  async function merge(domainRole, history, candidate, confirmedAt) {
    if (domainRole === "weekly_futures_workbook") {
      const result = await FuturesHistory.mergeCandidates(history, [candidate], confirmedAt);
      return { result, semanticWriteCount: (result.added || 0) + (result.revised || 0),
        duplicate: result.outcome === "merged" && (result.repeated || 0) === 1 };
    }
    if (domainRole === "weekly_options_workbook") {
      const result = await OptionsHistory.mergeWeeklyOptionsHistory(history, candidate,
        { confirmedAt });
      return { result, semanticWriteCount: ["added", "revised"].includes(result.outcome) ? 1 : 0,
        duplicate: result.outcome === "same_version" };
    }
    throw new TypeError("weekly_semantic_domain_invalid");
  }

  async function promote(input = {}) {
    if (!exact(input, ["domainRole", "history", "candidate", "evidenceSetId", "confirmedAt"]) ||
        !Contract.DOMAIN[input.domainRole])
      return outcome("unavailable", "promotion_input_invalid", input.history || null);
    let evidenceSet;
    try { evidenceSet = readEvidenceSet(input.evidenceSetId); }
    catch (_error) { return outcome("unavailable", "evidence_set_invalid", input.history); }
    if (evidenceSet.domainRole !== input.domainRole)
      return outcome("unavailable", "evidence_domain_mismatch", input.history);
    if (!(await Contract.validateSemanticCandidate(input.candidate, evidenceSet, options.vault,
      options.authority)))
      return outcome("unavailable", "semantic_evidence_mismatch", input.history);

    const merged = await merge(input.domainRole, input.history, input.candidate,
      input.confirmedAt);
    if (merged.result.outcome === "invalid_history" ||
        !["merged", "added", "revised", "same_version"].includes(merged.result.outcome))
      return outcome("unavailable", `semantic_${merged.result.outcome}`, input.history);

    if (merged.semanticWriteCount === 0) {
      let existing = null;
      try {
        existing = options.bindingStore.readForRevision(input.domainRole,
          input.candidate.sourceDate, input.candidate.versionKey, options.authority);
        if (existing) {
          const priorSet = readEvidenceSet(existing.evidenceSetId);
          if (!Contract.validateBindingAgainstEvidence(existing, priorSet, options.vault,
            options.authority)) throw new Error("binding_invalid");
        }
      } catch (_error) {
        return outcome("unavailable", "existing_binding_invalid", input.history);
      }
      return outcome("available", existing ? "semantic_duplicate" : "pre_activation",
        merged.result.history, existing, { semanticRevisionWriteCount: 0,
          bindingWriteCount: 0 });
    }

    let binding, stored, readback;
    try {
      binding = Contract.createBinding({ domainRole: input.domainRole,
        candidate: input.candidate, evidenceSet, boundAt: input.confirmedAt }, options.authority);
      stored = options.bindingStore.store(binding, options.authority);
      readback = options.bindingStore.readForRevision(input.domainRole,
        input.candidate.sourceDate, input.candidate.versionKey, options.authority);
      if (!readback || Evidence.stable(readback) !== Evidence.stable(binding) ||
          !Contract.validateBindingAgainstEvidence(readback, evidenceSet, options.vault,
            options.authority)) throw new Error("binding_readback_invalid");
    } catch (_error) {
      return outcome("unavailable", "binding_persistence_failed", input.history);
    }
    return outcome("available", null, merged.result.history, readback,
      { semanticRevisionWriteCount: merged.semanticWriteCount,
        bindingWriteCount: stored.writeCount });
  }

  async function resolveRevision(input = {}) {
    if (!exact(input, ["domainRole", "sourceDate", "versionKey", "revision"]) ||
        !Contract.DOMAIN[input.domainRole])
      return freeze({ status: "unavailable", reason: "revision_identity_invalid",
        binding: null, evidenceSet: null, documents: [] });
    let binding;
    try { binding = options.bindingStore.readForRevision(input.domainRole, input.sourceDate,
      input.versionKey, options.authority); }
    catch (_error) { return freeze({ status: "unavailable", reason: "binding_invalid",
      binding: null, evidenceSet: null, documents: [] }); }
    if (!binding) return freeze({ status: "unavailable", reason: "pre_activation",
      binding: null, evidenceSet: null, documents: [] });
    let evidenceSet;
    try { evidenceSet = readEvidenceSet(binding.evidenceSetId); }
    catch (_error) { return freeze({ status: "unavailable", reason: "evidence_set_invalid",
      binding: null, evidenceSet: null, documents: [] }); }
    const revisionValidation = input.domainRole === "weekly_futures_workbook"
      ? await FuturesHistory.validateRevision(input.revision, input.sourceDate)
      : await validateOptionsRevision(input.revision, input.sourceDate);
    if (!revisionValidation || binding.semanticVersionKey !== input.versionKey ||
        binding.semanticSignature !== input.revision?.signature ||
        !Contract.validateBindingAgainstEvidence(binding, evidenceSet, options.vault,
          options.authority)) return freeze({ status: "unavailable",
      reason: "binding_revision_mismatch", binding: null, evidenceSet: null, documents: [] });
    const documents = [];
    try {
      for (const entry of evidenceSet.roles) {
        const occurrence = options.vault.readOccurrence(entry.occurrenceId),
          content = options.vault.readContentMetadata(entry.contentSha256);
        if (!occurrence || !content) throw new Error("evidence_metadata_missing");
        documents.push({ role: entry.role, occurrence, content });
      }
    } catch (_error) { return freeze({ status: "unavailable",
      reason: "evidence_metadata_invalid", binding: null, evidenceSet: null, documents: [] }); }
    return freeze({ status: "available", reason: null, binding: clone(binding),
      evidenceSet: clone(evidenceSet), documents: clone(documents) });
  }

  async function promoteDomains(input = {}) {
    if (!exact(input, ["futures", "options"])) throw new TypeError("weekly_domains_input_invalid");
    const futures = await promote({ ...input.futures,
      domainRole: "weekly_futures_workbook" }), optionsResult = await promote({ ...input.options,
      domainRole: "weekly_options_workbook" });
    return freeze({ futures, options: optionsResult });
  }

  return freeze({ promote, promoteDomains, resolveRevision });
}

module.exports = freeze({ SHADOW_VERSION, createWeeklySemanticEvidencePromotionShadow });
