"use strict";

// Exact, policy-owned Calendar evidence-set mechanics shared by the BLS
// multi-document wrapper and fixed single-document Calendar sources.  This
// module knows no routes itself and cannot acquire, persist, or write Calendar
// state.
const Evidence = require("../sourceEvidence/sourceEvidenceContract.js");

const CONTRACT_VERSION = "optionmap-calendar-source-evidence-set-v1";
const HASH = /^[0-9a-f]{64}$/;
const FIELDS = Object.freeze(["contractVersion", "sourceId", "acquisitionRunId",
  "documents", "setSha256"]);
const DOCUMENT_FIELDS = Object.freeze(["role", "sourceUrl", "byteLength", "mediaType",
  "encoding", "evidenceRef"]);
const clone = value => value == null ? value : structuredClone(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function material(value) {
  return { contractVersion: value.contractVersion, sourceId: value.sourceId,
    acquisitionRunId: value.acquisitionRunId, documents: clone(value.documents) };
}
function validateConfiguration(value) {
  if (!exact(value, ["sourceId", "parserId", "parserVersion", "runIdPattern", "documents"]) ||
      typeof value.sourceId !== "string" || typeof value.parserId !== "string" ||
      !Number.isSafeInteger(value.parserVersion) || value.parserVersion < 1 ||
      !(value.runIdPattern instanceof RegExp) || !Array.isArray(value.documents) ||
      value.documents.length < 1) return false;
  const roles = new Set();
  return value.documents.every(document => {
    if (!exact(document, ["role", "initialUrl", "sourceUrls", "maxBytes", "mediaTypes",
      "encodings"]) || typeof document.role !== "string" || roles.has(document.role) ||
      typeof document.initialUrl !== "string" || !Array.isArray(document.sourceUrls) ||
      !document.sourceUrls.length || !document.sourceUrls.includes(document.initialUrl) ||
      !Number.isSafeInteger(document.maxBytes) || document.maxBytes < 1 ||
      !Array.isArray(document.mediaTypes) || !document.mediaTypes.length ||
      !Array.isArray(document.encodings) || !document.encodings.length) return false;
    roles.add(document.role); return true;
  });
}
function createExactDocumentSetContract(configuration) {
  if (!validateConfiguration(configuration)) throw new TypeError("calendar_evidence_policy_invalid");
  const policy = freeze(clone({ ...configuration,
    runIdPattern: { source: configuration.runIdPattern.source,
      flags: configuration.runIdPattern.flags } }));
  const runIdPattern = new RegExp(policy.runIdPattern.source, policy.runIdPattern.flags);
  function validateDocument(value, documentPolicy) {
    return exact(value, DOCUMENT_FIELDS) && value.role === documentPolicy.role &&
      documentPolicy.sourceUrls.includes(value.sourceUrl) &&
      Number.isSafeInteger(value.byteLength) && value.byteLength > 0 &&
      value.byteLength <= documentPolicy.maxBytes &&
      documentPolicy.mediaTypes.includes(value.mediaType) &&
      documentPolicy.encodings.includes(value.encoding) &&
      Evidence.validateSourceEvidenceRef(value.evidenceRef) &&
      value.evidenceRef.state === "available" &&
      value.evidenceRef.sourceFamily === "market_calendar" &&
      value.evidenceRef.sourceId === policy.sourceId &&
      HASH.test(value.evidenceRef.contentSha256 || "");
  }
  function validateSourceEvidenceSet(value) {
    if (!exact(value, FIELDS) || value.contractVersion !== CONTRACT_VERSION ||
        value.sourceId !== policy.sourceId || !runIdPattern.test(value.acquisitionRunId || "") ||
        !Array.isArray(value.documents) || value.documents.length !== policy.documents.length ||
        !HASH.test(value.setSha256 || "")) return false;
    if (value.documents.some((document, index) =>
      !validateDocument(document, policy.documents[index]))) return false;
    return value.setSha256 === Evidence.sha256Canonical(material(value));
  }
  function createSourceEvidenceSet({ acquisitionRunId, documents } = {}) {
    const result = { contractVersion: CONTRACT_VERSION, sourceId: policy.sourceId,
      acquisitionRunId, documents: clone(documents), setSha256: "" };
    result.setSha256 = Evidence.sha256Canonical(material(result));
    if (!validateSourceEvidenceSet(result)) throw new TypeError("calendar_source_evidence_set_invalid");
    return freeze(result);
  }
  function unavailable(reason = "pre_activation") {
    return freeze({ status: "unavailable", reason, integrityStatus: "unavailable",
      sourceId: policy.sourceId, acquisitionRunId: null, setSha256: null,
      documents: [], parserLineage: [] });
  }
  function invalid(reason, set = null) {
    return freeze({ status: "invalid", reason, integrityStatus: reason,
      sourceId: policy.sourceId, acquisitionRunId: set?.acquisitionRunId || null,
      setSha256: set?.setSha256 || null, documents: [], parserLineage: [] });
  }
  function resolveRunEvidence({ run, vault } = {}) {
    if (!run || run.sourceId !== policy.sourceId) return invalid("source_run_invalid");
    if (!Object.hasOwn(run, "sourceEvidenceSet")) return unavailable("pre_activation");
    const set = run.sourceEvidenceSet;
    if (!validateSourceEvidenceSet(set) || !vault ||
        typeof vault.verifyOccurrence !== "function" || typeof vault.readOccurrence !== "function")
      return invalid("source_evidence_set_invalid", set);
    const documents = [];
    try {
      for (const [index, document] of set.documents.entries()) {
        const documentPolicy = policy.documents[index], verified = vault.verifyOccurrence(
          document.evidenceRef.occurrenceId);
        if (verified.status !== "valid") return invalid(verified.status, set);
        const occurrence = vault.readOccurrence(document.evidenceRef.occurrenceId);
        if (!occurrence || occurrence.sourceFamily !== "market_calendar" ||
            occurrence.sourceId !== policy.sourceId || occurrence.runId !== set.acquisitionRunId ||
            occurrence.requestRole !== documentPolicy.role ||
            occurrence.sourceDocumentRole !== documentPolicy.role ||
            occurrence.initialUrl !== documentPolicy.initialUrl ||
            !documentPolicy.sourceUrls.includes(occurrence.sourceUrl) ||
            occurrence.sourceUrl !== document.sourceUrl || occurrence.httpStatus !== 200 ||
            occurrence.mediaType !== document.mediaType || occurrence.encoding !== document.encoding ||
            occurrence.byteLength !== document.byteLength ||
            occurrence.contentSha256 !== document.evidenceRef.contentSha256)
          return invalid("occurrence_binding_mismatch", set);
        documents.push({ role: document.role, sourceUrl: document.sourceUrl,
          byteLength: document.byteLength, mediaType: document.mediaType,
          encoding: document.encoding, evidenceRef: clone(document.evidenceRef),
          fetchedAt: occurrence.fetchedAt, acquisitionContext: occurrence.acquisitionContext });
      }
    } catch (error) {
      return invalid(error?.integrityStatus || error?.message || "evidence_integrity_invalid", set);
    }
    return freeze({ status: "available", reason: null, integrityStatus: "valid",
      sourceId: policy.sourceId, acquisitionRunId: set.acquisitionRunId,
      setSha256: set.setSha256, documents, parserLineage: [] });
  }
  function resolveRevisionEvidence({ snapshot, vault, revisionKey } = {}) {
    const revision = snapshot?.revisions?.find(value => value.revisionKey === revisionKey);
    if (!revision || revision.sourceId !== policy.sourceId) return invalid("revision_not_found");
    const links = (snapshot.evidence || []).filter(value => value.sourceId === policy.sourceId &&
      value.revisionKey === revisionKey && value.acceptedAt === revision.validFrom);
    if (links.length !== 1) return invalid("revision_run_link_ambiguous");
    const link = links[0], run = (snapshot.runs || []).find(value =>
      value.sourceId === policy.sourceId && value.runId === link.runId);
    if (!run) return invalid("source_run_not_found");
    const resolved = resolveRunEvidence({ run, vault });
    if (resolved.status !== "available") return resolved;
    const matches = resolved.documents.filter(document =>
      document.sourceUrl === link.acquisitionEvidence?.sourceUrl &&
      document.evidenceRef.contentSha256 === link.acquisitionEvidence?.rawContentHash);
    if (matches.length !== 1) return invalid("revision_document_binding_mismatch", run.sourceEvidenceSet);
    const lineage = Evidence.createParserLineage({ evidenceRef: matches[0].evidenceRef,
      parserId: link.acquisitionEvidence.parserId || policy.parserId,
      parserVersion: link.acquisitionEvidence.parserVersion || policy.parserVersion,
      canonicalIdentity: { kind: "revision_key", value: revisionKey } });
    return freeze({ ...clone(resolved), parserLineage: [lineage],
      revisionKey, documentRole: matches[0].role });
  }
  return freeze({ contractVersion: CONTRACT_VERSION, policy,
    validateSourceEvidenceSet, createSourceEvidenceSet, resolveRunEvidence,
    resolveRevisionEvidence });
}

module.exports = freeze({ CONTRACT_VERSION, FIELDS, DOCUMENT_FIELDS,
  createExactDocumentSetContract });
