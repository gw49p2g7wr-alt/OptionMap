"use strict";

const crypto = require("node:crypto");

const INTENT_VERSION = "participants-acquisition-intent-v1";
const ROUTE_VERSION = "participants-workbook-route-v1";
const DISCOVERY_VERSION = "participants-official-discovery-v1";
const MANIFEST_VERSION = "participants-acquisition-manifest-v1";
const ACQUISITION_VERSION = "participants-workbook-acquisition-v1";
const COMPLETE_SET_VERSION = "participants-acquisition-set-v1";
const PARSER_BINDING_VERSION = "participants-parser-result-binding-v1";
const FALLBACK_POLICY_VERSION = "participants-fallback-policy-v1";

const SOURCE_FAMILY = "participants";
const SOURCE_ID = "jpx-daily-participant-volume";
const ROUTE_FAMILY = "jpx-participants-daily-workbook-v1";
const JPX_ORIGIN = "https://www.jpx.co.jp";
const CURRENT_INDEX_URL = `${JPX_ORIGIN}/markets/derivatives/participant-volume/index.html`;
const ROLE_ORDER = Object.freeze(["dayAuction", "dayJnet", "nightAuction", "nightJnet"]);
const ROLE_SUFFIXES = Object.freeze({
  dayAuction: "volume_by_participant_whole_day.xlsx",
  dayJnet: "volume_by_participant_whole_day_J-NET.xlsx",
  nightAuction: "volume_by_participant_night.xlsx",
  nightJnet: "volume_by_participant_night_J-NET.xlsx"
});
const REQUEST_KINDS = Object.freeze([
  "latest_available", "explicit_source_date", "historical_backfill_range"
]);
const DISCOVERY_KINDS = Object.freeze([
  "official_current_index", "official_monthly_listing", "bounded_day_probe"
]);
const PARSER_AUTHORITY = Object.freeze({
  parserId: "jpx-participant-volume-workbook",
  parserVersion: 1,
  spreadsheetLibrary: "sheetjs",
  spreadsheetLibraryVersion: "0.20.3",
  sheetSelection: "first_worksheet",
  columnMappingVersion: 1
});
const FALLBACK_POLICY = Object.freeze({
  contractVersion: FALLBACK_POLICY_VERSION,
  owner: "main",
  enabled: true,
  maxAttempts: 10,
  probeRole: "dayAuction",
  dateStep: "previous_calendar_day_skip_weekends",
  routeFamily: ROUTE_FAMILY
});

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
  throw new TypeError("participants_canonical_value_invalid");
}

const sha256 = value => crypto.createHash("sha256").update(stable(value)).digest("hex");

function sourceDate(value) {
  if (typeof value !== "string" || !/^20\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/.test(value))
    return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function compactDate(value) {
  return sourceDate(value) ? value.replaceAll("-", "") : null;
}

function sourceDateAllowed(intent, value) {
  if (!validateAcquisitionIntent(intent) || !sourceDate(value)) return false;
  if (intent.requestKind === "latest_available") return true;
  if (intent.requestKind === "explicit_source_date") return value === intent.targetDate;
  return value >= intent.startDate && value <= intent.endDate;
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
      !identity(value.intentId, "participants-intent-v1")) return false;
  if (value.requestKind === "latest_available") {
    if (value.targetDatePolicy !== "official_latest_then_bounded_probe" ||
        value.targetDate !== null || value.startDate !== null || value.endDate !== null) return false;
  } else if (value.requestKind === "explicit_source_date") {
    if (value.targetDatePolicy !== "exact_official_source_date" || !sourceDate(value.targetDate) ||
        value.startDate !== null || value.endDate !== null) return false;
  } else if (value.targetDatePolicy !== "official_listing_range" || value.targetDate !== null ||
      !sourceDate(value.startDate) || !sourceDate(value.endDate) || value.startDate > value.endDate) {
    return false;
  }
  return value.intentId === `participants-intent-v1|sha256:${sha256(intentMaterial(value))}`;
}

