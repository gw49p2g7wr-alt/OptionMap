"use strict";

// R2-D2-R7 binds the fixed four-page BLS Calendar acquisition to the shared
// immutable Source Evidence Vault.  This contract stores references only;
// raw response bytes remain vault-owned and never enter Calendar IndexedDB.
const Route = require("../marketCalendarIsolated/blsFixedRoute.js");
const Evidence = require("../sourceEvidence/sourceEvidenceContract.js");

const CONTRACT_VERSION = "optionmap-calendar-source-evidence-set-v1";
const PARSER_ID = Route.shadowRegistry.getSource(Route.SOURCE_ID).parserId;
const HASH = /^[0-9a-f]{64}$/;
const RUN_ID = /^bls-calendar-acquisition\|sha256:[0-9a-f]{64}$/;
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
function validateDocument(value, route) {
  return exact(value, DOCUMENT_FIELDS) && value.role === route.role &&
    value.sourceUrl === route.url && Number.isSafeInteger(value.byteLength) &&
    value.byteLength > 0 && value.byteLength <= Route.MAX_BYTES &&
    value.mediaType === "text/html" && value.encoding === "utf-8" &&
    Evidence.validateSourceEvidenceRef(value.evidenceRef) &&
    value.evidenceRef.state === "available" &&
    value.evidenceRef.sourceFamily === "market_calendar" &&
    value.evidenceRef.sourceId === Route.SOURCE_ID &&
    value.evidenceRef.contentSha256 && HASH.test(value.evidenceRef.contentSha256);
}
function validateSourceEvidenceSet(value) {
  if (!exact(value, FIELDS) || value.contractVersion !== CONTRACT_VERSION ||
      value.sourceId !== Route.SOURCE_ID || !RUN_ID.test(value.acquisitionRunId || "") ||
      !Array.isArray(value.documents) || value.documents.length !== Route.ROLES.length ||
      !HASH.test(value.setSha256 || "")) return false;
  if (value.documents.some((document, index) =>
    !validateDocument(document, Route.ROLES[index]))) return false;
  return value.setSha256 === Evidence.sha256Canonical(material(value));
}
function createSourceEvidenceSet({ acquisitionRunId, documents } = {}) {
  const result = { contractVersion: CONTRACT_VERSION, sourceId: Route.SOURCE_ID,
    acquisitionRunId, documents: clone(documents), setSha256: "" };
  result.setSha256 = Evidence.sha256Canonical(material(result));
  if (!validateSourceEvidenceSet(result)) throw new TypeError("calendar_source_evidence_set_invalid");
  return freeze(result);
}
function unavailable(reason = "pre_activation") {
  return freeze({ status: "unavailable", reason, integrityStatus: "unavailable",
    sourceId: Route.SOURCE_ID, acquisitionRunId: null, setSha256: null,
    documents: [], parserLineage: [] });
}
function invalid(reason, set = null) {
  return freeze({ status: "invalid", reason, integrityStatus: reason,
    sourceId: Route.SOURCE_ID, acquisitionRunId: set?.acquisitionRunId || null,
    setSha256: set?.setSha256 || null, documents: [], parserLineage: [] });
}
function resolveRunEvidence({ run, vault } = {}) {
  if (!run || run.sourceId !== Route.SOURCE_ID) return invalid("source_run_invalid");
  if (!Object.hasOwn(run, "sourceEvidenceSet")) return unavailable("pre_activation");
  const set = run.sourceEvidenceSet;
  if (!validateSourceEvidenceSet(set) || !vault ||
      typeof vault.verifyOccurrence !== "function" || typeof vault.readOccurrence !== "function")
    return invalid("source_evidence_set_invalid", set);
  const documents = [];
  try {
    for (const [index, document] of set.documents.entries()) {
      const route = Route.ROLES[index], verified = vault.verifyOccurrence(
        document.evidenceRef.occurrenceId);
      if (verified.status !== "valid") return invalid(verified.status, set);
      const occurrence = vault.readOccurrence(document.evidenceRef.occurrenceId);
      if (!occurrence || occurrence.sourceFamily !== "market_calendar" ||
          occurrence.sourceId !== Route.SOURCE_ID || occurrence.runId !== set.acquisitionRunId ||
          occurrence.requestRole !== route.role || occurrence.sourceDocumentRole !== route.role ||
          occurrence.initialUrl !== route.url || occurrence.sourceUrl !== route.url ||
          occurrence.httpStatus !== 200 || occurrence.mediaType !== document.mediaType ||
          occurrence.encoding !== document.encoding || occurrence.byteLength !== document.byteLength ||
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
    sourceId: Route.SOURCE_ID, acquisitionRunId: set.acquisitionRunId,
    setSha256: set.setSha256, documents, parserLineage: [] });
}
function resolveRevisionEvidence({ snapshot, vault, revisionKey } = {}) {
  const revision = snapshot?.revisions?.find(value => value.revisionKey === revisionKey);
  if (!revision || revision.sourceId !== Route.SOURCE_ID) return invalid("revision_not_found");
  const links = (snapshot.evidence || []).filter(value => value.sourceId === Route.SOURCE_ID &&
    value.revisionKey === revisionKey && value.acceptedAt === revision.validFrom);
  if (links.length !== 1) return invalid("revision_run_link_ambiguous");
  const link = links[0], run = (snapshot.runs || []).find(value =>
    value.sourceId === Route.SOURCE_ID && value.runId === link.runId);
  if (!run) return invalid("source_run_not_found");
  const resolved = resolveRunEvidence({ run, vault });
  if (resolved.status !== "available") return resolved;
  const matches = resolved.documents.filter(document =>
    document.sourceUrl === link.acquisitionEvidence?.sourceUrl &&
    document.evidenceRef.contentSha256 === link.acquisitionEvidence?.rawContentHash);
  if (matches.length !== 1) return invalid("revision_document_binding_mismatch", run.sourceEvidenceSet);
  const lineage = Evidence.createParserLineage({ evidenceRef: matches[0].evidenceRef,
    parserId: link.acquisitionEvidence.parserId || PARSER_ID,
    parserVersion: link.acquisitionEvidence.parserVersion || Route.PARSER_VERSION,
    canonicalIdentity: { kind: "revision_key", value: revisionKey } });
  return freeze({ ...clone(resolved), parserLineage: [lineage],
    revisionKey, documentRole: matches[0].role });
}

module.exports = freeze({ CONTRACT_VERSION, PARSER_ID, FIELDS, DOCUMENT_FIELDS,
  validateSourceEvidenceSet, createSourceEvidenceSet, resolveRunEvidence,
  resolveRevisionEvidence });
