"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const XLSX = require("xlsx");

const P1 = require("../js/participantAcquisitionAuthorityContract.js");
const Shadow = require("../js/participantRawTransportShadow.js");
const ParticipantData = require("../js/participantData.js");

const root = path.join(__dirname, "..");
const DATE = "2026-11-10";
const FIXED_NOW = new Date("2026-11-10T09:30:00.000Z");

function authority(suffix = "a") {
  return P1.createMainAuthority({ keyId: `participants-p2-${suffix}`,
    secret: Buffer.alloc(32, suffix.charCodeAt(0)) });
}

function workbook(role, date = DATE) {
  const book = XLSX.utils.book_new();
  const rows = [
    ["手口上位一覧"],
    [null, "取引日 Trading Date :", date.replaceAll("-", "")],
    ["NK225F", "161090018", `${role} CONTRACT`, 1, `00${P1.ROLE_ORDER.indexOf(role) + 1}`,
      `${role}証券`, `${role} Securities`, 100 + P1.ROLE_ORDER.indexOf(role)]
  ];
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return new Uint8Array(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
}

function response(bytes, { status = 200, mime = Shadow.MIME, location = null,
    contentLength = bytes?.byteLength } = {}) {
  const headers = {};
  if (mime !== null) headers["content-type"] = mime;
  if (location !== null) headers.location = location;
  if (contentLength !== null && contentLength !== undefined)
    headers["content-length"] = String(contentLength);
  return new Response(bytes || null, { status, headers });
}

function chain({ date = DATE, suffix = "a", requestId = "participants-p2-request-1" } = {}) {
  const main = authority(suffix);
  const intent = P1.createAcquisitionIntent({ requestKind: "explicit_source_date",
    targetDate: date });
  const routes = Object.fromEntries(P1.ROLE_ORDER.map(role =>
    [role, P1.canonicalWorkbookUrl(role, date)]));
  const discovery = P1.createOfficialDiscovery({ intent,
    discoveryKind: "official_monthly_listing", discoveryRequestId: `participants-discovery-${suffix}`,
    officialUrl: P1.monthlyListingUrl(date), sourceDate: date, sourceUrls: routes,
    fallbackAttempt: null });
  const manifest = P1.createAcquisitionManifest({ intent, discovery, requestId }, main);
  const acquisitions = P1.createWorkbookAcquisitions(manifest, main);
  return { main, intent, discovery, manifest, acquisitions };
}

function normalFetch({ date = DATE, calls = [] } = {}) {
  return async (url, options) => {
    calls.push({ url, options });
    const role = P1.ROLE_ORDER.find(value => url === P1.canonicalWorkbookUrl(value, date));
    return role ? response(workbook(role, date)) : response(null, { status: 404, mime: "text/plain" });
  };
}

function service(fetchImpl, main, overrides = {}) {
  return Shadow.createParticipantsRawTransportShadow({ fetchImpl, authority: main,
    now: () => FIXED_NOW, ...overrides });
}

async function acquired(options = {}) {
  const value = chain(options);
  const calls = [];
  const result = await service(normalFetch({ date: value.manifest.sourceDate, calls }), value.main)
    .acquireManifest(value.manifest);
  assert.equal(result.success, true);
  return { ...value, calls, result };
}

test("P2-1 normal transport captures exact bytes for all four roles", async () => {
  const value = await acquired();
  assert.deepEqual(value.result.results.map(result => result.role), P1.ROLE_ORDER);
  assert.equal(value.calls.length, 4);
  for (const result of value.result.results) {
    assert.deepEqual(result.bytes, workbook(result.role));
    assert.equal(Shadow.validateTransportResult(result, value.manifest,
      value.acquisitions.find(item => item.role === result.role), value.main), true);
    assert.deepEqual({ method: value.calls.find(call => call.url === result.initialUrl).options.method,
      redirect: value.calls.find(call => call.url === result.initialUrl).options.redirect,
      credentials: value.calls.find(call => call.url === result.initialUrl).options.credentials,
      cache: value.calls.find(call => call.url === result.initialUrl).options.cache },
    { method: "GET", redirect: "manual", credentials: "omit", cache: "no-store" });
  }
});

test("P2-2 raw SHA-256 is stable and binds the original bytes before parsing", async () => {
  const value = await acquired();
  for (const result of value.result.results)
    assert.equal(result.rawSha256, crypto.createHash("sha256").update(result.bytes).digest("hex"));
  const changed = structuredClone(value.result.results[0]);
  changed.bytes[0] ^= 1;
  assert.equal(Shadow.validateTransportResult(changed, value.manifest,
    value.acquisitions[0], value.main), false);
});

test("P2-3 byte length is exact and bounded", async () => {
  const value = await acquired();
  for (const result of value.result.results) {
    assert.equal(result.byteLength, result.bytes.byteLength);
    assert.ok(result.byteLength > 0 && result.byteLength < Shadow.MAX_BYTES);
  }
});

test("P2-4 official XLSX MIME is accepted", async () => {
  const value = await acquired();
  assert.ok(value.result.results.every(result => result.mime === Shadow.MIME));
});

test("P2-5 generic binary MIME is rejected", async () => {
  const value = chain();
  const result = await service(async () => response(workbook("dayAuction"),
    { mime: "application/octet-stream" }), value.main).acquireManifest(value.manifest);
  assert.deepEqual([result.success, result.reason, result.diagnostics[0].stage],
    [false, "mime_mismatch", "mime"]);
});

test("P2-6 declared and actual oversize are rejected", async () => {
  const value = chain();
  const declared = await service(async () => response(new Uint8Array([1]),
    { contentLength: Shadow.MAX_BYTES + 1 }), value.main).acquireManifest(value.manifest);
  assert.equal(declared.reason, "oversize");
  const bytes = new Uint8Array(Shadow.MAX_BYTES + 1);
  const actual = await service(async () => response(bytes, { contentLength: null }), value.main)
    .acquireManifest(value.manifest);
  assert.equal(actual.reason, "oversize");
});

test("P2-7 non-200 status is rejected before parser", async () => {
  const value = chain();
  const result = await service(async () => response(null,
    { status: 404, mime: "text/plain", contentLength: null }), value.main)
    .acquireManifest(value.manifest);
  assert.deepEqual([result.reason, result.diagnostics[0].httpStatus], ["http_status", 404]);
});

test("P2-8 one validated same-route redirect is accepted", async () => {
  const value = chain();
  const calls = new Map();
  const result = await service(async url => {
    const count = calls.get(url) || 0;
    calls.set(url, count + 1);
    const role = P1.ROLE_ORDER.find(item => P1.canonicalWorkbookUrl(item, DATE) === url);
    return count === 0 ? response(null, { status: 302, mime: null, location: url,
      contentLength: null }) : response(workbook(role));
  }, value.main).acquireManifest(value.manifest);
  assert.equal(result.success, true);
  assert.ok(result.results.every(item => item.redirects.length === 1));
});

test("P2-9 external redirect is rejected", async () => {
  const value = chain();
  const result = await service(async () => response(null,
    { status: 302, mime: null, location: "https://evil.example/file.xlsx",
      contentLength: null }), value.main).acquireManifest(value.manifest);
  assert.equal(result.reason, "redirect_rejected");
});

test("P2-10 more than three redirects are rejected", async () => {
  const value = chain();
  const result = await service(async url => response(null,
    { status: 302, mime: null, location: url, contentLength: null }), value.main)
    .acquireManifest(value.manifest);
  assert.deepEqual([result.reason, result.diagnostics[0].redirectCount],
    ["redirect_rejected", 3]);
});

test("P2-11 request and body receive timeouts fail closed", async () => {
  const first = chain();
  const request = await service(() => new Promise(() => {}), first.main,
    { requestTimeoutMs: 5, bodyTimeoutMs: 5 }).acquireManifest(first.manifest);
  assert.deepEqual([request.reason, request.diagnostics[0].stage], ["timeout", "request"]);
  const second = chain({ suffix: "b", requestId: "participants-p2-request-2" });
  const body = await service(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])); }
  }), { status: 200, headers: { "content-type": Shadow.MIME } }), second.main,
  { requestTimeoutMs: 20, bodyTimeoutMs: 5 }).acquireManifest(second.manifest);
  assert.deepEqual([body.reason, body.diagnostics[0].stage], ["timeout", "body"]);
});