function createAcquisitionIntent(input) {
  if (!object(input)) throw new TypeError("participants_intent_invalid");
  let result;
  if (exact(input, ["requestKind"]) && input.requestKind === "latest_available") {
    result = { contractVersion: INTENT_VERSION, intentId: "", requestKind: input.requestKind,
      targetDatePolicy: "official_latest_then_bounded_probe", targetDate: null,
      startDate: null, endDate: null };
  } else if (exact(input, ["requestKind", "targetDate"]) &&
      input.requestKind === "explicit_source_date") {
    result = { contractVersion: INTENT_VERSION, intentId: "", requestKind: input.requestKind,
      targetDatePolicy: "exact_official_source_date", targetDate: input.targetDate,
      startDate: null, endDate: null };
  } else if (exact(input, ["requestKind", "startDate", "endDate"]) &&
      input.requestKind === "historical_backfill_range") {
    result = { contractVersion: INTENT_VERSION, intentId: "", requestKind: input.requestKind,
      targetDatePolicy: "official_listing_range", targetDate: null,
      startDate: input.startDate, endDate: input.endDate };
  } else throw new TypeError("participants_intent_fields_invalid");
  result.intentId = `participants-intent-v1|sha256:${sha256(intentMaterial(result))}`;
  if (!validateAcquisitionIntent(result)) throw new TypeError("participants_intent_invalid");
  return freeze(result);
}

function createMainAuthority({ keyId, secret } = {}) {
  if (!identifier(keyId, 96)) throw new TypeError("participants_authority_key_id_invalid");
  const key = Buffer.isBuffer(secret) ? Buffer.from(secret) :
    typeof secret === "string" ? Buffer.from(secret, "utf8") : null;
  if (!key || key.byteLength < 32) throw new TypeError("participants_authority_secret_invalid");
  const sign = (kind, integrity) => crypto.createHmac("sha256", key)
    .update(`optionmap-participants-authority-v1\0${kind}\0${integrity}`).digest("hex");
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

function workbookFilename(role, date) {
  const compact = compactDate(date), suffix = ROLE_SUFFIXES[role];
  return compact && suffix ? `${compact}_${suffix}` : null;
}

function canonicalWorkbookUrl(role, date) {
  const compact = compactDate(date), filename = workbookFilename(role, date);
  if (!compact || !filename) return null;
  return `${JPX_ORIGIN}/automation/markets/derivatives/participant-volume/files/daily/` +
    `${compact.slice(0, 6)}/${filename}`;
}

function monthlyListingUrl(date) {
  const compact = compactDate(date);
  return compact ? `${JPX_ORIGIN}/automation/markets/derivatives/participant-volume/json/` +
    `participant_volume_${compact.slice(0, 6)}.json` : null;
}

function exactCanonicalUrl(value, expected) {
  if (typeof value !== "string" || value !== expected) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === "www.jpx.co.jp" && !parsed.port &&
      !parsed.username && !parsed.password && !parsed.search && !parsed.hash && parsed.href === expected;
  } catch (_error) { return false; }
}

const ROUTE_FIELDS = Object.freeze([
  "contractVersion", "routeIdentity", "routeFamily", "sourceFamily", "sourceId",
  "sourceDate", "role", "scheme", "host", "path", "filename", "suffix", "canonicalUrl"
]);

function routeMaterial(value) {
  return Object.fromEntries(ROUTE_FIELDS.filter(field => field !== "routeIdentity")
    .map(field => [field, value[field]]));
}

