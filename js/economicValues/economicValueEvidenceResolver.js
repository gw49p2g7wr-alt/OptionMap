"use strict";

const Canonical = require("./economicValueCanonical.js");
const Evidence = require("../sourceEvidence/sourceEvidenceContract.js");

function fail(reason) { throw new Error(reason); }
function invalid(reason) {
  return Canonical.freeze({ status: "invalid", diagnostic: "evidence_invalid", reason,
    evidenceRef: null, occurrence: null, integrityStatus: reason, parserLineage: [] });
}
function unavailablePreActivation(sourceId) {
  return Evidence.createSourceEvidenceRef({ state: "unavailable", sourceFamily: "economic_values",
    sourceId, reason: "pre_activation" });
}

function resolveSourceDocument({ snapshot, vault, sourceId, sourceDocumentKey,
    expectedEncoding, validateSourceUrl } = {}) {
  if (!snapshot || !Array.isArray(snapshot.documents) || !vault ||
      typeof vault.verifyOccurrence !== "function" || typeof sourceId !== "string" ||
      typeof sourceDocumentKey !== "string" || typeof expectedEncoding !== "function" ||
      typeof validateSourceUrl !== "function") fail("economic_evidence_reader_input_invalid");
  const document = snapshot.documents.find(value => value.sourceDocumentKey === sourceDocumentKey);
  if (!document || document.sourceId !== sourceId) return invalid("source_document_missing");
  const release = snapshot.releases.find(value =>
    value.releaseOccurrenceKey === document.releaseOccurrenceKey);
  if (!Object.hasOwn(document, "sourceEvidence")) return Canonical.freeze({ status: "unavailable",
    diagnostic: "evidence_unavailable_pre_activation", reason: "pre_activation",
    evidenceRef: unavailablePreActivation(sourceId), occurrence: null,
    integrityStatus: "unavailable", parserLineage: [] });
  const reference = document.sourceEvidence, encoding = expectedEncoding(document);
  if (!Evidence.validateSourceEvidenceRef(reference) || reference.state !== "available" ||
      reference.sourceFamily !== "economic_values" || reference.sourceId !== sourceId ||
      reference.contentSha256 !== document.rawContentHash || !encoding ||
      validateSourceUrl(document.sourceUrl, document, release) !== document.sourceUrl ||
      validateSourceUrl(document.finalUrl, document, release) !== document.finalUrl)
    return invalid("evidence_ref_invalid");
  let verified, occurrence;
  try {
    verified = vault.verifyOccurrence(reference.occurrenceId);
    if (verified.status !== "valid") return invalid(verified.status);
    occurrence = vault.readOccurrence(reference.occurrenceId);
  } catch (_error) { return invalid("vault_read_failed"); }
  if (!occurrence || occurrence.contentSha256 !== document.rawContentHash ||
      occurrence.byteLength !== document.byteCount || occurrence.sourceFamily !== "economic_values" ||
      occurrence.sourceId !== sourceId || occurrence.mediaType !== document.mime ||
      occurrence.encoding !== encoding || occurrence.initialUrl !== document.sourceUrl ||
      occurrence.sourceUrl !== document.finalUrl) return invalid("source_identity_mismatch");
  const evidenceRecords = snapshot.evidence.filter(value => value.sourceDocumentKey === sourceDocumentKey);
  if (!release || evidenceRecords.length === 0 || evidenceRecords.some(value =>
    value.releaseOccurrenceKey !== release.releaseOccurrenceKey || value.sourceId !== sourceId ||
    value.rawContentHash !== document.rawContentHash || value.parserId !== document.parserId ||
    value.parserVersion !== document.parserVersion ||
    Canonical.stable(value.sourceEvidence) !== Canonical.stable(reference)))
    return invalid("formal_lineage_mismatch");
  let parserLineage;
  try {
    parserLineage = evidenceRecords.map(value => Evidence.createParserLineage({ evidenceRef: reference,
      parserId: value.parserId, parserVersion: value.parserVersion,
      canonicalIdentity: { kind: "revision_key", value: value.revisionKey } }));
  } catch (_error) { return invalid("parser_lineage_invalid"); }
  return Canonical.freeze({ status: "available", diagnostic: "evidence_saved", reason: null,
    evidenceRef: Canonical.clone(reference), occurrence: Canonical.clone(occurrence),
    integrityStatus: "valid", parserLineage });
}

function resolveRevision({ snapshot, vault, sourceId, seriesDefinitionKeys, revisionKey,
    expectedEncoding, validateSourceUrl } = {}) {
  if (!snapshot || !Array.isArray(snapshot.revisions) || !Array.isArray(seriesDefinitionKeys) ||
      typeof revisionKey !== "string") fail("economic_revision_evidence_input_invalid");
  const revision = snapshot.revisions.find(value => value.revisionKey === revisionKey),
    series = new Set(seriesDefinitionKeys);
  if (!revision || !series.has(revision.seriesDefinitionKey))
    return Canonical.freeze({ ...invalid("revision_missing"), revision: null, release: null,
      sourceDocument: null });
  const matches = snapshot.evidence.filter(value => value.revisionKey === revisionKey &&
    value.sourceId === sourceId && value.releaseOccurrenceKey === revision.releaseOccurrenceKey &&
    value.acceptedAt === revision.validFrom);
  if (matches.length !== 1) return Canonical.freeze({ ...invalid("revision_lineage_ambiguous"),
    revision: Canonical.clone(revision), release: null, sourceDocument: null });
  const evidence = matches[0], release = snapshot.releases.find(value =>
    value.releaseOccurrenceKey === evidence.releaseOccurrenceKey), sourceDocument = snapshot.documents.find(value =>
    value.sourceDocumentKey === evidence.sourceDocumentKey), resolved = resolveSourceDocument({ snapshot, vault,
      sourceId, sourceDocumentKey: evidence.sourceDocumentKey, expectedEncoding, validateSourceUrl });
  if (!release || !sourceDocument) return Canonical.freeze({ ...invalid("revision_lineage_mismatch"),
    revision: Canonical.clone(revision), release: release ? Canonical.clone(release) : null,
    sourceDocument: sourceDocument ? Canonical.clone(sourceDocument) : null });
  if (resolved.status !== "available") return Canonical.freeze({ ...resolved,
    revision: Canonical.clone(revision), release: Canonical.clone(release),
    sourceDocument: Canonical.clone(sourceDocument) });
  if (!resolved.parserLineage.some(value => value.canonicalIdentity.value === revisionKey))
    return Canonical.freeze({ ...invalid("revision_lineage_mismatch"), revision: Canonical.clone(revision),
      release: Canonical.clone(release), sourceDocument: Canonical.clone(sourceDocument) });
  return Canonical.freeze({ ...resolved, revision: Canonical.clone(revision),
    release: Canonical.clone(release), sourceDocument: Canonical.clone(sourceDocument) });
}

module.exports = Canonical.freeze({ resolveSourceDocument, resolveRevision });
