"use strict";

const Authority = require("./weeklyAcquisitionAuthorityContract.js");
const Transport = require("./weeklyRawTransportShadow.js");
const Evidence = require("./sourceEvidence/sourceEvidenceContract.js");

const SET_VERSION = "weekly-domain-source-evidence-set-v1";
const ACQUISITION_CONTEXT = "live_original_acquisition";
const LISTING_SOURCE_ID = "jpx-weekly-open-interest-listing";
const DOMAIN_ROLES = Object.freeze([...Authority.ROLES]);
const LISTING_ROLE = "official_listing";
const DOMAIN = Object.freeze({
  weekly_futures_workbook: Object.freeze({
    sourceId: Authority.ROLE_AUTHORITY.weekly_futures_workbook.sourceId,
    setIdPrefix: "weekly-futures-evidence-set-v1",
    signatureKind: "weekly_futures_evidence_set"
  }),
  weekly_options_workbook: Object.freeze({
    sourceId: Authority.ROLE_AUTHORITY.weekly_options_workbook.sourceId,
    setIdPrefix: "weekly-options-evidence-set-v1",
    signatureKind: "weekly_options_evidence_set"
  })
});
const LISTING_POLICY = Evidence.createSourcePolicy({ sourceFamily: Authority.SOURCE_FAMILY,
  sourceId: LISTING_SOURCE_ID, allowedMediaTypes: Transport.LISTING_MIME_TYPES,
  allowedEncodings: ["utf-8"], maxBytes: Transport.LISTING_MAX_BYTES });
