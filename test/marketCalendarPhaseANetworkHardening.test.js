"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const XLSX = require("xlsx");
const Policy = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");
const Acquisition = require("../js/marketCalendarRuntime/calendarAcquisitionService.js");
const Workbook = require("../js/marketCalendarRuntime/workbookSafety.js");
const Parsers = require("../js/marketCalendarShadow/representativeParsers.js");

const root = path.join(__dirname, "..");
function headers(values = {}) {
  const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) =>
    [key.toLowerCase(), String(value)]));
  return { get: name => normalized[String(name).toLowerCase()] ?? null };
}
function response(body, options = {}) {
  const bytes = body instanceof Uint8Array ? body : new TextEncoder().encode(String(body));
  const chunks = options.chunks || [bytes]; let index = 0;
  return { status: options.status ?? 200, ok: (options.status ?? 200) >= 200 &&
      (options.status ?? 200) < 300, headers: headers({
        "content-type": options.type || "text/html; charset=utf-8",
        ...(options.length === false ? {} : { "content-length": options.length ?? bytes.length }),
        ...(options.encoding ? { "content-encoding": options.encoding } : {}),
        ...(options.location ? { location: options.location } : {})
      }), body: { getReader: () => ({ read: async () => index < chunks.length
        ? { done: false, value: chunks[index++] } : { done: true },
      cancel: async () => undefined, releaseLock: () => undefined }) } };
}
function service(fetchImpl, options = {}) {
  return Acquisition.createCalendarAcquisitionService({ fetchImpl, maxRetries: 0,
    now: () => new Date("2026-09-24T00:00:00.000Z"), ...options });
}
function u16(value) { const buffer = Buffer.alloc(2); buffer.writeUInt16LE(value); return buffer; }
function u32(value) { const buffer = Buffer.alloc(4); buffer.writeUInt32LE(value); return buffer; }
function storedZip(entries) {
  const locals = [], centrals = []; let offset = 0;
  for (const [name, value] of entries) {
    const nameBytes = Buffer.from(name), data = Buffer.from(value), local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes, data
    ]), central = Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(data.length), u32(data.length), u16(nameBytes.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes]);
    locals.push(local); centrals.push(central); offset += local.length;
  }
  const central = Buffer.concat(centrals), eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0),
    u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0)]);
  return Buffer.concat([...locals, central, eocd]);
}

test("12 sourceだけをsource-document-set operationへ固定", () => {
  assert.equal(Object.keys(Policy.SOURCE_POLICIES).length, 12);
  for (const sourceId of Object.keys(Policy.SOURCE_POLICIES))
    assert.equal(Policy.validateRequest({ sourceId, operation: Policy.OPERATION }).valid, true);
  for (const sourceId of ["unknown", "jp-meti-calendar", "us-ism-calendar", "jp-esri-calendar"])
    assert.equal(Policy.validateRequest({ sourceId, operation: Policy.OPERATION }).valid, false);
  assert.equal(Policy.validateRequest({ sourceId: "jp-boj-calendar", operation: "fetch",
    url: "https://example.com" }).valid, false);
});

test("URL policyはHTTPS・host・path・query・credential・fragmentをfail-closed", () => {
  const p = Policy.getPolicy("jp-boj-calendar").documents[0];
  for (const url of ["http://www.boj.or.jp/about/calendar/", "https://evil.example/about/calendar/",
    "https://www.boj.or.jp/other/", "https://www.boj.or.jp/about/calendar/?x=1",
    "https://user:pass@www.boj.or.jp/about/calendar/",
    "https://www.boj.or.jp/about/calendar/#x"])
    assert.equal(Policy.validateUrl("jp-boj-calendar", p, url).valid, false, url);
  assert.equal(Policy.validateUrl("jp-boj-calendar", p, p.url).valid, true);
});

test("MIME allowlistとsource別limitを監査可能", () => {
  for (const value of Object.values(Policy.SOURCE_POLICIES)) for (const document of value.documents) {
    assert.ok(document.maxBytes > 0); assert.ok(document.allowedMime.length > 0);
  }
  const html = Policy.getPolicy("jp-boj-calendar").documents[0];
  assert.equal(Policy.validateMime(html, "text/html; charset=UTF-8").valid, true);
  assert.equal(Policy.validateMime(html, "application/json").valid, false);
});

