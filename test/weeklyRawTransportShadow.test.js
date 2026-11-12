"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const XLSX = require("xlsx");
const Authority = require("../js/weeklyAcquisitionAuthorityContract.js");
const Shadow = require("../js/weeklyRawTransportShadow.js");
const WeeklyFutures = require("../js/weeklyFutures.js");
const WeeklyOptions = require("../js/weeklyOptions.js");

const DATE = "2026-11-06";
const PUBLISHED_DATE = "2026-11-09";
const MIME = "binary/octet-stream";
const SECRET = "weekly-shadow-main-authority-fixture-secret-v1";
const authority = () => Authority.createMainAuthority({
  keyId: "weekly-shadow-main-session-v1", secret: SECRET
});
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function futuresRows() {
  const rows = Array.from({ length: 8 }, () => []);
  rows[1][0] = "（ 2026年11月6日現在 ）";
  rows[2][0] = "2026年11月9日";
  rows[4] = ["＜日経225先物＞"];
  rows[5] = ["1", "2026年12月限月", "12724", "ＨＳＢＣ証券", "33,597",
    "12400", "野村証券", "33,492"];
  return rows;
}

function optionsRows() {
  const rows = Array.from({ length: 84 }, () => Array(18).fill(null));
  rows[0][0] = WeeklyOptions.SOURCE_TITLE;
  rows[1][0] = "（ 2026年11月6日現在 ）";
  rows[2][0] = "2026年11月9日";
  rows[6][1] = "プット（2026年11月限月）";
  rows[6][11] = "コール（2026年11月限月）";
  [10, 25, 40, 55, 70].forEach((start, block) => {
    const strike = 65375 + block * 125;
    rows[start - 1][1] = strike;
    rows[start - 1][11] = strike;
    for (let index = 0; index < 15; index += 1) {
      rows[start - 1 + index][0] = index + 1;
      rows[start - 1 + index][10] = index + 1;
    }
  });
  const row = rows[9];
  row[2] = "12479";
  row[3] = "ＡＢＮクリアリン証券";
  row[4] = 392;
  row[15] = "11746";
  row[16] = "ＵＢＳ証券";
  row[17] = 250;
  return rows;
}

function xlsxBytes(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
}

const FUTURES_BYTES = xlsxBytes(futuresRows());
const OPTIONS_BYTES = xlsxBytes(optionsRows());

function listingBytes({ futures = true, options = true, tradeDate = "20261106" } = {}) {
  const row = { TradeDate: tradeDate };
  if (futures) row.IndexFutures = "/automation/markets/derivatives/open-interest/files/2026/" +
    `${tradeDate}_indexfut_oi_by_tp.xlsx`;
  if (options) row.IndexOptions = "/automation/markets/derivatives/open-interest/files/2026/" +
    `${tradeDate}_nk225op_oi_by_tp.xlsx`;
  return new TextEncoder().encode(JSON.stringify({ UpdateDate: "2026/11/09 15:31",
    TableDatas: [row] }));
}

function response(bytes, { status = 200, mime = MIME, declared = bytes.byteLength,
    headers = {} } = {}) {
  const responseHeaders = { "content-type": mime, ...headers };
  if (declared !== null) responseHeaders["content-length"] = String(declared);
  return new Response(bytes, { status, headers: responseHeaders });
}

function neverResponse() {
  return new Promise(() => undefined);
}

function hangingResponse(mime = MIME) {
  return new Response(new ReadableStream({ start() {} }), { status: 200,
    headers: { "content-type": mime } });
}

function makeFetch(overrides = {}) {
  const calls = [];
  const listing = Authority.createListingRoute(2026).canonicalUrl;
  const futures = Authority.createWorkbookRoute("weekly_futures_workbook", DATE).canonicalUrl;
  const options = Authority.createWorkbookRoute("weekly_options_workbook", DATE).canonicalUrl;
  const implementation = async (url, optionsValue) => {
    calls.push({ url, options: optionsValue });
    if (url === listing) return overrides.listing ? overrides.listing(url, optionsValue) :
      response(listingBytes());
    if (url === futures) return overrides.futures ? overrides.futures(url, optionsValue) :
      response(FUTURES_BYTES);
    if (url === options) return overrides.options ? overrides.options(url, optionsValue) :
      response(OPTIONS_BYTES);
    throw new Error(`unexpected_url:${url}`);
  };
  return { fetchImpl: implementation, calls, urls: { listing, futures, options } };
}

