"use strict";

const crypto = require("node:crypto");

const INTENT_VERSION = "weekly-acquisition-intent-v1";
const LISTING_ROUTE_VERSION = "weekly-listing-route-v1";
const WORKBOOK_ROUTE_VERSION = "weekly-workbook-route-v1";
const LISTING_RESULT_VERSION = "weekly-listing-result-v1";
const DISCOVERY_VERSION = "weekly-official-discovery-v1";
const ACQUISITION_VERSION = "weekly-domain-acquisition-v1";
const MANIFEST_VERSION = "weekly-acquisition-manifest-v1";

const SOURCE_FAMILY = "weekly";
const JPX_ORIGIN = "https://www.jpx.co.jp";
const LANDING_URL = `${JPX_ORIGIN}/markets/derivatives/open-interest/index.html`;
const LISTING_ROUTE_FAMILY = "jpx-weekly-open-interest-listing-v1";
const WORKBOOK_ROUTE_FAMILY = "jpx-weekly-open-interest-workbook-v1";
const ROLES = Object.freeze([
  "weekly_futures_workbook", "weekly_options_workbook"
]);
const REQUEST_KINDS = Object.freeze([
  "latest_available", "explicit_source_date", "historical_backfill_range"
]);
const ROLE_AUTHORITY = Object.freeze({
  weekly_futures_workbook: Object.freeze({
    sourceId: "jpx-weekly-index-futures-open-interest",
    suffix: "indexfut_oi_by_tp.xlsx"
  }),
  weekly_options_workbook: Object.freeze({
    sourceId: "jpx-weekly-nikkei225-options-open-interest",
    suffix: "nk225op_oi_by_tp.xlsx"
  })
});
const DATE_AUTHORITY = Object.freeze({
  sourceDate: "official_listing_trade_date",
  publishedDate: "workbook_declared_publication_date",
  fetchedAt: "main_transport_observation_time",
  confirmedAt: "semantic_revision_acceptance_time"
});
const PARSER_AUTHORITIES = Object.freeze({
  weekly_futures_workbook: Object.freeze({
    parserId: "jpx-weekly-index-futures-open-interest",
    parserVersion: 2,
    schemaVersion: 2,
    brokerSetVersion: 1,
    scoringVersion: 2
  }),
  weekly_options_workbook: Object.freeze({
    parserId: "jpx-weekly-nikkei225-options-open-interest",
    parserVersion: 2,
    schemaVersion: 2,
    cacheVersion: 2
  })
});
const PROMOTION_POLICY = Object.freeze({
  sharedDiscoveryRequired: true,
  domainPromotion: "independent",
  futuresFailureBlocksOptions: false,
  optionsFailureBlocksFutures: false
});
const HISTORY_SEMANTICS = Object.freeze({
  current: "latest_source_date_active_revision",
  previous: "prior_distinct_source_date_active_revision",
  sameDatePriorRevision: "correction_history_not_previous_week"
});
const FAILURE_REASONS = Object.freeze([
  "discovery_failed", "listing_invalid", "source_date_unavailable",
  "futures_route_invalid", "options_route_invalid", "manifest_invalid"
]);

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const text = (value, maximum = 192) => typeof value === "string" && value.length > 0 &&
  value.length <= maximum && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const identifier = (value, maximum = 192) => text(value, maximum) &&
  /^[A-Za-z0-9][A-Za-z0-9._:|+-]*$/.test(value) && !value.includes("..");