function validateRouteDescriptor(value) {
  if (!exact(value, ROUTE_FIELDS) || value.contractVersion !== ROUTE_VERSION ||
      value.routeFamily !== ROUTE_FAMILY || value.sourceFamily !== SOURCE_FAMILY ||
      value.sourceId !== SOURCE_ID || !sourceDate(value.sourceDate) ||
      !ROLE_ORDER.includes(value.role) || value.scheme !== "https" ||
      value.host !== "www.jpx.co.jp" || value.suffix !== ROLE_SUFFIXES[value.role] ||
      value.filename !== workbookFilename(value.role, value.sourceDate) ||
      !identity(value.routeIdentity, "participants-route-v1")) return false;
  const expected = canonicalWorkbookUrl(value.role, value.sourceDate);
  if (!exactCanonicalUrl(value.canonicalUrl, expected)) return false;
  const parsed = new URL(expected);
  if (value.path !== parsed.pathname) return false;
  return value.routeIdentity === `participants-route-v1|sha256:${sha256(routeMaterial(value))}`;
}

function createRouteDescriptor(role, date) {
  const canonicalUrl = canonicalWorkbookUrl(role, date);
  if (!canonicalUrl) throw new TypeError("participants_route_authority_invalid");
  const parsed = new URL(canonicalUrl);
  const result = { contractVersion: ROUTE_VERSION, routeIdentity: "",
    routeFamily: ROUTE_FAMILY, sourceFamily: SOURCE_FAMILY, sourceId: SOURCE_ID,
    sourceDate: date, role, scheme: "https", host: "www.jpx.co.jp", path: parsed.pathname,
    filename: workbookFilename(role, date), suffix: ROLE_SUFFIXES[role], canonicalUrl };
  result.routeIdentity = `participants-route-v1|sha256:${sha256(routeMaterial(result))}`;
  if (!validateRouteDescriptor(result)) throw new TypeError("participants_route_invalid");
  return freeze(result);
}

function createRouteSet(date) {
  if (!sourceDate(date)) throw new TypeError("participants_source_date_invalid");
  return freeze(ROLE_ORDER.map(role => createRouteDescriptor(role, date)));
}

function validateSourceUrls(value, routes) {
  return exact(value, ROLE_ORDER) && routes.every(route =>
    value[route.role] === route.canonicalUrl);
}

const DISCOVERY_FIELDS = Object.freeze([
  "contractVersion", "discoveryIdentity", "discoveryKind", "discoveryRequestId",
  "intentId", "requestKind", "sourceFamily", "sourceId", "officialUrl",
  "sourceDate", "fallbackAttempt", "routes"
]);

function discoveryMaterial(value) {
  return Object.fromEntries(DISCOVERY_FIELDS.filter(field => field !== "discoveryIdentity")
    .map(field => [field, clone(value[field])]));
}

function validDiscoveryAuthority(value) {
  if (value.discoveryKind === "official_current_index") {
    return value.requestKind === "latest_available" && value.officialUrl === CURRENT_INDEX_URL &&
      value.fallbackAttempt === null;
  }
  if (value.discoveryKind === "official_monthly_listing") {
    return ["explicit_source_date", "historical_backfill_range"].includes(value.requestKind) &&
      value.officialUrl === monthlyListingUrl(value.sourceDate) && value.fallbackAttempt === null;
  }
  return value.discoveryKind === "bounded_day_probe" && value.requestKind === "latest_available" &&
    value.officialUrl === canonicalWorkbookUrl(FALLBACK_POLICY.probeRole, value.sourceDate) &&
    Number.isSafeInteger(value.fallbackAttempt) && value.fallbackAttempt >= 1 &&
    value.fallbackAttempt <= FALLBACK_POLICY.maxAttempts;
}

