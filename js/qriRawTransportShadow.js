"use strict";

const crypto = require("node:crypto");
const QriAuthority = require("./qriAcquisitionAuthorityContract.js");

const SHADOW_VERSION = "qri-raw-transport-shadow-v1";
const SESSION_PARTITION = "persist:qri-option-session";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const JPX_HOME_URL = "https://www.jpx.co.jp/";
const JPX_QUOTES_URL = "https://www.jpx.co.jp/markets/derivatives/quotes/index.html";
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const BODY_TIMEOUT_MS = 20_000;
const ACCEPTED_MEDIA_TYPE = "text/html";
const BLOCK_SIGNATURES = Object.freeze([
  "403 error", "request blocked", "the request could not be satisfied", "access denied"
]);
const WARMUP_PLAN = Object.freeze([
  Object.freeze({ url: JPX_HOME_URL, referer: null }),
  Object.freeze({ url: JPX_QUOTES_URL, referer: JPX_HOME_URL })
]);

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
  fields.every(field => Object.hasOwn(value, field));
const digest = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function parserInputSha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeHeaders(headers) {
  const result = Object.create(null);
  if (!headers || typeof headers !== "object") return result;
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = String(name).toLowerCase();
    if (!normalizedName || Object.hasOwn(result, normalizedName)) continue;
    result[normalizedName] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return result;
}

function parseContentType(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return null;
  const parts = value.split(";").map(part => part.trim());
  const mediaType = parts.shift()?.toLowerCase();
  if (!mediaType || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) return null;
  let charset = null;
  for (const part of parts) {
    const match = part.match(/^charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))$/i);
    if (!match) continue;
    if (charset !== null) return null;
    charset = (match[1] || match[2] || match[3]).trim().toLowerCase();
  }
  return { declaredContentType: value, mediaType, charset };
}

function canonicalEncoding(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (["utf-8", "utf8"].includes(normalized)) return "utf-8";
  if (["shift-jis", "shiftjis", "sjis", "windows-31j", "cp932", "ms-kanji"]
    .includes(normalized)) return "shift_jis";
  return null;
}

