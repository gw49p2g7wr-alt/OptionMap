"use strict";

const crypto = require("node:crypto");
const policyApi = require("./calendarNetworkPolicy.js");
const workbookSafety = require("./workbookSafety.js");
const parsers = require("../marketCalendarShadow/representativeParsers.js");
const htmlEncoding = require("../marketCalendarShadow/htmlEncoding.js");
const xmlEncoding = require("../marketCalendarShadow/xmlEncoding.js");
const XLSX = require("xlsx");

const RETRYABLE = new Set(["network_failed", "request_timeout", "body_timeout", "http_5xx"]);
const FORBIDDEN_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function publicFailure(reason, diagnostics = [], retryable = false) {
  return Object.freeze({ success: false, reason, retryable, documents: Object.freeze([]),
    diagnostics: Object.freeze(diagnostics.map(value => Object.freeze(clone(value)))) });
}
function timeoutSignal(milliseconds) {
  const controller = new AbortController(); let timer;
  const timedOut = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort();
    reject(Object.assign(new Error("request_timeout"), { code: "request_timeout" }));
  }, milliseconds); });
  return { signal: controller.signal, timedOut, abort: () => controller.abort(),
    clear: () => clearTimeout(timer) };
}
function contentLength(headers) {
  const value = headers?.get?.("content-length");
  if (value === null || value === undefined || value === "") return null;
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
}
async function readBounded(response, maxBytes, timeoutMs) {
  const declared = contentLength(response.headers);
  const contentEncoding = String(response.headers?.get?.("content-encoding") || "").trim().toLowerCase();
  if (Number.isNaN(declared)) throw Object.assign(new Error("content_length_invalid"), { code: "content_length_invalid" });
  if (declared !== null && declared > maxBytes)
    throw Object.assign(new Error("content_length_exceeded"), { code: "content_length_exceeded" });
  if (!response.body?.getReader) throw Object.assign(new Error("response_stream_unavailable"),
    { code: "response_stream_unavailable" });
  const reader = response.body.getReader(), chunks = []; let total = 0, timer;
  const timedOut = new Promise((_, reject) => { timer = setTimeout(() => {
    reader.cancel().catch(() => undefined);
    reject(Object.assign(new Error("body_timeout"), { code: "body_timeout" }));
  }, timeoutMs); });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), timedOut]);
      if (result.done) break;
      const chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value || []);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw Object.assign(new Error("body_size_exceeded"), { code: "body_size_exceeded" });
      }
      chunks.push(chunk);
    }
  } finally { clearTimeout(timer); reader.releaseLock?.(); }
  if (declared !== null && !contentEncoding && declared !== total)
    throw Object.assign(new Error("truncated_response"), { code: "truncated_response" });
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function validateJson(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (_error) { return { valid: false, reason: "json_invalid" }; }
  const visit = current => {
    if (!current || typeof current !== "object") return true;
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype) return false;
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_JSON_KEYS.has(key) || !visit(child)) return false;
    }
    return true;
  };
  return visit(value) ? { valid: true, encoding: { encoding: "utf-8", evidence: {
    mediaType: "application/json", resolvedEncoding: "utf-8", resolutionPolicyVersion: 1 }, warnings: [] } }
    : { valid: false, reason: "prototype_pollution_key" };
}

