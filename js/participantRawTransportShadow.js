"use strict";

const crypto = require("node:crypto");
const XLSX = require("xlsx");
const P1 = require("./participantAcquisitionAuthorityContract.js");
const ParticipantData = require("./participantData.js");

const TRANSPORT_RESULT_VERSION = "participants-raw-transport-result-v1";
const TRANSPORT_SET_VERSION = "participants-raw-transport-set-v1";
const MAX_REDIRECTS = 3;
const MAX_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 15_000;
const BODY_TIMEOUT_MS = 15_000;
const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const REQUEST_POLICY = Object.freeze({
  method: "GET",
  redirect: "manual",
  credentials: "omit",
  cache: "no-store",
  maxRedirects: MAX_REDIRECTS,
  maxRetries: 0,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  bodyTimeoutMs: BODY_TIMEOUT_MS,
  maxBytes: MAX_BYTES,
  acceptedMime: MIME
});

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const identity = (value, prefix) => typeof value === "string" &&
  new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|sha256:[0-9a-f]{64}$`)
    .test(value);
const isoTime = value => typeof value === "string" && /^20\d{2}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value));

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value) || ArrayBuffer.isView(value))
    return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

const rawSha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function failure(reason, details = {}) {
  return freeze({ success: false, reason, transportResult: null,
    diagnostics: [{ stage: details.stage || "transport", role: details.role || null,
      sourceDate: details.sourceDate || null, httpStatus: details.httpStatus ?? null,
      redirectCount: details.redirectCount ?? 0 }] });
}

function mimeOf(headers) {
  return String(headers?.get?.("content-type") || "").split(";", 1)[0].trim().toLowerCase();
}

function sourceUrls(sourceDate) {
  return Object.fromEntries(P1.ROLE_ORDER.map(role =>
    [role, P1.canonicalWorkbookUrl(role, sourceDate)]));
}

function previousWeekdayDate(value) {
  const date = new Date(`${value}T00:00:00.000Z`);
  do date.setUTCDate(date.getUTCDate() - 1);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return date.toISOString().slice(0, 10);
}

function parseWorkbook(bytes, sourceDate) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4 || bytes[0] !== 0x50 ||
      bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04)
    throw new TypeError("xlsx_container_invalid");
  const workbook = XLSX.read(bytes, { type: "array" });
  const sheetName = workbook.SheetNames?.[0];
  if (!sheetName || !workbook.Sheets?.[sheetName]) throw new TypeError("first_worksheet_missing");
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
  const parsed = ParticipantData.parseParticipantExcel(rows, sourceDate);
  if (!parsed || parsed.sourceDate !== sourceDate) throw new TypeError("source_date_mismatch");
  return parsed;
}

function parserPreviewHash(value) {
  return P1.sha256(value);
}

function routeFor(manifest, acquisition) {
  if (!manifest || !acquisition) return null;
  const route = manifest.routes?.find(value => value.role === acquisition.role);
  return route && route.routeIdentity === acquisition.routeIdentity &&
    route.canonicalUrl === acquisition.canonicalUrl ? route : null;
}

function requestTimeout(milliseconds) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error("request_timeout"), { code: "request_timeout" }));
    }, milliseconds);
  });
  return { signal: controller.signal, deadline, clear: () => clearTimeout(timer) };
}

function mapBodyFailure(error) {
  if (["content_length_exceeded", "body_size_exceeded"].includes(error?.code)) return "oversize";
  if (error?.code === "body_timeout") return "timeout";
  if (["content_length_invalid", "truncated_response", "response_stream_unavailable"]
    .includes(error?.code)) return "body_length_mismatch";
  return "body_length_mismatch";
}

function contentLength(headers) {
  const value = headers?.get?.("content-length");
  if (value === null || value === undefined || value === "") return null;
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
}

async function readExactBounded(response, maximum, timeoutMs) {
  const declared = contentLength(response.headers);
  if (Number.isNaN(declared))
    throw Object.assign(new Error("content_length_invalid"), { code: "content_length_invalid" });
  if (declared !== null && declared > maximum)
    throw Object.assign(new Error("content_length_exceeded"), { code: "content_length_exceeded" });
  if (!response.body?.getReader)
    throw Object.assign(new Error("response_stream_unavailable"), { code: "response_stream_unavailable" });
  const reader = response.body.getReader(), chunks = [];
  let total = 0, timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error("body_timeout"), { code: "body_timeout" }));
      reader.cancel().catch(() => undefined);
    }, timeoutMs);
  });
  try {
    while (true) {
      const item = await Promise.race([reader.read(), deadline]);
      if (item.done) break;
      const chunk = item.value instanceof Uint8Array ? item.value : new Uint8Array(item.value || []);
      total += chunk.byteLength;
      if (total > maximum) {
        await reader.cancel().catch(() => undefined);
        throw Object.assign(new Error("body_size_exceeded"), { code: "body_size_exceeded" });
      }
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock?.();
  }
  const contentEncoding = String(response.headers?.get?.("content-encoding") || "")
    .trim().toLowerCase();
  if (declared !== null && !contentEncoding && declared !== total)
    throw Object.assign(new Error("truncated_response"), { code: "truncated_response" });
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

const RESULT_FIELDS = Object.freeze([
  "success", "contractVersion", "transportResultId", "manifestId", "runId", "requestId",
  "acquisitionId", "routeIdentity", "sourceFamily", "sourceId", "sourceDate", "role",
  "initialUrl", "finalUrl", "redirects", "status", "mime", "encoding", "byteLength",
  "rawSha256", "fetchedAt", "parserPreview", "parserPreviewSha256", "authorityKeyId",
  "integritySha256", "authoritySignature", "bytes", "diagnostics"
]);

function resultMaterial(value) {
  return Object.fromEntries(RESULT_FIELDS.filter(field =>
    !["transportResultId", "integritySha256", "authoritySignature", "bytes"].includes(field))
    .map(field => [field, value[field]]));
}

function validateTransportResult(value, manifest, acquisition, authority) {
  if (!exact(value, RESULT_FIELDS) || value.success !== true ||
      value.contractVersion !== TRANSPORT_RESULT_VERSION ||
      !P1.validateAcquisitionManifest(manifest, authority) ||
      !P1.validateWorkbookAcquisition(acquisition, manifest, authority) ||
      !identity(value.transportResultId, "participants-raw-transport-result-v1") ||
      value.manifestId !== manifest.manifestId || value.runId !== manifest.runId ||
      value.requestId !== manifest.requestId || value.acquisitionId !== acquisition.acquisitionId ||
      value.routeIdentity !== acquisition.routeIdentity || value.sourceFamily !== P1.SOURCE_FAMILY ||
      value.sourceId !== P1.SOURCE_ID || value.sourceDate !== acquisition.sourceDate ||
      value.role !== acquisition.role || value.initialUrl !== acquisition.canonicalUrl ||
      value.finalUrl !== acquisition.canonicalUrl || !Array.isArray(value.redirects) ||
      value.redirects.length > MAX_REDIRECTS || value.redirects.some(redirect =>
        !exact(redirect, ["status", "from", "to"]) || redirect.status < 300 ||
        redirect.status >= 400 || redirect.from !== acquisition.canonicalUrl ||
        redirect.to !== acquisition.canonicalUrl) || value.status !== 200 || value.mime !== MIME ||
      value.encoding !== null || !(value.bytes instanceof Uint8Array) ||
      value.byteLength !== value.bytes.byteLength || value.byteLength <= 0 ||
      value.byteLength > MAX_BYTES || !digest(value.rawSha256) ||
      value.rawSha256 !== rawSha256(value.bytes) || !isoTime(value.fetchedAt) ||
      !object(value.parserPreview) || !digest(value.parserPreviewSha256) ||
      value.parserPreviewSha256 !== parserPreviewHash(value.parserPreview) ||
      value.parserPreview.sourceDate !== value.sourceDate || value.authorityKeyId !== authority.keyId ||
      !digest(value.integritySha256) || !digest(value.authoritySignature) ||
      !Array.isArray(value.diagnostics) || value.diagnostics.length !== 0) return false;
  const integrity = P1.sha256(resultMaterial(value));
  return value.integritySha256 === integrity &&
    value.transportResultId === `participants-raw-transport-result-v1|sha256:${integrity}` &&
    authority.verify("participants_transport_result", integrity, value.authoritySignature);
}

function buildTransportResult({ manifest, acquisition, route, response, finalUrl, redirects,
    bytes, acquiredByteLength, acquiredRawSha256, parsed, now }, authority) {
  const result = { success: true, contractVersion: TRANSPORT_RESULT_VERSION,
    transportResultId: "", manifestId: manifest.manifestId, runId: manifest.runId,
    requestId: manifest.requestId, acquisitionId: acquisition.acquisitionId,
    routeIdentity: route.routeIdentity, sourceFamily: P1.SOURCE_FAMILY, sourceId: P1.SOURCE_ID,
    sourceDate: route.sourceDate, role: route.role, initialUrl: route.canonicalUrl, finalUrl,
    redirects, status: response.status, mime: MIME, encoding: null, byteLength: acquiredByteLength,
    rawSha256: acquiredRawSha256, fetchedAt: now().toISOString(), parserPreview: parsed,
    parserPreviewSha256: parserPreviewHash(parsed), authorityKeyId: authority.keyId,
    integritySha256: "", authoritySignature: "", bytes: new Uint8Array(bytes), diagnostics: [] };
  result.integritySha256 = P1.sha256(resultMaterial(result));
  result.transportResultId =
    `participants-raw-transport-result-v1|sha256:${result.integritySha256}`;
  result.authoritySignature = authority.sign("participants_transport_result", result.integritySha256);
  if (!validateTransportResult(result, manifest, acquisition, authority))
    throw new TypeError("participants_transport_result_invalid");
  return freeze(result);
}

function createParticipantsRawTransportShadow({ fetchImpl = globalThis.fetch,
    authority, now = () => new Date(), requestTimeoutMs = REQUEST_TIMEOUT_MS,
    bodyTimeoutMs = BODY_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function" || !authority || typeof authority.sign !== "function" ||
      typeof authority.verify !== "function" || !Number.isInteger(requestTimeoutMs) ||
      requestTimeoutMs < 1 || requestTimeoutMs > REQUEST_TIMEOUT_MS ||
      !Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > BODY_TIMEOUT_MS)
    throw new TypeError("participants_transport_configuration_invalid");

  async function fetchRoute(route) {
    if (!P1.validateRouteDescriptor(route)) return failure("route_rejected",
      { stage: "route", role: route?.role, sourceDate: route?.sourceDate });
    const redirects = [];
    let currentUrl = route.canonicalUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (currentUrl !== route.canonicalUrl) return failure("route_rejected",
        { stage: "redirect", role: route.role, sourceDate: route.sourceDate,
          redirectCount: redirects.length });
      const guard = requestTimeout(requestTimeoutMs);
      let response;
      try {
        response = await Promise.race([fetchImpl(currentUrl, { method: "GET", redirect: "manual",
          credentials: "omit", cache: "no-store", signal: guard.signal,
          headers: { accept: MIME } }), guard.deadline]);
      } catch (error) {
        return failure(error?.code === "request_timeout" || error?.name === "AbortError"
          ? "timeout" : "network_failed", { stage: "request", role: route.role,
          sourceDate: route.sourceDate, redirectCount: redirects.length });
      } finally { guard.clear(); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.("location");
        if (!location || hop === MAX_REDIRECTS) return failure("redirect_rejected",
          { stage: "redirect", role: route.role, sourceDate: route.sourceDate,
            httpStatus: response.status, redirectCount: redirects.length });
        let next;
        try { next = new URL(location, currentUrl).href; }
        catch (_error) { next = null; }
        if (next !== route.canonicalUrl) return failure("redirect_rejected",
          { stage: "redirect", role: route.role, sourceDate: route.sourceDate,
            httpStatus: response.status, redirectCount: redirects.length });
        redirects.push(freeze({ status: response.status, from: currentUrl, to: next }));
        currentUrl = next;
        continue;
      }
      if (response.status !== 200 || response.ok !== true) return failure("http_status",
        { stage: "status", role: route.role, sourceDate: route.sourceDate,
          httpStatus: response.status, redirectCount: redirects.length });
      if (mimeOf(response.headers) !== MIME) return failure("mime_mismatch",
        { stage: "mime", role: route.role, sourceDate: route.sourceDate,
          httpStatus: response.status, redirectCount: redirects.length });
      let bytes;
      try { bytes = await readExactBounded(response, MAX_BYTES, bodyTimeoutMs); }
      catch (error) { return failure(mapBodyFailure(error), { stage: "body", role: route.role,
        sourceDate: route.sourceDate, httpStatus: response.status,
        redirectCount: redirects.length }); }
      const acquiredByteLength = bytes.byteLength, acquiredRawSha256 = rawSha256(bytes);
      let parsed;
      try { parsed = parseWorkbook(bytes, route.sourceDate); }
      catch (_error) { return failure("workbook_parse_rejected", { stage: "parser",
        role: route.role, sourceDate: route.sourceDate, httpStatus: response.status,
        redirectCount: redirects.length }); }
      return { success: true, route, response, finalUrl: currentUrl, redirects, bytes,
        acquiredByteLength, acquiredRawSha256, parsed };
    }
    return failure("redirect_rejected", { stage: "redirect", role: route.role,
      sourceDate: route.sourceDate, redirectCount: redirects.length });
  }

  async function resolveDiscovery({ intent, indexFacts = null, probeStartDate = null,
      discoveryRequestId = null } = {}) {
    if (!P1.validateAcquisitionIntent(intent)) return failure("route_rejected", { stage: "intent" });
    if (intent.requestKind !== "latest_available") {
      const date = intent.requestKind === "explicit_source_date" ? intent.targetDate : probeStartDate;
      if (!P1.sourceDate(date)) return failure("route_rejected", { stage: "discovery" });
      try {
        return freeze({ success: true, reason: null, discovery: P1.createOfficialDiscovery({ intent,
          discoveryKind: "official_monthly_listing", discoveryRequestId,
          officialUrl: P1.monthlyListingUrl(date), sourceDate: date, sourceUrls: sourceUrls(date),
          fallbackAttempt: null }), probeCount: 0 });
      } catch (_error) { return failure("route_rejected", { stage: "discovery" }); }
    }
    const indexed = P1.discoverLatestParticipantsSourceSet({ intent, indexFacts });
    if (indexed.accepted) return freeze({ success: true, reason: null,
      discovery: indexed.discovery, probeCount: 0 });
    if (!P1.sourceDate(probeStartDate) || typeof discoveryRequestId !== "string")
      return failure("incomplete_set", { stage: "discovery" });
    let date = probeStartDate;
    for (let attempt = 1; attempt <= P1.FALLBACK_POLICY.maxAttempts; attempt += 1) {
      const route = P1.createRouteDescriptor(P1.FALLBACK_POLICY.probeRole, date);
      const probed = await fetchRoute(route);
      if (probed.success) {
        try {
          const discovery = P1.createOfficialDiscovery({ intent,
            discoveryKind: "bounded_day_probe", discoveryRequestId,
            officialUrl: route.canonicalUrl, sourceDate: date, sourceUrls: sourceUrls(date),
            fallbackAttempt: attempt });
          return freeze({ success: true, reason: null, discovery, probeCount: attempt });
        } catch (_error) { return failure("route_rejected", { stage: "discovery" }); }
      }
      if (probed.reason !== "http_status" || probed.diagnostics[0].httpStatus !== 404)
        return probed;
      date = previousWeekdayDate(date);
    }
    return failure("incomplete_set", { stage: "fallback", sourceDate: date,
      redirectCount: P1.FALLBACK_POLICY.maxAttempts });
  }

  async function resolveManifest(input = {}) {
    const resolved = await resolveDiscovery(input);
    if (!resolved.success) return resolved;
    try {
      return freeze({ success: true, reason: null, discovery: resolved.discovery,
        manifest: P1.createAcquisitionManifest({ intent: input.intent,
          discovery: resolved.discovery, requestId: input.requestId }, authority),
        probeCount: resolved.probeCount });
    } catch (_error) { return failure("route_rejected", { stage: "manifest" }); }
  }

  async function acquireManifest(manifest) {
    if (!P1.validateAcquisitionManifest(manifest, authority))
      return failure("route_rejected", { stage: "manifest" });
    const acquisitions = P1.createWorkbookAcquisitions(manifest, authority);
    const raw = await Promise.all(acquisitions.map(async acquisition => {
      const route = routeFor(manifest, acquisition);
      if (!route || !P1.validateRouteDescriptor(route)) return failure("route_rejected",
        { stage: "route", role: acquisition.role, sourceDate: acquisition.sourceDate });
      const fetched = await fetchRoute(route);
      if (!fetched.success) return fetched;
      return buildTransportResult({ manifest, acquisition, route, response: fetched.response,
        finalUrl: fetched.finalUrl, redirects: fetched.redirects, bytes: fetched.bytes,
        acquiredByteLength: fetched.acquiredByteLength,
        acquiredRawSha256: fetched.acquiredRawSha256, parsed: fetched.parsed, now }, authority);
    }));
    const failed = raw.find(value => value.success !== true);
    if (failed) return failed;
    return assembleTransportSet({ manifest, acquisitions, results: raw }, authority);
  }

  return freeze({ resolveDiscovery, resolveManifest, acquireManifest });
}

const SET_FIELDS = Object.freeze([
  "success", "contractVersion", "transportSetId", "manifestId", "runId", "sourceFamily",
  "sourceId", "sourceDate", "completeSetIdentity", "results", "authorityKeyId",
  "integritySha256", "authoritySignature", "diagnostics"
]);

function setMaterial(value) {
  return Object.fromEntries(SET_FIELDS.filter(field =>
    !["transportSetId", "integritySha256", "authoritySignature", "results"].includes(field))
    .map(field => [field, value[field]]).concat([["transportResultIds",
      value.results.map(result => result.transportResultId)]]));
}

function validateTransportSet(value, manifest, acquisitions, authority) {
  if (!exact(value, SET_FIELDS) || value.success !== true ||
      value.contractVersion !== TRANSPORT_SET_VERSION ||
      !P1.validateAcquisitionManifest(manifest, authority) ||
      !identity(value.transportSetId, "participants-raw-transport-set-v1") ||
      value.manifestId !== manifest.manifestId || value.runId !== manifest.runId ||
      value.sourceFamily !== P1.SOURCE_FAMILY || value.sourceId !== P1.SOURCE_ID ||
      value.sourceDate !== manifest.sourceDate || !Array.isArray(acquisitions) ||
      acquisitions.length !== P1.ROLE_ORDER.length || !Array.isArray(value.results) ||
      value.results.length !== P1.ROLE_ORDER.length ||
      value.results.some((result, index) => result.role !== P1.ROLE_ORDER[index] ||
        !validateTransportResult(result, manifest, acquisitions[index], authority)) ||
      new Set(value.results.map(result => result.role)).size !== P1.ROLE_ORDER.length ||
      value.authorityKeyId !== authority.keyId || !digest(value.integritySha256) ||
      !digest(value.authoritySignature) || !Array.isArray(value.diagnostics) ||
      value.diagnostics.length !== 0) return false;
  let completeSet;
  try { completeSet = P1.createCompleteSet({ manifest, acquisitions }, authority); }
  catch (_error) { return false; }
  if (value.completeSetIdentity !== completeSet.setIdentity) return false;
  const integrity = P1.sha256(setMaterial(value));
  return value.integritySha256 === integrity &&
    value.transportSetId === `participants-raw-transport-set-v1|sha256:${integrity}` &&
    authority.verify("participants_transport_set", integrity, value.authoritySignature);
}

function assembleTransportSet({ manifest, acquisitions, results } = {}, authority) {
  if (!P1.validateAcquisitionManifest(manifest, authority) || !Array.isArray(acquisitions) ||
      !Array.isArray(results)) return failure("mixed_run", { stage: "assembly" });
  if (acquisitions.length !== P1.ROLE_ORDER.length || results.length !== P1.ROLE_ORDER.length ||
      new Set(results.map(result => result?.role)).size !== P1.ROLE_ORDER.length)
    return failure("incomplete_set", { stage: "assembly", sourceDate: manifest.sourceDate });
  const byRole = new Map(results.map(result => [result.role, result]));
  const ordered = P1.ROLE_ORDER.map(role => byRole.get(role));
  if (ordered.some((result, index) => !result || result.runId !== manifest.runId ||
      result.sourceDate !== manifest.sourceDate ||
      !validateTransportResult(result, manifest, acquisitions[index], authority)))
    return failure("mixed_run", { stage: "assembly", sourceDate: manifest.sourceDate });
  let completeSet;
  try { completeSet = P1.createCompleteSet({ manifest, acquisitions }, authority); }
  catch (_error) { return failure("mixed_run", { stage: "assembly", sourceDate: manifest.sourceDate }); }
  const set = { success: true, contractVersion: TRANSPORT_SET_VERSION, transportSetId: "",
    manifestId: manifest.manifestId, runId: manifest.runId, sourceFamily: P1.SOURCE_FAMILY,
    sourceId: P1.SOURCE_ID, sourceDate: manifest.sourceDate,
    completeSetIdentity: completeSet.setIdentity, results: ordered,
    authorityKeyId: authority.keyId, integritySha256: "", authoritySignature: "", diagnostics: [] };
  set.integritySha256 = P1.sha256(setMaterial(set));
  set.transportSetId = `participants-raw-transport-set-v1|sha256:${set.integritySha256}`;
  set.authoritySignature = authority.sign("participants_transport_set", set.integritySha256);
  if (!validateTransportSet(set, manifest, acquisitions, authority))
    return failure("mixed_run", { stage: "assembly", sourceDate: manifest.sourceDate });
  return freeze(set);
}

module.exports = freeze({ TRANSPORT_RESULT_VERSION, TRANSPORT_SET_VERSION, MAX_REDIRECTS,
  MAX_BYTES, REQUEST_TIMEOUT_MS, BODY_TIMEOUT_MS, MIME, REQUEST_POLICY, rawSha256,
  parseWorkbook, validateTransportResult, validateTransportSet, assembleTransportSet,
  createParticipantsRawTransportShadow });
