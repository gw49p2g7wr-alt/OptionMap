"use strict";

const Core = require("./calendarEvidenceSetCore.js");
const Registry = require("../marketCalendar/sourceRegistry.js");
const Network = require("../marketCalendarRuntime/calendarNetworkPolicy.js");
const Parsers = require("../marketCalendarShadow/representativeParsers.js");

const SOURCE_ID = "jp-jpx-derivatives-calendar";
const source = Registry.getSource(SOURCE_ID), routes = Network.getPolicy(SOURCE_ID).documents;
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function invalid(reason, set = null) {
  return freeze({ status: "invalid", reason, integrityStatus: reason, sourceId: SOURCE_ID,
    acquisitionRunId: set?.acquisitionRunId || null, setSha256: set?.setSha256 || null,
    documents: [], parserLineage: [] });
}
function unavailable() {
  return freeze({ status: "unavailable", reason: "pre_activation",
    integrityStatus: "unavailable", sourceId: SOURCE_ID, acquisitionRunId: null,
    setSha256: null, documents: [], parserLineage: [] });
}
function documentShape(documents) {
  return Array.isArray(documents) && documents.length === 2 &&
    documents[0]?.role === "landing" && documents[1]?.role === "workbook";
}
function contractFor(documents, workbookInitialUrl = documents?.[1]?.sourceUrl) {
  if (!documentShape(documents)) return null;
  const landingSourceUrl = documents[0].sourceUrl, workbookSourceUrl = documents[1].sourceUrl;
  if (!Network.validateUrl(SOURCE_ID, routes[0], landingSourceUrl).valid ||
      !Network.validateUrl(SOURCE_ID, routes[1], workbookInitialUrl).valid ||
      !Network.validateUrl(SOURCE_ID, routes[1], workbookSourceUrl).valid) return null;
  return Core.createExactDocumentSetContract({ sourceId: SOURCE_ID,
    parserId: source.parserId, parserVersion: source.parserVersion,
    runIdPattern: /^jpx-derivatives-calendar-acquisition\|sha256:[0-9a-f]{64}$/,
    documents: [{ role: "landing", initialUrl: routes[0].url,
      sourceUrls: [landingSourceUrl], maxBytes: routes[0].maxBytes,
      mediaTypes: routes[0].allowedMime, encodings: ["utf-8", "windows-1252"] },
    { role: "workbook", initialUrl: workbookInitialUrl,
      sourceUrls: [workbookSourceUrl], maxBytes: routes[1].maxBytes,
      mediaTypes: routes[1].allowedMime, encodings: [null] }] });
}
function discoverWorkbookAuthority(bytes, encoding, fetchedAt, baseUrl) {
  let text;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch (_error) { return freeze({ valid: false, reason: "landing_decode_failed", url: null }); }
  const year = Number(String(fetchedAt || "").slice(0, 4));
  if (!Number.isInteger(year))
    return freeze({ valid: false, reason: "landing_fetched_at_invalid", url: null });
  const pattern = new RegExp(`href="([^"]*${year}_indexfutures_options_1_j\\.xlsx)"`, "g"),
    urls = [];
  try {
    for (const match of text.matchAll(pattern)) urls.push(new URL(match[1], baseUrl).href);
  } catch (_error) {
    return freeze({ valid: false, reason: "workbook_discovery_url_invalid", url: null });
  }
  const unique = [...new Set(urls)], parserUrl = Parsers.discoverJpxWorkbook(text, year, baseUrl);
  if (unique.length === 0 || !parserUrl)
    return freeze({ valid: false, reason: "workbook_not_discovered", url: null });
  if (unique.length !== 1 || unique[0] !== parserUrl)
    return freeze({ valid: false, reason: "workbook_discovery_ambiguous", url: null });
  if (!Network.validateUrl(SOURCE_ID, routes[1], parserUrl).valid)
    return freeze({ valid: false, reason: "workbook_discovery_url_rejected", url: null });
  return freeze({ valid: true, reason: null, url: parserUrl });
}
function validateSourceEvidenceSet(value) {
  const contract = contractFor(value?.documents);
  return !!contract && contract.validateSourceEvidenceSet(value);
}
function createSourceEvidenceSet({ acquisitionRunId, documents, workbookInitialUrl } = {}) {
  const contract = contractFor(documents, workbookInitialUrl);
  if (!contract) throw new TypeError("jpx_derivatives_evidence_policy_invalid");
  return contract.createSourceEvidenceSet({ acquisitionRunId, documents });
}
function boundContract(set, vault) {
  if (!validateSourceEvidenceSet(set) || !vault ||
      typeof vault.readOccurrence !== "function" || typeof vault.readRawBytes !== "function")
    return { error: "source_evidence_set_invalid" };
  try {
    const landing = vault.readOccurrence(set.documents[0].evidenceRef.occurrenceId),
      workbook = vault.readOccurrence(set.documents[1].evidenceRef.occurrenceId);
    if (!landing || !workbook || landing.fetchedAt !== workbook.fetchedAt)
      return { error: "source_run_occurrence_mismatch" };
    const contract = contractFor(set.documents, workbook.initialUrl);
    if (!contract) return { error: "occurrence_url_policy_mismatch" };
    return { contract, landing, workbook };
  } catch (error) {
    return { error: error?.integrityStatus || error?.message || "evidence_integrity_invalid" };
  }
}
function validateDiscovery(set, vault, bound) {
  try {
    const raw = vault.readRawBytes(set.documents[0].evidenceRef.contentSha256), found =
      discoverWorkbookAuthority(raw, bound.landing.encoding, bound.landing.fetchedAt,
        bound.landing.sourceUrl);
    if (!found.valid || found.url !== bound.workbook.initialUrl)
      return found.valid ? "workbook_discovery_binding_mismatch" : found.reason;
    return null;
  } catch (error) {
    return error?.integrityStatus || error?.message || "discovery_evidence_invalid";
  }
}
function resolveRunEvidence({ run, vault } = {}) {
  if (!run || run.sourceId !== SOURCE_ID) return invalid("source_run_invalid");
  if (!Object.hasOwn(run, "sourceEvidenceSet")) return unavailable();
  const set = run.sourceEvidenceSet, bound = boundContract(set, vault);
  if (bound.error) return invalid(bound.error, set);
  const resolved = bound.contract.resolveRunEvidence({ run, vault });
  if (resolved.status !== "available") return resolved;
  const discoveryError = validateDiscovery(set, vault, bound);
  return discoveryError ? invalid(discoveryError, set) : resolved;
}
function resolveRevisionEvidence({ snapshot, vault, revisionKey } = {}) {
  const revision = snapshot?.revisions?.find(value => value.revisionKey === revisionKey);
  if (!revision || revision.sourceId !== SOURCE_ID) return invalid("revision_not_found");
  const links = (snapshot.evidence || []).filter(value => value.sourceId === SOURCE_ID &&
    value.revisionKey === revisionKey && value.acceptedAt === revision.validFrom);
  if (links.length !== 1) return invalid("revision_run_link_ambiguous");
  const run = (snapshot.runs || []).find(value => value.sourceId === SOURCE_ID &&
    value.runId === links[0].runId);
  if (!run) return invalid("source_run_not_found");
  if (!Object.hasOwn(run, "sourceEvidenceSet")) return unavailable();
  const set = run.sourceEvidenceSet, bound = boundContract(set, vault);
  if (bound.error) return invalid(bound.error, set);
  const resolved = bound.contract.resolveRevisionEvidence({ snapshot, vault, revisionKey });
  if (resolved.status !== "available") return resolved;
  const discoveryError = validateDiscovery(set, vault, bound);
  return discoveryError ? invalid(discoveryError, set) : resolved;
}

module.exports = freeze({ SOURCE_ID, CONTRACT_VERSION: Core.CONTRACT_VERSION,
  PARSER_ID: source.parserId, PARSER_VERSION: source.parserVersion,
  FIELDS: Core.FIELDS, DOCUMENT_FIELDS: Core.DOCUMENT_FIELDS,
  discoverWorkbookAuthority, validateSourceEvidenceSet, createSourceEvidenceSet,
  resolveRunEvidence, resolveRevisionEvidence });
