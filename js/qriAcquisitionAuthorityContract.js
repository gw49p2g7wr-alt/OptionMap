"use strict";

const crypto = require("node:crypto");

const INTENT_VERSION = "qri-acquisition-intent-v1";
const ROUTE_VERSION = "qri-route-descriptor-v1";
const MANIFEST_VERSION = "qri-parent-manifest-v1";
const ACQUISITION_VERSION = "qri-main-acquisition-identity-v1";
const RECEIPT_VERSION = "qri-acquisition-receipt-v1";
const RECEIPT_V2_VERSION = "qri-acquisition-receipt-v2";
const RECEIPT_V3_VERSION = "qri-acquisition-receipt-v3";
const PARSER_INPUT_VERSION = "qri-parser-input-identity-v1";
const TRANSPORT_IDENTITY_VERSION = "qri-transport-identity-v1";
const TRANSPORT_PLACEHOLDER_VERSION = "qri-transport-identity-placeholder-v1";
const EVIDENCE_PLACEHOLDER_VERSION = "qri-evidence-status-placeholder-v1";
const EVIDENCE_STATUS_VERSION = "qri-evidence-status-v1";
const EVIDENCE_CONTEXT_VERSION = "qri-evidence-context-v1";
const PARSER_BINDING_VERSION = "qri-parser-result-binding-v1";
const IV_INHERITANCE_VERSION = "qri-iv-receipt-inheritance-v1";
const IV_INHERITANCE_V2_VERSION = "qri-iv-receipt-inheritance-v2";

const SOURCE_FAMILY = "qri";
const SOURCE_ID = "qri-nikkei225-options";
const IV_SOURCE_ID = "qri-nikkei225-option-iv";
const FUTURES_SOURCE_ID = "qri-nikkei225-futures";
const ROUTE_FAMILY = "qri-nikkei225-options-route-v1";
const MANIFEST_PARSER_ID = "qri-options-contract-manifest";
const MANIFEST_PARSER_VERSION = 2;
const QRI_ORIGIN = "https://svc.qri.jp";
const ACTIVE_URL = `${QRI_ORIGIN}/jpx/nkopm/`;
const ROLES = Object.freeze(["active", "next", "major_sq"]);
const REFERENCE_ROLES = Object.freeze(["next", "major_sq"]);

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const text = (value, maximum = 192) => typeof value === "string" && value.length > 0 &&
  value.length <= maximum && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const contract = value => typeof value === "string" && /^20\d{2}-(0[1-9]|1[0-2])$/.test(value);
const gengetsu = value => typeof value === "string" && /^20\d{2}(0[1-9]|1[0-2])$/.test(value);
const date = value => typeof value === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const identifier = (value, maximum = 192) => text(value, maximum) &&
  /^[A-Za-z0-9][A-Za-z0-9._:|+-]*$/.test(value) && !value.includes("..");
