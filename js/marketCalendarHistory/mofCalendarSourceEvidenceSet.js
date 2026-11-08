"use strict";

const Evidence = require("../sourceEvidence/sourceEvidenceContract.js");
const Source = require("../marketCalendarIsolated/mofJgbSource.js");
const Registry = require("../marketCalendar/sourceRegistry.js");

const CONTRACT_VERSION = "optionmap-mof-calendar-variable-evidence-set-v1";
const MANIFEST_VERSION = "optionmap-mof-calendar-discovery-manifest-v1";
const SOURCE_ID = Source.SOURCE_ID, MAX_MONTH_ROLES = 36;
const source = Registry.getSource(SOURCE_ID), HASH = /^[0-9a-f]{64}$/;
const SET_FIELDS = Object.freeze(["contractVersion", "sourceId", "acquisitionRunId",
  "manifest", "documents", "setSha256"]);
const MANIFEST_FIELDS = Object.freeze(["manifestVersion", "sourceId", "assessmentDateJst",
  "documents", "documentCount", "manifestSha256"]);
const MANIFEST_DOCUMENT_FIELDS = Object.freeze(["role", "url"]);
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
function manifestMaterial(value) {
  return { manifestVersion: value.manifestVersion, sourceId: value.sourceId,
    assessmentDateJst: value.assessmentDateJst, documents: clone(value.documents),
    documentCount: value.documentCount };
}
function setMaterial(value) {
  return { contractVersion: value.contractVersion, sourceId: value.sourceId,
    acquisitionRunId: value.acquisitionRunId, manifest: clone(value.manifest),
    documents: clone(value.documents) };
}
function expectedRole(url, index) {
  if (index === 0) return url === Source.INDEX_URL ? "index" : null;
  const month = Source.pageMonth(url);
  return month ? `month:${month}` : null;
}
function validateManifest(value) {
  if (!exact(value, MANIFEST_FIELDS) || value.manifestVersion !== MANIFEST_VERSION ||
      value.sourceId !== SOURCE_ID || !Source.validDate(value.assessmentDateJst) ||
      !Array.isArray(value.documents) || value.documents.length < 2 ||
      value.documents.length > MAX_MONTH_ROLES + 1 ||
      value.documentCount !== value.documents.length || !HASH.test(value.manifestSha256 || ""))
    return false;
  const roles = new Set(), urls = new Set();
  for (const [index, document] of value.documents.entries()) {
    if (!exact(document, MANIFEST_DOCUMENT_FIELDS) ||
        document.role !== expectedRole(document.url, index) || roles.has(document.role) ||
        urls.has(document.url) || !Source.validateUrl(document.url).valid) return false;
    roles.add(document.role); urls.add(document.url);
  }
  const monthRoles = value.documents.slice(1).map(document => document.role);
  if (monthRoles.some((role, index) => index > 0 && role <= monthRoles[index - 1])) return false;
  return value.manifestSha256 === Evidence.sha256Canonical(manifestMaterial(value));
}
function createManifest({ assessmentDateJst, documents } = {}) {
  const value = { manifestVersion: MANIFEST_VERSION, sourceId: SOURCE_ID,
    assessmentDateJst, documents: clone(documents), documentCount: documents?.length || 0,
    manifestSha256: "" };
  value.manifestSha256 = Evidence.sha256Canonical(manifestMaterial(value));
  if (!validateManifest(value)) throw new TypeError("mof_calendar_discovery_manifest_invalid");
  return freeze(value);
}
function validateDocument(value, manifestDocument) {
  return exact(value, DOCUMENT_FIELDS) && value.role === manifestDocument.role &&
    value.sourceUrl === manifestDocument.url && Number.isSafeInteger(value.byteLength) &&
    value.byteLength > 0 && value.byteLength <= Source.MAX_BYTES &&
    value.mediaType === "text/html" && value.encoding === "utf-8" &&
    Evidence.validateSourceEvidenceRef(value.evidenceRef) &&
    value.evidenceRef.state === "available" &&
    value.evidenceRef.sourceFamily === "market_calendar" &&
    value.evidenceRef.sourceId === SOURCE_ID && HASH.test(value.evidenceRef.contentSha256 || "");
}
function validateSourceEvidenceSet(value) {
  if (!exact(value, SET_FIELDS) || value.contractVersion !== CONTRACT_VERSION ||
      value.sourceId !== SOURCE_ID ||
      !/^mof-calendar-acquisition\|sha256:[0-9a-f]{64}$/.test(value.acquisitionRunId || "") ||
      !validateManifest(value.manifest) || !Array.isArray(value.documents) ||
      value.documents.length !== value.manifest.documents.length ||
      value.documents.some((document, index) =>
        !validateDocument(document, value.manifest.documents[index])) ||
      !HASH.test(value.setSha256 || "")) return false;
  return value.setSha256 === Evidence.sha256Canonical(setMaterial(value));
}
function createSourceEvidenceSet({ acquisitionRunId, assessmentDateJst, documents } = {}) {
  const manifestDocuments = Array.isArray(documents) ? documents.map(document =>
    ({ role: document.role, url: document.sourceUrl })) : [], manifest =
    createManifest({ assessmentDateJst, documents: manifestDocuments }), value = {
      contractVersion: CONTRACT_VERSION, sourceId: SOURCE_ID, acquisitionRunId,
      manifest, documents: clone(documents), setSha256: "" };
  value.setSha256 = Evidence.sha256Canonical(setMaterial(value));
  if (!validateSourceEvidenceSet(value))
    throw new TypeError("mof_calendar_source_evidence_set_invalid");
  return freeze(value);
}
function unavailable() {
  return freeze({ status: "unavailable", reason: "pre_activation",
    integrityStatus: "unavailable", sourceId: SOURCE_ID, acquisitionRunId: null,
    setSha256: null, manifest: null, documents: [], parserLineage: [] });
}
function invalid(reason, set = null) {
  return freeze({ status: "invalid", reason, integrityStatus: reason, sourceId: SOURCE_ID,
    acquisitionRunId: set?.acquisitionRunId || null, setSha256: set?.setSha256 || null,
    manifest: set?.manifest ? clone(set.manifest) : null, documents: [], parserLineage: [] });
}
function verifyDiscovery(set, vault, occurrences) {
  try {
    const raw = vault.readRawBytes(set.documents[0].evidenceRef.contentSha256), decoded =
      Source.decode(new Uint8Array(raw), `text/html; charset=${occurrences[0].encoding}`);
    if (!decoded.ok) return decoded.reason || "index_evidence_decode_failed";
    const discovery = Source.discoverMonths(decoded.text, set.manifest.assessmentDateJst);
    if (!discovery.ok || discovery.duplicateCount) return discovery.reason || "duplicate_month_role";
    const expected = [{ role: "index", url: Source.INDEX_URL }, ...discovery.months.map(value =>
      ({ role: `month:${value.month}`, url: value.url }))];
    return Evidence.sha256Canonical(expected) === Evidence.sha256Canonical(
      set.manifest.documents) ? null : "discovery_manifest_mismatch";
  } catch (error) {
    return error?.integrityStatus || error?.message || "discovery_evidence_invalid";
  }
}
function resolveRunEvidence({ run, vault } = {}) {
  if (!run || run.sourceId !== SOURCE_ID) return invalid("source_run_invalid");
  if (!Object.hasOwn(run, "sourceEvidenceSet")) return unavailable();
  const set = run.sourceEvidenceSet;
  if (!validateSourceEvidenceSet(set) || !vault ||
      typeof vault.verifyOccurrence !== "function" || typeof vault.readOccurrence !== "function" ||
      typeof vault.readRawBytes !== "function") return invalid("source_evidence_set_invalid", set);
  const documents = [], occurrences = [];
  try {
    for (const [index, document] of set.documents.entries()) {
      const verified = vault.verifyOccurrence(document.evidenceRef.occurrenceId);
      if (verified.status !== "valid") return invalid(verified.status, set);
      const occurrence = vault.readOccurrence(document.evidenceRef.occurrenceId), manifestDocument =
        set.manifest.documents[index];
      if (!occurrence || occurrence.sourceFamily !== "market_calendar" ||
          occurrence.sourceId !== SOURCE_ID || occurrence.runId !== set.acquisitionRunId ||
          occurrence.requestRole !== manifestDocument.role ||
          occurrence.sourceDocumentRole !== manifestDocument.role ||
          occurrence.initialUrl !== manifestDocument.url || occurrence.sourceUrl !== manifestDocument.url ||
          occurrence.httpStatus !== 200 || occurrence.mediaType !== document.mediaType ||
          occurrence.encoding !== document.encoding || occurrence.byteLength !== document.byteLength ||
          occurrence.contentSha256 !== document.evidenceRef.contentSha256)
        return invalid("occurrence_binding_mismatch", set);
      occurrences.push(occurrence); documents.push({ role: document.role,
        sourceUrl: document.sourceUrl, byteLength: document.byteLength,
        mediaType: document.mediaType, encoding: document.encoding,
        evidenceRef: clone(document.evidenceRef), fetchedAt: occurrence.fetchedAt,
        acquisitionContext: occurrence.acquisitionContext });
    }
    if (new Set(occurrences.map(value => value.fetchedAt)).size !== 1)
      return invalid("source_run_occurrence_mismatch", set);
  } catch (error) {
    return invalid(error?.integrityStatus || error?.message || "evidence_integrity_invalid", set);
  }
  const discoveryError = verifyDiscovery(set, vault, occurrences);
  if (discoveryError) return invalid(discoveryError, set);
  return freeze({ status: "available", reason: null, integrityStatus: "valid",
    sourceId: SOURCE_ID, acquisitionRunId: set.acquisitionRunId, setSha256: set.setSha256,
    manifest: clone(set.manifest), documents, parserLineage: [] });
}
function resolveRevisionEvidence({ snapshot, vault, revisionKey } = {}) {
  const revision = snapshot?.revisions?.find(value => value.revisionKey === revisionKey);
  if (!revision || revision.sourceId !== SOURCE_ID) return invalid("revision_not_found");
  const links = (snapshot.evidence || []).filter(value => value.sourceId === SOURCE_ID &&
    value.revisionKey === revisionKey && value.acceptedAt === revision.validFrom);
  if (links.length !== 1) return invalid("revision_run_link_ambiguous");
  const link = links[0], run = (snapshot.runs || []).find(value =>
    value.sourceId === SOURCE_ID && value.runId === link.runId);
  if (!run) return invalid("source_run_not_found");
  const resolved = resolveRunEvidence({ run, vault });
  if (resolved.status !== "available") return resolved;
  const matches = resolved.documents.filter(document =>
    document.sourceUrl === link.acquisitionEvidence?.sourceUrl &&
    document.evidenceRef.contentSha256 === link.acquisitionEvidence?.rawContentHash);
  if (matches.length !== 1) return invalid("revision_document_binding_mismatch", run.sourceEvidenceSet);
  const lineage = Evidence.createParserLineage({ evidenceRef: matches[0].evidenceRef,
    parserId: link.acquisitionEvidence.parserId || source.parserId,
    parserVersion: link.acquisitionEvidence.parserVersion || source.parserVersion,
    canonicalIdentity: { kind: "revision_key", value: revisionKey } });
  return freeze({ ...clone(resolved), parserLineage: [lineage], revisionKey,
    documentRole: matches[0].role });
}

module.exports = freeze({ SOURCE_ID, CONTRACT_VERSION, MANIFEST_VERSION, MAX_MONTH_ROLES,
  SET_FIELDS, MANIFEST_FIELDS, DOCUMENT_FIELDS, validateManifest, createManifest,
  validateSourceEvidenceSet, createSourceEvidenceSet, resolveRunEvidence,
  resolveRevisionEvidence });