function contentDeclaredEncoding(bytes) {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  const prefix = bytes.subarray(0, Math.min(bytes.byteLength, 4096)).toString("latin1");
  const direct = prefix.match(/<meta\b[^>]*\bcharset\s*=\s*["']?([^\s"'/>;]+)/i)?.[1];
  if (direct) return canonicalEncoding(direct) || "unsupported";
  const httpEquiv = prefix.match(/<meta\b[^>]*\bcontent\s*=\s*["'][^"']*charset\s*=\s*([^\s"';>]+)[^"']*["'][^>]*>/i)?.[1];
  return httpEquiv ? canonicalEncoding(httpEquiv) || "unsupported" : null;
}

function resolveEncoding(bytes, httpCharset) {
  const fromHttp = httpCharset == null ? null : canonicalEncoding(httpCharset);
  if (httpCharset != null && !fromHttp) return { accepted: false, reason: "charset_unsupported" };
  const fromContent = contentDeclaredEncoding(bytes);
  if (fromContent === "unsupported") return { accepted: false, reason: "charset_unsupported" };
  if (fromHttp && fromContent && fromHttp !== fromContent) {
    return { accepted: false, reason: "charset_conflict" };
  }
  const encoding = fromHttp || fromContent;
  return encoding ? { accepted: true, reason: null, encoding } :
    { accepted: false, reason: "charset_unverifiable" };
}

function decode(bytes, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch (_error) {
    return null;
  }
}

function canonicalRouteUrl(rawUrl, route) {
  return QriAuthority.canonicalQriUrl(rawUrl, { active: route.requestKind === "active" });
}

function routeHopAccepted(rawUrl, route) {
  return canonicalRouteUrl(rawUrl, route) === route.canonicalUrl;
}

function frozenResult(value) {
  if (value.receipt) Object.freeze(value.receipt);
  if (value.rawFacts) Object.freeze(value.rawFacts);
  if (value.diagnostics) Object.freeze(value.diagnostics);
  return Object.freeze(value);
}

function failure(reason, diagnostics = {}, rawFacts = null) {
  return frozenResult({ contractVersion: SHADOW_VERSION, status: "unavailable", reason,
    receipt: null, rawFacts, parserInput: null, diagnostics });
}

function withTimeout(promise, timeoutMs, controller, reason) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(Object.assign(new Error(reason), { code: reason }));
      }, timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

async function bodyBytes(body, maximum) {
  const resolved = await body;
  if (Buffer.isBuffer(resolved)) {
    if (resolved.byteLength > maximum) throw Object.assign(new Error("byte_ceiling_exceeded"),
      { code: "byte_ceiling_exceeded" });
    return Buffer.from(resolved);
  }
  if (resolved instanceof Uint8Array) return bodyBytes(Buffer.from(resolved), maximum);
  if (!resolved || typeof resolved[Symbol.asyncIterator] !== "function") {
    throw Object.assign(new Error("body_stream_invalid"), { code: "body_stream_invalid" });
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of resolved) {
    const bytes = Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > maximum) throw Object.assign(new Error("byte_ceiling_exceeded"),
      { code: "byte_ceiling_exceeded" });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

function fixedRequestHeaders() {
  return Object.freeze({
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8",
    "Accept-Encoding": "identity",
    Referer: JPX_QUOTES_URL
  });
}

function createQriRawTransportShadow(options) {
  if (!exact(options, ["authority", "requestClient", "warmupSession", "now",
    "requestTimeoutMs", "bodyTimeoutMs", "maxResponseBytes"]) ||
      typeof options.requestClient?.requestOnce !== "function" ||
      typeof options.warmupSession !== "function" || typeof options.now !== "function" ||
      !Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0 ||
      !Number.isInteger(options.bodyTimeoutMs) || options.bodyTimeoutMs <= 0 ||
      !Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0) {
    throw new TypeError("qri_raw_shadow_options_invalid");
  }

  async function acquire(input) {
    if (!exact(input, ["intent", "authorityContext", "runId", "requestId"])) {
      return failure("request_envelope_invalid", { rendererUrlAccepted: false });
    }
    const activeContext = input.intent?.requestKind === "active" &&
      exact(input.authorityContext, ["activeContractIdentity"]);
    const listedContext = input.intent?.requestKind === "listed_reference" &&
      exact(input.authorityContext, ["parentManifest", "parentReceipt", "authority"]);
    if (!activeContext && !listedContext) {
      return failure("authority_context_invalid", { rendererUrlAccepted: false });
    }
    const resolution = QriAuthority.resolveQriIntent(input.intent, input.authorityContext);
    if (!resolution.accepted) return failure(resolution.reason, { rendererUrlAccepted: false });
    const route = resolution.route;
    let acquisition;
    try {
      acquisition = QriAuthority.createMainAcquisitionIdentity({ intent: input.intent, route,
        runId: input.runId, requestId: input.requestId }, options.authority);
    } catch (_error) {
      return failure("acquisition_identity_invalid", { routeIdentity: route.routeIdentity });
    }

    try {
      const warmupController = new AbortController();
      const warmup = await withTimeout(options.warmupSession({ plan: WARMUP_PLAN,
        sessionPartition: SESSION_PARTITION, userAgent: USER_AGENT,
        signal: warmupController.signal }),
      options.requestTimeoutMs, warmupController, "warmup_timeout");
      if (!warmup || warmup.accepted !== true) {
        return failure("warmup_failed", { routeIdentity: route.routeIdentity,
          warmupReason: "rejected" });
      }
    } catch (error) {
      return failure(error?.code === "warmup_timeout" ? "warmup_timeout" : "warmup_failed",
        { routeIdentity: route.routeIdentity });
    }

    const redirectHops = [];
    const visited = new Set();
    let requestUrl = route.canonicalUrl;
    let response;
    while (true) {
      if (visited.has(requestUrl)) return failure("redirect_loop", { routeIdentity: route.routeIdentity,
        redirectCount: redirectHops.length });
      visited.add(requestUrl);
      const controller = new AbortController();
      try {
        response = await withTimeout(options.requestClient.requestOnce({ url: requestUrl,
          method: "GET", headers: fixedRequestHeaders(), useSessionCookies: true,
          sessionPartition: SESSION_PARTITION, redirect: "manual", cache: "no-store",
          maxBytes: options.maxResponseBytes, signal: controller.signal }),
        options.requestTimeoutMs, controller, "request_timeout");
      } catch (error) {
        const reason = ["request_timeout", "byte_ceiling_exceeded"].includes(error?.code)
          ? error.code : "request_failed";
        return failure(reason, { routeIdentity: route.routeIdentity,
          redirectCount: redirectHops.length });
      }
      if (response?.kind !== "redirect") break;
      if (!Number.isInteger(response.statusCode) || response.statusCode < 300 ||
          response.statusCode > 399 || typeof response.redirectUrl !== "string") {
        return failure("redirect_invalid", { routeIdentity: route.routeIdentity });
      }
      if (redirectHops.length >= MAX_REDIRECTS) {
        return failure("redirect_limit_exceeded", { routeIdentity: route.routeIdentity,
          redirectCount: redirectHops.length + 1 });
      }
      let nextUrl;
      try { nextUrl = new URL(response.redirectUrl, requestUrl).href; }
      catch (_error) { return failure("redirect_invalid", { routeIdentity: route.routeIdentity }); }
      if (!routeHopAccepted(requestUrl, route) || !routeHopAccepted(nextUrl, route)) {
        return failure("redirect_outside_route", { routeIdentity: route.routeIdentity });
      }
      redirectHops.push(Object.freeze({ status: response.statusCode, fromUrl: requestUrl,
        toUrl: nextUrl }));
      requestUrl = nextUrl;
    }

    if (!response || response.kind !== "response" || !routeHopAccepted(requestUrl, route)) {
      return failure("response_invalid", { routeIdentity: route.routeIdentity });
    }
    const headers = normalizeHeaders(response.headers);
    const rawLength = headers["content-length"];
    if (rawLength != null && (!/^\d+$/.test(rawLength) || Number(rawLength) > options.maxResponseBytes)) {
      return failure("byte_ceiling_exceeded", { routeIdentity: route.routeIdentity });
    }
    if (response.statusCode !== 200) {
      return failure("http_status_rejected", { routeIdentity: route.routeIdentity,
        httpStatus: response.statusCode });
    }
    if (headers["content-encoding"] && headers["content-encoding"].toLowerCase() !== "identity") {
      return failure("content_encoding_rejected", { routeIdentity: route.routeIdentity });
    }
    const contentType = parseContentType(headers["content-type"]);
    if (!contentType || contentType.mediaType !== ACCEPTED_MEDIA_TYPE) {
      return failure("mime_rejected", { routeIdentity: route.routeIdentity,
        declaredContentType: headers["content-type"] || null });
    }

    const bodyController = new AbortController();
    bodyController.signal.addEventListener("abort", () => response.abort?.(), { once: true });
    let rawBytes;
    try {
      rawBytes = await withTimeout(bodyBytes(response.body, options.maxResponseBytes),
        options.bodyTimeoutMs, bodyController, "body_timeout");
    } catch (error) {
      const reason = ["body_timeout", "byte_ceiling_exceeded"].includes(error?.code)
        ? error.code : "body_receive_failed";
      return failure(reason, { routeIdentity: route.routeIdentity });
    }
    if (rawLength != null && Number(rawLength) !== rawBytes.byteLength) {
      return failure("content_length_mismatch", { routeIdentity: route.routeIdentity,
        declaredByteLength: Number(rawLength), receivedByteLength: rawBytes.byteLength });
    }
    const contentSha256 = sha256Bytes(rawBytes);
    const encodingResult = resolveEncoding(rawBytes, contentType.charset);
    if (!encodingResult.accepted) return failure(encodingResult.reason,
      { routeIdentity: route.routeIdentity, contentSha256, byteLength: rawBytes.byteLength });
    const parserInput = decode(rawBytes, encodingResult.encoding);
    if (parserInput === null) return failure("decode_failed", { routeIdentity: route.routeIdentity,
      contentSha256, byteLength: rawBytes.byteLength });
    const normalizedText = parserInput.toLowerCase();
    if (BLOCK_SIGNATURES.some(signature => normalizedText.includes(signature))) {
      return failure("block_page_detected", { routeIdentity: route.routeIdentity,
        contentSha256, byteLength: rawBytes.byteLength });
    }

    const transportIdentity = QriAuthority.createTransportIdentity({ httpStatus: response.statusCode,
      declaredContentType: contentType.declaredContentType, mediaType: contentType.mediaType,
      encoding: encodingResult.encoding, byteLength: rawBytes.byteLength, contentSha256,
      redirectHops });
    const parserInputIdentity = QriAuthority.createParserInputIdentity({ state: "bound",
      sha256: parserInputSha256(parserInput), encoding: encodingResult.encoding,
      rawContentSha256: contentSha256 });
    let receipt;
    try {
      receipt = QriAuthority.createAcquisitionReceiptV2({ acquisition, intent: input.intent,
        route, acceptedInitialUrl: route.canonicalUrl, acceptedFinalUrl: route.canonicalUrl,
        fetchedAt: options.now(), transportIdentity, parserInputIdentity }, options.authority);
    } catch (_error) {
      return failure("receipt_invalid", { routeIdentity: route.routeIdentity });
    }
    const rawFacts = { httpStatus: response.statusCode,
      declaredContentType: contentType.declaredContentType, mediaType: contentType.mediaType,
      encoding: encodingResult.encoding, byteLength: rawBytes.byteLength, contentSha256,
      redirectHops: Object.freeze([...redirectHops]),
      responseHeaders: Object.freeze({ contentType: headers["content-type"],
        contentLength: headers["content-length"] || null }) };
    const diagnostics = { routeIdentity: route.routeIdentity, warmup: "completed",
      redirectCount: redirectHops.length, sessionPartition: SESSION_PARTITION,
      sessionCookies: "main_owned_not_exposed", retryCount: 0,
      parserCompatibility: "raw_html_parser_compatible",
      domMutationDependency: "none_observed_in_fixture" };
    return frozenResult({ contractVersion: SHADOW_VERSION, status: "available", reason: null,
      receipt, rawFacts, parserInput, diagnostics,
      copyRawBytesForMainShadow: () => Buffer.from(rawBytes),
      copyRawBytesForMainTest: () => Buffer.from(rawBytes) });
  }

  return Object.freeze({ acquire });
}

function createElectronNetClient({ net, session }) {
  if (typeof net?.request !== "function" || !session) {
    throw new TypeError("qri_electron_net_client_invalid");
  }
  return Object.freeze({
    requestOnce(options) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const request = net.request({ url: options.url, method: options.method,
          session, useSessionCookies: options.useSessionCookies, credentials: "include",
          redirect: options.redirect, cache: options.cache, headers: options.headers });
        const finish = value => { if (!settled) { settled = true; resolve(value); } };
        const fail = error => { if (!settled) { settled = true; reject(error); } };
        const abort = () => request.abort();
        options.signal?.addEventListener("abort", abort, { once: true });
        request.on("login", (_authInfo, callback) => callback());
        request.on("redirect", (statusCode, _method, redirectUrl, responseHeaders) => {
          if (options.redirect !== "manual") return;
          finish({ kind: "redirect", statusCode, redirectUrl,
            headers: normalizeHeaders(responseHeaders) });
          request.abort();
        });
        request.on("response", response => {
          const body = new Promise((bodyResolve, bodyReject) => {
            const chunks = [];
            let length = 0;
            response.on("data", chunk => {
              const bytes = Buffer.from(chunk);
              length += bytes.byteLength;
              if (length > options.maxBytes) {
                request.abort();
                bodyReject(Object.assign(new Error("byte_ceiling_exceeded"),
                  { code: "byte_ceiling_exceeded" }));
                return;
              }
              chunks.push(bytes);
            });
            response.on("end", () => bodyResolve(Buffer.concat(chunks, length)));
            response.on("aborted", () => bodyReject(Object.assign(new Error("body_aborted"),
              { code: "body_aborted" })));
            response.on("error", bodyReject);
          });
          finish({ kind: "response", statusCode: response.statusCode,
            headers: normalizeHeaders(response.headers), body, abort: () => request.abort() });
        });
        request.on("error", fail);
        request.end();
      });
    }
  });
}

