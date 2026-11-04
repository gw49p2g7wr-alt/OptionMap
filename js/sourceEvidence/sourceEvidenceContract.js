"use strict";

const crypto = require("node:crypto");

const CONTENT_CONTRACT_VERSION = "optionmap-source-content-v1";
const OCCURRENCE_CONTRACT_VERSION = "optionmap-source-acquisition-v1";
const EVIDENCE_REF_CONTRACT_VERSION = "optionmap-source-evidence-ref-v1";
const LINEAGE_CONTRACT_VERSION = "optionmap-source-parser-lineage-v1";
const POLICY_CONTRACT_VERSION = "optionmap-source-evidence-policy-v1";
const MAX_REDIRECT_HOPS = 3;

const SOURCE_FAMILIES = Object.freeze([
  "economic_values", "market_calendar", "qri", "weekly", "participants", "jpx_daily_oi"
]);
const ACQUISITION_CONTEXTS = Object.freeze([
  "live_original_acquisition", "historical_archive_fetch"
]);
const UNAVAILABLE_REASONS = Object.freeze(["pre_activation", "evidence_not_captured"]);
const CANONICAL_IDENTITY_KINDS = Object.freeze([
  "canonical_sha256", "fact_sha256", "revision_key"
]);

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const hash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const timestamp = value => typeof value === "string" &&
  /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const boundedText = (value, maximum = 128) => typeof value === "string" && value.length > 0 &&
  value.length <= maximum && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const nullableText = (value, maximum = 128) => value === null || boundedText(value, maximum);
const sourceId = value => boundedText(value, 96) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const boundedIdentifier = (value, maximum = 128) => boundedText(value, maximum) &&
  /^[A-Za-z0-9][A-Za-z0-9._:|+-]*$/.test(value) && !value.includes("..");
const nullableIdentifier = (value, maximum = 128) => value === null || boundedIdentifier(value, maximum);

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function stable(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  throw new TypeError("canonical_value_invalid");
}

const sha256Canonical = value => crypto.createHash("sha256").update(stable(value)).digest("hex");

function bytesView(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array)
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function sha256Bytes(bytes) {
  const view = bytesView(bytes);
  if (!view || view.byteLength === 0) throw new TypeError("content_bytes_missing");
  return crypto.createHash("sha256").update(view).digest("hex");
}

function canonicalMediaType(value) {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0 || value.length > 127)
    return null;
  const normalized = value.toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/.test(normalized)
    ? normalized : null;
}

function canonicalEncoding(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value !== value.trim() || value.length === 0 || value.length > 32)
    return undefined;
  const normalized = value.toLowerCase().replace(/_/g, "-");
  const aliases = Object.freeze({
    "utf8": "utf-8", "utf-8": "utf-8",
    "shift-jis": "shift_jis", "shiftjis": "shift_jis", "sjis": "shift_jis",
    "windows-31j": "shift_jis", "cp932": "shift_jis",
    "us-ascii": "us-ascii", "ascii": "us-ascii",
    "windows-1252": "windows-1252"
  });
  return aliases[normalized];
}

function canonicalHttpsUrl(value) {
  if (typeof value !== "string" || value !== value.trim() || value.length === 0 || value.length > 2048)
    return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) return null;
    const secretKeys = /^(?:api[-_]?key|access[-_]?token|token|authorization|auth|password|secret|sig(?:nature)?)$/i;
    if ([...parsed.searchParams.keys()].some(key => secretKeys.test(key))) return null;
    return parsed.href;
  } catch (_error) {
    return null;
  }
}

const POLICY_FIELDS = Object.freeze([
  "contractVersion", "sourceFamily", "sourceId", "allowedMediaTypes", "allowedEncodings", "maxBytes"
]);