const identity = (value, prefix) => typeof value === "string" &&
  new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|sha256:[0-9a-f]{64}$`)
    .test(value);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function stable(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  throw new TypeError("weekly_canonical_value_invalid");
}

const sha256 = value => crypto.createHash("sha256").update(stable(value)).digest("hex");

function sourceDate(value) {
  if (typeof value !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value))
    return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function listingYear(value) {
  return Number.isSafeInteger(value) && value >= 2000 && value <= 2099;
}

function compactDate(value) {
  return sourceDate(value) ? value.replaceAll("-", "") : null;
}

function exactCanonicalUrl(value, expected) {
  if (typeof value !== "string" || value !== expected) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === "www.jpx.co.jp" &&
      !parsed.port && !parsed.username && !parsed.password && !parsed.search && !parsed.hash &&
      parsed.href === expected;
  } catch (_error) { return false; }
}

const INTENT_FIELDS = Object.freeze([
  "contractVersion", "intentId", "requestKind", "targetDatePolicy",
  "targetDate", "startDate", "endDate"
]);

function intentMaterial(value) {
  return Object.fromEntries(INTENT_FIELDS.filter(field => field !== "intentId")
    .map(field => [field, value[field]]));
}

function validateAcquisitionIntent(value) {
  if (!exact(value, INTENT_FIELDS) || value.contractVersion !== INTENT_VERSION ||
      !REQUEST_KINDS.includes(value.requestKind) ||
      !identity(value.intentId, "weekly-intent-v1")) return false;
  if (value.requestKind === "latest_available") {
    if (value.targetDatePolicy !== "official_listing_latest_trade_date" ||
        value.targetDate !== null || value.startDate !== null || value.endDate !== null) return false;
  } else if (value.requestKind === "explicit_source_date") {
    if (value.targetDatePolicy !== "official_listing_exact_trade_date" ||
        !sourceDate(value.targetDate) || value.startDate !== null || value.endDate !== null) return false;
  } else if (value.targetDatePolicy !== "official_listing_bounded_trade_date_range" ||
      value.targetDate !== null || !sourceDate(value.startDate) || !sourceDate(value.endDate) ||
      value.startDate > value.endDate) return false;
  return value.intentId === `weekly-intent-v1|sha256:${sha256(intentMaterial(value))}`;
}

function createAcquisitionIntent(input) {
  if (!object(input)) throw new TypeError("weekly_intent_invalid");
  let result;
  if (exact(input, ["requestKind"]) && input.requestKind === "latest_available") {
    result = { contractVersion: INTENT_VERSION, intentId: "", requestKind: input.requestKind,
      targetDatePolicy: "official_listing_latest_trade_date", targetDate: null,
      startDate: null, endDate: null };
  } else if (exact(input, ["requestKind", "targetDate"]) &&
      input.requestKind === "explicit_source_date") {
    result = { contractVersion: INTENT_VERSION, intentId: "", requestKind: input.requestKind,
      targetDatePolicy: "official_listing_exact_trade_date", targetDate: input.targetDate,
      startDate: null, endDate: null };
  } else if (exact(input, ["requestKind", "startDate", "endDate"]) &&
      input.requestKind === "historical_backfill_range") {
    result = { contractVersion: INTENT_VERSION, intentId: "", requestKind: input.requestKind,
      targetDatePolicy: "official_listing_bounded_trade_date_range", targetDate: null,
      startDate: input.startDate, endDate: input.endDate };
  } else throw new TypeError("weekly_intent_fields_invalid");
  result.intentId = `weekly-intent-v1|sha256:${sha256(intentMaterial(result))}`;
  if (!validateAcquisitionIntent(result)) throw new TypeError("weekly_intent_invalid");
  return freeze(result);
}

function sourceDateAllowed(intent, value, availableDates) {
  if (!validateAcquisitionIntent(intent) || !sourceDate(value) || !availableDates.includes(value))
    return false;
  if (intent.requestKind === "latest_available") return value === availableDates.at(-1);
  if (intent.requestKind === "explicit_source_date") return value === intent.targetDate;
  return value >= intent.startDate && value <= intent.endDate;
}

function createMainAuthority({ keyId, secret } = {}) {
  if (!identifier(keyId, 96)) throw new TypeError("weekly_authority_key_id_invalid");
  const key = Buffer.isBuffer(secret) ? Buffer.from(secret) :
    typeof secret === "string" ? Buffer.from(secret, "utf8") : null;
  if (!key || key.byteLength < 32) throw new TypeError("weekly_authority_secret_invalid");
  const sign = (kind, integrity) => crypto.createHmac("sha256", key)
    .update(`optionmap-weekly-authority-v1\0${kind}\0${integrity}`).digest("hex");
  const verify = (kind, integrity, signature) => {
    if (!digest(integrity) || !digest(signature)) return false;
    return crypto.timingSafeEqual(Buffer.from(sign(kind, integrity), "hex"),
      Buffer.from(signature, "hex"));
  };
  return Object.freeze({ keyId, sign, verify });
}

function validAuthority(authority) {
  return object(authority) && identifier(authority.keyId, 96) &&
    typeof authority.sign === "function" && typeof authority.verify === "function";
}

function canonicalListingUrl(year) {
  return listingYear(year) ? `${JPX_ORIGIN}/automation/markets/derivatives/open-interest/json/` +
    `open_interest_${year}.json` : null;
}

const LISTING_ROUTE_FIELDS = Object.freeze([
  "contractVersion", "routeIdentity", "routeFamily", "sourceFamily", "role",
  "listingYear", "scheme", "host", "path", "filename", "canonicalUrl"
]);

function listingRouteMaterial(value) {
  return Object.fromEntries(LISTING_ROUTE_FIELDS.filter(field => field !== "routeIdentity")
    .map(field => [field, value[field]]));
}

function validateListingRoute(value) {
  if (!exact(value, LISTING_ROUTE_FIELDS) || value.contractVersion !== LISTING_ROUTE_VERSION ||
      value.routeFamily !== LISTING_ROUTE_FAMILY || value.sourceFamily !== SOURCE_FAMILY ||
      value.role !== "official_yearly_listing" || !listingYear(value.listingYear) ||
      value.scheme !== "https" || value.host !== "www.jpx.co.jp" ||
      value.filename !== `open_interest_${value.listingYear}.json` ||
      !identity(value.routeIdentity, "weekly-listing-route-v1")) return false;
  const expected = canonicalListingUrl(value.listingYear);
  if (!exactCanonicalUrl(value.canonicalUrl, expected)) return false;
  if (value.path !== new URL(expected).pathname) return false;
  return value.routeIdentity ===
    `weekly-listing-route-v1|sha256:${sha256(listingRouteMaterial(value))}`;
}

function createListingRoute(year) {
  const canonicalUrl = canonicalListingUrl(year);
  if (!canonicalUrl) throw new TypeError("weekly_listing_year_invalid");
  const parsed = new URL(canonicalUrl);
  const result = { contractVersion: LISTING_ROUTE_VERSION, routeIdentity: "",
    routeFamily: LISTING_ROUTE_FAMILY, sourceFamily: SOURCE_FAMILY,
    role: "official_yearly_listing", listingYear: year, scheme: "https",
    host: parsed.hostname, path: parsed.pathname,
    filename: `open_interest_${year}.json`, canonicalUrl };
  result.routeIdentity =
    `weekly-listing-route-v1|sha256:${sha256(listingRouteMaterial(result))}`;
  if (!validateListingRoute(result)) throw new TypeError("weekly_listing_route_invalid");
  return freeze(result);
}

function workbookFilename(role, date) {
  const compact = compactDate(date), authority = ROLE_AUTHORITY[role];
  return compact && authority ? `${compact}_${authority.suffix}` : null;
}

function canonicalWorkbookUrl(role, date) {
  const compact = compactDate(date), filename = workbookFilename(role, date);
  if (!compact || !filename) return null;
  return `${JPX_ORIGIN}/automation/markets/derivatives/open-interest/files/` +
    `${compact.slice(0, 4)}/${filename}`;
}

const WORKBOOK_ROUTE_FIELDS = Object.freeze([
  "contractVersion", "routeIdentity", "routeFamily", "sourceFamily", "sourceId",
  "sourceDate", "role", "scheme", "host", "path", "filename", "suffix", "canonicalUrl"
]);

function workbookRouteMaterial(value) {
  return Object.fromEntries(WORKBOOK_ROUTE_FIELDS.filter(field => field !== "routeIdentity")
    .map(field => [field, value[field]]));
}

function validateWorkbookRoute(value) {
  const authority = ROLE_AUTHORITY[value?.role];
  if (!authority || !exact(value, WORKBOOK_ROUTE_FIELDS) ||
      value.contractVersion !== WORKBOOK_ROUTE_VERSION ||
      value.routeFamily !== WORKBOOK_ROUTE_FAMILY || value.sourceFamily !== SOURCE_FAMILY ||
      value.sourceId !== authority.sourceId || !sourceDate(value.sourceDate) ||
      value.scheme !== "https" || value.host !== "www.jpx.co.jp" ||
      value.suffix !== authority.suffix || value.filename !== workbookFilename(value.role,
        value.sourceDate) || !identity(value.routeIdentity, "weekly-workbook-route-v1")) return false;
  const expected = canonicalWorkbookUrl(value.role, value.sourceDate);
  if (!exactCanonicalUrl(value.canonicalUrl, expected)) return false;
  if (value.path !== new URL(expected).pathname) return false;
  return value.routeIdentity ===
    `weekly-workbook-route-v1|sha256:${sha256(workbookRouteMaterial(value))}`;
}

function createWorkbookRoute(role, date) {
  const authority = ROLE_AUTHORITY[role], canonicalUrl = canonicalWorkbookUrl(role, date);
  if (!authority || !canonicalUrl) throw new TypeError("weekly_workbook_route_authority_invalid");
  const parsed = new URL(canonicalUrl);
  const result = { contractVersion: WORKBOOK_ROUTE_VERSION, routeIdentity: "",
    routeFamily: WORKBOOK_ROUTE_FAMILY, sourceFamily: SOURCE_FAMILY,
    sourceId: authority.sourceId, sourceDate: date, role, scheme: "https",
    host: parsed.hostname, path: parsed.pathname, filename: workbookFilename(role, date),
    suffix: authority.suffix, canonicalUrl };
  result.routeIdentity =
    `weekly-workbook-route-v1|sha256:${sha256(workbookRouteMaterial(result))}`;
  if (!validateWorkbookRoute(result)) throw new TypeError("weekly_workbook_route_invalid");
  return freeze(result);
}

const LISTING_RESULT_FIELDS = Object.freeze([
  "contractVersion", "listingResultIdentity", "listingYear", "tradeDates"
]);

function listingResultMaterial(value) {
  return Object.fromEntries(LISTING_RESULT_FIELDS.filter(field =>
    field !== "listingResultIdentity").map(field => [field, clone(value[field])]));
}

function validateListingResult(value) {
  if (!exact(value, LISTING_RESULT_FIELDS) || value.contractVersion !== LISTING_RESULT_VERSION ||
      !identity(value.listingResultIdentity, "weekly-listing-result-v1") ||
      !listingYear(value.listingYear) || !Array.isArray(value.tradeDates) ||
      value.tradeDates.length === 0 || value.tradeDates.some(date =>
        !sourceDate(date) || Number(date.slice(0, 4)) !== value.listingYear) ||
      value.tradeDates.some((date, index) => index > 0 && value.tradeDates[index - 1] >= date))
    return false;
  return value.listingResultIdentity ===
    `weekly-listing-result-v1|sha256:${sha256(listingResultMaterial(value))}`;
}

function createListingResult({ listingYear: year, tradeDates } = {}) {
  if (!listingYear(year) || !Array.isArray(tradeDates))
    throw new TypeError("weekly_listing_result_input_invalid");
  const normalized = [...new Set(tradeDates)].sort();
  const result = { contractVersion: LISTING_RESULT_VERSION, listingResultIdentity: "",
    listingYear: year, tradeDates: normalized };
  result.listingResultIdentity =
    `weekly-listing-result-v1|sha256:${sha256(listingResultMaterial(result))}`;
  if (!validateListingResult(result)) throw new TypeError("weekly_listing_result_invalid");
  return freeze(result);
}

const DISCOVERY_FIELDS = Object.freeze([
  "contractVersion", "discoveryIdentity", "intentId", "requestKind", "sourceFamily",
  "landingUrl", "listingRoute", "listingResultIdentity", "listingYear",
  "tradeDate", "sourceDate"
]);

function discoveryMaterial(value) {
  return Object.fromEntries(DISCOVERY_FIELDS.filter(field => field !== "discoveryIdentity")
    .map(field => [field, clone(value[field])]));
}

function validateDiscovery(value, intent = null, listingResult = null) {
  if (!exact(value, DISCOVERY_FIELDS) || value.contractVersion !== DISCOVERY_VERSION ||
      !identity(value.discoveryIdentity, "weekly-discovery-v1") ||
      !identity(value.intentId, "weekly-intent-v1") || !REQUEST_KINDS.includes(value.requestKind) ||
      value.sourceFamily !== SOURCE_FAMILY || !exactCanonicalUrl(value.landingUrl, LANDING_URL) ||
      !validateListingRoute(value.listingRoute) || !listingYear(value.listingYear) ||
      value.listingRoute.listingYear !== value.listingYear ||
      !identity(value.listingResultIdentity, "weekly-listing-result-v1") ||
      !sourceDate(value.tradeDate) || value.sourceDate !== value.tradeDate ||
      Number(value.sourceDate.slice(0, 4)) !== value.listingYear) return false;
  if (intent && (!validateAcquisitionIntent(intent) || value.intentId !== intent.intentId ||
      value.requestKind !== intent.requestKind)) return false;
  if (listingResult && (!validateListingResult(listingResult) ||
      value.listingResultIdentity !== listingResult.listingResultIdentity ||
      value.listingYear !== listingResult.listingYear ||
      !sourceDateAllowed(intent, value.sourceDate, listingResult.tradeDates))) return false;
  return value.discoveryIdentity ===
    `weekly-discovery-v1|sha256:${sha256(discoveryMaterial(value))}`;
}

function createDiscovery({ intent, listingResult, selectedTradeDate } = {}) {
  if (!validateAcquisitionIntent(intent) || !validateListingResult(listingResult) ||
      !sourceDateAllowed(intent, selectedTradeDate, listingResult.tradeDates))
    throw new TypeError("weekly_discovery_input_invalid");
  const result = { contractVersion: DISCOVERY_VERSION, discoveryIdentity: "",
    intentId: intent.intentId, requestKind: intent.requestKind, sourceFamily: SOURCE_FAMILY,
    landingUrl: LANDING_URL, listingRoute: clone(createListingRoute(listingResult.listingYear)),
    listingResultIdentity: listingResult.listingResultIdentity,
    listingYear: listingResult.listingYear, tradeDate: selectedTradeDate,
    sourceDate: selectedTradeDate };
  result.discoveryIdentity =
    `weekly-discovery-v1|sha256:${sha256(discoveryMaterial(result))}`;
  if (!validateDiscovery(result, intent, listingResult))
    throw new TypeError("weekly_discovery_invalid");
  return freeze(result);
}

const ACQUISITION_FIELDS = Object.freeze([
  "contractVersion", "acquisitionId", "runId", "sourceFamily", "sourceId",
  "sourceDate", "role", "route"
]);

function acquisitionMaterial(value) {
  return Object.fromEntries(ACQUISITION_FIELDS.filter(field => field !== "acquisitionId")
    .map(field => [field, clone(value[field])]));
}

function validateDomainAcquisition(value, runId = null) {
  const authority = ROLE_AUTHORITY[value?.role];
  if (!authority || !exact(value, ACQUISITION_FIELDS) ||
      value.contractVersion !== ACQUISITION_VERSION ||
      !identity(value.acquisitionId, "weekly-domain-acquisition-v1") ||
      !identity(value.runId, "weekly-run-v1") || (runId && value.runId !== runId) ||
      value.sourceFamily !== SOURCE_FAMILY || value.sourceId !== authority.sourceId ||
      !sourceDate(value.sourceDate) || !validateWorkbookRoute(value.route) ||
      value.route.sourceId !== value.sourceId || value.route.sourceDate !== value.sourceDate ||
      value.route.role !== value.role) return false;
  return value.acquisitionId ===
    `weekly-domain-acquisition-v1|sha256:${sha256(acquisitionMaterial(value))}`;
}

function createDomainAcquisition(runId, role, date) {
  if (!identity(runId, "weekly-run-v1") || !ROLE_AUTHORITY[role] || !sourceDate(date))
    throw new TypeError("weekly_domain_acquisition_input_invalid");
  const result = { contractVersion: ACQUISITION_VERSION, acquisitionId: "", runId,
    sourceFamily: SOURCE_FAMILY, sourceId: ROLE_AUTHORITY[role].sourceId,
    sourceDate: date, role, route: clone(createWorkbookRoute(role, date)) };
  result.acquisitionId =
    `weekly-domain-acquisition-v1|sha256:${sha256(acquisitionMaterial(result))}`;
  if (!validateDomainAcquisition(result, runId))
    throw new TypeError("weekly_domain_acquisition_invalid");
  return freeze(result);
}

function manifestRunId(input) {
  return `weekly-run-v1|sha256:${sha256({ intentId: input.intent.intentId,
    requestKind: input.intent.requestKind, discoveryIdentity: input.discovery.discoveryIdentity,
    sourceDate: input.discovery.sourceDate, requestId: input.requestId,
    expectedRoles: ROLES })}`;
}

function manifestRunIdFromRecord(value) {
  return `weekly-run-v1|sha256:${sha256({ intentId: value.intentId,
    requestKind: value.requestKind, discoveryIdentity: value.discoveryIdentity,
    sourceDate: value.sourceDate, requestId: value.requestId,
    expectedRoles: ROLES })}`;
}

const MANIFEST_FIELDS = Object.freeze([
  "contractVersion", "manifestId", "sourceFamily", "intentId", "requestKind",
  "discoveryIdentity", "sourceDate", "runId", "requestId", "expectedRoles",
  "futuresDescriptor", "optionsDescriptor", "dateAuthority", "parserAuthorities",
  "promotionPolicy", "authorityKeyId", "integritySha256", "authoritySignature"
]);

function manifestUnsigned(value) {
  return Object.fromEntries(MANIFEST_FIELDS.filter(field =>
    !["manifestId", "integritySha256", "authoritySignature"].includes(field))
    .map(field => [field, clone(value[field])]));
}

function validateManifest(value, authority, context = null) {
  if (!exact(value, MANIFEST_FIELDS) || value.contractVersion !== MANIFEST_VERSION ||
      !identity(value.manifestId, "weekly-manifest-v1") || value.sourceFamily !== SOURCE_FAMILY ||
      !identity(value.intentId, "weekly-intent-v1") || !REQUEST_KINDS.includes(value.requestKind) ||
      !identity(value.discoveryIdentity, "weekly-discovery-v1") || !sourceDate(value.sourceDate) ||
      !identity(value.runId, "weekly-run-v1") || !identifier(value.requestId) ||
      value.runId !== manifestRunIdFromRecord(value) ||
      stable(value.expectedRoles) !== stable(ROLES) ||
      !validateDomainAcquisition(value.futuresDescriptor, value.runId) ||
      value.futuresDescriptor.role !== "weekly_futures_workbook" ||
      !validateDomainAcquisition(value.optionsDescriptor, value.runId) ||
      value.optionsDescriptor.role !== "weekly_options_workbook" ||
      value.futuresDescriptor.sourceDate !== value.sourceDate ||
      value.optionsDescriptor.sourceDate !== value.sourceDate ||
      stable(value.dateAuthority) !== stable(DATE_AUTHORITY) ||
      stable(value.parserAuthorities) !== stable(PARSER_AUTHORITIES) ||
      stable(value.promotionPolicy) !== stable(PROMOTION_POLICY) ||
      !validAuthority(authority) || value.authorityKeyId !== authority.keyId ||
      !digest(value.integritySha256) || !digest(value.authoritySignature)) return false;
  const integrity = sha256(manifestUnsigned(value));
  if (value.integritySha256 !== integrity ||
      value.manifestId !== `weekly-manifest-v1|sha256:${integrity}` ||
      !authority.verify("acquisition_manifest", integrity, value.authoritySignature)) return false;
  if (context) {
    if (!exact(context, ["intent", "discovery"]) ||
        !validateAcquisitionIntent(context.intent) ||
        !validateDiscovery(context.discovery, context.intent) ||
        value.intentId !== context.intent.intentId ||
        value.requestKind !== context.intent.requestKind ||
        value.discoveryIdentity !== context.discovery.discoveryIdentity ||
        value.sourceDate !== context.discovery.sourceDate ||
        value.runId !== manifestRunId({ intent: context.intent, discovery: context.discovery,
          requestId: value.requestId })) return false;
  }
  return true;
}

function createManifest(input, authority) {
  if (!exact(input, ["intent", "discovery", "requestId"]) ||
      !validateAcquisitionIntent(input.intent) ||
      !validateDiscovery(input.discovery, input.intent) || !identifier(input.requestId) ||
      !validAuthority(authority)) throw new TypeError("weekly_manifest_input_invalid");
  const runId = manifestRunId(input);
  const result = { contractVersion: MANIFEST_VERSION, manifestId: "",
    sourceFamily: SOURCE_FAMILY, intentId: input.intent.intentId,
    requestKind: input.intent.requestKind, discoveryIdentity: input.discovery.discoveryIdentity,
    sourceDate: input.discovery.sourceDate, runId, requestId: input.requestId,
    expectedRoles: clone(ROLES),
    futuresDescriptor: clone(createDomainAcquisition(runId, "weekly_futures_workbook",
      input.discovery.sourceDate)),
    optionsDescriptor: clone(createDomainAcquisition(runId, "weekly_options_workbook",
      input.discovery.sourceDate)),
    dateAuthority: clone(DATE_AUTHORITY), parserAuthorities: clone(PARSER_AUTHORITIES),
    promotionPolicy: clone(PROMOTION_POLICY), authorityKeyId: authority.keyId,
    integritySha256: "", authoritySignature: "" };
  result.integritySha256 = sha256(manifestUnsigned(result));
  result.manifestId = `weekly-manifest-v1|sha256:${result.integritySha256}`;
  result.authoritySignature = authority.sign("acquisition_manifest", result.integritySha256);
  if (!validateManifest(result, authority,
    { intent: input.intent, discovery: input.discovery }))
    throw new TypeError("weekly_manifest_invalid");
  return freeze(result);
}

function evaluatePromotionBoundary(input) {
  if (!exact(input, ["discoveryStatus", "futuresStatus", "optionsStatus"]))
    throw new TypeError("weekly_promotion_input_invalid");
  const sharedStatuses = ["accepted", "discovery_failed", "listing_invalid",
    "source_date_unavailable", "manifest_invalid"];
  if (!sharedStatuses.includes(input.discoveryStatus) ||
      !["accepted", "futures_route_invalid"].includes(input.futuresStatus) ||
      !["accepted", "options_route_invalid"].includes(input.optionsStatus))
    throw new TypeError("weekly_promotion_status_invalid");
  if (input.discoveryStatus !== "accepted") {
    return freeze({ futures: { canPromote: false, reason: input.discoveryStatus },
      options: { canPromote: false, reason: input.discoveryStatus } });
  }
  return freeze({
    futures: { canPromote: input.futuresStatus === "accepted",
      reason: input.futuresStatus === "accepted" ? null : input.futuresStatus },
    options: { canPromote: input.optionsStatus === "accepted",
      reason: input.optionsStatus === "accepted" ? null : input.optionsStatus }
  });
}

module.exports = freeze({
  INTENT_VERSION, LISTING_ROUTE_VERSION, WORKBOOK_ROUTE_VERSION, LISTING_RESULT_VERSION,
  DISCOVERY_VERSION, ACQUISITION_VERSION, MANIFEST_VERSION, SOURCE_FAMILY, JPX_ORIGIN,
  LANDING_URL, LISTING_ROUTE_FAMILY, WORKBOOK_ROUTE_FAMILY, ROLES, REQUEST_KINDS,
  ROLE_AUTHORITY, DATE_AUTHORITY, PARSER_AUTHORITIES, PROMOTION_POLICY, HISTORY_SEMANTICS,
  FAILURE_REASONS, stable, sha256, sourceDate, createMainAuthority,
  createAcquisitionIntent, validateAcquisitionIntent, canonicalListingUrl, createListingRoute,
  validateListingRoute, workbookFilename, canonicalWorkbookUrl, createWorkbookRoute,
  validateWorkbookRoute, createListingResult, validateListingResult, createDiscovery,
  validateDiscovery, createDomainAcquisition, validateDomainAcquisition, createManifest,
  validateManifest, evaluatePromotionBoundary
});
