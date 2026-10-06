"use strict";

const registry = require("../marketCalendar/sourceRegistry.js");

const OPERATION = "source-document-set";
const MAX_REDIRECTS = 3;
const MAX_RETRIES = 1;
const REQUEST_TIMEOUT_MS = 15_000;
const BODY_TIMEOUT_MS = 15_000;

const MIME = Object.freeze({
  html: Object.freeze(["text/html", "application/xhtml+xml"]),
  xml: Object.freeze(["application/xml", "text/xml"]),
  json: Object.freeze(["application/json", "text/json"]),
  xlsx: Object.freeze([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/zip"
  ])
});

const documentPolicy = (role, url, kind, maxBytes, pathPattern = null, options = {}) =>
  Object.freeze({ role, url, kind, maxBytes, allowedMime: MIME[kind], pathPattern,
    allowUndeclaredUtf8: options.allowUndeclaredUtf8 === true,
    encodingEvidenceOnly: options.encodingEvidenceOnly === true,
    allowValueOnlyWorkbookSanitization: options.allowValueOnlyWorkbookSanitization === true });

const sourcePolicies = Object.freeze({
  "jp-boj-calendar": Object.freeze({ documents: Object.freeze([
    documentPolicy("primary", registry.getSource("jp-boj-calendar").canonicalUrl, "html", 2_000_000)
  ]) }),
  "jp-stat-cpi": Object.freeze({ documents: Object.freeze([
    documentPolicy("landing", registry.getSource("jp-stat-cpi").canonicalUrl, "html", 2_000_000,
      null, { encodingEvidenceOnly: true }),
    documentPolicy("data", "https://www.stat.go.jp/data/kouhyou/e-stat_cpi.xml", "xml", 2_000_000)
  ]) }),
  "jp-stat-labor": Object.freeze({ documents: Object.freeze([
    documentPolicy("landing", registry.getSource("jp-stat-labor").canonicalUrl, "html", 2_000_000,
      null, { encodingEvidenceOnly: true }),
    documentPolicy("data", "https://www.stat.go.jp/data/kouhyou/e-stat_roudou.xml", "xml", 2_000_000)
  ]) }),
  "jp-esri-machinery-orders-calendar": Object.freeze({ documents: Object.freeze([
    documentPolicy("primary", registry.getSource("jp-esri-machinery-orders-calendar").canonicalUrl,
      "html", 2_000_000)
  ]) }),
  "jp-esri-sna-calendar": Object.freeze({ documents: Object.freeze([
    documentPolicy("primary", registry.getSource("jp-esri-sna-calendar").canonicalUrl,
      "html", 2_000_000)
  ]) }),
  "us-fed-fomc-calendar": Object.freeze({ documents: Object.freeze([
    documentPolicy("primary", registry.getSource("us-fed-fomc-calendar").canonicalUrl,
      "html", 3_000_000)
  ]) }),
  "us-bls-calendar": Object.freeze({ documents: Object.freeze([
    documentPolicy("primary", registry.getSource("us-bls-calendar").canonicalUrl,
      "html", 3_000_000,
      /^\/schedule\/(?:$|20\d{2}\/(?:0[1-9]|1[0-2])_sched\.htm$)/,
      { allowUndeclaredUtf8: true })
  ]) }),
  "us-bea-calendar": Object.freeze({ documents: Object.freeze([
    documentPolicy("scheduleAuthority", registry.getSource("us-bea-calendar")
      .endpointRoles.scheduleAuthority, "json", 3_000_000),
    documentPolicy("releaseSemantics", registry.getSource("us-bea-calendar")
      .endpointRoles.releaseSemantics, "html", 3_000_000)
  ]) }),
  "us-census-calendar": Object.freeze({ documents: Object.freeze([
    documentPolicy("primary", registry.getSource("us-census-calendar").canonicalUrl,
      "html", 5_000_000)
  ]) }),
  "jp-jpx-derivatives-calendar": Object.freeze({ documents: Object.freeze([
    documentPolicy("landing", registry.getSource("jp-jpx-derivatives-calendar").canonicalUrl,
      "html", 2_000_000),
    Object.freeze({ role: "workbook", url: null, kind: "xlsx", maxBytes: 5_000_000,
      allowedMime: MIME.xlsx,
      pathPattern: /^\/derivatives\/rules\/last-trading-day\/[a-z0-9]+-att\/20\d{2}_indexfutures_options_1_j\.xlsx$/,
      allowUndeclaredUtf8: false, encodingEvidenceOnly: false,
      allowValueOnlyWorkbookSanitization: true })
  ]) }),
  "jp-jpx-market-holidays": Object.freeze({ documents: Object.freeze([
    documentPolicy("primary", registry.getSource("jp-jpx-market-holidays").canonicalUrl,
      "html", 2_000_000)
  ]) }),
  "us-nyse-market-holidays": Object.freeze({ documents: Object.freeze([
    documentPolicy("primary", registry.getSource("us-nyse-market-holidays").canonicalUrl,
      "html", 5_000_000)
  ]) })
});