function validateDiscoveryResult(value) {
  if (!exact(value, DISCOVERY_FIELDS) || value.contractVersion !== DISCOVERY_VERSION ||
      !identity(value.discoveryIdentity, "participants-discovery-v1") ||
      !DISCOVERY_KINDS.includes(value.discoveryKind) || !identifier(value.discoveryRequestId) ||
      !identity(value.intentId, "participants-intent-v1") ||
      !REQUEST_KINDS.includes(value.requestKind) || value.sourceFamily !== SOURCE_FAMILY ||
      value.sourceId !== SOURCE_ID || !sourceDate(value.sourceDate) ||
      !Array.isArray(value.routes) || value.routes.length !== ROLE_ORDER.length ||
      value.routes.some((route, index) => route.role !== ROLE_ORDER[index] ||
        route.sourceDate !== value.sourceDate || !validateRouteDescriptor(route)) ||
      !validDiscoveryAuthority(value)) return false;
  return value.discoveryIdentity ===
    `participants-discovery-v1|sha256:${sha256(discoveryMaterial(value))}`;
}

function discoveryMatchesIntent(discovery, intent) {
  return validateDiscoveryResult(discovery) && validateAcquisitionIntent(intent) &&
    discovery.intentId === intent.intentId && discovery.requestKind === intent.requestKind &&
    sourceDateAllowed(intent, discovery.sourceDate);
}

function createOfficialDiscovery(input) {
  if (!exact(input, ["intent", "discoveryKind", "discoveryRequestId", "officialUrl",
    "sourceDate", "sourceUrls", "fallbackAttempt"]) ||
      !validateAcquisitionIntent(input.intent) || !sourceDateAllowed(input.intent, input.sourceDate)) {
    throw new TypeError("participants_discovery_input_invalid");
  }
  const routes = createRouteSet(input.sourceDate);
  if (!validateSourceUrls(input.sourceUrls, routes))
    throw new TypeError("participants_discovery_routes_invalid");
  const result = { contractVersion: DISCOVERY_VERSION, discoveryIdentity: "",
    discoveryKind: input.discoveryKind, discoveryRequestId: input.discoveryRequestId,
    intentId: input.intent.intentId, requestKind: input.intent.requestKind,
    sourceFamily: SOURCE_FAMILY, sourceId: SOURCE_ID, officialUrl: input.officialUrl,
    sourceDate: input.sourceDate, fallbackAttempt: input.fallbackAttempt, routes: clone(routes) };
  result.discoveryIdentity =
    `participants-discovery-v1|sha256:${sha256(discoveryMaterial(result))}`;
  if (!validateDiscoveryResult(result) || !discoveryMatchesIntent(result, input.intent))
    throw new TypeError("participants_discovery_invalid");
  return freeze(result);
}