function validateSourcePolicy(value) {
  if (!exact(value, POLICY_FIELDS) || value.contractVersion !== POLICY_CONTRACT_VERSION ||
      !SOURCE_FAMILIES.includes(value.sourceFamily) || !sourceId(value.sourceId) ||
      !Array.isArray(value.allowedMediaTypes) || value.allowedMediaTypes.length === 0 ||
      new Set(value.allowedMediaTypes).size !== value.allowedMediaTypes.length ||
      value.allowedMediaTypes.some(item => canonicalMediaType(item) !== item) ||
      !Array.isArray(value.allowedEncodings) ||
      new Set(value.allowedEncodings).size !== value.allowedEncodings.length ||
      value.allowedEncodings.some(item => canonicalEncoding(item) !== item) ||
      !Number.isSafeInteger(value.maxBytes) || value.maxBytes <= 0) return false;
  return JSON.stringify(value.allowedMediaTypes) === JSON.stringify([...value.allowedMediaTypes].sort()) &&
    JSON.stringify(value.allowedEncodings) === JSON.stringify([...value.allowedEncodings].sort());
}

function createSourcePolicy(input) {
  const fields = ["sourceFamily", "sourceId", "allowedMediaTypes", "allowedEncodings", "maxBytes"];
  if (!exact(input, fields) || !Array.isArray(input.allowedMediaTypes) ||
      !Array.isArray(input.allowedEncodings)) throw new TypeError("source_policy_fields_invalid");
  const mediaTypes = input.allowedMediaTypes.map(canonicalMediaType);
  const encodings = input.allowedEncodings.map(canonicalEncoding);
  if (mediaTypes.some(item => item === null) || encodings.some(item => item === undefined))
    throw new TypeError("source_policy_metadata_invalid");
  const result = { contractVersion: POLICY_CONTRACT_VERSION, sourceFamily: input.sourceFamily,
    sourceId: input.sourceId, allowedMediaTypes: [...new Set(mediaTypes)].sort(),
    allowedEncodings: [...new Set(encodings)].sort(), maxBytes: input.maxBytes };
  if (!validateSourcePolicy(result)) throw new TypeError("source_policy_invalid");
  return freeze(result);
}

const CONTENT_FIELDS = Object.freeze([
  "contractVersion", "contentObjectId", "sha256", "byteLength", "mediaType", "encoding"
]);

function validateContentObject(value) {
  return exact(value, CONTENT_FIELDS) && value.contractVersion === CONTENT_CONTRACT_VERSION &&
    hash(value.sha256) && value.contentObjectId === `sha256:${value.sha256}` &&
    Number.isSafeInteger(value.byteLength) && value.byteLength > 0 &&
    canonicalMediaType(value.mediaType) === value.mediaType &&
    canonicalEncoding(value.encoding) === value.encoding;
}

function policyFailure({ mediaType, encoding, byteLength }, policy) {
  if (!validateSourcePolicy(policy)) return "source_policy_invalid";
  if (!policy.allowedMediaTypes.includes(mediaType)) return "media_type_not_allowed";
  if (byteLength > policy.maxBytes) return "content_oversize";
  if (policy.allowedEncodings.length === 0)
    return encoding === null ? null : "encoding_not_allowed";
  return policy.allowedEncodings.includes(encoding) ? null : "encoding_not_allowed";
}

function createContentObject(input) {
  if (!exact(input, ["bytes", "mediaType", "encoding", "policy"]))
    throw new TypeError("content_object_fields_invalid");
  const view = bytesView(input.bytes), mediaType = canonicalMediaType(input.mediaType),
    encoding = canonicalEncoding(input.encoding);
  if (!view || view.byteLength === 0) throw new TypeError("content_bytes_missing");
  if (!mediaType || encoding === undefined) throw new TypeError("content_metadata_invalid");
  const reason = policyFailure({ mediaType, encoding, byteLength: view.byteLength }, input.policy);
  if (reason) throw new TypeError(reason);
  const digest = sha256Bytes(view), result = { contractVersion: CONTENT_CONTRACT_VERSION,
    contentObjectId: `sha256:${digest}`, sha256: digest, byteLength: view.byteLength,
    mediaType, encoding };
  if (!validateContentObject(result)) throw new TypeError("content_object_invalid");
  return freeze(result);
}