const identity = (value, prefix) => typeof value === "string" &&
  new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|sha256:[0-9a-f]{64}$`).test(value);
const receiptIdentity = value => identity(value, "qri-receipt-v1") ||
  identity(value, "qri-receipt-v2") || identity(value, "qri-receipt-v3");

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function stable(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  throw new TypeError("canonical_value_invalid");
}

const sha256 = value => crypto.createHash("sha256").update(stable(value)).digest("hex");

function canonicalContractIdentity(value) {
  if (!object(value)) return null;
  const canonicalContract = value.contract;
  const canonicalGengetsu = value.gengetsu;
  if (!exact(value, ["contract", "gengetsu"]) || !contract(canonicalContract) ||
      !gengetsu(canonicalGengetsu) || canonicalGengetsu !== canonicalContract.replace("-", "")) return null;
  return { contract: canonicalContract, gengetsu: canonicalGengetsu };
}

function createContractIdentity(value) {
  const contractValue = typeof value === "string" ? value : value?.contract;
  const result = canonicalContractIdentity({ contract: contractValue,
    gengetsu: contractValue?.replace("-", "") });
  if (!result) throw new TypeError("qri_contract_identity_invalid");
  return freeze(result);
}

function canonicalQriUrl(value, { active = false } = {}) {
  if (typeof value !== "string" || value !== value.trim() || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.hostname !== "svc.qri.jp" || parsed.port ||
        parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const path = parsed.pathname.replace(/\/+$/, "");
    if (active) return path === "/jpx/nkopm" ? ACTIVE_URL : null;
    if (!/^\/jpx\/nkopm\/\d+$/.test(path)) return null;
    return `${QRI_ORIGIN}${path}`;
  } catch (_error) { return null; }
}

function createMainAuthority({ keyId, secret }) {
  if (!identifier(keyId, 96)) throw new TypeError("qri_authority_key_id_invalid");
  const key = Buffer.isBuffer(secret) ? Buffer.from(secret) :
    typeof secret === "string" ? Buffer.from(secret, "utf8") : null;
  if (!key || key.byteLength < 32) throw new TypeError("qri_authority_secret_invalid");
  const sign = (kind, integrity) => crypto.createHmac("sha256", key)
    .update(`optionmap-qri-authority-v1\0${kind}\0${integrity}`).digest("hex");
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

const INTENT_FIELDS = Object.freeze([
  "contractVersion", "intentId", "requestKind", "role", "parentAcquisitionId", "listedContractId"
]);

function intentMaterial(value) {
  return { contractVersion: value.contractVersion, requestKind: value.requestKind,
    role: value.role, parentAcquisitionId: value.parentAcquisitionId,
    listedContractId: value.listedContractId };
}

function validateAcquisitionIntent(value) {
  if (!exact(value, INTENT_FIELDS) || value.contractVersion !== INTENT_VERSION ||
      !ROLES.includes(value.role) || !identity(value.intentId, "qri-intent-v1")) return false;
  if (value.requestKind === "active") {
    if (value.role !== "active" || value.parentAcquisitionId !== null ||
        value.listedContractId !== null) return false;
  } else if (value.requestKind === "listed_reference") {
    if (!REFERENCE_ROLES.includes(value.role) ||
        !identity(value.parentAcquisitionId, "qri-acquisition-v1") ||
        !identity(value.listedContractId, "qri-listed-contract-v1")) return false;
  } else return false;
  return value.intentId === `qri-intent-v1|sha256:${sha256(intentMaterial(value))}`;
}

function createAcquisitionIntent(input) {
  if (!object(input)) throw new TypeError("qri_intent_invalid");
  let result;
  if (exact(input, ["requestKind"]) && input.requestKind === "active") {
    result = { contractVersion: INTENT_VERSION, intentId: "", requestKind: "active",
      role: "active", parentAcquisitionId: null, listedContractId: null };
  } else if (exact(input, ["requestKind", "role", "parentAcquisitionId", "listedContractId"]) &&
      input.requestKind === "listed_reference") {
    result = { contractVersion: INTENT_VERSION, intentId: "", requestKind: input.requestKind,
      role: input.role, parentAcquisitionId: input.parentAcquisitionId,
      listedContractId: input.listedContractId };
  } else throw new TypeError("qri_intent_fields_invalid");
  result.intentId = `qri-intent-v1|sha256:${sha256(intentMaterial(result))}`;
  if (!validateAcquisitionIntent(result)) throw new TypeError("qri_intent_invalid");
  return freeze(result);
}

const ROUTE_FIELDS = Object.freeze([
  "contractVersion", "routeIdentity", "routeFamily", "sourceFamily", "sourceId",
  "requestKind", "role", "scheme", "host", "path", "canonicalUrl", "contractIdentity",
  "parentAcquisitionId", "listedContractId"
]);

function routeMaterial(value) {
  return Object.fromEntries(ROUTE_FIELDS.filter(field => field !== "routeIdentity")
    .map(field => [field, clone(value[field])]));
}

function validateRouteDescriptor(value) {
  if (!exact(value, ROUTE_FIELDS) || value.contractVersion !== ROUTE_VERSION ||
      value.routeFamily !== ROUTE_FAMILY || value.sourceFamily !== SOURCE_FAMILY ||
      value.sourceId !== SOURCE_ID || value.scheme !== "https" || value.host !== "svc.qri.jp" ||
      !ROLES.includes(value.role) || !canonicalContractIdentity(value.contractIdentity) ||
      !identity(value.routeIdentity, "qri-route-v1")) return false;
  const active = value.requestKind === "active" && value.role === "active";
  const listed = value.requestKind === "listed_reference" && REFERENCE_ROLES.includes(value.role);
  if (!active && !listed) return false;
  const url = canonicalQriUrl(value.canonicalUrl, { active });
  if (!url || url !== value.canonicalUrl || new URL(url).pathname !== value.path) return false;
  if (active && (value.parentAcquisitionId !== null || value.listedContractId !== null)) return false;
  if (listed && (!identity(value.parentAcquisitionId, "qri-acquisition-v1") ||
      !identity(value.listedContractId, "qri-listed-contract-v1"))) return false;
  return value.routeIdentity === `qri-route-v1|sha256:${sha256(routeMaterial(value))}`;
}

function intentMatchesRoute(intent, route) {
  return validateAcquisitionIntent(intent) && validateRouteDescriptor(route) &&
    intent.requestKind === route.requestKind && intent.role === route.role &&
    intent.parentAcquisitionId === route.parentAcquisitionId &&
    intent.listedContractId === route.listedContractId;
}

function makeRoute({ intent, url, contractIdentity: contractValue }) {
  const canonicalUrl = canonicalQriUrl(url, { active: intent.requestKind === "active" });
  const canonicalContract = canonicalContractIdentity(contractValue);
  if (!canonicalUrl || !canonicalContract) throw new TypeError("qri_route_authority_invalid");
  const parsed = new URL(canonicalUrl);
  const result = { contractVersion: ROUTE_VERSION, routeIdentity: "",
    routeFamily: ROUTE_FAMILY, sourceFamily: SOURCE_FAMILY, sourceId: SOURCE_ID,
    requestKind: intent.requestKind, role: intent.role, scheme: "https", host: "svc.qri.jp",
    path: parsed.pathname, canonicalUrl, contractIdentity: canonicalContract,
    parentAcquisitionId: intent.parentAcquisitionId, listedContractId: intent.listedContractId };
  result.routeIdentity = `qri-route-v1|sha256:${sha256(routeMaterial(result))}`;
  if (!validateRouteDescriptor(result)) throw new TypeError("qri_route_invalid");
  return freeze(result);
}

const MANIFEST_ENTRY_FIELDS = Object.freeze([
  "listedContractId", "contractIdentity", "canonicalUrl", "path", "allowedRoles"
]);
const MANIFEST_FIELDS = Object.freeze([
  "contractVersion", "manifestId", "parentAcquisitionId", "parentReceiptId",
  "parentParserInputIdentity", "parserId", "parserVersion", "entries", "authorityKeyId",
  "integritySha256", "authoritySignature"
]);

function listedContractId(parentAcquisitionId, entry) {
  return `qri-listed-contract-v1|sha256:${sha256({ parentAcquisitionId,
    contractIdentity: entry.contractIdentity, canonicalUrl: entry.canonicalUrl })}`;
}

function validateParserInputIdentity(value) {
  if (!exact(value, ["contractVersion", "state", "sha256", "encoding", "rawContentSha256"]) ||
      value.contractVersion !== PARSER_INPUT_VERSION || !["pending_q2", "bound"].includes(value.state)) {
    return false;
  }
  if (value.state === "pending_q2") return value.sha256 === null && value.encoding === null &&
    value.rawContentSha256 === null;
  return digest(value.sha256) && text(value.encoding, 32) &&
    (value.rawContentSha256 === null || digest(value.rawContentSha256));
}

function createParserInputIdentity(input = { state: "pending_q2" }) {
  if (!object(input)) throw new TypeError("qri_parser_input_identity_invalid");
  const result = input.state === "pending_q2" && exact(input, ["state"])
    ? { contractVersion: PARSER_INPUT_VERSION, state: "pending_q2", sha256: null,
      encoding: null, rawContentSha256: null }
    : exact(input, ["state", "sha256", "encoding", "rawContentSha256"])
      ? { contractVersion: PARSER_INPUT_VERSION, state: input.state, sha256: input.sha256,
        encoding: input.encoding, rawContentSha256: input.rawContentSha256 }
      : null;
  if (!validateParserInputIdentity(result)) throw new TypeError("qri_parser_input_identity_invalid");
  return freeze(result);
}

function manifestUnsigned(value) {
  return Object.fromEntries(MANIFEST_FIELDS.filter(field =>
    !["manifestId", "integritySha256", "authoritySignature"].includes(field))
    .map(field => [field, clone(value[field])]));
}

function manifestIntegrity(value) {
  return sha256(manifestUnsigned(value));
}

function validateManifestEntry(entry, parentAcquisitionId, parentContract) {
  if (!exact(entry, MANIFEST_ENTRY_FIELDS) || !canonicalContractIdentity(entry.contractIdentity) ||
      entry.contractIdentity.contract <= parentContract ||
      !Array.isArray(entry.allowedRoles) || entry.allowedRoles.length === 0 ||
      entry.allowedRoles.some(role => !REFERENCE_ROLES.includes(role)) ||
      new Set(entry.allowedRoles).size !== entry.allowedRoles.length ||
      stable(entry.allowedRoles) !== stable([...entry.allowedRoles].sort())) return false;
  const url = canonicalQriUrl(entry.canonicalUrl);
  return url === entry.canonicalUrl && new URL(url).pathname === entry.path &&
    entry.listedContractId === listedContractId(parentAcquisitionId, entry);
}

function validateParentManifest(value, parentReceipt, authority) {
  if (!exact(value, MANIFEST_FIELDS) || value.contractVersion !== MANIFEST_VERSION ||
      !identity(value.manifestId, "qri-parent-manifest-v1") ||
      !identity(value.parentAcquisitionId, "qri-acquisition-v1") ||
      !receiptIdentity(value.parentReceiptId) ||
      !validateParserInputIdentity(value.parentParserInputIdentity) ||
      value.parserId !== MANIFEST_PARSER_ID || value.parserVersion !== MANIFEST_PARSER_VERSION ||
      !Array.isArray(value.entries) || value.entries.length === 0 ||
      value.authorityKeyId !== authority?.keyId || !digest(value.integritySha256) ||
      !digest(value.authoritySignature) || !validAuthority(authority) ||
      !validateAcquisitionReceipt(parentReceipt, authority) || parentReceipt.role !== "active" ||
      value.parentAcquisitionId !== parentReceipt.acquisitionId ||
      value.parentReceiptId !== parentReceipt.receiptId ||
      stable(value.parentParserInputIdentity) !== stable(parentReceipt.parserInputIdentity)) return false;
  if (value.entries.some(entry => !validateManifestEntry(entry, value.parentAcquisitionId,
      parentReceipt.contractIdentity.contract))) return false;
  const ids = value.entries.map(entry => entry.listedContractId);
  const contracts = value.entries.map(entry => entry.contractIdentity.contract);
  const urls = value.entries.map(entry => entry.canonicalUrl);
  if (new Set(ids).size !== ids.length || new Set(contracts).size !== contracts.length ||
      new Set(urls).size !== urls.length || stable(ids) !== stable([...ids].sort())) return false;
  const integrity = manifestIntegrity(value);
  return value.integritySha256 === integrity &&
    value.manifestId === `qri-parent-manifest-v1|sha256:${integrity}` &&
    authority.verify("parent_manifest", integrity, value.authoritySignature);
}

function createParentManifest(input, authority) {
  if (!validAuthority(authority) || !exact(input, ["parentReceipt", "entries"]) ||
      !validateAcquisitionReceipt(input.parentReceipt, authority) || input.parentReceipt.role !== "active" ||
      !Array.isArray(input.entries) || input.entries.length === 0) {
    throw new TypeError("qri_parent_manifest_input_invalid");
  }
  const entries = input.entries.map(entry => {
    if (!exact(entry, ["contractIdentity", "canonicalUrl", "allowedRoles"])) {
      throw new TypeError("qri_parent_manifest_entry_fields_invalid");
    }
    const contractIdentity = canonicalContractIdentity(entry.contractIdentity);
    const canonicalUrl = canonicalQriUrl(entry.canonicalUrl);
    const allowedRoles = Array.isArray(entry.allowedRoles) ? [...new Set(entry.allowedRoles)].sort() : null;
    if (!contractIdentity || !canonicalUrl || !allowedRoles) {
      throw new TypeError("qri_parent_manifest_entry_invalid");
    }
    const result = { listedContractId: "", contractIdentity, canonicalUrl,
      path: new URL(canonicalUrl).pathname, allowedRoles };
    result.listedContractId = listedContractId(input.parentReceipt.acquisitionId, result);
    return result;
  }).sort((left, right) => left.listedContractId.localeCompare(right.listedContractId));
  const result = { contractVersion: MANIFEST_VERSION, manifestId: "",
    parentAcquisitionId: input.parentReceipt.acquisitionId,
    parentReceiptId: input.parentReceipt.receiptId,
    parentParserInputIdentity: clone(input.parentReceipt.parserInputIdentity),
    parserId: MANIFEST_PARSER_ID, parserVersion: MANIFEST_PARSER_VERSION, entries,
    authorityKeyId: authority.keyId, integritySha256: "", authoritySignature: "" };
  result.integritySha256 = manifestIntegrity(result);
  result.manifestId = `qri-parent-manifest-v1|sha256:${result.integritySha256}`;
  result.authoritySignature = authority.sign("parent_manifest", result.integritySha256);
  if (!validateParentManifest(result, input.parentReceipt, authority)) {
    throw new TypeError("qri_parent_manifest_invalid");
  }
  return freeze(result);
}

function resolveQriIntent(intent, authorityContext = {}) {
  if (!validateAcquisitionIntent(intent) || !object(authorityContext)) {
    return freeze({ accepted: false, reason: "intent_invalid", route: null });
  }
  if (intent.requestKind === "active") {
    const contractIdentity = canonicalContractIdentity(authorityContext.activeContractIdentity);
    if (!contractIdentity) return freeze({ accepted: false,
      reason: "active_contract_authority_invalid", route: null });
    try { return freeze({ accepted: true, reason: null,
      route: makeRoute({ intent, url: ACTIVE_URL, contractIdentity }) }); }
    catch (_error) { return freeze({ accepted: false, reason: "route_invalid", route: null }); }
  }
  const { parentManifest, parentReceipt, authority } = authorityContext;
  if (!validateParentManifest(parentManifest, parentReceipt, authority)) {
    return freeze({ accepted: false, reason: "parent_manifest_invalid", route: null });
  }
  if (intent.parentAcquisitionId !== parentManifest.parentAcquisitionId) {
    return freeze({ accepted: false, reason: "parent_acquisition_mismatch", route: null });
  }
  const entry = parentManifest.entries.find(item => item.listedContractId === intent.listedContractId);
  if (!entry) return freeze({ accepted: false, reason: "listed_contract_unknown", route: null });
  if (!entry.allowedRoles.includes(intent.role)) {
    return freeze({ accepted: false, reason: "listed_role_not_allowed", route: null });
  }
  try { return freeze({ accepted: true, reason: null,
    route: makeRoute({ intent, url: entry.canonicalUrl,
      contractIdentity: entry.contractIdentity }) }); }
  catch (_error) { return freeze({ accepted: false, reason: "route_invalid", route: null }); }
}

const ACQUISITION_FIELDS = Object.freeze([
  "contractVersion", "acquisitionId", "intentId", "sourceFamily", "sourceId", "role",
  "routeIdentity", "contractIdentity", "parentAcquisitionId", "runId", "requestId",
  "authorityKeyId", "integritySha256", "authoritySignature"
]);

function acquisitionUnsigned(value) {
  return Object.fromEntries(ACQUISITION_FIELDS.filter(field =>
    !["acquisitionId", "integritySha256", "authoritySignature"].includes(field))
    .map(field => [field, clone(value[field])]));
}

function validateMainAcquisitionIdentity(value, intent, route, authority) {
  if (!exact(value, ACQUISITION_FIELDS) || value.contractVersion !== ACQUISITION_VERSION ||
      !intentMatchesRoute(intent, route) || !validAuthority(authority) ||
      !identity(value.acquisitionId, "qri-acquisition-v1") || value.intentId !== intent.intentId ||
      value.sourceFamily !== SOURCE_FAMILY || value.sourceId !== SOURCE_ID || value.role !== route.role ||
      value.routeIdentity !== route.routeIdentity ||
      stable(value.contractIdentity) !== stable(route.contractIdentity) ||
      value.parentAcquisitionId !== route.parentAcquisitionId || !identifier(value.runId) ||
      !identifier(value.requestId) || value.authorityKeyId !== authority.keyId ||
      !digest(value.integritySha256) || !digest(value.authoritySignature)) return false;
  const integrity = sha256(acquisitionUnsigned(value));
  return value.integritySha256 === integrity &&
    value.acquisitionId === `qri-acquisition-v1|sha256:${integrity}` &&
    authority.verify("acquisition_identity", integrity, value.authoritySignature);
}

function createMainAcquisitionIdentity(input, authority) {
  if (!validAuthority(authority) || !exact(input, ["intent", "route", "runId", "requestId"]) ||
      !intentMatchesRoute(input.intent, input.route)) {
    throw new TypeError("qri_acquisition_identity_input_invalid");
  }
  const result = { contractVersion: ACQUISITION_VERSION, acquisitionId: "",
    intentId: input.intent.intentId, sourceFamily: SOURCE_FAMILY, sourceId: SOURCE_ID,
    role: input.route.role, routeIdentity: input.route.routeIdentity,
    contractIdentity: clone(input.route.contractIdentity),
    parentAcquisitionId: input.route.parentAcquisitionId, runId: input.runId,
    requestId: input.requestId, authorityKeyId: authority.keyId,
    integritySha256: "", authoritySignature: "" };
  result.integritySha256 = sha256(acquisitionUnsigned(result));
  result.acquisitionId = `qri-acquisition-v1|sha256:${result.integritySha256}`;
  result.authoritySignature = authority.sign("acquisition_identity", result.integritySha256);
  if (!validateMainAcquisitionIdentity(result, input.intent, input.route, authority)) {
    throw new TypeError("qri_acquisition_identity_invalid");
  }
  return freeze(result);
}

const TRANSPORT_PLACEHOLDER = freeze({ contractVersion: TRANSPORT_PLACEHOLDER_VERSION,
  state: "pending_q2", identity: null });
const EVIDENCE_PLACEHOLDER = freeze({ contractVersion: EVIDENCE_PLACEHOLDER_VERSION,
  state: "not_activated", reason: "q2_q3_pending", rawContentSha256: null });
const EVIDENCE_STATUS_FIELDS = Object.freeze([
  "contractVersion", "state", "contentSha256", "occurrenceId", "sourceFamily", "sourceId",
  "role", "contextIdentity", "parentManifestId", "listedContractId"
]);
const REDIRECT_HOP_FIELDS = Object.freeze(["status", "fromUrl", "toUrl"]);
const TRANSPORT_IDENTITY_FIELDS = Object.freeze([
  "contractVersion", "httpStatus", "declaredContentType", "mediaType", "encoding",
  "byteLength", "contentSha256", "redirectHops"
]);
const RECEIPT_FIELDS = Object.freeze([
  "contractVersion", "receiptId", "acquisitionId", "intentId", "sourceFamily", "sourceId",
  "role", "contractIdentity", "routeIdentity", "parentAcquisitionId", "acceptedInitialUrl",
  "acceptedFinalUrl", "fetchedAt", "transportIdentity", "parserInputIdentity", "evidenceStatus",
  "authorityKeyId", "integritySha256", "authoritySignature"
]);

function receiptUnsigned(value) {
  return Object.fromEntries(RECEIPT_FIELDS.filter(field =>
    !["receiptId", "integritySha256", "authoritySignature"].includes(field))
    .map(field => [field, clone(value[field])]));
}

function validateTransportIdentity(value) {
  if (!exact(value, TRANSPORT_IDENTITY_FIELDS) ||
      value.contractVersion !== TRANSPORT_IDENTITY_VERSION || value.httpStatus !== 200 ||
      !text(value.declaredContentType, 256) || value.mediaType !== "text/html" ||
      !text(value.encoding, 32) || !Number.isSafeInteger(value.byteLength) ||
      value.byteLength < 0 || !digest(value.contentSha256) ||
      !Array.isArray(value.redirectHops) || value.redirectHops.length > 3) return false;
  return value.redirectHops.every(hop => exact(hop, REDIRECT_HOP_FIELDS) &&
    Number.isInteger(hop.status) && hop.status >= 300 && hop.status <= 399 &&
    canonicalQriUrl(hop.fromUrl, { active: Boolean(canonicalQriUrl(hop.fromUrl, { active: true })) }) &&
    canonicalQriUrl(hop.toUrl, { active: Boolean(canonicalQriUrl(hop.toUrl, { active: true })) }));
}

function createTransportIdentity(input) {
  if (!exact(input, ["httpStatus", "declaredContentType", "mediaType", "encoding",
    "byteLength", "contentSha256", "redirectHops"])) {
    throw new TypeError("qri_transport_identity_fields_invalid");
  }
  const result = { contractVersion: TRANSPORT_IDENTITY_VERSION,
    httpStatus: input.httpStatus, declaredContentType: input.declaredContentType,
    mediaType: input.mediaType, encoding: input.encoding, byteLength: input.byteLength,
    contentSha256: input.contentSha256, redirectHops: clone(input.redirectHops) };
  if (!validateTransportIdentity(result)) throw new TypeError("qri_transport_identity_invalid");
  return freeze(result);
}

function validateEvidenceStatus(value) {
  if (!exact(value, EVIDENCE_STATUS_FIELDS) || value.contractVersion !== EVIDENCE_STATUS_VERSION ||
      value.state !== "available" || !digest(value.contentSha256) ||
      !identity(value.occurrenceId, "source-occurrence-v1") ||
      value.sourceFamily !== SOURCE_FAMILY || value.sourceId !== SOURCE_ID ||
      !ROLES.includes(value.role) || !identity(value.contextIdentity, EVIDENCE_CONTEXT_VERSION)) {
    return false;
  }
  if (value.role === "active") {
    return value.parentManifestId === null && value.listedContractId === null;
  }
  return identity(value.parentManifestId, "qri-parent-manifest-v1") &&
    identity(value.listedContractId, "qri-listed-contract-v1");
}

function createEvidenceStatus(input) {
  if (!exact(input, ["contentSha256", "occurrenceId", "role", "contextIdentity",
    "parentManifestId", "listedContractId"])) throw new TypeError("qri_evidence_status_fields_invalid");
  const result = { contractVersion: EVIDENCE_STATUS_VERSION, state: "available",
    contentSha256: input.contentSha256, occurrenceId: input.occurrenceId,
    sourceFamily: SOURCE_FAMILY, sourceId: SOURCE_ID, role: input.role,
    contextIdentity: input.contextIdentity, parentManifestId: input.parentManifestId,
    listedContractId: input.listedContractId };
  if (!validateEvidenceStatus(result)) throw new TypeError("qri_evidence_status_invalid");
  return freeze(result);
}

function evidenceContextMaterial(acquisition, intent, route, parentManifestId) {
  return { contractVersion: EVIDENCE_CONTEXT_VERSION,
    acquisitionId: acquisition.acquisitionId, intentId: intent.intentId,
    sourceFamily: SOURCE_FAMILY, sourceId: SOURCE_ID, role: route.role,
    contractIdentity: clone(route.contractIdentity), routeIdentity: route.routeIdentity,
    canonicalUrl: route.canonicalUrl, parentAcquisitionId: route.parentAcquisitionId,
    parentManifestId, listedContractId: route.listedContractId,
    runId: acquisition.runId, requestId: acquisition.requestId };
}

function createEvidenceContextIdentity(input, authority) {
  if (!exact(input, ["acquisition", "intent", "route", "parentManifestId"]) ||
      !validateMainAcquisitionIdentity(input.acquisition, input.intent, input.route, authority)) {
    throw new TypeError("qri_evidence_context_input_invalid");
  }
  const active = input.route.role === "active";
  if (active ? input.parentManifestId !== null :
      !identity(input.parentManifestId, "qri-parent-manifest-v1")) {
    throw new TypeError("qri_evidence_context_parent_invalid");
  }
  return `${EVIDENCE_CONTEXT_VERSION}|sha256:${sha256(evidenceContextMaterial(
    input.acquisition, input.intent, input.route, input.parentManifestId))}`;
}

function receiptRouteMatches(value, route) {
  const active = route.requestKind === "active";
  const normalize = url => canonicalQriUrl(url, { active });
  if (normalize(value.acceptedInitialUrl) !== route.canonicalUrl ||
      normalize(value.acceptedFinalUrl) !== route.canonicalUrl) return false;
  if (value.contractVersion === RECEIPT_VERSION) return true;
  return value.transportIdentity.redirectHops.every(hop =>
    normalize(hop.fromUrl) === route.canonicalUrl && normalize(hop.toUrl) === route.canonicalUrl);
}

function validateAcquisitionReceipt(value, authority, context = null) {
  if (!exact(value, RECEIPT_FIELDS) ||
      ![RECEIPT_VERSION, RECEIPT_V2_VERSION, RECEIPT_V3_VERSION]
        .includes(value.contractVersion) ||
      !receiptIdentity(value.receiptId) ||
      !identity(value.acquisitionId, "qri-acquisition-v1") ||
      !identity(value.intentId, "qri-intent-v1") || value.sourceFamily !== SOURCE_FAMILY ||
      value.sourceId !== SOURCE_ID || !ROLES.includes(value.role) ||
      !canonicalContractIdentity(value.contractIdentity) ||
      !identity(value.routeIdentity, "qri-route-v1") ||
      value.parentAcquisitionId !== null &&
        !identity(value.parentAcquisitionId, "qri-acquisition-v1") ||
      !timestamp(value.fetchedAt) || !validAuthority(authority) ||
      value.authorityKeyId !== authority.keyId || !validateParserInputIdentity(value.parserInputIdentity) ||
      !digest(value.integritySha256) || !digest(value.authoritySignature)) return false;
  const v1 = value.contractVersion === RECEIPT_VERSION;
  const v3 = value.contractVersion === RECEIPT_V3_VERSION;
  if (v1 ? stable(value.transportIdentity) !== stable(TRANSPORT_PLACEHOLDER) :
      !validateTransportIdentity(value.transportIdentity) ||
      value.parserInputIdentity.state !== "bound" ||
      value.parserInputIdentity.rawContentSha256 !== value.transportIdentity.contentSha256 ||
      value.parserInputIdentity.encoding !== value.transportIdentity.encoding) return false;
  if (v3 ? !validateEvidenceStatus(value.evidenceStatus) ||
      value.evidenceStatus.contentSha256 !== value.transportIdentity.contentSha256 ||
      value.evidenceStatus.role !== value.role :
      stable(value.evidenceStatus) !== stable(EVIDENCE_PLACEHOLDER)) return false;
  const active = value.role === "active";
  const initial = canonicalQriUrl(value.acceptedInitialUrl, { active });
  const final = canonicalQriUrl(value.acceptedFinalUrl, { active });
  if (!initial || !final || initial !== value.acceptedInitialUrl || final !== value.acceptedFinalUrl ||
      initial !== final || active !== (value.parentAcquisitionId === null)) return false;
  if (!v1 && value.transportIdentity.redirectHops.some(hop =>
    canonicalQriUrl(hop.fromUrl, { active }) !== initial ||
    canonicalQriUrl(hop.toUrl, { active }) !== initial)) return false;
  const integrity = sha256(receiptUnsigned(value));
  const receiptPrefix = v1 ? "qri-receipt-v1" : v3 ? "qri-receipt-v3" : "qri-receipt-v2";
  const signatureKind = v1 ? "acquisition_receipt" : v3 ?
    "acquisition_receipt_v3" : "acquisition_receipt_v2";
  if (value.integritySha256 !== integrity ||
      value.receiptId !== `${receiptPrefix}|sha256:${integrity}` ||
      !authority.verify(signatureKind, integrity, value.authoritySignature)) return false;
  if (context) {
    const { acquisition, intent, route } = context;
    if (!validateMainAcquisitionIdentity(acquisition, intent, route, authority) ||
        value.acquisitionId !== acquisition.acquisitionId || value.intentId !== intent.intentId ||
        value.role !== route.role || value.routeIdentity !== route.routeIdentity ||
        stable(value.contractIdentity) !== stable(route.contractIdentity) ||
        !receiptRouteMatches(value, route)) return false;
    if (v3) {
      let contextIdentity;
      try { contextIdentity = createEvidenceContextIdentity({ acquisition, intent, route,
        parentManifestId: context.parentManifestId }, authority); }
      catch (_error) { return false; }
      if (value.evidenceStatus.contextIdentity !== contextIdentity ||
          value.evidenceStatus.parentManifestId !== context.parentManifestId ||
          value.evidenceStatus.listedContractId !== route.listedContractId) return false;
    }
  }
  return true;
}

function createAcquisitionReceiptV3(input, authority) {
  if (!validAuthority(authority) || !exact(input,
    ["acquisition", "intent", "route", "acceptedInitialUrl", "acceptedFinalUrl", "fetchedAt",
      "transportIdentity", "parserInputIdentity", "evidenceStatus", "parentManifestId"]) ||
      !validateMainAcquisitionIdentity(input.acquisition, input.intent, input.route, authority) ||
      !validateTransportIdentity(input.transportIdentity) ||
      !validateParserInputIdentity(input.parserInputIdentity) ||
      !validateEvidenceStatus(input.evidenceStatus)) {
    throw new TypeError("qri_receipt_v3_input_invalid");
  }
  const result = { contractVersion: RECEIPT_V3_VERSION, receiptId: "",
    acquisitionId: input.acquisition.acquisitionId, intentId: input.intent.intentId,
    sourceFamily: SOURCE_FAMILY, sourceId: SOURCE_ID, role: input.route.role,
    contractIdentity: clone(input.route.contractIdentity), routeIdentity: input.route.routeIdentity,
    parentAcquisitionId: input.route.parentAcquisitionId,
    acceptedInitialUrl: input.acceptedInitialUrl, acceptedFinalUrl: input.acceptedFinalUrl,
    fetchedAt: input.fetchedAt, transportIdentity: clone(input.transportIdentity),
    parserInputIdentity: clone(input.parserInputIdentity),
    evidenceStatus: clone(input.evidenceStatus), authorityKeyId: authority.keyId,
    integritySha256: "", authoritySignature: "" };
  result.integritySha256 = sha256(receiptUnsigned(result));
  result.receiptId = `qri-receipt-v3|sha256:${result.integritySha256}`;
  result.authoritySignature = authority.sign("acquisition_receipt_v3", result.integritySha256);
  if (!validateAcquisitionReceipt(result, authority, input)) {
    throw new TypeError("qri_receipt_v3_invalid");
  }
  return freeze(result);
}

function createAcquisitionReceiptV2(input, authority) {
  if (!validAuthority(authority) || !exact(input,
    ["acquisition", "intent", "route", "acceptedInitialUrl", "acceptedFinalUrl", "fetchedAt",
      "transportIdentity", "parserInputIdentity"]) ||
      !validateMainAcquisitionIdentity(input.acquisition, input.intent, input.route, authority) ||
      !validateTransportIdentity(input.transportIdentity) ||
      !validateParserInputIdentity(input.parserInputIdentity)) {
    throw new TypeError("qri_receipt_v2_input_invalid");
  }
  const result = { contractVersion: RECEIPT_V2_VERSION, receiptId: "",
    acquisitionId: input.acquisition.acquisitionId, intentId: input.intent.intentId,
    sourceFamily: SOURCE_FAMILY, sourceId: SOURCE_ID, role: input.route.role,
    contractIdentity: clone(input.route.contractIdentity), routeIdentity: input.route.routeIdentity,
    parentAcquisitionId: input.route.parentAcquisitionId,
    acceptedInitialUrl: input.acceptedInitialUrl, acceptedFinalUrl: input.acceptedFinalUrl,
    fetchedAt: input.fetchedAt, transportIdentity: clone(input.transportIdentity),
    parserInputIdentity: clone(input.parserInputIdentity), evidenceStatus: clone(EVIDENCE_PLACEHOLDER),
    authorityKeyId: authority.keyId, integritySha256: "", authoritySignature: "" };
  result.integritySha256 = sha256(receiptUnsigned(result));
  result.receiptId = `qri-receipt-v2|sha256:${result.integritySha256}`;
  result.authoritySignature = authority.sign("acquisition_receipt_v2", result.integritySha256);
  if (!validateAcquisitionReceipt(result, authority, input)) {
    throw new TypeError("qri_receipt_v2_invalid");
  }
  return freeze(result);
}

function createAcquisitionReceipt(input, authority) {
  if (!validAuthority(authority) || !exact(input,
    ["acquisition", "intent", "route", "acceptedInitialUrl", "acceptedFinalUrl", "fetchedAt",
      "parserInputIdentity"]) ||
      !validateMainAcquisitionIdentity(input.acquisition, input.intent, input.route, authority) ||
      !validateParserInputIdentity(input.parserInputIdentity)) {
    throw new TypeError("qri_receipt_input_invalid");
  }
  const result = { contractVersion: RECEIPT_VERSION, receiptId: "",
    acquisitionId: input.acquisition.acquisitionId, intentId: input.intent.intentId,
    sourceFamily: SOURCE_FAMILY, sourceId: SOURCE_ID, role: input.route.role,
    contractIdentity: clone(input.route.contractIdentity), routeIdentity: input.route.routeIdentity,
    parentAcquisitionId: input.route.parentAcquisitionId,
    acceptedInitialUrl: input.acceptedInitialUrl, acceptedFinalUrl: input.acceptedFinalUrl,
    fetchedAt: input.fetchedAt, transportIdentity: clone(TRANSPORT_PLACEHOLDER),
    parserInputIdentity: clone(input.parserInputIdentity), evidenceStatus: clone(EVIDENCE_PLACEHOLDER),
    authorityKeyId: authority.keyId, integritySha256: "", authoritySignature: "" };
  result.integritySha256 = sha256(receiptUnsigned(result));
  result.receiptId = `qri-receipt-v1|sha256:${result.integritySha256}`;
  result.authoritySignature = authority.sign("acquisition_receipt", result.integritySha256);
  if (!validateAcquisitionReceipt(result, authority, input)) throw new TypeError("qri_receipt_invalid");
  return freeze(result);
}

function parserFailure(reason) {
  return freeze({ accepted: false, reason, binding: null });
}

function validateParserResultAgainstReceipt(receipt, candidate, authority) {
  if (!validateAcquisitionReceipt(receipt, authority)) return parserFailure("receipt_invalid");
  if (!exact(candidate, ["canonical", "acquisitionBinding"]) || !object(candidate.canonical) ||
      !exact(candidate.acquisitionBinding, ["acquisitionId", "role", "parentAcquisitionId"])) {
    return parserFailure("parser_result_envelope_invalid");
  }
  const canonical = candidate.canonical, binding = candidate.acquisitionBinding;
  if (binding.acquisitionId !== receipt.acquisitionId) return parserFailure("acquisition_mismatch");
  if (binding.role !== receipt.role) return parserFailure("role_mismatch");
  if (binding.parentAcquisitionId !== receipt.parentAcquisitionId) return parserFailure("parent_mismatch");
  if (canonical.source !== SOURCE_ID) return parserFailure("source_mismatch");
  if (canonical.sourceUrl !== receipt.acceptedFinalUrl) return parserFailure("source_url_mismatch");
  if (!contract(canonical.contract) || !gengetsu(canonical.gengetsu) ||
      canonical.contract !== receipt.contractIdentity.contract ||
      canonical.gengetsu !== receipt.contractIdentity.gengetsu) return parserFailure("contract_mismatch");
  if (!date(canonical.tradingDate)) return parserFailure("trading_date_invalid");
  const result = { contractVersion: PARSER_BINDING_VERSION,
    receiptId: receipt.receiptId, acquisitionId: receipt.acquisitionId,
    sourceFamily: SOURCE_FAMILY, sourceId: SOURCE_ID, role: receipt.role,
    parentAcquisitionId: receipt.parentAcquisitionId,
    contractIdentity: clone(receipt.contractIdentity), sourceUrl: receipt.acceptedFinalUrl,
    tradingDate: canonical.tradingDate,
    parserInputIdentity: clone(receipt.parserInputIdentity), canonicalIdentity: "" };
  result.canonicalIdentity = `qri-parser-result-v1|sha256:${sha256({
    source: canonical.source, sourceUrl: canonical.sourceUrl, contract: canonical.contract,
    gengetsu: canonical.gengetsu, tradingDate: canonical.tradingDate,
    receiptId: receipt.receiptId, role: receipt.role,
    parentAcquisitionId: receipt.parentAcquisitionId })}`;
  return freeze({ accepted: true, reason: null, binding: freeze(result) });
}

function validateDecodedParserInputAgainstReceipt(receipt, parserInput, authority) {
  if (!validateAcquisitionReceipt(receipt, authority) ||
      receipt.parserInputIdentity.state !== "bound" || typeof parserInput !== "string") return false;
  const actual = crypto.createHash("sha256").update(parserInput, "utf8").digest("hex");
  return actual === receipt.parserInputIdentity.sha256;
}

function createIvReceiptInheritance(receipt, ivCandidate, authority) {
  if (!validateAcquisitionReceipt(receipt, authority)) {
    return freeze({ accepted: false, reason: "receipt_invalid", inheritance: null });
  }
  if (!object(ivCandidate) || ivCandidate.source !== IV_SOURCE_ID ||
      ivCandidate.sourceUrl !== receipt.acceptedFinalUrl ||
      ivCandidate.contract !== receipt.contractIdentity.contract ||
      !date(ivCandidate.tradingDate)) {
    return freeze({ accepted: false, reason: "iv_parent_binding_mismatch", inheritance: null });
  }
  return freeze({ accepted: true, reason: null, inheritance: freeze({
    contractVersion: IV_INHERITANCE_VERSION, sourceFamily: SOURCE_FAMILY,
    sourceId: IV_SOURCE_ID, parentSourceId: SOURCE_ID, parentReceiptId: receipt.receiptId,
    parentAcquisitionId: receipt.acquisitionId, role: receipt.role,
    contractIdentity: clone(receipt.contractIdentity), sourceUrl: receipt.acceptedFinalUrl,
    tradingDate: ivCandidate.tradingDate,
    parserInputIdentity: clone(receipt.parserInputIdentity)
  }) });
}

function createIvReceiptInheritanceV2(receipt, ivCandidate, authority) {
  if (!validateAcquisitionReceipt(receipt, authority) ||
      receipt.contractVersion !== RECEIPT_V3_VERSION ||
      !validateEvidenceStatus(receipt.evidenceStatus)) {
    return freeze({ accepted: false, reason: "evidence_receipt_invalid", inheritance: null });
  }
  if (!object(ivCandidate) || ivCandidate.source !== IV_SOURCE_ID ||
      ivCandidate.sourceUrl !== receipt.acceptedFinalUrl ||
      ivCandidate.contract !== receipt.contractIdentity.contract ||
      !date(ivCandidate.tradingDate)) {
    return freeze({ accepted: false, reason: "iv_parent_binding_mismatch", inheritance: null });
  }
  return freeze({ accepted: true, reason: null, inheritance: freeze({
    contractVersion: IV_INHERITANCE_V2_VERSION, sourceFamily: SOURCE_FAMILY,
    sourceId: IV_SOURCE_ID, parentSourceId: SOURCE_ID, parentReceiptId: receipt.receiptId,
    parentAcquisitionId: receipt.acquisitionId, role: receipt.role,
    contractIdentity: clone(receipt.contractIdentity), sourceUrl: receipt.acceptedFinalUrl,
    tradingDate: ivCandidate.tradingDate,
    occurrenceId: receipt.evidenceStatus.occurrenceId,
    rawContentSha256: receipt.evidenceStatus.contentSha256,
    evidenceContextIdentity: receipt.evidenceStatus.contextIdentity,
    parserInputIdentity: clone(receipt.parserInputIdentity)
  }) });
}

module.exports = freeze({
  INTENT_VERSION, ROUTE_VERSION, MANIFEST_VERSION, ACQUISITION_VERSION, RECEIPT_VERSION,
  RECEIPT_V2_VERSION, RECEIPT_V3_VERSION, PARSER_INPUT_VERSION, TRANSPORT_IDENTITY_VERSION,
  TRANSPORT_PLACEHOLDER_VERSION, EVIDENCE_PLACEHOLDER_VERSION, EVIDENCE_STATUS_VERSION,
  EVIDENCE_CONTEXT_VERSION, PARSER_BINDING_VERSION, IV_INHERITANCE_VERSION,
  IV_INHERITANCE_V2_VERSION, SOURCE_FAMILY, SOURCE_ID, IV_SOURCE_ID,
  FUTURES_SOURCE_ID, ROUTE_FAMILY, MANIFEST_PARSER_ID, MANIFEST_PARSER_VERSION,
  QRI_ORIGIN, ACTIVE_URL, ROLES, REFERENCE_ROLES, TRANSPORT_PLACEHOLDER,
  EVIDENCE_PLACEHOLDER, stable, sha256, createMainAuthority, createContractIdentity,
  canonicalContractIdentity, canonicalQriUrl, createAcquisitionIntent,
  validateAcquisitionIntent, validateRouteDescriptor, createParserInputIdentity,
  validateParserInputIdentity, createParentManifest, validateParentManifest,
  resolveQriIntent, createMainAcquisitionIdentity, validateMainAcquisitionIdentity,
  createTransportIdentity, validateTransportIdentity, createEvidenceContextIdentity,
  createEvidenceStatus, validateEvidenceStatus, createAcquisitionReceipt,
  createAcquisitionReceiptV2, createAcquisitionReceiptV3, validateAcquisitionReceipt,
  validateDecodedParserInputAgainstReceipt, validateParserResultAgainstReceipt,
  createIvReceiptInheritance, createIvReceiptInheritanceV2
});