function participantRouteFromUrl(value) {
  if (typeof value !== "string") return null;
  for (const role of ROLE_ORDER) {
    const match = value.match(/\/(20\d{6})_[^/]+\.xlsx$/);
    if (!match) continue;
    const compact = match[1], date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6)}`;
    if (sourceDate(date) && exactCanonicalUrl(value, canonicalWorkbookUrl(role, date)))
      return { role, sourceDate: date, canonicalUrl: value };
  }
  return null;
}

function discoverLatestParticipantsSourceSet({ intent, indexFacts } = {}) {
  if (!validateAcquisitionIntent(intent) || intent.requestKind !== "latest_available" ||
      !exact(indexFacts, ["indexUrl", "hrefs", "discoveryRequestId"]) ||
      indexFacts.indexUrl !== CURRENT_INDEX_URL || !Array.isArray(indexFacts.hrefs) ||
      !identifier(indexFacts.discoveryRequestId)) return freeze({ accepted: false,
        reason: "latest_discovery_input_invalid", discovery: null, fallbackPolicy: FALLBACK_POLICY });
  const byDate = new Map();
  for (const href of indexFacts.hrefs) {
    let absolute;
    try { absolute = new URL(href, JPX_ORIGIN).href; } catch (_error) { continue; }
    const parsed = participantRouteFromUrl(absolute);
    if (!parsed) continue;
    const roles = byDate.get(parsed.sourceDate) || {};
    roles[parsed.role] = parsed.canonicalUrl;
    byDate.set(parsed.sourceDate, roles);
  }
  const date = [...byDate.keys()].sort().at(-1);
  if (!date) return freeze({ accepted: false, reason: "official_index_empty",
    discovery: null, fallbackPolicy: FALLBACK_POLICY });
  const sourceUrls = byDate.get(date);
  const missingRoles = ROLE_ORDER.filter(role => !sourceUrls[role]);
  if (missingRoles.length) return freeze({ accepted: false,
    reason: "latest_source_set_incomplete", sourceDate: date, missingRoles,
    discovery: null, fallbackPolicy: FALLBACK_POLICY });
  try {
    const discovery = createOfficialDiscovery({ intent, discoveryKind: "official_current_index",
      discoveryRequestId: indexFacts.discoveryRequestId, officialUrl: CURRENT_INDEX_URL,
      sourceDate: date, sourceUrls, fallbackAttempt: null });
    return freeze({ accepted: true, reason: null, discovery, fallbackPolicy: FALLBACK_POLICY });
  } catch (_error) {
    return freeze({ accepted: false, reason: "official_index_invalid",
      discovery: null, fallbackPolicy: FALLBACK_POLICY });
  }
}

const MANIFEST_FIELDS = Object.freeze([
  "contractVersion", "manifestId", "sourceFamily", "sourceId", "intentId", "requestKind",
  "discoveryIdentity", "sourceDate", "runId", "requestId", "routes", "parserAuthority",
  "authorityKeyId", "integritySha256", "authoritySignature"
]);

function manifestUnsigned(value) {
  return Object.fromEntries(MANIFEST_FIELDS.filter(field =>
    !["manifestId", "integritySha256", "authoritySignature"].includes(field))
    .map(field => [field, clone(value[field])]));
}

function manifestRunId(value) {
  return `participants-run-v1|sha256:${sha256({ sourceFamily: value.sourceFamily,
    sourceId: value.sourceId, intentId: value.intentId, requestKind: value.requestKind,
    discoveryIdentity: value.discoveryIdentity, sourceDate: value.sourceDate,
    requestId: value.requestId, routeIdentities: value.routes.map(route => route.routeIdentity) })}`;
}

function validateAcquisitionManifest(value, authority, context = null) {
  if (!exact(value, MANIFEST_FIELDS) || value.contractVersion !== MANIFEST_VERSION ||
      value.sourceFamily !== SOURCE_FAMILY || value.sourceId !== SOURCE_ID ||
      !identity(value.intentId, "participants-intent-v1") ||
      !REQUEST_KINDS.includes(value.requestKind) ||
      !identity(value.discoveryIdentity, "participants-discovery-v1") || !sourceDate(value.sourceDate) ||
      !identity(value.runId, "participants-run-v1") || !identifier(value.requestId) ||
      !Array.isArray(value.routes) || value.routes.length !== ROLE_ORDER.length ||
      value.routes.some((route, index) => route.role !== ROLE_ORDER[index] ||
        route.sourceDate !== value.sourceDate || !validateRouteDescriptor(route)) ||
      stable(value.parserAuthority) !== stable(PARSER_AUTHORITY) || !validAuthority(authority) ||
      value.authorityKeyId !== authority.keyId || !digest(value.integritySha256) ||
      !digest(value.authoritySignature) || !identity(value.manifestId, "participants-manifest-v1") ||
      value.runId !== manifestRunId(value)) return false;
  const integrity = sha256(manifestUnsigned(value));
  if (value.integritySha256 !== integrity ||
      value.manifestId !== `participants-manifest-v1|sha256:${integrity}` ||
      !authority.verify("acquisition_manifest", integrity, value.authoritySignature)) return false;
  if (context) {
    if (!exact(context, ["intent", "discovery"]) ||
        !discoveryMatchesIntent(context.discovery, context.intent) ||
        value.intentId !== context.intent.intentId || value.requestKind !== context.intent.requestKind ||
        value.discoveryIdentity !== context.discovery.discoveryIdentity ||
        value.sourceDate !== context.discovery.sourceDate ||
        stable(value.routes) !== stable(context.discovery.routes)) return false;
  }
  return true;
}

function createAcquisitionManifest(input, authority) {
  if (!validAuthority(authority) || !exact(input, ["intent", "discovery", "requestId"]) ||
      !discoveryMatchesIntent(input.discovery, input.intent) || !identifier(input.requestId))
    throw new TypeError("participants_manifest_input_invalid");
  const result = { contractVersion: MANIFEST_VERSION, manifestId: "",
    sourceFamily: SOURCE_FAMILY, sourceId: SOURCE_ID, intentId: input.intent.intentId,
    requestKind: input.intent.requestKind, discoveryIdentity: input.discovery.discoveryIdentity,
    sourceDate: input.discovery.sourceDate, runId: "", requestId: input.requestId,
    routes: clone(input.discovery.routes), parserAuthority: clone(PARSER_AUTHORITY),
    authorityKeyId: authority.keyId, integritySha256: "", authoritySignature: "" };
  result.runId = manifestRunId(result);
  result.integritySha256 = sha256(manifestUnsigned(result));
  result.manifestId = `participants-manifest-v1|sha256:${result.integritySha256}`;
  result.authoritySignature = authority.sign("acquisition_manifest", result.integritySha256);
  if (!validateAcquisitionManifest(result, authority,
    { intent: input.intent, discovery: input.discovery }))
    throw new TypeError("participants_manifest_invalid");
  return freeze(result);
}

const ACQUISITION_FIELDS = Object.freeze([
  "contractVersion", "acquisitionId", "manifestId", "runId", "requestId",
  "sourceFamily", "sourceId", "sourceDate", "role", "routeIdentity", "canonicalUrl"
]);

function acquisitionMaterial(value) {
  return Object.fromEntries(ACQUISITION_FIELDS.filter(field => field !== "acquisitionId")
    .map(field => [field, value[field]]));
}

function validateWorkbookAcquisition(value, manifest, authority) {
  if (!exact(value, ACQUISITION_FIELDS) ||
      !validateAcquisitionManifest(manifest, authority) ||
      value.contractVersion !== ACQUISITION_VERSION ||
      !identity(value.acquisitionId, "participants-workbook-acquisition-v1") ||
      value.manifestId !== manifest.manifestId || value.runId !== manifest.runId ||
      value.requestId !== manifest.requestId || value.sourceFamily !== SOURCE_FAMILY ||
      value.sourceId !== SOURCE_ID || value.sourceDate !== manifest.sourceDate ||
      !ROLE_ORDER.includes(value.role)) return false;
  const route = manifest.routes.find(item => item.role === value.role);
  return Boolean(route) && value.routeIdentity === route.routeIdentity &&
    value.canonicalUrl === route.canonicalUrl && value.acquisitionId ===
      `participants-workbook-acquisition-v1|sha256:${sha256(acquisitionMaterial(value))}`;
}

function createWorkbookAcquisitions(manifest, authority) {
  if (!validateAcquisitionManifest(manifest, authority))
    throw new TypeError("participants_acquisition_manifest_invalid");
  return freeze(manifest.routes.map(route => {
    const value = { contractVersion: ACQUISITION_VERSION, acquisitionId: "",
      manifestId: manifest.manifestId, runId: manifest.runId, requestId: manifest.requestId,
      sourceFamily: SOURCE_FAMILY, sourceId: SOURCE_ID, sourceDate: manifest.sourceDate,
      role: route.role, routeIdentity: route.routeIdentity, canonicalUrl: route.canonicalUrl };
    value.acquisitionId =
      `participants-workbook-acquisition-v1|sha256:${sha256(acquisitionMaterial(value))}`;
    if (!validateWorkbookAcquisition(value, manifest, authority))
      throw new TypeError("participants_workbook_acquisition_invalid");
    return value;
  }));
}

const COMPLETE_SET_FIELDS = Object.freeze([
  "contractVersion", "setIdentity", "manifestId", "runId", "sourceFamily", "sourceId",
  "sourceDate", "acquisitions"
]);

function completeSetMaterial(value) {
  return Object.fromEntries(COMPLETE_SET_FIELDS.filter(field => field !== "setIdentity")
    .map(field => [field, clone(value[field])]));
}

function validateCompleteSet(value, manifest, authority) {
  if (!exact(value, COMPLETE_SET_FIELDS) || value.contractVersion !== COMPLETE_SET_VERSION ||
      !identity(value.setIdentity, "participants-acquisition-set-v1") ||
      !validateAcquisitionManifest(manifest, authority) || value.manifestId !== manifest.manifestId ||
      value.runId !== manifest.runId || value.sourceFamily !== SOURCE_FAMILY ||
      value.sourceId !== SOURCE_ID || value.sourceDate !== manifest.sourceDate ||
      !Array.isArray(value.acquisitions) || value.acquisitions.length !== ROLE_ORDER.length ||
      value.acquisitions.some((item, index) => item.role !== ROLE_ORDER[index] ||
        !validateWorkbookAcquisition(item, manifest, authority))) return false;
  return new Set(value.acquisitions.map(item => item.role)).size === ROLE_ORDER.length &&
    value.setIdentity ===
      `participants-acquisition-set-v1|sha256:${sha256(completeSetMaterial(value))}`;
}

function createCompleteSet({ manifest, acquisitions } = {}, authority) {
  if (!validateAcquisitionManifest(manifest, authority) || !Array.isArray(acquisitions) ||
      acquisitions.length !== ROLE_ORDER.length) throw new TypeError("participants_set_input_invalid");
  const byRole = new Map();
  for (const acquisition of acquisitions) {
    if (!ROLE_ORDER.includes(acquisition?.role) || byRole.has(acquisition.role) ||
        !validateWorkbookAcquisition(acquisition, manifest, authority))
      throw new TypeError("participants_set_acquisition_invalid");
    byRole.set(acquisition.role, acquisition);
  }
  if (byRole.size !== ROLE_ORDER.length) throw new TypeError("participants_set_roles_incomplete");
  const ordered = ROLE_ORDER.map(role => clone(byRole.get(role)));
  const result = { contractVersion: COMPLETE_SET_VERSION, setIdentity: "",
    manifestId: manifest.manifestId, runId: manifest.runId, sourceFamily: SOURCE_FAMILY,
    sourceId: SOURCE_ID, sourceDate: manifest.sourceDate, acquisitions: ordered };
  result.setIdentity =
    `participants-acquisition-set-v1|sha256:${sha256(completeSetMaterial(result))}`;
  if (!validateCompleteSet(result, manifest, authority))
    throw new TypeError("participants_set_invalid");
  return freeze(result);
}

const PARSER_RESULT_FIELDS = Object.freeze([
  "manifestId", "setIdentity", "acquisitionId", "runId", "sourceFamily", "sourceId",
  "sourceDate", "role", "sourceUrl", "parserId", "parserVersion", "spreadsheetLibrary",
  "spreadsheetLibraryVersion", "sheetSelection", "columnMappingVersion", "canonicalSha256"
]);

function validateParserResult(value) {
  return exact(value, PARSER_RESULT_FIELDS) &&
    identity(value.manifestId, "participants-manifest-v1") &&
    identity(value.setIdentity, "participants-acquisition-set-v1") &&
    identity(value.acquisitionId, "participants-workbook-acquisition-v1") &&
    identity(value.runId, "participants-run-v1") && value.sourceFamily === SOURCE_FAMILY &&
    value.sourceId === SOURCE_ID && sourceDate(value.sourceDate) && ROLE_ORDER.includes(value.role) &&
    exactCanonicalUrl(value.sourceUrl, canonicalWorkbookUrl(value.role, value.sourceDate)) &&
    value.parserId === PARSER_AUTHORITY.parserId &&
    value.parserVersion === PARSER_AUTHORITY.parserVersion &&
    value.spreadsheetLibrary === PARSER_AUTHORITY.spreadsheetLibrary &&
    value.spreadsheetLibraryVersion === PARSER_AUTHORITY.spreadsheetLibraryVersion &&
    value.sheetSelection === PARSER_AUTHORITY.sheetSelection &&
    value.columnMappingVersion === PARSER_AUTHORITY.columnMappingVersion &&
    digest(value.canonicalSha256);
}

function parserBindingMaterial(value) {
  return Object.fromEntries(Object.keys(value).filter(field => field !== "bindingId")
    .map(field => [field, clone(value[field])]));
}

function bindParserResult({ manifest, completeSet, result } = {}, authority) {
  if (!validateAcquisitionManifest(manifest, authority))
    return freeze({ accepted: false, reason: "manifest_invalid", binding: null });
  if (!validateCompleteSet(completeSet, manifest, authority))
    return freeze({ accepted: false, reason: "complete_set_invalid", binding: null });
  if (!validateParserResult(result))
    return freeze({ accepted: false, reason: "parser_result_invalid", binding: null });
  const acquisition = completeSet.acquisitions.find(item => item.role === result.role);
  if (!acquisition || result.manifestId !== manifest.manifestId ||
      result.setIdentity !== completeSet.setIdentity || result.acquisitionId !== acquisition.acquisitionId ||
      result.runId !== manifest.runId || result.sourceDate !== manifest.sourceDate ||
      result.sourceUrl !== acquisition.canonicalUrl)
    return freeze({ accepted: false, reason: "parser_result_binding_mismatch", binding: null });
  const binding = { contractVersion: PARSER_BINDING_VERSION, bindingId: "",
    manifestId: result.manifestId, setIdentity: result.setIdentity,
    acquisitionId: result.acquisitionId, runId: result.runId,
    sourceFamily: result.sourceFamily, sourceId: result.sourceId,
    sourceDate: result.sourceDate, role: result.role, sourceUrl: result.sourceUrl,
    parserAuthority: clone(PARSER_AUTHORITY), canonicalSha256: result.canonicalSha256 };
  binding.bindingId =
    `participants-parser-binding-v1|sha256:${sha256(parserBindingMaterial(binding))}`;
  return freeze({ accepted: true, reason: null, binding: freeze(binding) });
}

module.exports = freeze({ INTENT_VERSION, ROUTE_VERSION, DISCOVERY_VERSION, MANIFEST_VERSION,
  ACQUISITION_VERSION, COMPLETE_SET_VERSION, PARSER_BINDING_VERSION, FALLBACK_POLICY_VERSION,
  SOURCE_FAMILY, SOURCE_ID, ROUTE_FAMILY, JPX_ORIGIN, CURRENT_INDEX_URL, ROLE_ORDER,
  ROLE_SUFFIXES, REQUEST_KINDS, DISCOVERY_KINDS, PARSER_AUTHORITY, FALLBACK_POLICY,
  stable, sha256, sourceDate, createMainAuthority, createAcquisitionIntent,
  validateAcquisitionIntent, workbookFilename, canonicalWorkbookUrl, monthlyListingUrl,
  createRouteDescriptor, createRouteSet, validateRouteDescriptor, createOfficialDiscovery,
  validateDiscoveryResult, discoveryMatchesIntent, discoverLatestParticipantsSourceSet,
  createAcquisitionManifest, validateAcquisitionManifest, createWorkbookAcquisitions,
  validateWorkbookAcquisition, createCompleteSet, validateCompleteSet,
  validateParserResult, bindParserResult });
