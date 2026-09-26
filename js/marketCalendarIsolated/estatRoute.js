"use strict";

// Inactive candidate route. No production registry mutation or renderer capability.
const Registry = require("../marketCalendar/sourceRegistry.js");
const PhaseA = require("../marketCalendarRuntime/calendarNetworkPolicy.js");
const Acquisition = require("../marketCalendarRuntime/calendarAcquisitionService.js");
const Encoding = require("../marketCalendarShadow/htmlEncoding.js");
const { createHash } = require("node:crypto");
const SOURCE_CONTRACT_VERSION = 2, PARSER_VERSION = 2;
const ROUTES = Object.freeze(Object.assign(Object.create(null), Object.fromEntries([
  ["jp-stat-cpi", "00200573", "消費者物価指数"],
  ["jp-stat-labor", "00200531", "労働力調査"]
].map(([sourceId, code, statisticsName]) => [sourceId, Object.freeze({ sourceId, statisticsName,
  url: `https://www.e-stat.go.jp/release-calendar/statistics/${code}`, role: "primary", kind: "html",
  allowedMime: PhaseA.MIME.html, maxBytes: PhaseA.getPolicy(sourceId).documents[0].maxBytes })]))));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function validateUrl(sourceId, value) {
  const route = ROUTES[sourceId];
  if (!route || typeof value !== "string") return { valid: false, reason: "source_or_url_invalid" };
  try {
    const url = new URL(value);
    if (url.username || url.password) return { valid: false, reason: "credentials_forbidden" };
    // Exact serialized route also rejects query, fragments, ports and cross-source redirects.
    if (value !== route.url || url.href !== route.url)
      return { valid: false, reason: "fixed_route_required" };
    return { valid: true, url: route.url };
  } catch (_) { return { valid: false, reason: "url_invalid" }; }
}
const shadowRegistry = Object.freeze({
  getSource(sourceId) { const route = ROUTES[sourceId], original = Registry.getSource(sourceId);
    return route ? Object.freeze({ ...original, canonicalUrl: route.url,
      allowedHosts: Object.freeze(["www.e-stat.go.jp"]), parserVersion: PARSER_VERSION }) : null; },
  validateSourceUrl: validateUrl
});
function decode(bytes, contentType) {
  const result = Encoding.decodeHtml(bytes, contentType);
  const declarations = result.evidence || {};
  const specified = [declarations.httpCharset, declarations.bom, declarations.html5MetaCharset,
    declarations.legacyMetaCharset].filter(Boolean);
  if (!result.ok || result.encoding !== "utf-8" ||
      specified.some(label => !/^utf-?8$/i.test(label)))
    return { ok: false, reason: "utf8_evidence_required" };
  return result;
}
const SAFE_FAILURES = new Set(["request_timeout", "body_timeout", "content_length_invalid",
  "content_length_exceeded", "body_size_exceeded", "truncated_response", "response_stream_unavailable"]);
function createAcquirer({ fetchImpl, requestTimeoutMs = PhaseA.REQUEST_TIMEOUT_MS,
  bodyTimeoutMs = PhaseA.BODY_TIMEOUT_MS } = {}) {
  // Test injection can tighten, never expand, Phase A limits. No ambient transport fallback.
  if (typeof fetchImpl !== "function" || ![requestTimeoutMs, bodyTimeoutMs].every(x =>
    Number.isInteger(x) && x > 0 && x <= 15000)) throw new TypeError("isolated_transport_required");
  const resources = { activeTasks: 0, activeTimers: 0, requestCount: 0 };
  async function acquire(request) {
    const sourceId = request?.sourceId, route = ROUTES[sourceId];
    const failure = (reason, extra = {}) => ({ success: false, sourceId: route ? sourceId : null,
      reason, ...extra });
    if (!route || Object.keys(request).join() !== "sourceId") return failure("request_shape_invalid");
    resources.activeTasks++;
    const redirects = []; let response, controller;
    try {
      for (let hop = 0; hop <= PhaseA.MAX_REDIRECTS; hop++) {
        controller = new AbortController(); let timer;
        resources.activeTimers++;
        try {
          resources.requestCount++;
          response = await Promise.race([fetchImpl(route.url, { method: "GET", redirect: "manual",
            credentials: "omit", cache: "no-store", signal: controller.signal,
            headers: { accept: route.allowedMime.join(",") } }),
          new Promise((_, reject) => { timer = setTimeout(() => {
            controller.abort(); reject(Object.assign(new Error(), { code: "request_timeout" }));
          }, requestTimeoutMs); })]);
        } finally { clearTimeout(timer); resources.activeTimers--; }
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          let next; try { next = location ? new URL(location, route.url).href : null; } catch (_) { next = null; }
          await response.body?.cancel(); response = null;
          if (!validateUrl(sourceId, next).valid) return failure("redirect_route_rejected", { redirects });
          if (hop === PhaseA.MAX_REDIRECTS) return failure("redirect_hop_exceeded", { redirects });
          redirects.push({ from: route.url, to: route.url }); continue;
        }
        if (response.status !== 200) return failure("http_status_rejected", { httpStatus: response.status });
        const contentType = response.headers.get("content-type"), mime = PhaseA.validateMime(route, contentType);
        if (!mime.valid) return failure("mime_not_allowed");
        // Reject before cancellation can resolve a pending read as EOF. Keep Phase A unchanged.
        let bodyTimer, bytes;
        resources.activeTimers++;
        const deadline = new Promise((_, reject) => { bodyTimer = setTimeout(() => {
          reject(Object.assign(new Error(), { code: "body_timeout" })); controller.abort();
        }, bodyTimeoutMs); });
        const bodyRead = Acquisition.readBounded(response, route.maxBytes, bodyTimeoutMs);
        try { bytes = await Promise.race([bodyRead, deadline]); }
        catch (error) { await bodyRead.catch(() => undefined); throw error; }
        finally { clearTimeout(bodyTimer); resources.activeTimers--; }
        const decoded = decode(bytes, contentType);
        if (!decoded.ok) return failure(decoded.reason);
        return { success: true, sourceId, fetchedAt: new Date().toISOString(), document: {
          finalUrl: route.url, httpStatus: 200, redirects, mime: mime.mime, contentType,
          encodingEvidence: decoded.evidence, byteCount: bytes.length,
          contentSha256: hash(bytes), parserInput: bytes } };
      }
      return failure("redirect_hop_exceeded");
    } catch (error) { return failure(SAFE_FAILURES.has(error?.code) ? error.code : "network_or_body_failed"); }
    finally { controller?.abort();
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
      resources.activeTasks--; }
  }
  return Object.freeze({ acquire, diagnostics: () => ({ ...resources }) });
}
module.exports = Object.freeze({ ROUTES, SOURCE_CONTRACT_VERSION, PARSER_VERSION,
  shadowRegistry, validateUrl, decode, hash, createAcquirer });