test("bounded streamはContent-Length超過・実受信超過・truncationを拒否", async () => {
  const p = Policy.getPolicy("jp-boj-calendar").documents[0];
  const tooLong = await service(async () => response("x", { length: p.maxBytes + 1 })).acquire({
    sourceId: "jp-boj-calendar", operation: Policy.OPERATION });
  assert.equal(tooLong.reason, "content_length_exceeded");
  const streamed = await service(async () => response("x", { length: false,
    chunks: [new Uint8Array(p.maxBytes), new Uint8Array(1)] })).acquire({
    sourceId: "jp-boj-calendar", operation: Policy.OPERATION });
  assert.equal(streamed.reason, "body_size_exceeded");
  const truncated = await service(async () => response("x", { length: 2 })).acquire({
    sourceId: "jp-boj-calendar", operation: Policy.OPERATION });
  assert.equal(truncated.reason, "truncated_response");
  const decompressed = await service(async () => response("<meta charset=utf-8>",
    { length: 3, encoding: "gzip" })).acquire({ sourceId: "jp-boj-calendar",
    operation: Policy.OPERATION });
  assert.equal(decompressed.success, true);
});

test("redirect逸脱・downgrade・loop/hop超過・MIME不一致を拒否", async () => {
  for (const target of ["https://evil.example/x", "http://www.bls.gov/schedule/2026/09_sched.htm"] ) {
    const result = await service(async () => response("", { status: 302, location: target })).acquire({
      sourceId: "us-bls-calendar", operation: Policy.OPERATION });
    assert.match(result.reason, /^redirect_/);
  }
  const loop = await service(async () => response("", { status: 302,
    location: "https://www.bls.gov/schedule/2026/09_sched.htm" })).acquire({
      sourceId: "us-bls-calendar", operation: Policy.OPERATION });
  assert.equal(loop.reason, "redirect_hop_exceeded");
  const mime = await service(async () => response("{}", { type: "application/json" })).acquire({
    sourceId: "jp-boj-calendar", operation: Policy.OPERATION });
  assert.equal(mime.reason, "mime_not_allowed");
});

test("body timeoutとnetwork failureはretryable分類しretry上限を超えない", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { status: 200, ok: true,
    headers: headers({ "content-type": "text/html" }), body: { getReader: () => ({
      read: () => new Promise(() => {}), cancel: async () => undefined, releaseLock: () => undefined }) } }; };
  const result = await service(fetchImpl, { bodyTimeoutMs: 5, maxRetries: 1 }).acquire({
    sourceId: "jp-boj-calendar", operation: Policy.OPERATION });
  assert.equal(result.reason, "body_timeout"); assert.equal(result.retryable, true); assert.equal(calls, 2);

  calls = 0;
  const requestTimeout = await service(() => { calls += 1; return new Promise(() => {}); },
    { requestTimeoutMs: 5, maxRetries: 1 }).acquire({ sourceId: "jp-boj-calendar",
      operation: Policy.OPERATION });
  assert.equal(requestTimeout.reason, "request_timeout");
  assert.equal(requestTimeout.retryable, true); assert.equal(calls, 2);
});

test("malformed HTML/XMLとunexpected structureは既存parserでfail-closed", () => {
  const context = { sourceId: "fixture", sourceUrl: "https://example.invalid/", fetchedAt:
    "2026-09-24T00:00:00.000Z", parserId: "fixture", parserVersion: 1,
  rawContentHash: "0".repeat(64) };
  const html = Parsers.parseBls("<html><table><tr><td>broken", context);
  assert.equal(html.records.length, 0); assert.ok(html.diagnostics.length > 0);
  const xml = Parsers.parseStatCpiXml('<?xml version="1.0"?><class_1 name="全国"></class_1>',
    context);
  assert.equal(xml.records.length, 0); assert.ok(xml.diagnostics.length > 0);
});

test("JSON malformed・prototype pollution keyを拒否しplain inputだけを受理", () => {
  assert.equal(Acquisition.validateJson(new TextEncoder().encode("{" )).reason, "json_invalid");
  assert.equal(Acquisition.validateJson(new TextEncoder().encode(
    '{"__proto__":{"polluted":true}}')).reason, "prototype_pollution_key");
  assert.equal(Acquisition.validateJson(new TextEncoder().encode('{"data":[]}')).valid, true);
  assert.equal({}.polluted, undefined);
});