for (const [number, role] of P1.ROLE_ORDER.map((role, index) => [12 + index, role])) {
  test(`P2-${number} ${role} uses the exact P1 route`, async () => {
    const value = await acquired();
    const result = value.result.results.find(item => item.role === role);
    assert.equal(result.initialUrl, P1.canonicalWorkbookUrl(role, DATE));
    assert.equal(result.routeIdentity,
      value.manifest.routes.find(item => item.role === role).routeIdentity);
  });
}

test("P2-16 wrong suffix or date is rejected before a request", async () => {
  const value = chain();
  const wrongSuffix = structuredClone(value.manifest);
  wrongSuffix.routes[0].canonicalUrl = wrongSuffix.routes[0].canonicalUrl.replace(
    "whole_day.xlsx", "other.xlsx");
  const wrongDate = structuredClone(value.manifest);
  wrongDate.routes[0].sourceDate = "2026-11-09";
  let calls = 0;
  const transport = service(async () => { calls++; return response(workbook("dayAuction")); },
    value.main);
  const suffixResult = await transport.acquireManifest(wrongSuffix);
  const dateResult = await transport.acquireManifest(wrongDate);
  assert.deepEqual([suffixResult.reason, dateResult.reason, calls],
    ["route_rejected", "route_rejected", 0]);
});