function verifyContentBytes(bytes, expectedSha256, expectedByteLength) {
  const view = bytesView(bytes);
  if (!view || view.byteLength === 0) return freeze({ valid: false, reason: "content_bytes_missing",
    actualSha256: null, actualByteLength: null });
  if (!hash(expectedSha256)) return freeze({ valid: false, reason: "expected_hash_invalid",
    actualSha256: null, actualByteLength: view.byteLength });
  if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength <= 0)
    return freeze({ valid: false, reason: "expected_byte_length_invalid",
      actualSha256: null, actualByteLength: view.byteLength });
  const actualSha256 = sha256Bytes(view);
  if (view.byteLength !== expectedByteLength) return freeze({ valid: false,
    reason: "byte_length_mismatch", actualSha256, actualByteLength: view.byteLength });
  if (actualSha256 !== expectedSha256) return freeze({ valid: false, reason: "hash_mismatch",
    actualSha256, actualByteLength: view.byteLength });
  return freeze({ valid: true, reason: null, actualSha256, actualByteLength: view.byteLength });
}

const REDIRECT_FIELDS = Object.freeze(["status", "url"]);
function canonicalRedirects(value, initialUrl, finalUrl) {
  if (!Array.isArray(value) || value.length > MAX_REDIRECT_HOPS) return null;
  const result = [], seen = new Set([initialUrl]);
  for (const hop of value) {
    const url = canonicalHttpsUrl(hop?.url);
    if (!exact(hop, REDIRECT_FIELDS) || !Number.isInteger(hop.status) || hop.status < 300 ||
        hop.status > 399 || !url || seen.has(url)) return null;
    seen.add(url); result.push({ status: hop.status, url });
  }
  if (result.length === 0 && initialUrl !== finalUrl ||
      result.length > 0 && result.at(-1).url !== finalUrl) return null;
  return result;
}

const OCCURRENCE_INPUT_FIELDS = Object.freeze([
  "sourceFamily", "sourceId", "initialUrl", "sourceUrl", "fetchedAt", "httpStatus",
  "mediaType", "encoding", "byteLength", "contentSha256", "transportVersion", "publishedAt",
  "requestRole", "redirectHops", "sourceDocumentRole", "runId", "acquisitionContext"
]);
const OCCURRENCE_CREATE_FIELDS = Object.freeze([
  "sourceFamily", "sourceId", "initialUrl", "sourceUrl", "fetchedAt", "httpStatus",
  "contentObject", "transportVersion", "publishedAt", "requestRole", "redirectHops",
  "sourceDocumentRole", "runId", "acquisitionContext"
]);
const OCCURRENCE_FIELDS = Object.freeze([
  "contractVersion", "occurrenceId", ...OCCURRENCE_INPUT_FIELDS
]);

function occurrenceMaterial(value) {
  return Object.fromEntries(OCCURRENCE_INPUT_FIELDS.map(field => [field, clone(value[field])]));
}

function occurrenceIdFor(value) {
  return `source-occurrence-v1|sha256:${sha256Canonical(occurrenceMaterial(value))}`;
}

function validateAcquisitionOccurrence(value, policy) {
  if (!exact(value, OCCURRENCE_FIELDS) || value.contractVersion !== OCCURRENCE_CONTRACT_VERSION ||
      !validateSourcePolicy(policy) || value.sourceFamily !== policy.sourceFamily ||
      value.sourceId !== policy.sourceId || !timestamp(value.fetchedAt) ||
      value.publishedAt !== null && !timestamp(value.publishedAt) ||
      !Number.isInteger(value.httpStatus) || value.httpStatus < 200 || value.httpStatus > 299 ||
      !hash(value.contentSha256) || !Number.isSafeInteger(value.byteLength) || value.byteLength <= 0 ||
      !boundedIdentifier(value.transportVersion, 96) || !nullableIdentifier(value.requestRole, 96) ||
      !nullableIdentifier(value.sourceDocumentRole, 96) || !nullableIdentifier(value.runId, 192) ||
      !ACQUISITION_CONTEXTS.includes(value.acquisitionContext)) return false;
  if (value.publishedAt !== null && value.publishedAt > value.fetchedAt) return false;
  const initialUrl = canonicalHttpsUrl(value.initialUrl), sourceUrlValue = canonicalHttpsUrl(value.sourceUrl),
    mediaType = canonicalMediaType(value.mediaType), encoding = canonicalEncoding(value.encoding),
    redirects = canonicalRedirects(value.redirectHops, initialUrl, sourceUrlValue);
  if (!initialUrl || !sourceUrlValue || initialUrl !== value.initialUrl || sourceUrlValue !== value.sourceUrl ||
      !mediaType || mediaType !== value.mediaType || encoding !== value.encoding || redirects === null ||
      stable(redirects) !== stable(value.redirectHops) || policyFailure({ mediaType, encoding,
        byteLength: value.byteLength }, policy)) return false;
  return value.occurrenceId === occurrenceIdFor(value);
}

