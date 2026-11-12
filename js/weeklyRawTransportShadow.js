"use strict";

const crypto = require("node:crypto");
const XLSX = require("xlsx");
const Authority = require("./weeklyAcquisitionAuthorityContract.js");
const WeeklyFutures = require("./weeklyFutures.js");
const WeeklyOptions = require("./weeklyOptions.js");

const LISTING_RESULT_VERSION = "weekly-listing-raw-transport-result-v1";
const WORKBOOK_RESULT_VERSION = "weekly-workbook-raw-transport-result-v1";
const SHADOW_RESULT_VERSION = "weekly-raw-transport-shadow-v1";
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const BODY_TIMEOUT_MS = 15_000;
const LISTING_MAX_BYTES = 512_000;
const FUTURES_MAX_BYTES = 1_000_000;
const OPTIONS_MAX_BYTES = 1_000_000;
const OBSERVED_JPX_MIME = "binary/octet-stream";
const LISTING_MIME_TYPES = Object.freeze([OBSERVED_JPX_MIME]);
const WORKBOOK_MIME_TYPES = Object.freeze([OBSERVED_JPX_MIME]);
const REQUEST_POLICY = Object.freeze({
  method: "GET",
  redirect: "manual",
  credentials: "omit",
  cache: "no-store",
  maxRedirects: MAX_REDIRECTS,
  maxRetries: 0,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  bodyTimeoutMs: BODY_TIMEOUT_MS,
  listingMaxBytes: LISTING_MAX_BYTES,
  futuresMaxBytes: FUTURES_MAX_BYTES,
  optionsMaxBytes: OPTIONS_MAX_BYTES,
  listingMimeTypes: LISTING_MIME_TYPES,
  workbookMimeTypes: WORKBOOK_MIME_TYPES
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

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value) || ArrayBuffer.isView(value))
    return value;
  Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

const rawSha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function mimeOf(headers) {
  return String(headers?.get?.("content-type") || "").split(";", 1)[0].trim().toLowerCase();
}