function createService(fetchFixture, options = {}) {
  const main = options.authority || authority();
  return { main, service: Shadow.createWeeklyRawTransportShadow({
    fetchImpl: fetchFixture.fetchImpl,
    authority: main,
    now: () => new Date("2026-11-12T06:00:00.000Z"),
    requestTimeoutMs: options.requestTimeoutMs || 100,
    bodyTimeoutMs: options.bodyTimeoutMs || 100
  }) };
}

async function acquire(overrides = {}, serviceOptions = {}) {
  const fetchFixture = makeFetch(overrides);
  const fixture = createService(fetchFixture, serviceOptions);
  const intent = Authority.createAcquisitionIntent({
    requestKind: "explicit_source_date", targetDate: DATE
  });
  const result = await fixture.service.acquireIntent({ intent, requestId: "weekly-shadow-1" });
  return { ...fixture, fetchFixture, result, run: result.runs[0] };
}

test("W2-1 official yearly listing raw bytes are retained exactly", async () => {
  const expected = listingBytes();
  const fixture = await acquire({ listing: () => response(expected) });
  assert.equal(fixture.result.success, true);
  assert.deepEqual(fixture.run.listing.bytes, expected);
  assert.equal(fixture.run.listing.encoding, "utf-8");
});

test("W2-2 listing byteLength and SHA-256 bind the exact pre-parse bytes", async () => {
  const fixture = await acquire();
  const listing = fixture.run.listing;
  assert.equal(listing.byteLength, listing.bytes.byteLength);
  assert.equal(listing.rawSha256, sha256(listing.bytes));
  const tampered = structuredClone(listing);
  tampered.bytes[0] ^= 1;
  assert.equal(Shadow.validateListingTransportResult(tampered, fixture.run.manifest,
    fixture.run.discovery, fixture.main), false);
});

test("W2-3 live-observed JPX binary/octet-stream is the narrow accepted MIME", async () => {
  const fixture = await acquire();
  assert.deepEqual(Shadow.LISTING_MIME_TYPES, [MIME]);
  assert.deepEqual(Shadow.WORKBOOK_MIME_TYPES, [MIME]);
  assert.equal(fixture.run.listing.mime, MIME);
  for (const call of fixture.fetchFixture.calls) {
    assert.deepEqual({ method: call.options.method, redirect: call.options.redirect,
      credentials: call.options.credentials, cache: call.options.cache },
    { method: "GET", redirect: "manual", credentials: "omit", cache: "no-store" });
    assert.equal(call.options.headers.accept, MIME);
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test("W2-4 listing MIME mismatch rejects before parsing", async () => {
  const fixture = await acquire({ listing: () => response(listingBytes(),
    { mime: "application/json" }) });
  assert.equal(fixture.result.reason, "listing_mime_mismatch");
  assert.equal(fixture.fetchFixture.calls.length, 1);
});

test("W2-5 listing declared and actual oversize are bounded", async () => {
  const declared = await acquire({ listing: () => response(listingBytes(),
    { declared: Shadow.LISTING_MAX_BYTES + 1 }) });
  assert.equal(declared.result.reason, "listing_oversize");
  const bytes = new Uint8Array(Shadow.LISTING_MAX_BYTES + 1);
  const actual = await acquire({ listing: () => response(bytes, { declared: null }) });
  assert.equal(actual.result.reason, "listing_oversize");
});

test("W2-6 request and body timeout fail closed", async () => {
  const request = await acquire({ listing: () => neverResponse() }, { requestTimeoutMs: 5 });
  assert.equal(request.result.reason, "listing_timeout");
  const body = await acquire({ listing: () => hangingResponse() }, { bodyTimeoutMs: 5 });
  assert.equal(body.result.reason, "listing_timeout");
});

test("W2-7 redirects cannot escape the exact authority route", async () => {
  const fixture = await acquire({ listing: () => new Response(null, { status: 302,
    headers: { location: "https://example.invalid/listing.json" } }) });
  assert.equal(fixture.result.reason, "listing_redirect_rejected");
  assert.equal(fixture.fetchFixture.calls.length, 1);
});

test("W2-8 latest TradeDate selection matches the production-equivalent listing rule", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ TableDatas: [
    { TradeDate: "20261030", IndexFutures: "/automation/markets/derivatives/open-interest/files/2026/20261030_indexfut_oi_by_tp.xlsx" },
    { TradeDate: "20261106", IndexOptions: "/automation/markets/derivatives/open-interest/files/2026/20261106_nk225op_oi_by_tp.xlsx" }
  ] }));
  const parsed = Shadow.parseListingBytes(bytes, 2026);
  const intent = Authority.createAcquisitionIntent({ requestKind: "latest_available" });
  assert.equal(Shadow.selectTradeDates(intent, [parsed])[0],
    Shadow.productionEquivalentLatestTradeDate(bytes));
  assert.equal(Shadow.productionEquivalentLatestTradeDate(bytes), DATE);
});