test("workbook safetyは正常XLSXを受理しZIP・bomb・path・macro・externalを拒否", () => {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book,
    XLSX.utils.aoa_to_sheet([["date", "value"], ["2026-09-24", 1]]), "Sheet1");
  const valid = XLSX.write(book, { type: "buffer", bookType: "xlsx" });
  assert.equal(Workbook.inspectWorkbook(valid).valid, true);
  assert.equal(Workbook.inspectWorkbook(Buffer.from("not zip")).reason, "zip_signature_invalid");
  assert.equal(Workbook.inspectWorkbook(storedZip([["../evil", "x"]])).reason, "path_traversal");
  assert.equal(Workbook.inspectWorkbook(storedZip([["xl/a.xml", "x"], ["XL/A.XML", "y"]])).reason,
    "duplicate_entry");
  assert.equal(Workbook.inspectWorkbook(storedZip([["xl/vbaProject.bin", "x"]])).reason,
    "macro_workbook_forbidden");
  assert.equal(Workbook.inspectWorkbook(storedZip([["_rels/.rels",
    '<Relationship TargetMode="External" Target="https://evil.example"/>']])).reason,
  "external_relationship_forbidden");
  const sanitized = Workbook.sanitizeValueOnly(storedZip([["_rels/.rels",
    '<Relationship TargetMode="External" Target="file:///Z:/unsafe.xlsx"/>'],
    ["xl/worksheets/sheet1.xml", "<worksheet/>"]]), XLSX);
  assert.equal(sanitized.valid, false);
  const many = Array.from({ length: Workbook.LIMITS.maxEntryCount + 1 }, (_, i) => [`x/${i}`, ""]);
  assert.equal(Workbook.inspectWorkbook(storedZip(many)).reason, "entry_count_exceeded");
  assert.equal(Workbook.inspectWorkbook(storedZip([["xl/a.xml", "x".repeat(32)]]),
    { ...Workbook.LIMITS, maxUncompressedBytes: 8, maxEntryBytes: 64 }).reason,
  "uncompressed_size_exceeded");
});

test("preloadはURLなしの限定APIだけを公開しmain requestも再検証される", async () => {
  let exposed, invoked;
  const sandbox = { require: name => name === "electron" ? {
    contextBridge: { exposeInMainWorld: (key, value) => { exposed = { key, value }; } },
    ipcRenderer: { invoke: (...args) => { invoked = args; return Promise.resolve({ success: true }); } }
  } : require(name), Object };
  vm.runInNewContext(fs.readFileSync(path.join(root, "preload.js"), "utf8"), sandbox);
  assert.equal(typeof exposed.value.requestCalendarSource, "function");
  await exposed.value.requestCalendarSource({ sourceId: "jp-boj-calendar",
    operation: "source-document-set" });
  assert.equal(invoked[0], "request-market-calendar-source");
  assert.deepEqual(JSON.parse(JSON.stringify(invoked[1])), { sourceId: "jp-boj-calendar",
    operation: "source-document-set" });
  invoked = null;
  const rejected = await exposed.value.requestCalendarSource({ sourceId: "jp-boj-calendar",
    operation: "source-document-set", url: "https://evil.example" });
  assert.equal(rejected.errorCode, "invalid_argument"); assert.equal(invoked, null);
});

test("Phase A modulesはstorage・DB・UI・writer・exportへ非接続", () => {
  for (const file of ["calendarNetworkPolicy.js", "calendarAcquisitionService.js", "workbookSafety.js"]) {
    const source = fs.readFileSync(path.join(root, "js/marketCalendarRuntime", file), "utf8");
    assert.doesNotMatch(source, /indexedDB|localStorage|SourceRun|SourceCursor|SemanticRevision|AI Export|Time Travel/);
    assert.doesNotMatch(source,
      /productionHistoryWriter|runtimeControlledWriter|globalThis\.document|window\.document|querySelector/);
  }
  const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
  const handler = main.slice(main.indexOf('ipcMain.handle("request-market-calendar-source"'),
    main.indexOf('ipcMain.handle("save-full-export-json"'));
  assert.doesNotMatch(handler, /indexedDB|localStorage|productionHistoryWriter|createInUpgrade/);
  assert.doesNotMatch(handler, /request\.url|request\.headers|request\.path/);
});

test("sanitized failure envelopeはstack・path・cookie・credentialを漏らさない", async () => {
  const result = await service(async () => { throw new Error("/Users/private/secret"); }).acquire({
    sourceId: "jp-boj-calendar", operation: Policy.OPERATION });
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /Users|stack|cookie|credential|secret/);
  assert.equal(result.reason, "network_failed");
});