function contentLength(headers) {
  const value = headers?.get?.("content-length");
  if (value === null || value === undefined || value === "") return null;
  return /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : NaN;
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

async function readExactBounded(response, maximum, timeoutMs) {
  const declared = contentLength(response.headers);
  if (Number.isNaN(declared))
    throw Object.assign(new Error("content_length_invalid"), { code: "content_length_invalid" });
  if (declared !== null && declared > maximum)
    throw Object.assign(new Error("content_length_exceeded"), { code: "content_length_exceeded" });
  if (!response.body?.getReader)
    throw Object.assign(new Error("response_stream_unavailable"),
      { code: "response_stream_unavailable" });
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
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bodyFailure(error) {
  if (["content_length_exceeded", "body_size_exceeded"].includes(error?.code)) return "oversize";
  if (error?.code === "body_timeout") return "timeout";
  return "body_length_mismatch";
}

function failure(reason, details = {}) {
  return freeze({ success: false, reason, transportResult: null,
    diagnostics: [{ stage: details.stage || "transport", role: details.role || null,
      sourceDate: details.sourceDate || null, listingYear: details.listingYear || null,
      httpStatus: details.httpStatus ?? null, redirectCount: details.redirectCount ?? 0,
      transportReason: details.transportReason || null }] });
}

function isoDateFromCompact(value) {
  if (typeof value !== "string" || !/^20\d{6}$/.test(value)) return null;
  const result = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  return Authority.sourceDate(result) ? result : null;
}

function parseJapaneseDate(value, asOf = false) {
  const normalized = String(value ?? "").replace(/\r?\n/g, "").trim();
  const expression = asOf
    ? /(?:[（(]\s*)?(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日現在(?:\s*[）)])?/
    : /^(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日$/;
  const match = normalized.match(expression);
  if (!match) return null;
  return isoDateFromCompact(`${match[1]}${String(Number(match[2])).padStart(2, "0")}` +
    `${String(Number(match[3])).padStart(2, "0")}`);
}

function strictUtf8(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (_error) { throw new TypeError("listing_utf8_invalid"); }
}

function normalizeListingUrl(value, role, sourceDate) {
  if (value === null || value === undefined || value === "") return null;
  let absolute;
  try { absolute = new URL(value, Authority.JPX_ORIGIN).href; }
  catch (_error) { throw new TypeError("listing_workbook_route_invalid"); }
  if (absolute !== Authority.canonicalWorkbookUrl(role, sourceDate))
    throw new TypeError("listing_workbook_route_invalid");
  return absolute;
}

function parseListingBytes(bytes, year) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 ||
      !Number.isSafeInteger(year) || year < 2000 || year > 2099)
    throw new TypeError("listing_parse_input_invalid");
  let parsed;
  try { parsed = JSON.parse(strictUtf8(bytes)); }
  catch (_error) { throw new TypeError("listing_parse_rejected"); }
  if (!object(parsed) || !Array.isArray(parsed.TableDatas))
    throw new TypeError("listing_structure_invalid");
  const entries = [], seen = new Set();
  for (const row of parsed.TableDatas) {
    if (!object(row)) throw new TypeError("listing_row_invalid");
    const sourceDate = isoDateFromCompact(String(row.TradeDate || ""));
    if (!sourceDate || Number(sourceDate.slice(0, 4)) !== year || seen.has(sourceDate))
      throw new TypeError("listing_trade_date_invalid");
    const futuresUrl = normalizeListingUrl(row.IndexFutures,
      "weekly_futures_workbook", sourceDate);
    const optionsUrl = normalizeListingUrl(row.IndexOptions,
      "weekly_options_workbook", sourceDate);
    if (!futuresUrl && !optionsUrl) throw new TypeError("listing_domain_routes_missing");
    seen.add(sourceDate);
    entries.push({ sourceDate, futuresUrl, optionsUrl });
  }
  entries.sort((left, right) => left.sourceDate.localeCompare(right.sourceDate));
  if (entries.length === 0) throw new TypeError("listing_empty");
  const tradeDates = entries.map(entry => entry.sourceDate);
  return freeze({ listingResult: Authority.createListingResult({ listingYear: year, tradeDates }),
    entries, updateDate: typeof parsed.UpdateDate === "string" ? parsed.UpdateDate : null });
}

function selectTradeDates(intent, parsedListings) {
  if (!Authority.validateAcquisitionIntent(intent) || !Array.isArray(parsedListings) ||
      parsedListings.some(value => !object(value) ||
        !Authority.validateListingResult(value.listingResult)))
    throw new TypeError("listing_selection_input_invalid");
  const entries = parsedListings.flatMap(value => value.entries)
    .sort((left, right) => left.sourceDate.localeCompare(right.sourceDate));
  if (intent.requestKind === "latest_available")
    return entries.length ? [entries.at(-1).sourceDate] : [];
  if (intent.requestKind === "explicit_source_date")
    return entries.some(entry => entry.sourceDate === intent.targetDate) ? [intent.targetDate] : [];
  return entries.filter(entry => entry.sourceDate >= intent.startDate &&
    entry.sourceDate <= intent.endDate).map(entry => entry.sourceDate);
}

function productionEquivalentLatestTradeDate(bytes) {
  let parsed;
  try { parsed = JSON.parse(strictUtf8(bytes)); }
  catch (_error) { return null; }
  if (!Array.isArray(parsed?.TableDatas)) return null;
  const latest = parsed.TableDatas.filter(row =>
    isoDateFromCompact(String(row?.TradeDate || "")) &&
    (row?.IndexFutures || row?.IndexOptions)).sort((left, right) =>
    String(right.TradeDate).localeCompare(String(left.TradeDate)))[0];
  return latest ? isoDateFromCompact(String(latest.TradeDate)) : null;
}

function workbookMaximum(role) {
  if (role === "weekly_futures_workbook") return FUTURES_MAX_BYTES;
  if (role === "weekly_options_workbook") return OPTIONS_MAX_BYTES;
  return null;
}

function isXlsx(bytes) {
  return bytes instanceof Uint8Array && bytes.byteLength >= 4 && bytes[0] === 0x50 &&
    bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function parseWorkbookPreview(bytes, acquisition) {
  if (!Authority.validateDomainAcquisition(acquisition, acquisition?.runId))
    throw new TypeError("workbook_acquisition_invalid");
  if (!isXlsx(bytes)) throw new TypeError("workbook_signature_rejected");
  let workbook, sheet, rows;
  try {
    workbook = XLSX.read(bytes, { type: "array" });
    const sheetName = workbook.SheetNames?.[0];
    sheet = sheetName ? workbook.Sheets?.[sheetName] : null;
    if (!sheet) throw new Error("first_worksheet_missing");
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  } catch (_error) { throw new TypeError("workbook_parse_rejected"); }
  const sourceDate = parseJapaneseDate(sheet?.A2?.v, true);
  const publishedDate = parseJapaneseDate(sheet?.A3?.v, false);
  if (sourceDate !== acquisition.sourceDate || !publishedDate)
    throw new TypeError("workbook_date_rejected");
  let canonical;
  try {
    canonical = acquisition.role === "weekly_futures_workbook"
      ? WeeklyFutures.parseWeeklyFuturesRows(rows)
      : WeeklyOptions.parseWeeklyOptionsRows(rows);
  } catch (_error) { throw new TypeError("workbook_parse_rejected"); }
  const valid = acquisition.role === "weekly_futures_workbook"
    ? WeeklyFutures.validateWeeklyFuturesData(canonical)
    : WeeklyOptions.validateWeeklyOptionsData(canonical);
  if (!valid) throw new TypeError("workbook_parse_rejected");
  return freeze({ sourceDate, publishedDate, canonical,
    canonicalSha256: Authority.sha256(canonical), parserAuthority:
      clone(Authority.PARSER_AUTHORITIES[acquisition.role]) });
}

function jstYear(now) {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", year: "numeric" })
    .format(now));
}

function yearsForIntent(intent, now) {
  if (intent.requestKind === "latest_available") return [jstYear(now)];
  const start = Number((intent.targetDate || intent.startDate).slice(0, 4));
  const end = Number((intent.targetDate || intent.endDate).slice(0, 4));
  return Array.from({ length: end - start + 1 }, (_unused, index) => start + index);
}

const LISTING_FIELDS = Object.freeze([
  "success", "contractVersion", "rawResultId", "manifestId", "runId", "discoveryId",
  "sourceType", "year", "initialUrl", "finalUrl", "redirects", "status", "mime",
  "encoding", "byteLength", "rawSha256", "fetchedAt", "authorityKeyId",
  "integritySha256", "authoritySignature", "bytes", "diagnostics"
]);

function listingMaterial(value) {
  return Object.fromEntries(LISTING_FIELDS.filter(field =>
    !["rawResultId", "integritySha256", "authoritySignature", "bytes"].includes(field))
    .map(field => [field, clone(value[field])]));
}

function validateListingTransportResult(value, manifest, discovery, authority) {
  if (!exact(value, LISTING_FIELDS) || value.success !== true ||
      value.contractVersion !== LISTING_RESULT_VERSION ||
      !Authority.validateManifest(manifest, authority) ||
      !Authority.validateDiscovery(discovery) ||
      !identity(value.rawResultId, LISTING_RESULT_VERSION) ||
      value.manifestId !== manifest.manifestId || value.runId !== manifest.runId ||
      value.discoveryId !== discovery.discoveryIdentity || value.sourceType !== "official_listing" ||
      value.year !== discovery.listingYear ||
      value.initialUrl !== discovery.listingRoute.canonicalUrl ||
      value.finalUrl !== discovery.listingRoute.canonicalUrl || !Array.isArray(value.redirects) ||
      value.redirects.length > MAX_REDIRECTS || value.status !== 200 ||
      !LISTING_MIME_TYPES.includes(value.mime) || value.encoding !== "utf-8" ||
      !(value.bytes instanceof Uint8Array) || value.byteLength !== value.bytes.byteLength ||
      value.byteLength <= 0 || value.byteLength > LISTING_MAX_BYTES ||
      !digest(value.rawSha256) || value.rawSha256 !== rawSha256(value.bytes) ||
      !isoTime(value.fetchedAt) || value.authorityKeyId !== authority.keyId ||
      !digest(value.integritySha256) || !digest(value.authoritySignature) ||
      !Array.isArray(value.diagnostics) || value.diagnostics.length !== 0) return false;
  const integrity = Authority.sha256(listingMaterial(value));
  return value.integritySha256 === integrity &&
    value.rawResultId === `${LISTING_RESULT_VERSION}|sha256:${integrity}` &&
    authority.verify("weekly_listing_transport_result", integrity, value.authoritySignature);
}

const WORKBOOK_FIELDS = Object.freeze([
  "success", "contractVersion", "rawResultId", "manifestId", "runId", "acquisitionId",
  "sourceId", "role", "sourceDate", "routeIdentity", "initialUrl", "finalUrl",
  "redirects", "status", "mime", "encoding", "byteLength", "rawSha256", "fetchedAt",
  "publishedDate", "parserPreviewSha256", "parserAuthority", "authorityKeyId",
  "integritySha256", "authoritySignature", "bytes", "parserPreview", "diagnostics"
]);

function workbookMaterial(value) {
  return Object.fromEntries(WORKBOOK_FIELDS.filter(field =>
    !["rawResultId", "integritySha256", "authoritySignature", "bytes", "parserPreview"]
      .includes(field)).map(field => [field, clone(value[field])]));
}

function manifestDescriptor(manifest, role) {
  return role === "weekly_futures_workbook" ? manifest?.futuresDescriptor :
    role === "weekly_options_workbook" ? manifest?.optionsDescriptor : null;
}

function validateWorkbookTransportResult(value, manifest, authority) {
  const acquisition = manifestDescriptor(manifest, value?.role);
  if (!exact(value, WORKBOOK_FIELDS) || value.success !== true ||
      value.contractVersion !== WORKBOOK_RESULT_VERSION ||
      !Authority.validateManifest(manifest, authority) ||
      !Authority.validateDomainAcquisition(acquisition, manifest.runId) ||
      !identity(value.rawResultId, WORKBOOK_RESULT_VERSION) ||
      value.manifestId !== manifest.manifestId || value.runId !== manifest.runId ||
      value.acquisitionId !== acquisition.acquisitionId || value.sourceId !== acquisition.sourceId ||
      value.role !== acquisition.role || value.sourceDate !== acquisition.sourceDate ||
      value.routeIdentity !== acquisition.route.routeIdentity ||
      value.initialUrl !== acquisition.route.canonicalUrl ||
      value.finalUrl !== acquisition.route.canonicalUrl || !Array.isArray(value.redirects) ||
      value.redirects.length > MAX_REDIRECTS || value.status !== 200 ||
      !WORKBOOK_MIME_TYPES.includes(value.mime) || value.encoding !== null ||
      !(value.bytes instanceof Uint8Array) || value.byteLength !== value.bytes.byteLength ||
      value.byteLength <= 0 || value.byteLength > workbookMaximum(value.role) ||
      !isXlsx(value.bytes) || !digest(value.rawSha256) ||
      value.rawSha256 !== rawSha256(value.bytes) || !isoTime(value.fetchedAt) ||
      !Authority.sourceDate(value.publishedDate) || !object(value.parserPreview) ||
      value.parserPreview.sourceDate !== value.sourceDate ||
      value.parserPreview.publishedDate !== value.publishedDate ||
      !digest(value.parserPreviewSha256) ||
      value.parserPreviewSha256 !== Authority.sha256(value.parserPreview) ||
      Authority.stable(value.parserAuthority) !==
        Authority.stable(Authority.PARSER_AUTHORITIES[value.role]) ||
      value.authorityKeyId !== authority.keyId || !digest(value.integritySha256) ||
      !digest(value.authoritySignature) || !Array.isArray(value.diagnostics) ||
      value.diagnostics.length !== 0) return false;
  const integrity = Authority.sha256(workbookMaterial(value));
  return value.integritySha256 === integrity &&
    value.rawResultId === `${WORKBOOK_RESULT_VERSION}|sha256:${integrity}` &&
    authority.verify("weekly_workbook_transport_result", integrity, value.authoritySignature);
}

function createWeeklyRawTransportShadow({ fetchImpl = globalThis.fetch, authority,
    now = () => new Date(), requestTimeoutMs = REQUEST_TIMEOUT_MS,
    bodyTimeoutMs = BODY_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function" || !authority || typeof authority.sign !== "function" ||
      typeof authority.verify !== "function" || typeof now !== "function" ||
      !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 ||
      requestTimeoutMs > REQUEST_TIMEOUT_MS || !Number.isInteger(bodyTimeoutMs) ||
      bodyTimeoutMs < 1 || bodyTimeoutMs > BODY_TIMEOUT_MS)
    throw new TypeError("weekly_transport_configuration_invalid");

  async function fetchRoute(route, type, role = null) {
    const listing = type === "listing";
    const routeValid = listing ? Authority.validateListingRoute(route) :
      Authority.validateWorkbookRoute(route);
    const routeFailure = listing ? "listing_route_rejected" :
      role === "weekly_futures_workbook" ? "futures_route_rejected" :
        "options_route_rejected";
    if (!routeValid) return failure(routeFailure, { stage: "route", role,
      sourceDate: route?.sourceDate, listingYear: route?.listingYear });
    const maximum = listing ? LISTING_MAX_BYTES : workbookMaximum(role);
    const acceptedMime = listing ? LISTING_MIME_TYPES : WORKBOOK_MIME_TYPES;
    const redirects = [];
    let currentUrl = route.canonicalUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (currentUrl !== route.canonicalUrl) return failure(listing
        ? "listing_redirect_rejected" : `${role === "weekly_futures_workbook"
          ? "futures" : "options"}_transport_failed`,
      { stage: "redirect", role, sourceDate: route.sourceDate, listingYear: route.listingYear,
        redirectCount: redirects.length, transportReason: "redirect_rejected" });
      const guard = requestTimeout(requestTimeoutMs);
      let response;
      try {
        response = await Promise.race([fetchImpl(currentUrl, { method: "GET", redirect: "manual",
          credentials: "omit", cache: "no-store", signal: guard.signal,
          headers: { accept: acceptedMime.join(", ") } }), guard.deadline]);
      } catch (error) {
        const timedOut = error?.code === "request_timeout" || error?.name === "AbortError";
        return failure(listing ? (timedOut ? "listing_timeout" : "discovery_failed") :
          `${role === "weekly_futures_workbook" ? "futures" : "options"}_transport_failed`,
        { stage: "request", role, sourceDate: route.sourceDate, listingYear: route.listingYear,
          redirectCount: redirects.length, transportReason: timedOut ? "timeout" : "network_failed" });
      } finally { guard.clear(); }
      if (!response || !Number.isInteger(response.status)) return failure(listing
        ? "discovery_failed" : `${role === "weekly_futures_workbook"
          ? "futures" : "options"}_transport_failed`, { stage: "request", role,
        sourceDate: route.sourceDate, listingYear: route.listingYear,
        redirectCount: redirects.length, transportReason: "response_invalid" });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.("location");
        let next;
        try { next = location ? new URL(location, currentUrl).href : null; }
        catch (_error) { next = null; }
        if (!next || hop === MAX_REDIRECTS || next !== route.canonicalUrl)
          return failure(listing ? "listing_redirect_rejected" :
            `${role === "weekly_futures_workbook" ? "futures" : "options"}_transport_failed`,
          { stage: "redirect", role, sourceDate: route.sourceDate,
            listingYear: route.listingYear, httpStatus: response.status,
            redirectCount: redirects.length, transportReason: "redirect_rejected" });
        redirects.push(freeze({ status: response.status, from: currentUrl, to: next }));
        currentUrl = next;
        continue;
      }
      if (response.status !== 200 || response.ok !== true) return failure(listing
        ? "listing_http_status" : `${role === "weekly_futures_workbook"
          ? "futures" : "options"}_transport_failed`, { stage: "status", role,
        sourceDate: route.sourceDate, listingYear: route.listingYear,
        httpStatus: response.status, redirectCount: redirects.length,
        transportReason: "http_status" });
      if (response.url && response.url !== currentUrl) return failure(listing
        ? "listing_redirect_rejected" : `${role === "weekly_futures_workbook"
          ? "futures" : "options"}_transport_failed`, { stage: "redirect", role,
        sourceDate: route.sourceDate, listingYear: route.listingYear,
        httpStatus: response.status, redirectCount: redirects.length,
        transportReason: "final_url_mismatch" });
      const mime = mimeOf(response.headers);
      if (!acceptedMime.includes(mime)) return failure(listing
        ? "listing_mime_mismatch" : "workbook_mime_mismatch", { stage: "mime", role,
        sourceDate: route.sourceDate, listingYear: route.listingYear,
        httpStatus: response.status, redirectCount: redirects.length });
      let bytes;
      try { bytes = await readExactBounded(response, maximum, bodyTimeoutMs); }
      catch (error) {
        const reason = bodyFailure(error);
        return failure(listing ? (reason === "oversize" ? "listing_oversize" :
          reason === "timeout" ? "listing_timeout" : "discovery_failed") :
          `${role === "weekly_futures_workbook" ? "futures" : "options"}_transport_failed`,
        { stage: "body", role, sourceDate: route.sourceDate, listingYear: route.listingYear,
          httpStatus: response.status, redirectCount: redirects.length, transportReason: reason });
      }
      return { success: true, route, finalUrl: currentUrl, redirects, status: response.status,
        mime, bytes, byteLength: bytes.byteLength, rawSha256: rawSha256(bytes),
        fetchedAt: now().toISOString() };
    }
    return failure(listing ? "listing_redirect_rejected" :
      `${role === "weekly_futures_workbook" ? "futures" : "options"}_transport_failed`,
    { stage: "redirect", role, sourceDate: route.sourceDate,
      listingYear: route.listingYear, redirectCount: redirects.length,
      transportReason: "redirect_rejected" });
  }

  function buildListingResult(fetched, manifest, discovery) {
    const result = { success: true, contractVersion: LISTING_RESULT_VERSION, rawResultId: "",
      manifestId: manifest.manifestId, runId: manifest.runId,
      discoveryId: discovery.discoveryIdentity, sourceType: "official_listing",
      year: discovery.listingYear, initialUrl: discovery.listingRoute.canonicalUrl,
      finalUrl: fetched.finalUrl, redirects: clone(fetched.redirects), status: fetched.status,
      mime: fetched.mime, encoding: "utf-8", byteLength: fetched.byteLength,
      rawSha256: fetched.rawSha256, fetchedAt: fetched.fetchedAt,
      authorityKeyId: authority.keyId, integritySha256: "", authoritySignature: "",
      bytes: new Uint8Array(fetched.bytes), diagnostics: [] };
    result.integritySha256 = Authority.sha256(listingMaterial(result));
    result.rawResultId = `${LISTING_RESULT_VERSION}|sha256:${result.integritySha256}`;
    result.authoritySignature = authority.sign("weekly_listing_transport_result",
      result.integritySha256);
    if (!validateListingTransportResult(result, manifest, discovery, authority))
      throw new TypeError("weekly_listing_transport_result_invalid");
    return freeze(result);
  }

  function buildWorkbookResult(fetched, manifest, acquisition, preview) {
    const result = { success: true, contractVersion: WORKBOOK_RESULT_VERSION, rawResultId: "",
      manifestId: manifest.manifestId, runId: manifest.runId,
      acquisitionId: acquisition.acquisitionId, sourceId: acquisition.sourceId,
      role: acquisition.role, sourceDate: acquisition.sourceDate,
      routeIdentity: acquisition.route.routeIdentity, initialUrl: acquisition.route.canonicalUrl,
      finalUrl: fetched.finalUrl, redirects: clone(fetched.redirects), status: fetched.status,
      mime: fetched.mime, encoding: null, byteLength: fetched.byteLength,
      rawSha256: fetched.rawSha256, fetchedAt: fetched.fetchedAt,
      publishedDate: preview.publishedDate, parserPreviewSha256: Authority.sha256(preview),
      parserAuthority: clone(Authority.PARSER_AUTHORITIES[acquisition.role]),
      authorityKeyId: authority.keyId, integritySha256: "", authoritySignature: "",
      bytes: new Uint8Array(fetched.bytes), parserPreview: clone(preview), diagnostics: [] };
    result.integritySha256 = Authority.sha256(workbookMaterial(result));
    result.rawResultId = `${WORKBOOK_RESULT_VERSION}|sha256:${result.integritySha256}`;
    result.authoritySignature = authority.sign("weekly_workbook_transport_result",
      result.integritySha256);
    if (!validateWorkbookTransportResult(result, manifest, authority))
      throw new TypeError("weekly_workbook_transport_result_invalid");
    return freeze(result);
  }

  async function acquireDomain(manifest, acquisition, listedUrl) {
    const rolePrefix = acquisition.role === "weekly_futures_workbook" ? "futures" : "options";
    if (!Authority.validateManifest(manifest, authority) ||
        !Authority.validateDomainAcquisition(acquisition, manifest.runId) ||
        listedUrl !== acquisition.route.canonicalUrl)
      return failure(`${rolePrefix}_route_rejected`, { stage: "route", role: acquisition.role,
        sourceDate: acquisition.sourceDate });
    const fetched = await fetchRoute(acquisition.route, "workbook", acquisition.role);
    if (!fetched.success) return fetched;
    if (!isXlsx(fetched.bytes)) return failure("workbook_signature_rejected",
      { stage: "signature", role: acquisition.role, sourceDate: acquisition.sourceDate,
        httpStatus: fetched.status, redirectCount: fetched.redirects.length });
    let preview;
    try { preview = parseWorkbookPreview(fetched.bytes, acquisition); }
    catch (_error) { return failure("workbook_parse_rejected", { stage: "parser",
      role: acquisition.role, sourceDate: acquisition.sourceDate,
      httpStatus: fetched.status, redirectCount: fetched.redirects.length }); }
    return buildWorkbookResult(fetched, manifest, acquisition, preview);
  }

  async function acquireIntent(input) {
    if (!exact(input, ["intent", "requestId"]) ||
        !Authority.validateAcquisitionIntent(input.intent))
      return freeze({ success: false, contractVersion: SHADOW_RESULT_VERSION,
        status: "failed", reason: "listing_route_rejected", runs: [], diagnostics: [] });
    const years = yearsForIntent(input.intent, now());
    const listingAcquisitions = [];
    for (const year of years) {
      let route;
      try { route = Authority.createListingRoute(year); }
      catch (_error) {
        return freeze({ success: false, contractVersion: SHADOW_RESULT_VERSION,
          status: "failed", reason: "listing_route_rejected", runs: [], diagnostics: [] });
      }
      const fetched = await fetchRoute(route, "listing");
      if (!fetched.success) return freeze({ success: false,
        contractVersion: SHADOW_RESULT_VERSION, status: "failed", reason: fetched.reason,
        runs: [], diagnostics: fetched.diagnostics });
      let parsed;
      try { parsed = parseListingBytes(fetched.bytes, year); }
      catch (_error) { return freeze({ success: false,
        contractVersion: SHADOW_RESULT_VERSION, status: "failed",
        reason: "listing_parse_rejected", runs: [], diagnostics: [{ stage: "parser",
          role: null, sourceDate: null, listingYear: year, httpStatus: fetched.status,
          redirectCount: fetched.redirects.length, transportReason: null }] }); }
      listingAcquisitions.push({ fetched, parsed });
    }
    const selectedDates = selectTradeDates(input.intent,
      listingAcquisitions.map(value => value.parsed));
    if (selectedDates.length === 0) return freeze({ success: false,
      contractVersion: SHADOW_RESULT_VERSION, status: "failed",
      reason: "source_date_unavailable", runs: [], diagnostics: [] });
    const runs = [];
    for (const selectedDate of selectedDates) {
      const source = listingAcquisitions.find(value =>
        value.parsed.listingResult.tradeDates.includes(selectedDate));
      const entry = source.parsed.entries.find(value => value.sourceDate === selectedDate);
      let discovery, manifest;
      try {
        discovery = Authority.createDiscovery({ intent: input.intent,
          listingResult: source.parsed.listingResult, selectedTradeDate: selectedDate });
        manifest = Authority.createManifest({ intent: input.intent, discovery,
          requestId: selectedDates.length === 1 ? input.requestId :
            `${input.requestId}-${selectedDate.replaceAll("-", "")}` }, authority);
      } catch (_error) {
        return freeze({ success: false, contractVersion: SHADOW_RESULT_VERSION,
          status: "failed", reason: "manifest_invalid", runs: [], diagnostics: [] });
      }
      const listingResult = buildListingResult(source.fetched, manifest, discovery);
      const [futures, options] = await Promise.all([
        acquireDomain(manifest, manifest.futuresDescriptor, entry.futuresUrl),
        acquireDomain(manifest, manifest.optionsDescriptor, entry.optionsUrl)
      ]);
      runs.push(freeze({ sourceDate: selectedDate, discovery, manifest, listing: listingResult,
        futures, options, status: futures.success && options.success ? "complete" :
          futures.success || options.success ? "partial" : "failed" }));
    }
    const complete = runs.every(run => run.status === "complete");
    const partial = runs.some(run => run.status === "partial");
    return freeze({ success: complete, contractVersion: SHADOW_RESULT_VERSION,
      status: complete ? "complete" : partial ? "partial" : "failed",
      reason: complete ? null : partial ? "domain_transport_partial" : "domain_transport_failed",
      runs, diagnostics: [] });
  }

  return freeze({ acquireIntent });
}

module.exports = freeze({
  LISTING_RESULT_VERSION, WORKBOOK_RESULT_VERSION, SHADOW_RESULT_VERSION, MAX_REDIRECTS,
  REQUEST_TIMEOUT_MS, BODY_TIMEOUT_MS, LISTING_MAX_BYTES, FUTURES_MAX_BYTES,
  OPTIONS_MAX_BYTES, OBSERVED_JPX_MIME, LISTING_MIME_TYPES, WORKBOOK_MIME_TYPES,
  REQUEST_POLICY, rawSha256, parseListingBytes, selectTradeDates,
  productionEquivalentLatestTradeDate, parseWorkbookPreview,
  validateListingTransportResult, validateWorkbookTransportResult,
  createWeeklyRawTransportShadow
});