function createAcquisitionOccurrence(input, policy) {
  if (!exact(input, OCCURRENCE_CREATE_FIELDS)) throw new TypeError("occurrence_fields_invalid");
  if (!validateSourcePolicy(policy) || input.sourceFamily !== policy.sourceFamily ||
      input.sourceId !== policy.sourceId) throw new TypeError("occurrence_source_policy_mismatch");
  const initialUrl = canonicalHttpsUrl(input.initialUrl), sourceUrlValue = canonicalHttpsUrl(input.sourceUrl),
    contentObject = input.contentObject, mediaType = contentObject?.mediaType,
    encoding = contentObject?.encoding,
    redirects = canonicalRedirects(input.redirectHops, initialUrl, sourceUrlValue);
  if (!validateContentObject(contentObject) || !initialUrl || !sourceUrlValue || redirects === null ||
      policyFailure({ mediaType, encoding, byteLength: contentObject.byteLength }, policy))
    throw new TypeError("occurrence_metadata_invalid");
  const result = { contractVersion: OCCURRENCE_CONTRACT_VERSION, occurrenceId: "",
    sourceFamily: input.sourceFamily, sourceId: input.sourceId, initialUrl,
    sourceUrl: sourceUrlValue, fetchedAt: input.fetchedAt, httpStatus: input.httpStatus,
    mediaType, encoding, byteLength: contentObject.byteLength, contentSha256: contentObject.sha256,
    transportVersion: input.transportVersion, publishedAt: input.publishedAt,
    requestRole: input.requestRole, redirectHops: redirects,
    sourceDocumentRole: input.sourceDocumentRole, runId: input.runId,
    acquisitionContext: input.acquisitionContext };
  result.occurrenceId = occurrenceIdFor(result);
  if (!validateAcquisitionOccurrence(result, policy)) throw new TypeError("occurrence_invalid");
  return freeze(result);
}

const EVIDENCE_REF_FIELDS = Object.freeze([
  "contractVersion", "state", "reason", "contentSha256", "occurrenceId", "sourceFamily", "sourceId"
]);

function validateSourceEvidenceRef(value) {
  if (!exact(value, EVIDENCE_REF_FIELDS) || value.contractVersion !== EVIDENCE_REF_CONTRACT_VERSION ||
      !["available", "unavailable", "not_applicable"].includes(value.state)) return false;
  if (value.state === "available") return value.reason === null && hash(value.contentSha256) &&
    /^source-occurrence-v1\|sha256:[0-9a-f]{64}$/.test(value.occurrenceId || "") &&
    SOURCE_FAMILIES.includes(value.sourceFamily) && sourceId(value.sourceId);
  if (value.state === "unavailable") return UNAVAILABLE_REASONS.includes(value.reason) &&
    value.contentSha256 === null && value.occurrenceId === null &&
    SOURCE_FAMILIES.includes(value.sourceFamily) && sourceId(value.sourceId);
  return value.reason === "not_applicable" && value.contentSha256 === null &&
    value.occurrenceId === null && value.sourceFamily === null && value.sourceId === null;
}

