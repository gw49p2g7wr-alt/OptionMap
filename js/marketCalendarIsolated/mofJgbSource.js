"use strict";

// G1 isolated authority. Not registered, not callable from IPC, no ambient fetch.
const { createHash } = require("node:crypto");
const { readBounded } = require("../marketCalendarRuntime/calendarAcquisitionService.js");
const Encoding = require("../marketCalendarShadow/htmlEncoding.js");
const SOURCE_ID = "jp-mof-jgb-auction-calendar";
const EVENT_TYPE = "JP_JGB_AUCTION";
const INDEX_URL = "https://www.mof.go.jp/jgbs/auction/calendar/index.htm";
const PREFIX = "https://www.mof.go.jp/jgbs/auction/calendar/";
const MAX_BYTES = 2_000_000, MAX_REDIRECTS = 3, TIMEOUT_MS = 15_000;
const SOURCE = Object.freeze({ sourceId: SOURCE_ID, authority: "MOF", jurisdiction: "JP",
  sourceOwner: "財務省理財局国債業務課", sourceTimeZone: "Asia/Tokyo",
  eventType: EVENT_TYPE, instrumentClass: "normal_fixed_rate_jgb",
  absenceAuthority: "none", productionActive: false, writeAllowed: false });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function validDate(value) {
  if (typeof value !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
function validateUrl(value) {
  if (typeof value !== "string" || !/^https:\/\/www\.mof\.go\.jp\/jgbs\/auction\/calendar\/(?:index|\d{2}(?:0[1-9]|1[0-2]))\.htm$/.test(value))
    return { valid: false, reason: "url_not_allowed" };
  const url = new URL(value);
  return { valid: url.href === value, reason: url.href === value ? null : "url_not_allowed", url: value };
}
function pageMonth(value) {
  if (!validateUrl(value).valid || value === INDEX_URL) return null;
  const code = value.slice(PREFIX.length, -4);
  return `20${code.slice(0, 2)}-${code.slice(2)}`;
}
function text(value) {
  return value.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&")
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, dec) => {
      const n = parseInt(hex || dec, hex ? 16 : 10);
      return n <= 0x10ffff ? String.fromCodePoint(n) : "�";
    }).replace(/\s+/g, " ").trim();
}
function discoverMonths(html, assessmentDateJst) {
  const failed = reason => ({ ok: false, reason, months: [], duplicateCount: 0 });
  if (!validDate(assessmentDateJst) || typeof html !== "string" ||
      !/<h1\b[^>]*>\s*入札カレンダー\s*<\/h1>/i.test(html)) return failed("index_structure_invalid");
  const found = new Map(); let duplicateCount = 0;
  // Only exact month-link candidates; navigation/result/notice links are never fetched.
  const clean = html.replace(/<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi, "");
  for (const a of clean.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = text(a[2]);
    if (!/^\d{1,2}月$/.test(label)) continue;
    if (/[\\%?#]|(?:^|\/)\.{1,2}(?:\/|$)/.test(a[1])) return failed("index_month_link_invalid");
    let url; try { url = new URL(a[1], INDEX_URL).href; } catch (_) { return failed("index_month_link_invalid"); }
    const month = pageMonth(url);
    if (!month || Number(month.slice(5)) !== Number(label.slice(0, -1))) return failed("index_month_link_invalid");
    if (month < assessmentDateJst.slice(0, 7)) continue;
    if (found.has(month)) duplicateCount++; else found.set(month, { month, url });
  }
  if (found.size > 36) return failed("index_month_limit_exceeded");
  return { ok: true, reason: null, months: [...found.values()].sort((a, b) => a.month.localeCompare(b.month)), duplicateCount };
}
function decode(bytes, contentType) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_BYTES ||
      !/^text\/html(?:\s*;|\s*$)/i.test(contentType || "")) return { ok: false, reason: "content_contract_invalid" };
  const result = Encoding.decodeHtml(bytes, contentType), e = result.evidence || {};
  if (!result.ok || result.encoding !== "utf-8" ||
      [e.httpCharset, e.bom, e.html5MetaCharset, e.legacyMetaCharset].filter(Boolean)
        .some(value => !/^utf-?8$/i.test(value))) return { ok: false, reason: "strict_utf8_required" };
  return result;
}
const SAFE = new Set(["request_timeout", "body_timeout", "content_length_invalid", "content_length_exceeded",
  "body_size_exceeded", "truncated_response", "response_stream_unavailable"]);