const DOMAIN_POLICIES = Object.freeze(Object.fromEntries(DOMAIN_ROLES.map(role => [role,
  Evidence.createSourcePolicy({ sourceFamily: Authority.SOURCE_FAMILY,
    sourceId: DOMAIN[role].sourceId, allowedMediaTypes: Transport.WORKBOOK_MIME_TYPES,
    allowedEncodings: [], maxBytes: role === "weekly_futures_workbook"
      ? Transport.FUTURES_MAX_BYTES : Transport.OPTIONS_MAX_BYTES })])));

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const identity = (value, prefix) => typeof value === "string" &&
  new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|sha256:[0-9a-f]{64}$`)
    .test(value);
const clone = value => value == null ? value : structuredClone(value);
function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value) || ArrayBuffer.isView(value))
    return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function policyForRole(role) {
  if (role === LISTING_ROLE) return LISTING_POLICY;
  return DOMAIN_POLICIES[role] || null;
}

function redirects(value) {
  return value.map(hop => ({ status: hop.status, url: hop.to }));
}

function listingLineage({ discoveryIdentity, listingYear, transportResultId, contentSha256 }) {
  if ((!identity(discoveryIdentity, "weekly-discovery-v1") && discoveryIdentity !== null) ||
      !Number.isSafeInteger(listingYear) || !identity(transportResultId,
        Transport.LISTING_RESULT_VERSION) && transportResultId !== null || !digest(contentSha256))
    return null;
  return `weekly-listing-v1|sha256:${Authority.sha256({ discoveryIdentity, listingYear,
    transportResultId, contentSha256 })}`;
}

function workbookLineage({ acquisitionId, transportResultId, role, contentSha256,
    parserPreviewSha256, publishedDate }) {
  if (!identity(acquisitionId, "weekly-domain-acquisition-v1") ||
      (!identity(transportResultId, Transport.WORKBOOK_RESULT_VERSION) &&
        transportResultId !== null) || !DOMAIN[role] || !digest(contentSha256) ||
      (!digest(parserPreviewSha256) && parserPreviewSha256 !== null) ||
      (!Authority.sourceDate(publishedDate) && publishedDate !== null)) return null;
  return `weekly-workbook-v1|sha256:${Authority.sha256({ acquisitionId, transportResultId,
    role, contentSha256, parserAuthority: Authority.PARSER_AUTHORITIES[role],
    parserPreviewSha256, publishedDate })}`;
}

function validateRawEvent(event, kind) {
  return exact(event, ["kind", "intentId", "requestId", "listingYear", "manifest",
    "acquisition", "transport"]) && event.kind === kind &&
    identity(event.intentId, "weekly-intent-v1") && typeof event.requestId === "string" &&
    event.requestId.length > 0 && object(event.transport) &&
    exact(event.transport, ["finalUrl", "redirects", "status", "mime", "bytes",
      "byteLength", "rawSha256", "fetchedAt"]);
}

function createListingOccurrence({ event, manifest, discovery, transportResult,
    contentObject, authority } = {}) {
  if (!validateRawEvent(event, LISTING_ROLE) || !Evidence.validateContentObject(contentObject) ||
      !Number.isSafeInteger(event.listingYear) || event.manifest !== null ||
      event.acquisition !== null || contentObject.sha256 !== event.transport.rawSha256 ||
      contentObject.byteLength !== event.transport.byteLength ||
      (manifest === null) !== (discovery === null) ||
      (manifest !== null && (!Authority.validateManifest(manifest, authority) ||
        !Authority.validateDiscovery(discovery) || manifest.discoveryIdentity !==
          discovery.discoveryIdentity || discovery.listingYear !== event.listingYear)))
    throw new TypeError("weekly_listing_occurrence_input_invalid");
  const transportResultId = transportResult?.rawResultId || null;
  if (transportResult !== null && transportResult !== undefined &&
      (!Transport.validateListingTransportResult(transportResult, manifest, discovery,
        authority) || transportResult.rawSha256 !== contentObject.sha256))
    throw new TypeError("weekly_listing_transport_binding_invalid");
  const lineage = listingLineage({ discoveryIdentity: discovery?.discoveryIdentity || null,
    listingYear: event.listingYear, transportResultId, contentSha256: contentObject.sha256 });
  if (!lineage) throw new TypeError("weekly_listing_lineage_invalid");
  return Evidence.createAcquisitionOccurrence({ sourceFamily: Authority.SOURCE_FAMILY,
    sourceId: LISTING_SOURCE_ID, initialUrl: Authority.canonicalListingUrl(event.listingYear),
    sourceUrl: event.transport.finalUrl, fetchedAt: event.transport.fetchedAt,
    httpStatus: event.transport.status, contentObject,
    transportVersion: Transport.SHADOW_RESULT_VERSION, publishedAt: null,
    requestRole: LISTING_ROLE, redirectHops: redirects(event.transport.redirects),
    sourceDocumentRole: lineage, runId: manifest?.runId || null,
    acquisitionContext: ACQUISITION_CONTEXT }, LISTING_POLICY);
}

function createWorkbookOccurrence({ event, manifest, domainResult, contentObject,
    authority } = {}) {
  const role = event?.kind, acquisition = event?.acquisition;
  if (!DOMAIN[role] || !validateRawEvent(event, role) ||
      !Authority.validateManifest(manifest, authority) ||
      !Authority.validateDomainAcquisition(acquisition, manifest.runId) ||
      acquisition.role !== role || Authority.stable(event.manifest) !== Authority.stable(manifest) ||
      !Evidence.validateContentObject(contentObject) ||
      contentObject.sha256 !== event.transport.rawSha256 ||
      contentObject.byteLength !== event.transport.byteLength)
    throw new TypeError("weekly_workbook_occurrence_input_invalid");
  const accepted = domainResult?.success === true;
  if (accepted && (!Transport.validateWorkbookTransportResult(domainResult, manifest, authority) ||
      domainResult.acquisitionId !== acquisition.acquisitionId ||
      domainResult.rawSha256 !== contentObject.sha256))
    throw new TypeError("weekly_workbook_transport_binding_invalid");
  const lineage = workbookLineage({ acquisitionId: acquisition.acquisitionId,
    transportResultId: accepted ? domainResult.rawResultId : null, role,
    contentSha256: contentObject.sha256,
    parserPreviewSha256: accepted ? domainResult.parserPreviewSha256 : null,
    publishedDate: accepted ? domainResult.publishedDate : null });
  if (!lineage) throw new TypeError("weekly_workbook_lineage_invalid");
  return Evidence.createAcquisitionOccurrence({ sourceFamily: Authority.SOURCE_FAMILY,
    sourceId: DOMAIN[role].sourceId, initialUrl: acquisition.route.canonicalUrl,
    sourceUrl: event.transport.finalUrl, fetchedAt: event.transport.fetchedAt,
    httpStatus: event.transport.status, contentObject,
    transportVersion: Transport.SHADOW_RESULT_VERSION, publishedAt: null,
    requestRole: role, redirectHops: redirects(event.transport.redirects),
    sourceDocumentRole: lineage, runId: manifest.runId,
    acquisitionContext: ACQUISITION_CONTEXT }, DOMAIN_POLICIES[role]);
}

const ENTRY_FIELDS = Object.freeze(["role", "acquisitionId", "transportResultId",
  "occurrenceId", "contentSha256", "byteLength", "publishedDate",
  "parserPreviewSha256", "parserLineageId"]);

function validateEntry(value, role) {
  const listing = role === LISTING_ROLE;
  return exact(value, ENTRY_FIELDS) && value.role === role &&
    (listing ? value.acquisitionId === null : identity(value.acquisitionId,
      "weekly-domain-acquisition-v1")) &&
    identity(value.transportResultId, listing ? Transport.LISTING_RESULT_VERSION :
      Transport.WORKBOOK_RESULT_VERSION) && identity(value.occurrenceId,
      "source-occurrence-v1") && digest(value.contentSha256) &&
    Number.isSafeInteger(value.byteLength) && value.byteLength > 0 &&
    (listing ? value.publishedDate === null : Authority.sourceDate(value.publishedDate)) &&
    (listing ? value.parserPreviewSha256 === null : digest(value.parserPreviewSha256)) &&
    identity(value.parserLineageId, listing ? "weekly-listing-v1" : "weekly-workbook-v1");
}

const SET_FIELDS = Object.freeze(["contractVersion", "evidenceSetId", "sourceFamily",
  "sourceId", "domainRole", "sourceDate", "listingYear", "runId", "manifestId",
  "discoveryIdentity", "roles", "authorityKeyId", "setHash", "authoritySignature"]);

function setMaterial(value) {
  return Object.fromEntries(SET_FIELDS.filter(field =>
    !["evidenceSetId", "setHash", "authoritySignature"].includes(field))
    .map(field => [field, clone(value[field])]));
}

function validateEvidenceSet(value, authority) {
  const domain = DOMAIN[value?.domainRole], ordered = domain ?
    [LISTING_ROLE, value.domainRole] : [];
  if (!domain || !exact(value, SET_FIELDS) || value.contractVersion !== SET_VERSION ||
      !identity(value.evidenceSetId, domain.setIdPrefix) ||
      value.sourceFamily !== Authority.SOURCE_FAMILY || value.sourceId !== domain.sourceId ||
      !Authority.sourceDate(value.sourceDate) || value.listingYear !==
        Number(value.sourceDate.slice(0, 4)) || !identity(value.runId, "weekly-run-v1") ||
      !identity(value.manifestId, "weekly-manifest-v1") ||
      !identity(value.discoveryIdentity, "weekly-discovery-v1") ||
      !Array.isArray(value.roles) || value.roles.length !== 2 ||
      value.roles.some((entry, index) => !validateEntry(entry, ordered[index])) ||
      value.roles[1].acquisitionId === value.roles[0].acquisitionId ||
      value.authorityKeyId !== authority?.keyId || typeof authority?.verify !== "function" ||
      !digest(value.setHash) || !digest(value.authoritySignature)) return false;
  const setHash = Authority.sha256(setMaterial(value));
  return value.setHash === setHash &&
    value.evidenceSetId === `${domain.setIdPrefix}|sha256:${setHash}` &&
    authority.verify(domain.signatureKind, setHash, value.authoritySignature);
}

function createEvidenceSet({ domainRole, manifest, discovery, listingResult, domainResult,
    listingOccurrence, workbookOccurrence } = {}, authority) {
  const domain = DOMAIN[domainRole], acquisition = manifest &&
    (domainRole === "weekly_futures_workbook" ? manifest.futuresDescriptor :
      manifest.optionsDescriptor);
  if (!domain || !Authority.validateManifest(manifest, authority) ||
      !Authority.validateDiscovery(discovery) || manifest.discoveryIdentity !==
        discovery.discoveryIdentity || manifest.sourceDate !== discovery.sourceDate ||
      !Transport.validateListingTransportResult(listingResult, manifest, discovery, authority) ||
      !Transport.validateWorkbookTransportResult(domainResult, manifest, authority) ||
      domainResult.role !== domainRole || domainResult.acquisitionId !== acquisition.acquisitionId ||
      !validateOccurrenceBinding(listingOccurrence, { role: LISTING_ROLE,
        manifest, discovery, listingResult }) ||
      !validateOccurrenceBinding(workbookOccurrence, { role: domainRole,
        manifest, domainResult }))
    throw new TypeError("weekly_evidence_set_input_invalid");
  const listingEntry = { role: LISTING_ROLE, acquisitionId: null,
    transportResultId: listingResult.rawResultId, occurrenceId: listingOccurrence.occurrenceId,
    contentSha256: listingOccurrence.contentSha256, byteLength: listingOccurrence.byteLength,
    publishedDate: null, parserPreviewSha256: null,
    parserLineageId: listingOccurrence.sourceDocumentRole };
  const workbookEntry = { role: domainRole, acquisitionId: acquisition.acquisitionId,
    transportResultId: domainResult.rawResultId, occurrenceId: workbookOccurrence.occurrenceId,
    contentSha256: workbookOccurrence.contentSha256, byteLength: workbookOccurrence.byteLength,
    publishedDate: domainResult.publishedDate,
    parserPreviewSha256: domainResult.parserPreviewSha256,
    parserLineageId: workbookOccurrence.sourceDocumentRole };
  const result = { contractVersion: SET_VERSION, evidenceSetId: "",
    sourceFamily: Authority.SOURCE_FAMILY, sourceId: domain.sourceId, domainRole,
    sourceDate: manifest.sourceDate, listingYear: discovery.listingYear,
    runId: manifest.runId, manifestId: manifest.manifestId,
    discoveryIdentity: discovery.discoveryIdentity, roles: [listingEntry, workbookEntry],
    authorityKeyId: authority.keyId, setHash: "", authoritySignature: "" };
  result.setHash = Authority.sha256(setMaterial(result));
  result.evidenceSetId = `${domain.setIdPrefix}|sha256:${result.setHash}`;
  result.authoritySignature = authority.sign(domain.signatureKind, result.setHash);
  if (!validateEvidenceSet(result, authority)) throw new TypeError("weekly_evidence_set_invalid");
  return freeze(result);
}

function validateOccurrenceBinding(occurrence, context) {
  if (!object(context) || !context.role) return false;
  if (context.role === LISTING_ROLE) {
    const { manifest, discovery, listingResult } = context;
    return Evidence.validateAcquisitionOccurrence(occurrence, LISTING_POLICY) &&
      occurrence.sourceFamily === Authority.SOURCE_FAMILY &&
      occurrence.sourceId === LISTING_SOURCE_ID && occurrence.runId === manifest.runId &&
      occurrence.requestRole === LISTING_ROLE && occurrence.contentSha256 ===
        listingResult.rawSha256 && occurrence.byteLength === listingResult.byteLength &&
      occurrence.initialUrl === Authority.canonicalListingUrl(discovery.listingYear) &&
      occurrence.sourceUrl === listingResult.finalUrl && occurrence.httpStatus === 200 &&
      occurrence.mediaType === listingResult.mime && occurrence.encoding === "utf-8" &&
      occurrence.transportVersion === Transport.SHADOW_RESULT_VERSION &&
      occurrence.acquisitionContext === ACQUISITION_CONTEXT &&
      occurrence.sourceDocumentRole === listingLineage({
        discoveryIdentity: discovery.discoveryIdentity, listingYear: discovery.listingYear,
        transportResultId: listingResult.rawResultId,
        contentSha256: listingResult.rawSha256 });
  }
  const { manifest, domainResult } = context, role = context.role,
    acquisition = role === "weekly_futures_workbook" ? manifest?.futuresDescriptor :
      manifest?.optionsDescriptor;
  return Boolean(DOMAIN[role]) && Evidence.validateAcquisitionOccurrence(occurrence,
    DOMAIN_POLICIES[role]) && occurrence.sourceFamily === Authority.SOURCE_FAMILY &&
    occurrence.sourceId === DOMAIN[role].sourceId && occurrence.runId === manifest.runId &&
    occurrence.requestRole === role && occurrence.contentSha256 === domainResult.rawSha256 &&
    occurrence.byteLength === domainResult.byteLength &&
    occurrence.initialUrl === acquisition.route.canonicalUrl &&
    occurrence.sourceUrl === domainResult.finalUrl && occurrence.httpStatus === 200 &&
    occurrence.mediaType === domainResult.mime && occurrence.encoding === null &&
    occurrence.transportVersion === Transport.SHADOW_RESULT_VERSION &&
    occurrence.acquisitionContext === ACQUISITION_CONTEXT &&
    occurrence.sourceDocumentRole === workbookLineage({
      acquisitionId: acquisition.acquisitionId, transportResultId: domainResult.rawResultId,
      role, contentSha256: domainResult.rawSha256,
      parserPreviewSha256: domainResult.parserPreviewSha256,
      publishedDate: domainResult.publishedDate });
}

function validateEvidenceSetAgainstVault(value, vault, authority) {
  if (!validateEvidenceSet(value, authority) || !vault ||
      typeof vault.verifyOccurrence !== "function" || typeof vault.readOccurrence !== "function" ||
      typeof vault.verifyContent !== "function" || typeof vault.readRawBytes !== "function")
    return false;
  for (const entry of value.roles) {
    if (vault.verifyOccurrence(entry.occurrenceId).status !== "valid" ||
        vault.verifyContent(entry.contentSha256).status !== "valid") return false;
    let occurrence, bytes;
    try {
      occurrence = vault.readOccurrence(entry.occurrenceId);
      bytes = vault.readRawBytes(entry.contentSha256);
    } catch (_error) { return false; }
    const listing = entry.role === LISTING_ROLE, expectedSource = listing ? LISTING_SOURCE_ID :
      DOMAIN[value.domainRole].sourceId, expectedUrl = listing ?
      Authority.canonicalListingUrl(value.listingYear) :
      Authority.canonicalWorkbookUrl(value.domainRole, value.sourceDate),
      expectedLineage = listing ? listingLineage({ discoveryIdentity: value.discoveryIdentity,
        listingYear: value.listingYear, transportResultId: entry.transportResultId,
        contentSha256: entry.contentSha256 }) : workbookLineage({
        acquisitionId: entry.acquisitionId, transportResultId: entry.transportResultId,
        role: value.domainRole, contentSha256: entry.contentSha256,
        parserPreviewSha256: entry.parserPreviewSha256, publishedDate: entry.publishedDate });
    if (!occurrence || occurrence.sourceFamily !== Authority.SOURCE_FAMILY ||
        occurrence.sourceId !== expectedSource || occurrence.runId !== value.runId ||
        occurrence.requestRole !== entry.role || occurrence.contentSha256 !== entry.contentSha256 ||
        occurrence.byteLength !== entry.byteLength || occurrence.initialUrl !== expectedUrl ||
        occurrence.sourceUrl !== expectedUrl || occurrence.httpStatus !== 200 ||
        occurrence.mediaType !== Transport.OBSERVED_JPX_MIME ||
        occurrence.encoding !== (listing ? "utf-8" : null) ||
        occurrence.transportVersion !== Transport.SHADOW_RESULT_VERSION ||
        occurrence.acquisitionContext !== ACQUISITION_CONTEXT ||
        occurrence.sourceDocumentRole !== entry.parserLineageId ||
        occurrence.sourceDocumentRole !== expectedLineage ||
        bytes?.byteLength !== entry.byteLength ||
        Evidence.sha256Bytes(bytes) !== entry.contentSha256) return false;
  }
  return true;
}

module.exports = freeze({ SET_VERSION, ACQUISITION_CONTEXT, LISTING_SOURCE_ID, LISTING_ROLE,
  DOMAIN_ROLES, DOMAIN, LISTING_POLICY, DOMAIN_POLICIES, ENTRY_FIELDS, SET_FIELDS,
  policyForRole, listingLineage, workbookLineage, createListingOccurrence,
  createWorkbookOccurrence, validateOccurrenceBinding, createEvidenceSet,
  validateEvidenceSet, validateEvidenceSetAgainstVault });
