"use strict";

const Authority = require("./weeklyAcquisitionAuthorityContract.js");
const EvidenceSet = require("./weeklyEvidenceSetContract.js");
const WeeklyFutures = require("./weeklyFutures.js");
const WeeklyOptions = require("./weeklyOptions.js");

const CONTRACT_VERSION = "weekly-semantic-evidence-binding-v1";
const DOMAIN = Object.freeze({
  weekly_futures_workbook: Object.freeze({
    bindingPrefix: "weekly-futures-semantic-evidence-v1",
    signatureKind: "weekly_futures_semantic_evidence_binding",
    sourceId: Authority.ROLE_AUTHORITY.weekly_futures_workbook.sourceId
  }),
  weekly_options_workbook: Object.freeze({
    bindingPrefix: "weekly-options-semantic-evidence-v1",
    signatureKind: "weekly_options_semantic_evidence_binding",
    sourceId: Authority.ROLE_AUTHORITY.weekly_options_workbook.sourceId
  })
});

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const identity = (value, prefix) => typeof value === "string" &&
  new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|sha256:[0-9a-f]{64}$`)
    .test(value);
const isoTime = value => typeof value === "string" && /^20\d{2}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value));
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value) || ArrayBuffer.isView(value))
    return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function semanticCanonical(domainRole, candidate) {
  if (domainRole === "weekly_futures_workbook") return candidate?.data || null;
  if (domainRole === "weekly_options_workbook") return candidate?.canonical || null;
  return null;
}

function semanticSignature(domainRole, candidate) {
  if (domainRole === "weekly_futures_workbook") return WeeklyFutures.createSignature(candidate.data);
  if (domainRole === "weekly_options_workbook") return WeeklyOptions.createSignature(candidate.canonical);
  throw new TypeError("weekly_semantic_domain_invalid");
}

function expectedVersionKey(domainRole, sourceDate, signature) {
  const prefix = domainRole === "weekly_futures_workbook" ? "weekly-futures-v2" :
    domainRole === "weekly_options_workbook" ? "weekly-options-v2" : null;
  return prefix && Authority.sourceDate(sourceDate) && digest(signature)
    ? `${prefix}|${sourceDate}|sha256:${signature}` : null;
}

function parserLineage(domainRole) {
  return clone(Authority.PARSER_AUTHORITIES[domainRole] || null);
}

async function validateSemanticCandidate(candidate, evidenceSet, vault, authority) {
  const role = evidenceSet?.domainRole, domain = DOMAIN[role], canonical =
    semanticCanonical(role, candidate), workbook = evidenceSet?.roles?.[1];
  if (!domain || !EvidenceSet.validateEvidenceSetAgainstVault(evidenceSet, vault, authority) ||
      evidenceSet.sourceId !== domain.sourceId || !object(candidate) ||
      candidate.sourceDate !== evidenceSet.sourceDate || candidate.sourceUrl !==
        Authority.canonicalWorkbookUrl(role, evidenceSet.sourceDate) ||
      !workbook || workbook.role !== role || workbook.publishedDate === null) return false;
  const validCanonical = role === "weekly_futures_workbook"
    ? WeeklyFutures.validateWeeklyFuturesData(canonical)
    : WeeklyOptions.validateWeeklyOptionsData(canonical);
  if (!validCanonical || role === "weekly_options_workbook" &&
      canonical.sourceDate !== evidenceSet.sourceDate) return false;
  const signature = await semanticSignature(role, candidate), expectedKey =
    expectedVersionKey(role, evidenceSet.sourceDate, signature), preview = {
      sourceDate: evidenceSet.sourceDate, publishedDate: workbook.publishedDate,
      canonical, canonicalSha256: Authority.sha256(canonical),
      parserAuthority: parserLineage(role)
    };
  return candidate.signature === signature && candidate.versionKey === expectedKey &&
    workbook.parserPreviewSha256 === Authority.sha256(preview);
}

const FIELDS = Object.freeze(["contractVersion", "bindingId", "sourceFamily", "sourceId",
  "domainRole", "sourceDate", "semanticVersionKey", "semanticSignature", "evidenceSetId",
  "evidenceSetHash", "runId", "parserLineage", "boundAt", "authorityKeyId", "bindingHash",
  "authoritySignature"]);

function material(value) {
  return Object.fromEntries(FIELDS.filter(field =>
    !["bindingId", "bindingHash", "authoritySignature"].includes(field))
    .map(field => [field, clone(value[field])]));
}

function validateBinding(value, authority) {
  const domain = DOMAIN[value?.domainRole];
  if (!domain || !exact(value, FIELDS) || value.contractVersion !== CONTRACT_VERSION ||
      !identity(value.bindingId, domain.bindingPrefix) ||
      value.sourceFamily !== Authority.SOURCE_FAMILY || value.sourceId !== domain.sourceId ||
      !Authority.sourceDate(value.sourceDate) || typeof value.semanticVersionKey !== "string" ||
      value.semanticVersionKey.length > 192 || !digest(value.semanticSignature) ||
      !identity(value.evidenceSetId, EvidenceSet.DOMAIN[value.domainRole].setIdPrefix) ||
      !digest(value.evidenceSetHash) || !identity(value.runId, "weekly-run-v1") ||
      Authority.stable(value.parserLineage) !==
        Authority.stable(Authority.PARSER_AUTHORITIES[value.domainRole]) ||
      !isoTime(value.boundAt) || value.authorityKeyId !== authority?.keyId ||
      typeof authority?.verify !== "function" || !digest(value.bindingHash) ||
      !digest(value.authoritySignature)) return false;
  const hash = Authority.sha256(material(value));
  return value.bindingHash === hash &&
    value.bindingId === `${domain.bindingPrefix}|sha256:${hash}` &&
    value.semanticVersionKey === expectedVersionKey(value.domainRole, value.sourceDate,
      value.semanticSignature) &&
    authority.verify(domain.signatureKind, hash, value.authoritySignature);
}

function createBinding({ domainRole, candidate, evidenceSet, boundAt } = {}, authority) {
  const domain = DOMAIN[domainRole];
  if (!domain || !EvidenceSet.validateEvidenceSet(evidenceSet, authority) ||
      evidenceSet.domainRole !== domainRole || evidenceSet.sourceId !== domain.sourceId ||
      !isoTime(boundAt) ||
      candidate?.sourceDate !== evidenceSet.sourceDate || candidate?.versionKey !==
        expectedVersionKey(domainRole, candidate.sourceDate, candidate.signature))
    throw new TypeError("weekly_semantic_binding_input_invalid");
  const result = { contractVersion: CONTRACT_VERSION, bindingId: "",
    sourceFamily: Authority.SOURCE_FAMILY, sourceId: domain.sourceId, domainRole,
    sourceDate: candidate.sourceDate, semanticVersionKey: candidate.versionKey,
    semanticSignature: candidate.signature, evidenceSetId: evidenceSet.evidenceSetId,
    evidenceSetHash: evidenceSet.setHash, runId: evidenceSet.runId,
    parserLineage: parserLineage(domainRole), boundAt, authorityKeyId: authority.keyId,
    bindingHash: "", authoritySignature: "" };
  result.bindingHash = Authority.sha256(material(result));
  result.bindingId = `${domain.bindingPrefix}|sha256:${result.bindingHash}`;
  result.authoritySignature = authority.sign(domain.signatureKind, result.bindingHash);
  if (!validateBinding(result, authority)) throw new TypeError("weekly_semantic_binding_invalid");
  return freeze(result);
}

function validateBindingAgainstEvidence(binding, evidenceSet, vault, authority) {
  return validateBinding(binding, authority) &&
    EvidenceSet.validateEvidenceSetAgainstVault(evidenceSet, vault, authority) &&
    binding.evidenceSetId === evidenceSet.evidenceSetId &&
    binding.evidenceSetHash === evidenceSet.setHash && binding.runId === evidenceSet.runId &&
    binding.sourceId === evidenceSet.sourceId && binding.sourceDate === evidenceSet.sourceDate &&
    binding.domainRole === evidenceSet.domainRole;
}

function revisionIdentity(domainRole, sourceDate, versionKey) {
  if (!DOMAIN[domainRole] || !Authority.sourceDate(sourceDate) ||
      typeof versionKey !== "string" || versionKey.length === 0 || versionKey.length > 192)
    throw new TypeError("weekly_semantic_revision_identity_invalid");
  return Authority.sha256({ domainRole, sourceDate, versionKey });
}

module.exports = freeze({ CONTRACT_VERSION, DOMAIN, FIELDS, semanticCanonical,
  expectedVersionKey, parserLineage, validateSemanticCandidate, createBinding,
  validateBinding, validateBindingAgainstEvidence, revisionIdentity });
