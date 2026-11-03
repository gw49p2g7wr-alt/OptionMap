"use strict";

const crypto = require("node:crypto");
const { readBounded } = require("../marketCalendarRuntime/calendarAcquisitionService.js");
const Canonical = require("./economicValueCanonical.js");

const SOURCE_ID = "us-bea-pce-values";
const HOST = "www.bea.gov";
const MAX_REDIRECTS = 3;
const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 15_000;
const ALLOWED_MIME = new Set(["text/html", "application/xhtml+xml"]);
const MONTHS = Object.freeze(["january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"]);

function pathFor(referencePeriod, releaseDate) {
  if (!Canonical.month(referencePeriod) || !Canonical.date(releaseDate))
    throw new Error("bea_pce_route_identity_invalid");
  const [referenceYear, referenceMonth] = referencePeriod.split("-"), releaseYear = releaseDate.slice(0, 4);
  return `/news/${releaseYear}/personal-income-and-outlays-${MONTHS[Number(referenceMonth) - 1]}-${referenceYear}`;
}
const urlFor = (referencePeriod, releaseDate) => `https://${HOST}${pathFor(referencePeriod, releaseDate)}`;
function validateUrl(value, referencePeriod, releaseDate) {
  let url;
  try { url = new URL(value); } catch (_error) { return null; }
  if (url.protocol !== "https:" || url.hostname !== HOST || url.port || url.username || url.password ||
      url.pathname !== pathFor(referencePeriod, releaseDate) || url.search || url.hash) return null;
  return url.href;
}
function signal(milliseconds) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), milliseconds);
  return { value: controller.signal, clear: () => clearTimeout(timer) };
}
function failure(reason, details = {}) {
  return Canonical.freeze({ success: false, sourceId: SOURCE_ID, reason, retryable: false, ...details });
}
function createBeaPceAcquisition({ fetchImpl = globalThis.fetch, now = () => new Date(),
    requestTimeoutMs = TIMEOUT_MS, bodyTimeoutMs = TIMEOUT_MS } = {}) {
  async function acquire({ referencePeriod, releaseDate } = {}) {
    let sourceUrl;
    try { sourceUrl = urlFor(referencePeriod, releaseDate); }
    catch (_error) { return failure("route_identity_invalid"); }
    if (typeof fetchImpl !== "function") return failure("network_unavailable");
    const redirects = []; let currentUrl = sourceUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!validateUrl(currentUrl, referencePeriod, releaseDate)) return failure("route_security_rejected");
      const guard = signal(requestTimeoutMs); let response;
      try {
        response = await fetchImpl(currentUrl, { method: "GET", redirect: "manual", signal: guard.value,
          credentials: "omit", cache: "no-store", headers: { accept: "text/html,application/xhtml+xml" } });
      } catch (error) {
        return failure(error?.name === "AbortError" ? "request_timeout" : "network_failed");
      } finally { guard.clear(); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.("location");
        if (!location || hop === MAX_REDIRECTS) return failure(location ?
          "redirect_hop_exceeded" : "redirect_location_missing");
        let next;
        try { next = new URL(location, currentUrl).href; }
        catch (_error) { return failure("redirect_url_invalid"); }
        const accepted = validateUrl(next, referencePeriod, releaseDate);
        redirects.push({ status: response.status, from: currentUrl, to: accepted });
        if (!accepted) return failure("redirect_route_security_rejected");
        currentUrl = accepted; continue;
      }
      if (!response.ok) return failure("http_status_rejected", { httpStatus: response.status });
      const contentType = String(response.headers?.get?.("content-type") || ""),
        mime = contentType.split(";", 1)[0].trim().toLowerCase();
      if (!ALLOWED_MIME.has(mime)) return failure("mime_rejected", { httpStatus: response.status });
      let bytes;
      try { bytes = await readBounded(response, MAX_BYTES, bodyTimeoutMs); }
      catch (error) { return failure(error?.code || "body_read_failed", { httpStatus: response.status }); }
      try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch (_error) { return failure("encoding_rejected", { httpStatus: response.status }); }
      const fetchedAt = now().toISOString(), rawContentHash = crypto.createHash("sha256").update(bytes).digest("hex");
      return Canonical.freeze({ success: true, sourceId: SOURCE_ID, referencePeriod, releaseDate, fetchedAt,
        document: { role: "official_release", sourceUrl, finalUrl: currentUrl, mime,
          byteCount: bytes.byteLength, rawContentHash, parserInput: bytes,
          httpMetadata: { httpStatus: response.status, mimeType: mime, encoding: "utf-8",
            redirectCount: redirects.length, contentLength: bytes.byteLength,
            routeRole: "bea_release_specific_pio_html", releasePath: pathFor(referencePeriod, releaseDate) } } });
    }
    return failure("redirect_hop_exceeded");
  }
  return Canonical.freeze({ acquire });
}

module.exports = Canonical.freeze({ SOURCE_ID, HOST, MAX_REDIRECTS, MAX_BYTES, TIMEOUT_MS,
  pathFor, urlFor, validateUrl, createBeaPceAcquisition });