test("P2-17 fallback probes dayAuction only and never exceeds ten attempts", async () => {
  const main = authority("c");
  const intent = P1.createAcquisitionIntent({ requestKind: "latest_available" });
  const urls = [];
  const transport = service(async url => {
    urls.push(url);
    return response(null, { status: 404, mime: "text/plain", contentLength: null });
  }, main);
  const result = await transport.resolveDiscovery({ intent,
    indexFacts: { indexUrl: P1.CURRENT_INDEX_URL, hrefs: [],
      discoveryRequestId: "participants-index-empty" }, probeStartDate: DATE,
    discoveryRequestId: "participants-fallback-request" });
  assert.deepEqual([result.success, result.reason, urls.length], [false, "incomplete_set", 10]);
  assert.ok(urls.every(url => P1.ROLE_SUFFIXES.dayAuction &&
    url.endsWith(P1.ROLE_SUFFIXES.dayAuction)));
});

test("fallback success establishes sourceDate then P1 derives all four routes", async () => {
  const main = authority("d");
  const intent = P1.createAcquisitionIntent({ requestKind: "latest_available" });
  const urls = [];
  const result = await service(async url => {
    urls.push(url);
    return urls.length === 1 ? response(null, { status: 404, mime: "text/plain",
      contentLength: null }) : response(workbook("dayAuction", "2026-11-09"));
  }, main).resolveDiscovery({ intent,
    indexFacts: { indexUrl: P1.CURRENT_INDEX_URL, hrefs: [],
      discoveryRequestId: "participants-index-empty-2" }, probeStartDate: DATE,
    discoveryRequestId: "participants-fallback-success" });
  assert.equal(result.success, true);
  assert.deepEqual([result.discovery.sourceDate, result.probeCount,
    result.discovery.routes.map(route => route.role)],
  ["2026-11-09", 2, P1.ROLE_ORDER]);
});

test("P2-18 four-role assembly is signed and deterministic", async () => {
  const value = await acquired();
  assert.equal(Shadow.validateTransportSet(value.result, value.manifest,
    value.acquisitions, value.main), true);
  assert.match(value.result.transportSetId,
    /^participants-raw-transport-set-v1\|sha256:[0-9a-f]{64}$/);
  assert.deepEqual(value.result.results.map(item => item.role), P1.ROLE_ORDER);
});

test("P2-19 one role from another run is rejected", async () => {
  const first = await acquired({ suffix: "e", requestId: "participants-run-e" });
  const second = await acquired({ suffix: "f", requestId: "participants-run-f" });
  const results = [...first.result.results];
  results[3] = second.result.results[3];
  const assembled = Shadow.assembleTransportSet({ manifest: first.manifest,
    acquisitions: first.acquisitions, results }, first.main);
  assert.equal(assembled.reason, "mixed_run");
});

test("P2-20 mixed sourceDate is rejected", async () => {
  const first = await acquired({ suffix: "g", requestId: "participants-run-g" });
  const second = await acquired({ date: "2026-11-09", suffix: "h",
    requestId: "participants-run-h" });
  const results = [...first.result.results];
  results[1] = second.result.results[1];
  assert.equal(Shadow.assembleTransportSet({ manifest: first.manifest,
    acquisitions: first.acquisitions, results }, first.main).reason, "mixed_run");
});

test("P2-21 missing role cannot create a complete set", async () => {
  const value = await acquired();
  const result = Shadow.assembleTransportSet({ manifest: value.manifest,
    acquisitions: value.acquisitions, results: value.result.results.slice(0, 3) }, value.main);
  assert.equal(result.reason, "incomplete_set");
});

test("P2-22 shadow bytes produce exactly the existing parser canonical records", async () => {
  const value = await acquired();
  for (const result of value.result.results) {
    const book = XLSX.read(result.bytes, { type: "array" });
    const sheet = book.Sheets[book.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    const productionEquivalent = ParticipantData.parseParticipantExcel(rows, DATE);
    assert.deepEqual(result.parserPreview, productionEquivalent);
    assert.equal(result.parserPreviewSha256, P1.sha256(productionEquivalent));
  }
});

test("content-length mismatch and malformed workbook retain distinct diagnostics", async () => {
  const first = chain({ suffix: "i", requestId: "participants-run-i" });
  const mismatch = await service(async () => response(new Uint8Array([1, 2, 3]),
    { contentLength: 4 }), first.main).acquireManifest(first.manifest);
  assert.equal(mismatch.reason, "body_length_mismatch");
  const second = chain({ suffix: "j", requestId: "participants-run-j" });
  const malformed = await service(async () => response(new Uint8Array([1, 2, 3])), second.main)
    .acquireManifest(second.manifest);
  assert.equal(malformed.reason, "workbook_parse_rejected");
});

test("P2-23 shadow is unwired and cannot write Vault history Formal IPC or renderer state", () => {
  const shadow = fs.readFileSync(path.join(root, "js/participantRawTransportShadow.js"), "utf8");
  for (const forbidden of ["ipcMain", "ipcRenderer", "localStorage", "indexedDB",
    "sourceEvidenceVault", "participantHistory", "FormalArchive", "writeFile", "appendFile"])
    assert.equal(shadow.includes(forbidden), false, forbidden);
  for (const runtime of ["main.js", "preload.js", "index.html"])
    assert.equal(fs.readFileSync(path.join(root, runtime), "utf8")
      .includes("participantRawTransportShadow"), false, runtime);
  assert.equal(require(path.join(root, "package.json")).build.files.includes("js/**/*"), true);
});