function createSourceEvidenceRef(input) {
  if (!object(input) || !["available", "unavailable", "not_applicable"].includes(input.state))
    throw new TypeError("evidence_ref_state_invalid");
  let result;
  if (input.state === "available") {
    if (!exact(input, ["state", "occurrence", "policy"]) ||
        !validateAcquisitionOccurrence(input.occurrence, input.policy))
      throw new TypeError("evidence_occurrence_invalid");
    result = { contractVersion: EVIDENCE_REF_CONTRACT_VERSION, state: "available", reason: null,
      contentSha256: input.occurrence.contentSha256, occurrenceId: input.occurrence.occurrenceId,
      sourceFamily: input.occurrence.sourceFamily, sourceId: input.occurrence.sourceId };
  } else if (input.state === "unavailable") {
    if (!exact(input, ["state", "sourceFamily", "sourceId", "reason"]))
      throw new TypeError("evidence_ref_fields_invalid");
    result = { contractVersion: EVIDENCE_REF_CONTRACT_VERSION, state: "unavailable",
      reason: input.reason, contentSha256: null, occurrenceId: null,
      sourceFamily: input.sourceFamily, sourceId: input.sourceId };
  } else {
    if (!exact(input, ["state"])) throw new TypeError("evidence_ref_fields_invalid");
    result = { contractVersion: EVIDENCE_REF_CONTRACT_VERSION, state: "not_applicable",
      reason: "not_applicable", contentSha256: null, occurrenceId: null,
      sourceFamily: null, sourceId: null };
  }
  if (!validateSourceEvidenceRef(result)) throw new TypeError("evidence_ref_invalid");
  return freeze(result);
}

const CANONICAL_IDENTITY_FIELDS = Object.freeze(["kind", "value"]);
const LINEAGE_FIELDS = Object.freeze([
  "contractVersion", "evidenceRef", "parserId", "parserVersion", "canonicalIdentity"
]);

function validateParserLineage(value) {
  if (!exact(value, LINEAGE_FIELDS) || value.contractVersion !== LINEAGE_CONTRACT_VERSION ||
      !validateSourceEvidenceRef(value.evidenceRef) || !boundedText(value.parserId, 128) ||
      !Number.isSafeInteger(value.parserVersion) || value.parserVersion <= 0 ||
      !exact(value.canonicalIdentity, CANONICAL_IDENTITY_FIELDS) ||
      !CANONICAL_IDENTITY_KINDS.includes(value.canonicalIdentity.kind)) return false;
  return value.canonicalIdentity.kind === "revision_key"
    ? boundedText(value.canonicalIdentity.value, 512)
    : hash(value.canonicalIdentity.value);
}

function createParserLineage(input) {
  if (!exact(input, ["evidenceRef", "parserId", "parserVersion", "canonicalIdentity"]))
    throw new TypeError("parser_lineage_fields_invalid");
  const result = { contractVersion: LINEAGE_CONTRACT_VERSION,
    evidenceRef: clone(input.evidenceRef), parserId: input.parserId,
    parserVersion: input.parserVersion, canonicalIdentity: clone(input.canonicalIdentity) };
  if (!validateParserLineage(result)) throw new TypeError("parser_lineage_invalid");
  return freeze(result);
}

module.exports = freeze({ CONTENT_CONTRACT_VERSION, OCCURRENCE_CONTRACT_VERSION,
  EVIDENCE_REF_CONTRACT_VERSION, LINEAGE_CONTRACT_VERSION, POLICY_CONTRACT_VERSION,
  MAX_REDIRECT_HOPS, SOURCE_FAMILIES, ACQUISITION_CONTEXTS, UNAVAILABLE_REASONS,
  CANONICAL_IDENTITY_KINDS, stable, sha256Canonical, sha256Bytes, canonicalMediaType,
  canonicalEncoding, canonicalHttpsUrl, createSourcePolicy, validateSourcePolicy,
  createContentObject, validateContentObject, verifyContentBytes, occurrenceIdFor,
  createAcquisitionOccurrence, validateAcquisitionOccurrence, createSourceEvidenceRef,
  validateSourceEvidenceRef, createParserLineage, validateParserLineage });