test("W2-9 Futures workbook transport preserves Evidence-grade raw identity", async () => {
  const fixture = await acquire();
  assert.equal(fixture.run.futures.success, true);
  assert.deepEqual(fixture.run.futures.bytes, FUTURES_BYTES);
  assert.equal(fixture.run.futures.rawSha256, sha256(FUTURES_BYTES));
  assert.equal(Shadow.validateWorkbookTransportResult(fixture.run.futures,
    fixture.run.manifest, fixture.main), true);
});

test("W2-10 Options workbook transport preserves Evidence-grade raw identity", async () => {
  const fixture = await acquire();
  assert.equal(fixture.run.options.success, true);
  assert.deepEqual(fixture.run.options.bytes, OPTIONS_BYTES);
  assert.equal(fixture.run.options.rawSha256, sha256(OPTIONS_BYTES));
  assert.equal(Shadow.validateWorkbookTransportResult(fixture.run.options,
    fixture.run.manifest, fixture.main), true);
});

test("W2-11 Futures invalid MIME is classified without affecting Options", async () => {
  const fixture = await acquire({ futures: () => response(FUTURES_BYTES,
    { mime: "application/vnd.ms-excel" }) });
  assert.equal(fixture.run.futures.reason, "workbook_mime_mismatch");
  assert.equal(fixture.run.options.success, true);
  assert.equal(fixture.result.status, "partial");
});

test("W2-12 Options invalid MIME is classified without affecting Futures", async () => {
  const fixture = await acquire({ options: () => response(OPTIONS_BYTES,
    { mime: "application/zip" }) });
  assert.equal(fixture.run.options.reason, "workbook_mime_mismatch");
  assert.equal(fixture.run.futures.success, true);
  assert.equal(fixture.result.status, "partial");
});

test("W2-13 XLSX PK signature is mandatory before SheetJS", async () => {
  const invalid = new TextEncoder().encode("not-an-xlsx");
  const fixture = await acquire({ futures: () => response(invalid) });
  assert.equal(fixture.run.futures.reason, "workbook_signature_rejected");
  assert.equal(fixture.run.options.success, true);
});

test("W2-14 Futures byte ceiling rejects before parser execution", async () => {
  const fixture = await acquire({ futures: () => response(FUTURES_BYTES,
    { declared: Shadow.FUTURES_MAX_BYTES + 1 }) });
  assert.equal(fixture.run.futures.reason, "futures_transport_failed");
  assert.equal(fixture.run.futures.diagnostics[0].transportReason, "oversize");
});

test("W2-15 Options byte ceiling rejects before parser execution", async () => {
  const fixture = await acquire({ options: () => response(OPTIONS_BYTES,
    { declared: Shadow.OPTIONS_MAX_BYTES + 1 }) });
  assert.equal(fixture.run.options.reason, "options_transport_failed");
  assert.equal(fixture.run.options.diagnostics[0].transportReason, "oversize");
});

test("W2-16 Futures timeout does not suppress successful Options acquisition", async () => {
  const fixture = await acquire({ futures: () => neverResponse() }, { requestTimeoutMs: 5 });
  assert.equal(fixture.run.futures.diagnostics[0].transportReason, "timeout");
  assert.equal(fixture.run.options.success, true);
});

test("W2-17 Options timeout does not suppress successful Futures acquisition", async () => {
  const fixture = await acquire({ options: () => neverResponse() }, { requestTimeoutMs: 5 });
  assert.equal(fixture.run.options.diagnostics[0].transportReason, "timeout");
  assert.equal(fixture.run.futures.success, true);
});

test("W2-18 Futures parser preview is exactly the existing canonical parser result", async () => {
  const fixture = await acquire();
  assert.deepEqual(fixture.run.futures.parserPreview.canonical,
    WeeklyFutures.parseWeeklyFuturesRows(futuresRows()));
  assert.deepEqual(fixture.run.futures.parserAuthority,
    Authority.PARSER_AUTHORITIES.weekly_futures_workbook);
});