function createElectronSessionWarmup({ requestClient }) {
  if (typeof requestClient?.requestOnce !== "function") {
    throw new TypeError("qri_electron_warmup_client_invalid");
  }
  return async function warmup({ plan, sessionPartition, userAgent, signal }) {
    if (sessionPartition !== SESSION_PARTITION || userAgent !== USER_AGENT ||
        JSON.stringify(plan) !== JSON.stringify(WARMUP_PLAN)) {
      return Object.freeze({ accepted: false, reason: "warmup_plan_invalid" });
    }
    for (const step of WARMUP_PLAN) {
      const headers = { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8", "Accept-Encoding": "identity" };
      if (step.referer) headers.Referer = step.referer;
      const response = await requestClient.requestOnce({ url: step.url, method: "GET", headers,
        useSessionCookies: true, sessionPartition: SESSION_PARTITION, redirect: "follow",
        cache: "no-store", maxBytes: MAX_RESPONSE_BYTES, signal });
      if (response?.kind !== "response" || response.statusCode < 200 || response.statusCode >= 400) {
        return Object.freeze({ accepted: false, reason: "warmup_response_rejected" });
      }
      await bodyBytes(response.body, MAX_RESPONSE_BYTES);
    }
    return Object.freeze({ accepted: true, reason: null });
  };
}

function createDefaultQriRawTransportShadow(options) {
  return createQriRawTransportShadow({ ...options, requestTimeoutMs: REQUEST_TIMEOUT_MS,
    bodyTimeoutMs: BODY_TIMEOUT_MS, maxResponseBytes: MAX_RESPONSE_BYTES });
}

module.exports = Object.freeze({ SHADOW_VERSION, SESSION_PARTITION, USER_AGENT, JPX_HOME_URL,
  JPX_QUOTES_URL, WARMUP_PLAN, MAX_REDIRECTS, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS,
  BODY_TIMEOUT_MS, ACCEPTED_MEDIA_TYPE, parseContentType, canonicalEncoding, resolveEncoding,
  createQriRawTransportShadow, createDefaultQriRawTransportShadow, createElectronNetClient,
  createElectronSessionWarmup, sha256Bytes });