function validateBody(documentPolicy, bytes, contentType) {
  if (documentPolicy.kind === "xlsx") {
    const limits = { ...workbookSafety.LIMITS, maxCompressedBytes: documentPolicy.maxBytes }, result =
      documentPolicy.allowValueOnlyWorkbookSanitization
        ? workbookSafety.sanitizeValueOnly(bytes, XLSX, limits)
        : workbookSafety.inspectWorkbook(bytes, limits);
    if (!result.valid) return result;
    const parserInput = result.bytes || bytes, workbook = result.sanitized
      ? { valid: true, sanitized: true, originalReason: result.originalReason,
          inspection: result.inspection }
      : { valid: true, sanitized: false, inspection: result.inspection || result };
    return { valid: true, encoding: null, workbook, parserInput };
  }
  if (documentPolicy.kind === "xml") {
    const decoded = xmlEncoding.decodeUtf16Xml(bytes, contentType);
    if (!decoded.ok) return { valid: false, reason: `encoding_${decoded.reason}` };
    const metadata = xmlEncoding.acquisitionMetadata(decoded);
    return metadata.ok ? { valid: true, encoding: { encoding: decoded.encoding,
      evidence: metadata.evidence, warnings: metadata.warnings } }
      : { valid: false, reason: `encoding_${metadata.reason}` };
  }
  if (documentPolicy.kind === "html") {
    const decoded = htmlEncoding.decodeHtml(bytes, contentType);
    if (decoded.ok) return { valid: true, encoding: { encoding: decoded.encoding,
      evidence: decoded.evidence, warnings: decoded.warnings } };
    if (documentPolicy.allowUndeclaredUtf8 && decoded.reason === "encoding_not_determined") {
      try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch (_error) { return { valid: false, reason: "encoding_utf8_strict_decode_failed" }; }
      return { valid: true, encoding: { encoding: "utf-8", evidence: { httpCharset: null,
        bom: null, html5MetaCharset: null, legacyMetaCharset: null, resolvedEncoding: "utf-8",
        resolutionPolicyVersion: 1, resolutionBasis: "source_policy_strict_utf8" },
      warnings: ["encoding_undeclared_strict_utf8_source_policy"] } };
    }
    if (documentPolicy.encodingEvidenceOnly && decoded.reason === "encoding_not_determined")
      return { valid: true, encoding: { encoding: null, evidence: { httpCharset: null, bom: null,
        html5MetaCharset: null, legacyMetaCharset: null, resolvedEncoding: null,
        resolutionPolicyVersion: 1, resolutionBasis: "auxiliary_document_not_parser_input" },
      warnings: ["encoding_undeclared_auxiliary_document"] } };
    return { valid: false, reason: `encoding_${decoded.reason}` };
  }
  if (documentPolicy.kind === "json") return validateJson(bytes);
  return { valid: false, reason: "document_kind_not_allowed" };
}

