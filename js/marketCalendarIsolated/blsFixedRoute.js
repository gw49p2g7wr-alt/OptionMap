"use strict";

// Isolated candidate only: no ambient transport, registry mutation or IPC entry point.
const Registry = require("../marketCalendar/sourceRegistry.js");
const Policy = require("../marketCalendarRuntime/calendarNetworkPolicy.js");
const { readBounded } = require("../marketCalendarRuntime/calendarAcquisitionService.js");
const Encoding = require("../marketCalendarShadow/htmlEncoding.js");
const { createHash } = require("node:crypto");
const SOURCE_ID = "us-bls-calendar", PARSER_VERSION = 2, SOURCE_CONTRACT_VERSION = 2;
const MAX_BYTES = Policy.getPolicy(SOURCE_ID).documents[0].maxBytes;
const ROLES = Object.freeze([
  ["cpi", "cpi", "US_CPI", "Consumer Price Index"],
  ["ppi", "ppi", "US_PPI", "Producer Price Index"],
  ["employment_situation", "empsit", "US_EMPLOYMENT_SITUATION", "Employment Situation"],
  ["jolts", "jolts", "US_JOLTS", "Job Openings and Labor Turnover Survey"]
].map(([role, page, eventType, title]) => Object.freeze({ role, eventType, title,
  url: `https://www.bls.gov/schedule/news_release/${page}.htm` })));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function validateUrl(role, value) {
  const route = ROLES.find(item => item.role === role);
  return { valid: !!route && typeof value === "string" && value === route.url };
}
const shadowRegistry = Object.freeze({
  getSource(id) { return id === SOURCE_ID ? Object.freeze({ ...Registry.getSource(id),
    parserVersion: PARSER_VERSION }) : null; },
  validateSourceUrl(id, url) { return { valid: id === SOURCE_ID && ROLES.some(r => validateUrl(r.role, url).valid) }; }
});
// Veto only: never selects an encoding or extends the shared 1024-byte prescan.
// Conservative matches (including malformed/late declarations) prevent undeclared fallback.
function hasDeclarationCandidate(bytes, contentType) {
  const ascii = Buffer.from(bytes).toString("latin1");
  return /charset/i.test(contentType) ||
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ||
    bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff ||
    bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff ||
    // A charset marker also covers malformed direct attributes and Content-Type
    // content values. http-equiv alone (e.g. X-UA-Compatible) is not encoding evidence.
    /<meta\b[^>]*charset[^>]*(?:>|$)/i.test(ascii);
}
function decode(bytes, contentType, binding) {
  if (binding?.sourceId !== SOURCE_ID || !validateUrl(binding.role, binding.requestedUrl).valid ||
      !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_BYTES ||
      !/^text\/html(?:\s*;|\s*$)/i.test(contentType || "")) return { ok: false, reason: "encoding_scope_invalid" };
  const result = Encoding.decodeHtml(bytes, contentType);
  const e = result.evidence || {};
  if (!result.ok && result.reason === "encoding_not_determined" &&
      ![e.httpCharset, e.bom, e.html5MetaCharset, e.legacyMetaCharset].some(Boolean) &&
      !hasDeclarationCandidate(bytes, contentType)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { ok: true, text, encoding: "utf-8", evidence: { ...e, resolvedEncoding: "utf-8",
        resolutionBasis: "source_policy_strict_utf8", declarationState: "absent", strictUtf8Validated: true,
        sourcePolicyId: "bls_fixed_four_pages_undeclared_utf8", sourcePolicyVersion: 1 },
      warnings: ["encoding_undeclared_strict_utf8_source_policy"] };
    } catch (_) { return { ok: false, reason: "encoding_utf8_strict_decode_failed" }; }
  }
  if (!result.ok || result.encoding !== "utf-8" ||
      [e.httpCharset, e.bom, e.html5MetaCharset, e.legacyMetaCharset].filter(Boolean)
        .some(label => !/^utf-?8$/i.test(label))) return { ok: false, reason: "utf8_evidence_invalid" };
  return result;
}
const SAFE = new Set(["request_timeout", "body_timeout", "content_length_invalid", "content_length_exceeded",
  "body_size_exceeded", "truncated_response", "response_stream_unavailable"]);