function cleanMime(value) {
  return typeof value === "string" ? value.split(";", 1)[0].trim().toLowerCase() : "";
}

function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("|") !== "operation|sourceId")
    return Object.freeze({ valid: false, reason: "request_shape_invalid" });
  if (value.operation !== OPERATION)
    return Object.freeze({ valid: false, reason: "operation_not_allowed" });
  const source = registry.getSource(value.sourceId);
  if (!source || source.formalEligible !== true || !registry.isAcquisitionEnabled(value.sourceId) ||
      !sourcePolicies[value.sourceId])
    return Object.freeze({ valid: false, reason: "source_not_allowed" });
  return Object.freeze({ valid: true, reason: null, sourceId: value.sourceId,
    operation: OPERATION });
}

function validateUrl(sourceId, policy, value) {
  const source = registry.getSource(sourceId);
  if (!source || !policy || typeof value !== "string")
    return Object.freeze({ valid: false, reason: "url_policy_unavailable" });
  let url;
  try { url = new URL(value); } catch (_error) {
    return Object.freeze({ valid: false, reason: "url_invalid" });
  }
  if (url.protocol !== "https:") return Object.freeze({ valid: false, reason: "https_required" });
  if (url.username || url.password) return Object.freeze({ valid: false, reason: "credentials_forbidden" });
  if (url.port || url.hash) return Object.freeze({ valid: false, reason: "url_component_forbidden" });
  if (url.search) return Object.freeze({ valid: false, reason: "query_forbidden" });
  if (!source.allowedHosts.includes(url.hostname))
    return Object.freeze({ valid: false, reason: "host_not_allowed" });
  if (/%[0-9a-f]{2}/i.test(url.pathname) || url.pathname.slice(1).includes("//") ||
      url.pathname.includes("\\"))
    return Object.freeze({ valid: false, reason: "path_not_allowed" });
  if (policy.pathPattern && !policy.pathPattern.test(url.pathname))
    return Object.freeze({ valid: false, reason: "path_not_allowed" });
  if (!policy.pathPattern && policy.url && url.href !== new URL(policy.url).href)
    return Object.freeze({ valid: false, reason: "path_not_allowed" });
  return Object.freeze({ valid: true, reason: null, url: url.href });
}

function validateMime(policy, contentType) {
  const mime = cleanMime(contentType);
  return policy?.allowedMime?.includes(mime)
    ? Object.freeze({ valid: true, mime })
    : Object.freeze({ valid: false, mime: mime || null, reason: "mime_not_allowed" });
}

function getPolicy(sourceId) { return sourcePolicies[sourceId] || null; }

module.exports = Object.freeze({ OPERATION, MAX_REDIRECTS, MAX_RETRIES,
  REQUEST_TIMEOUT_MS, BODY_TIMEOUT_MS, MIME, SOURCE_POLICIES: sourcePolicies,
  cleanMime, validateRequest, validateUrl, validateMime, getPolicy });