function createAcquirer({ fetchImpl, requestTimeoutMs = TIMEOUT_MS, bodyTimeoutMs = TIMEOUT_MS,
  rejectDuplicateDiscovery = false } = {}) {
  if (typeof fetchImpl !== "function" || ![requestTimeoutMs, bodyTimeoutMs].every(n => Number.isInteger(n) && n > 0 && n <= TIMEOUT_MS))
    throw TypeError("isolated_transport_required");
  const resources = { activeTasks: 0, activeTimers: 0, requests: 0 };
  async function document(requestedUrl, allowedUrls) {
    const base = { requestedUrl, httpStatus: null, redirects: [], byteCount: 0, outcome: "failed" };
    if (!validateUrl(requestedUrl).valid || !allowedUrls.includes(requestedUrl)) return { ...base, reason: "url_not_discovered" };
    resources.activeTasks++;
    let timer, response, controller;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; resources.activeTimers--; } };
    const deadline = (ms, reason) => new Promise((_, reject) => {
      resources.activeTimers++;
      timer = setTimeout(() => { reject(Object.assign(Error(), { code: reason })); controller.abort(); }, ms);
    });
    try {
      let url = requestedUrl;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        controller = new AbortController(); resources.requests++;
        response = await Promise.race([fetchImpl(url, { method: "GET", redirect: "manual", credentials: "omit",
          cache: "no-store", signal: controller.signal, headers: { accept: "text/html" } }), deadline(requestTimeoutMs, "request_timeout")]);
        clear(); base.httpStatus = response.status;
        if (response.redirected || response.url && response.url !== url) return { ...base, reason: "implicit_redirect_rejected" };
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location || hop === MAX_REDIRECTS) return { ...base, reason: "redirect_limit_or_location_invalid" };
          // Reject path normalization tricks before URL resolution, then validate every hop.
          if (/[\\%?#]|(?:^|\/)\.{1,2}(?:\/|$)/.test(location)) return { ...base, reason: "redirect_not_allowed" };
          let next; try { next = new URL(location, url).href; } catch (_) { return { ...base, reason: "redirect_not_allowed" }; }
          const allowed = validateUrl(next).valid && allowedUrls.includes(next) && pageMonth(next) === pageMonth(requestedUrl);
          base.redirects.push({ status: response.status, accepted: allowed });
          if (!allowed) return { ...base, reason: "redirect_not_allowed" };
          await response.body?.cancel().catch(() => undefined); controller.abort(); url = next; continue;
        }
        // Non-200 bodies never enter the reader/parser.
        if (response.status !== 200) return { ...base, reason: "http_status_rejected" };
        const contentType = response.headers.get("content-type");
        if (!/^text\/html(?:\s*;|\s*$)/i.test(contentType || "")) return { ...base, reason: "mime_invalid" };
        // Own deadline is armed first: shared reader cancellation can resolve EOF
        // before its timeout rejection. Preserve timeout classification and await
        // reader cleanup rather than interpreting cancelled EOF as empty HTML.
        const timedOut = deadline(bodyTimeoutMs, "body_timeout"), reading = readBounded(response, MAX_BYTES, bodyTimeoutMs);
        let bytes;
        try { bytes = await Promise.race([reading, timedOut]); }
        catch (e) { controller.abort(); await reading.catch(() => undefined); throw e; }
        clear(); const decoded = decode(bytes, contentType);
        if (!decoded.ok) return { ...base, byteCount: bytes.length, reason: decoded.reason };
        return { ...base, outcome: "complete", reason: null, finalUrl: url, contentType, mime: "text/html",
          byteCount: bytes.length, encoding: decoded.encoding, encodingEvidence: decoded.evidence,
          rawContentHash: hash(bytes), html: decoded.text };
      }
      return { ...base, reason: "redirect_limit_or_location_invalid" };
    } catch (e) { return { ...base, reason: SAFE.has(e?.code) ? e.code : "network_failed" }; }
    finally { clear(); controller?.abort(); if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined); resources.activeTasks--; }
  }
  async function acquire(request) {
    if (!request || Object.keys(request).sort().join("|") !== "assessmentDateJst|sourceId" ||
        request.sourceId !== SOURCE_ID || !validDate(request.assessmentDateJst))
      return { outcome: "failed", reason: "request_shape_invalid", documents: [], discovery: null };
    const index = await document(INDEX_URL, [INDEX_URL]), documents = [index];
    if (index.outcome !== "complete") return { outcome: "failed", reason: index.reason, documents, discovery: null };
    const discovery = discoverMonths(index.html, request.assessmentDateJst);
    if (!discovery.ok) return { outcome: "failed", reason: discovery.reason, documents, discovery };
    if (rejectDuplicateDiscovery && discovery.duplicateCount)
      return { outcome: "failed", reason: "duplicate_month_document", documents, discovery };
    const urls = discovery.months.map(m => m.url);
    for (const item of discovery.months) {
      const d = await document(item.url, urls); documents.push(d);
      if (d.outcome !== "complete") return { outcome: "failed", reason: d.reason, documents, discovery };
    }
    return { sourceId: SOURCE_ID, outcome: "complete", reason: null, assessmentDateJst: request.assessmentDateJst,
      fetchedAt: new Date().toISOString(), absenceAuthority: "none", coverage: "published_months_only", documents, discovery };
  }
  return Object.freeze({ acquire, diagnostics: () => ({ ...resources }) });
}
module.exports = Object.freeze({ SOURCE_ID, EVENT_TYPE, SOURCE, INDEX_URL, MAX_BYTES, MAX_REDIRECTS,
  validDate, validateUrl, pageMonth, text, hash, discoverMonths, decode, createAcquirer });