function createAcquirer({ fetchImpl, requestTimeoutMs = 15000, bodyTimeoutMs = 15000 } = {}) {
  if (typeof fetchImpl !== "function" || ![requestTimeoutMs, bodyTimeoutMs].every(n =>
    Number.isInteger(n) && n > 0 && n <= 15000)) throw TypeError("isolated_transport_required");
  const resources = { activeTasks: 0, activeTimers: 0, requestCount: 0 };
  async function document(route) {
    const base = { role: route.role, requestedUrl: route.url, fetchOutcome: "failure", redirects: [] };
    let response, timer; const controller = new AbortController();
    const deadline = (ms, reason) => new Promise((_, reject) => {
      resources.activeTimers++;
      timer = setTimeout(() => { reject(Object.assign(Error(), { code: reason })); controller.abort(); }, ms);
    });
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; resources.activeTimers--; } };
    resources.activeTasks++;
    try {
      resources.requestCount++;
      response = await Promise.race([fetchImpl(route.url, { method: "GET", redirect: "manual",
        credentials: "omit", cache: "no-store", signal: controller.signal, headers: { accept: "text/html" } }),
      deadline(requestTimeoutMs, "request_timeout")]); clear();
      base.httpStatus = response.status;
      base.responseUrlAvailable = !!response.url;
      if (response.status >= 300 && response.status < 400 || response.redirected ||
          response.headers.get("location") || response.url && !validateUrl(route.role, response.url).valid)
        return { ...base, reason: "unexpected_redirect" };
      if (response.status !== 200) return { ...base, reason: "http_status_rejected" };
      const contentType = response.headers.get("content-type");
      if (!/^text\/html(?:\s*;|\s*$)/i.test(contentType || "")) return { ...base, reason: "mime_invalid" };
      const reading = readBounded(response, MAX_BYTES, bodyTimeoutMs);
      let bytes;
      try { bytes = await Promise.race([reading, deadline(bodyTimeoutMs, "body_timeout")]); }
      finally { clear(); }
      const decoded = decode(bytes, contentType, { sourceId: SOURCE_ID, role: route.role, requestedUrl: route.url });
      if (!decoded.ok) return { ...base, reason: decoded.reason };
      return { ...base, fetchOutcome: "success", reason: null, mime: "text/html", contentType,
        encodingEvidence: decoded.evidence, encodingWarnings: decoded.warnings,
        byteCount: bytes.length, contentSha256: hash(bytes), parserInput: bytes };
    } catch (e) { return { ...base, reason: SAFE.has(e?.code) ? e.code : "network_failure" }; }
    finally { clear(); controller.abort();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
      resources.activeTasks--; }
  }
  async function acquire(request) {
    if (!request || request.sourceId !== SOURCE_ID || Object.keys(request).length !== 1)
      return { sourceId: null, outcome: "invalid", documents: [], reason: "request_shape_invalid" };
    const documents = [];
    for (const role of ROLES) documents.push(await document(role));
    const count = documents.filter(d => d.fetchOutcome === "success").length;
    return { sourceId: SOURCE_ID, fetchedAt: new Date().toISOString(),
      outcome: count === 4 ? "complete" : count ? "partial" : "failed", documents };
  }
  return Object.freeze({ acquire, diagnostics: () => ({ ...resources }) });
}
module.exports = Object.freeze({ SOURCE_ID, PARSER_VERSION, SOURCE_CONTRACT_VERSION, MAX_BYTES,
  ROLES, hash, validateUrl, shadowRegistry, decode, createAcquirer });
