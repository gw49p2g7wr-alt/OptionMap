"use strict";

const crypto = require("node:crypto");
const { readBounded } = require("../marketCalendarRuntime/calendarAcquisitionService.js");
const Canonical = require("./economicValueCanonical.js");
const Cpi = require("./blsCpiFormal.js");

const HOST = "www.bls.gov";
const MAX_REDIRECTS = 3;
const MAX_BYTES = 3_000_000;
const TIMEOUT_MS = 15_000;
const ALLOWED_MIME = new Set(["text/html", "application/xhtml+xml"]);
const archivePath = releaseDate => {
  if (!Canonical.date(releaseDate)) throw new Error("release_date_invalid");
  const [year, month, day] = releaseDate.split("-");
  return `/news.release/archives/cpi_${month}${day}${year}.htm`;
};
const urlFor = releaseDate => `https://${HOST}${archivePath(releaseDate)}`;
function validateUrl(value, releaseDate) {
  let url;
  try { url = new URL(value); } catch (_error) { return null; }
  if (url.protocol !== "https:" || url.hostname !== HOST || url.port || url.username || url.password ||
      url.search || url.hash || url.pathname !== archivePath(releaseDate)) return null;
  return url.href;
}
function signal(milliseconds) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), milliseconds);
  return { value: controller.signal, clear: () => clearTimeout(timer) };
}
function failure(reason, details = {}) {
  return Canonical.freeze({ success: false, sourceId: Cpi.SOURCE_ID, reason, retryable: false, ...details });
}
function createBlsCpiAcquisition({ fetchImpl = globalThis.fetch, now = () => new Date(),
    requestTimeoutMs = TIMEOUT_MS, bodyTimeoutMs = TIMEOUT_MS } = {}) {
  async function acquire({ releaseDate } = {}) {
    if (!Canonical.date(releaseDate)) return failure("release_date_invalid");
    if (typeof fetchImpl !== "function") return failure("network_unavailable");
    const requestedUrl = urlFor(releaseDate), redirects = []; let currentUrl = requestedUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!validateUrl(currentUrl, releaseDate)) return failure("route_security_rejected");
      const guard = signal(requestTimeoutMs); let response;
      try {
        response = await fetchImpl(currentUrl, { method: "GET", redirect: "manual", signal: guard.value,
          credentials: "omit", cache: "no-store", headers: { accept: "text/html,application/xhtml+xml" } });
      } catch (error) {
        return failure(error?.name === "AbortError" ? "request_timeout" : "network_failed");
      } finally { guard.clear(); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.("location");
        if (!location || hop === MAX_REDIRECTS) return failure(location ? "redirect_hop_exceeded" :
          "redirect_location_missing");
        let next;
        try { next = new URL(location, currentUrl).href; } catch (_error) { return failure("redirect_url_invalid"); }
        const accepted = validateUrl(next, releaseDate);
        redirects.push({ status: response.status, from: currentUrl, to: accepted });
        if (!accepted) return failure("redirect_route_security_rejected");
        currentUrl = accepted;
        continue;
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
      return Canonical.freeze({ success: true, sourceId: Cpi.SOURCE_ID, releaseDate, fetchedAt,
        document: { role: "official_release", sourceUrl: requestedUrl, finalUrl: currentUrl,
          mime, byteCount: bytes.byteLength, rawContentHash, parserInput: bytes,
          httpMetadata: { httpStatus: response.status, mimeType: mime,
            redirectCount: redirects.length, contentLength: bytes.byteLength } } });
    }
    return failure("redirect_hop_exceeded");
  }
  return Canonical.freeze({ acquire });
}

module.exports = Canonical.freeze({ HOST, MAX_REDIRECTS, MAX_BYTES, TIMEOUT_MS, archivePath,
  urlFor, validateUrl, createBlsCpiAcquisition });
