"use strict";

const History = require("./qriOptionsHistory.js");

const READER_VERSION = "qri-as-known-at-reader-v1";
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const contract = value => /^20\d{2}-(0[1-9]|1[0-2])$/.test(value || "");
const date = value => {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value || "")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
function timestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(20\d{2})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number),
    offsetHour = match[9] === undefined ? 0 : Number(match[9]),
    offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return false;
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day && Number.isFinite(Date.parse(value));
}
const clone = value => value == null ? value : structuredClone(value);

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function invalid(reason) {
  return freeze({ contractVersion: READER_VERSION, status: "invalid", reason,
    contract: null, tradingDate: null, knowledgeAt: null, revision: null,
    versionKey: null, validity: null, evidence: null });
}

function unavailable(reason, request) {
  return freeze({ contractVersion: READER_VERSION, status: "unavailable", reason,
    contract: request.contract, tradingDate: request.tradingDate,
    knowledgeAt: request.knowledgeAt, revision: null, versionKey: null,
    validity: null, evidence: null });
}

function evidenceState(revision) {
  if (!Object.hasOwn(revision, "sourceEvidence")) {
    return freeze({ status: "unavailable", reason: "pre_activation", receiptVersion: null,
      acquisitionId: null, occurrenceId: null, contentSha256: null, role: null });
  }
  if (!History.validateFormalEvidenceBinding(revision.sourceEvidence, revision)) return null;
  const receipt = revision.sourceEvidence.receipt;
  return freeze({ status: "available", reason: null, receiptVersion: receipt.contractVersion,
    acquisitionId: receipt.acquisitionId, occurrenceId: receipt.evidenceStatus.occurrenceId,
    contentSha256: receipt.evidenceStatus.contentSha256, role: receipt.role });
}

async function validateKnowledgeHistory(history) {
  const base = await History.validateHistory(history);
  if (!base.valid) return freeze({ valid: false, reason: "history_invalid", errors: base.errors });
  const errors = [];
  for (const entry of history.entries) {
    const revisions = entry.revisions;
    for (let index = 0; index < revisions.length; index += 1) {
      const revision = revisions[index], next = revisions[index + 1] || null;
      if (!timestamp(revision.confirmedAt)) {
        errors.push(`${entry.entryKey}:confirmed_at_invalid`); continue;
      }
      if (revision.replacedAt !== null && !timestamp(revision.replacedAt)) {
        errors.push(`${entry.entryKey}:replaced_at_invalid`); continue;
      }
      const from = Date.parse(revision.confirmedAt), to = revision.replacedAt === null
        ? null : Date.parse(revision.replacedAt);
      if (to !== null && to <= from) errors.push(`${entry.entryKey}:interval_order_invalid`);
      if (next) {
        if (!timestamp(next.confirmedAt)) errors.push(`${entry.entryKey}:confirmed_at_invalid`);
        else {
          const nextFrom = Date.parse(next.confirmedAt);
          if (nextFrom <= from) errors.push(`${entry.entryKey}:revision_order_invalid`);
          if (to === null || to !== nextFrom) errors.push(`${entry.entryKey}:replacement_chain_invalid`);
        }
      } else if (revision.versionKey !== entry.activeVersionKey || revision.replacedAt !== null) {
        errors.push(`${entry.entryKey}:active_interval_invalid`);
      }
      if (evidenceState(revision) === null) errors.push(`${entry.entryKey}:evidence_invalid`);
    }
  }
  return freeze({ valid: errors.length === 0,
    reason: errors.length ? "knowledge_intervals_invalid" : null, errors });
}

async function getQriRevisionAsKnownAt(input) {
  if (!exact(input, ["history", "contract", "tradingDate", "knowledgeAt"]) ||
      !contract(input.contract) || !date(input.tradingDate) || !timestamp(input.knowledgeAt)) {
    return invalid("request_invalid");
  }
  const validation = await validateKnowledgeHistory(input.history);
  if (!validation.valid) return invalid(validation.reason);
  const request = { contract: input.contract, tradingDate: input.tradingDate,
    knowledgeAt: input.knowledgeAt };
  const entry = input.history.entries.find(item => item.entryKey ===
    History.entryKeyFor(input.contract, input.tradingDate));
  if (!entry) return unavailable("entry_not_found", request);
  const instant = Date.parse(input.knowledgeAt);
  const revision = entry.revisions.find(item => Date.parse(item.confirmedAt) <= instant &&
    (item.replacedAt === null || instant < Date.parse(item.replacedAt)));
  if (!revision) return unavailable("not_known_yet", request);
  const evidence = evidenceState(revision);
  if (evidence === null) return invalid("evidence_invalid");
  return freeze({ contractVersion: READER_VERSION, status: "available", reason: null,
    contract: input.contract, tradingDate: input.tradingDate, knowledgeAt: input.knowledgeAt,
    revision: clone(revision), versionKey: revision.versionKey,
    validity: { validFrom: revision.confirmedAt, validTo: revision.replacedAt }, evidence });
}

function createQriAsKnownAtReader(options) {
  if (!exact(options, ["historyStore"]) ||
      typeof options.historyStore?.loadHistory !== "function") {
    throw new TypeError("qri_as_known_at_reader_options_invalid");
  }
  async function get(input) {
    if (!exact(input, ["contract", "tradingDate", "knowledgeAt"])) return invalid("request_invalid");
    let loaded;
    try { loaded = await options.historyStore.loadHistory(); }
    catch (_error) { return invalid("history_read_failed"); }
    if (!loaded || !["empty", "ready"].includes(loaded.status)) return invalid("history_invalid");
    return getQriRevisionAsKnownAt({ history: loaded.history, ...input });
  }
  return Object.freeze({ getQriRevisionAsKnownAt: get });
}

function auditRevisionEvidence(revision, evidenceResolver) {
  if (!object(revision)) return freeze({ status: "invalid", reason: "revision_invalid" });
  if (!Object.hasOwn(revision, "sourceEvidence")) {
    return freeze({ status: "unavailable", reason: "pre_activation" });
  }
  if (typeof evidenceResolver?.resolveRevisionEvidence !== "function") {
    return freeze({ status: "unavailable", reason: "audit_resolver_unavailable" });
  }
  const result = evidenceResolver.resolveRevisionEvidence(clone(revision));
  return freeze({ status: result.status, reason: result.reason });
}

module.exports = Object.freeze({ READER_VERSION, validateKnowledgeHistory,
  getQriRevisionAsKnownAt, createQriAsKnownAtReader, auditRevisionEvidence });