test("W2-19 Options parser preview is exactly the existing canonical parser result", async () => {
  const fixture = await acquire();
  assert.deepEqual(fixture.run.options.parserPreview.canonical,
    WeeklyOptions.parseWeeklyOptionsRows(optionsRows()));
  assert.deepEqual(fixture.run.options.parserAuthority,
    Authority.PARSER_AUTHORITIES.weekly_options_workbook);
});

test("W2-20 both workbook roles bind sourceDate and publishedDate from the workbook", async () => {
  const fixture = await acquire();
  for (const value of [fixture.run.futures, fixture.run.options]) {
    assert.equal(value.sourceDate, DATE);
    assert.equal(value.publishedDate, PUBLISHED_DATE);
    assert.equal(value.parserPreview.sourceDate, DATE);
    assert.equal(value.parserPreview.publishedDate, PUBLISHED_DATE);
  }
});

test("W2-21 Futures failure and Options success retain separate domain results", async () => {
  const fixture = await acquire({ futures: () => response(new Uint8Array([1, 2, 3, 4])) });
  assert.equal(fixture.run.status, "partial");
  assert.equal(fixture.run.futures.success, false);
  assert.equal(fixture.run.options.success, true);
  assert.equal(fixture.run.futures.diagnostics[0].role, "weekly_futures_workbook");
  assert.notEqual(fixture.run.manifest.futuresDescriptor.acquisitionId,
    fixture.run.manifest.optionsDescriptor.acquisitionId);
});

test("W2-22 Options failure and Futures success retain separate domain results", async () => {
  const fixture = await acquire({ options: () => response(new Uint8Array([1, 2, 3, 4])) });
  assert.equal(fixture.run.status, "partial");
  assert.equal(fixture.run.options.success, false);
  assert.equal(fixture.run.futures.success, true);
  assert.equal(fixture.run.options.diagnostics[0].role, "weekly_options_workbook");
  assert.equal(fixture.run.manifest.futuresDescriptor.runId,
    fixture.run.manifest.optionsDescriptor.runId);
});

test("W2-23 shared listing failure starts zero workbook requests", async () => {
  const fixture = await acquire({ listing: () => response(new TextEncoder().encode("{}")) });
  assert.equal(fixture.result.reason, "listing_parse_rejected");
  assert.equal(fixture.result.runs.length, 0);
  assert.equal(fixture.fetchFixture.calls.length, 1);
});

test("W2-24 renderer cannot inject URL, role, bytes or hash into the shadow request", async () => {
  const fetchFixture = makeFetch();
  const fixture = createService(fetchFixture);
  const intent = Authority.createAcquisitionIntent({ requestKind: "explicit_source_date",
    targetDate: DATE });
  for (const extra of [{ url: fetchFixture.urls.futures }, { role: "weekly_futures_workbook" },
    { sourceId: "jpx-weekly-index-futures-open-interest" }, { bytes: FUTURES_BYTES },
    { rawSha256: "a".repeat(64) }, { redirectTarget: fetchFixture.urls.options },
    { transportMetadata: { status: 200, mime: MIME } }]) {
    const result = await fixture.service.acquireIntent({ intent, requestId: "inject", ...extra });
    assert.equal(result.reason, "listing_route_rejected");
  }
  assert.equal(fetchFixture.calls.length, 0);
});

test("W2-25 shadow is pure-unwired and package-reachable without persistence or IPC", () => {
  const root = path.resolve(__dirname, "..");
  const source = fs.readFileSync(path.join(root, "js/weeklyRawTransportShadow.js"), "utf8");
  for (const forbidden of ["evidenceVault", "localStorage", "indexedDB", "ipcMain",
    "contextBridge", "writeFileSync", "appendFile", "productionProfile"])
    assert.equal(source.includes(forbidden), false, forbidden);
  for (const production of ["main.js", "preload.js", "index.html"])
    assert.equal(fs.readFileSync(path.join(root, production), "utf8")
      .includes("weeklyRawTransportShadow"), false, production);
  const packageConfig = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(packageConfig.build.files.includes("js/**/*"), true);
  assert.deepEqual(Shadow.REQUEST_POLICY, {
    method: "GET", redirect: "manual", credentials: "omit", cache: "no-store",
    maxRedirects: 3, maxRetries: 0, requestTimeoutMs: 15000, bodyTimeoutMs: 15000,
    listingMaxBytes: 512000, futuresMaxBytes: 1000000, optionsMaxBytes: 1000000,
    listingMimeTypes: [MIME], workbookMimeTypes: [MIME]
  });
});