function createCalendarAcquisitionService(configuration = {}) {
  const fetchImpl = configuration.fetchImpl || globalThis.fetch;
  const now = configuration.now || (() => new Date());
  const requestTimeoutMs = configuration.requestTimeoutMs || policyApi.REQUEST_TIMEOUT_MS;
  const bodyTimeoutMs = configuration.bodyTimeoutMs || policyApi.BODY_TIMEOUT_MS;
  const maxRetries = Number.isInteger(configuration.maxRetries)
    ? Math.min(policyApi.MAX_RETRIES, Math.max(0, configuration.maxRetries)) : policyApi.MAX_RETRIES;

  async function fetchOnce(sourceId, documentPolicy, requestedUrl) {
    const requested = policyApi.validateUrl(sourceId, documentPolicy, requestedUrl);
    if (!requested.valid) return { ok: false, reason: requested.reason, retryable: false };
    const redirects = []; let currentUrl = requested.url;
    for (let hop = 0; hop <= policyApi.MAX_REDIRECTS; hop += 1) {
      const guard = timeoutSignal(requestTimeoutMs); let response;
      try {
        response = await Promise.race([fetchImpl(currentUrl, { method: "GET", redirect: "manual",
          signal: guard.signal, credentials: "omit", cache: "no-store",
          headers: { accept: documentPolicy.allowedMime.join(",") } }), guard.timedOut]);
      } catch (error) {
        return { ok: false, reason: error?.name === "AbortError" || error?.code === "request_timeout"
          ? "request_timeout" : "network_failed",
          retryable: true };
      } finally { guard.clear(); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return { ok: false, reason: "redirect_location_missing", retryable: false };
        if (hop === policyApi.MAX_REDIRECTS)
          return { ok: false, reason: "redirect_hop_exceeded", retryable: false };
        let next;
        try { next = new URL(location, currentUrl).href; }
        catch (_error) { return { ok: false, reason: "redirect_url_invalid", retryable: false }; }
        const allowed = policyApi.validateUrl(sourceId, documentPolicy, next);
        redirects.push({ status: response.status, from: currentUrl, to: allowed.valid ? allowed.url : null,
          accepted: allowed.valid });
        if (!allowed.valid) return { ok: false, reason: `redirect_${allowed.reason}`, retryable: false,
          redirects };
        currentUrl = allowed.url; continue;
      }
      if (response.status >= 500) return { ok: false, reason: "http_5xx", retryable: true,
        httpStatus: response.status, redirects };
      if (!response.ok) return { ok: false, reason: "http_status_rejected", retryable: false,
        httpStatus: response.status, redirects };
      const mime = policyApi.validateMime(documentPolicy, response.headers.get("content-type"));
      if (!mime.valid) return { ok: false, reason: mime.reason, retryable: false,
        httpStatus: response.status, redirects };
      let bytes;
      try { bytes = await readBounded(response, documentPolicy.maxBytes, bodyTimeoutMs); }
      catch (error) { return { ok: false, reason: error.code || "body_read_failed",
        retryable: error.code === "body_timeout", httpStatus: response.status, redirects }; }
      const body = validateBody(documentPolicy, bytes, response.headers.get("content-type"));
      if (!body.valid) return { ok: false, reason: body.reason, retryable: false,
        httpStatus: response.status, redirects };
      return { ok: true, document: Object.freeze({ role: documentPolicy.role,
        originalOfficialUrl: requested.url, finalUrl: currentUrl,
        redirects: Object.freeze(redirects.map(value => Object.freeze(value))),
        httpStatus: response.status, mime: mime.mime, encoding: body.encoding ? clone(body.encoding) : null,
        workbook: body.workbook ? clone(body.workbook) : null, byteCount: bytes.byteLength,
        contentSha256: sha256(bytes), parserInputSha256: sha256(body.parserInput || bytes),
        parserInput: body.parserInput || bytes }) };
    }
    return { ok: false, reason: "redirect_hop_exceeded", retryable: false };
  }

  async function fetchDocument(sourceId, documentPolicy, url) {
    let result;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      result = await fetchOnce(sourceId, documentPolicy, url);
      if (result.ok || !result.retryable || !RETRYABLE.has(result.reason)) break;
    }
    return result;
  }

  async function acquire(request) {
    const checked = policyApi.validateRequest(request);
    if (!checked.valid) return publicFailure(checked.reason,
      [{ stage: "request_validation", reason: checked.reason }], false);
    if (typeof fetchImpl !== "function") return publicFailure("network_unavailable", [], true);
    const sourcePolicy = policyApi.getPolicy(checked.sourceId, configuration.documentContract || null);
    if (!sourcePolicy) return publicFailure("document_contract_invalid");
    const requestedAt = now().toISOString(), documents = [];
    for (const documentPolicy of sourcePolicy.documents) {
      let url = documentPolicy.url;
      if (documentPolicy.role === "workbook") {
        const landing = documents.find(value => value.role === "landing");
        if (!landing) return publicFailure("workbook_landing_unavailable", [], false);
        const decoded = htmlEncoding.decodeHtml(landing.parserInput,
          `${landing.mime}${landing.encoding?.evidence?.httpCharset ? `; charset=${landing.encoding.evidence.httpCharset}` : ""}`);
        if (!decoded.ok) return publicFailure("workbook_discovery_encoding_invalid", [], false);
        url = parsers.discoverJpxWorkbook(decoded.text, Number(now().getUTCFullYear()), landing.finalUrl);
        if (!url) return publicFailure("workbook_not_discovered", [], false);
      }
      const result = await fetchDocument(checked.sourceId, documentPolicy, url);
      if (!result.ok) return publicFailure(result.reason, [{ stage: "acquisition", role: documentPolicy.role,
        reason: result.reason, retryable: result.retryable === true,
        httpStatus: result.httpStatus || null, redirectCount: result.redirects?.length || 0 }],
      result.retryable === true);
      documents.push(result.document);
    }
    return Object.freeze({ success: true, reason: null, retryable: false,
      sourceId: checked.sourceId, operation: checked.operation, requestedAt,
      fetchedAt: now().toISOString(), documents: Object.freeze(documents),
      diagnostics: Object.freeze([]) });
  }
  return Object.freeze({ acquire });
}

function sanitizeForIpc(result) {
  if (!result?.success) return clone(result);
  return { ...clone({ ...result, documents: undefined }), documents: result.documents.map(document => ({
    ...clone({ ...document, parserInput: undefined }), parserInput: document.parserInput
  })) };
}

module.exports = Object.freeze({ createCalendarAcquisitionService, sanitizeForIpc,
  readBounded, validateBody, validateJson });
