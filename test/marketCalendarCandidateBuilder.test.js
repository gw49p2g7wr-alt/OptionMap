"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const XLSX = require("xlsx");
const Policy = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");
const Builder = require("../js/marketCalendarRuntime/calendarCandidateBuilder.js");
const Adapters = require("../js/marketCalendarShadow/representativeAdapters.js");
const Cpi = require("./fixtures/marketCalendar/statCpiXmlFixture.js");
const Bea = require("./fixtures/marketCalendar/beaCalendarFixtures.js");
const Census = require("./fixtures/marketCalendar/censusCalendarFixture.js");

const fetchedAt = "2026-09-24T00:00:00.000Z";
const BOJ = '<h2 id="p02">次回</h2><p>2026年9月17日（木）、18日（金）</p>' +
  '<h2 id="p03">会見</h2><p>2026年9月18日（金）15:30～（ライブ配信予定）</p>';
const encoding = (name = "utf-8", warnings = []) => ({ encoding: name, evidence: {
  httpCharset: name, bom: null, html5MetaCharset: null, legacyMetaCharset: null,
  resolvedEncoding: name, resolutionPolicyVersion: 1, resolutionBasis: "fixture" }, warnings });
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const bytes = value => value instanceof Uint8Array ? value : new TextEncoder().encode(value);
function document(role, url, body, mime, extra = {}) { const input = bytes(body); return {
  role, originalOfficialUrl: url, finalUrl: url, redirects: [], httpStatus: 200, mime,
  encoding: mime.includes("spreadsheet") ? null : encoding(), workbook: null,
  byteCount: input.byteLength, contentSha256: hash(input), parserInputSha256: hash(input),
  parserInput: input, ...extra }; }
function envelope(sourceId, documents, time = fetchedAt) { return { success: true, reason: null,
  retryable: false, sourceId, operation: Policy.OPERATION, requestedAt: time,
  fetchedAt: time, documents, diagnostics: [] }; }
function bojEnvelope(html = BOJ, time = fetchedAt) { const url =
  "https://www.boj.or.jp/about/calendar/"; return envelope("jp-boj-calendar",
  [document("primary", url, html, "text/html")], time); }
function cpiEnvelope() { const landing = "https://www.stat.go.jp/data/cpi/",
  data = "https://www.stat.go.jp/data/kouhyou/e-stat_cpi.xml"; return envelope("jp-stat-cpi",
  [document("landing", landing, "<html></html>", "text/html"), document("data", data,
    Cpi.utf16le(), "application/xml", { encoding: encoding("utf-16le") })]); }
function beaEnvelope() { return envelope("us-bea-calendar", [document("scheduleAuthority",
  "https://apps.bea.gov/API/signup/release_dates.json", Bea.json, "application/json"),
  document("releaseSemantics", "https://www.bea.gov/news/schedule", Bea.html, "text/html")]); }
function censusEnvelope() { const url = "https://www.census.gov/economic-indicators/calendar-listview.html";
  return envelope("us-census-calendar", [document("primary", url, Census.bytes, "text/html", {
    encoding: encoding("utf-8", ["conflicting_declaration_ignored_by_priority"])
  })]); }
function workbookEnvelope() { const landingUrl =
  "https://www.jpx.co.jp/derivatives/rules/last-trading-day/", workbookUrl =
  "https://www.jpx.co.jp/derivatives/rules/last-trading-day/abc-att/2026_indexfutures_options_1_j.xlsx",
  workbook = XLSX.utils.book_new(), sheet = XLSX.utils.aoa_to_sheet([
    ["商品", "限月取引", "9桁コード", "限月コード", "取引最終日", "権利行使日"],
    ["日経225オプション", "2026年9月限月", "-", "-", "2026/09/10", "2026/09/11"]]);
  XLSX.utils.book_append_sheet(workbook, sheet, "2026");
  const valueOnly = new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  return envelope("jp-jpx-derivatives-calendar", [document("landing", landingUrl,
    `<a href="${workbookUrl}">Excel</a>`, "text/html"), document("workbook", workbookUrl,
    valueOnly, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", {
      workbook: { valid: true, sanitized: true, originalReason: "external_relationship_forbidden",
        inspection: { valid: true } }
    })]); }

test("valid HTMLをFormal candidateへ変換しraw bodyを返さない", async () => {
  const candidate = await Builder.buildCalendarCandidate({ sourceId: "jp-boj-calendar",
    acquisitionResult: bojEnvelope() });
  assert.equal(candidate.candidateStatus, "available");
  assert.equal(candidate.formalEligible, true);
  assert.equal(candidate.recordCount, 3);
  assert.match(candidate.candidateIdentity, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(candidate).includes(BOJ), false);
  assert.equal(JSON.stringify(candidate).includes("parserInput"), false);
});

test("UTF-16LE XMLのencoding evidenceを保持してcandidate化", async () => {
  const candidate = await Builder.buildCalendarCandidate({ sourceId: "jp-stat-cpi",
    acquisitionResult: cpiEnvelope() });
  assert.equal(candidate.candidateStatus, "available");
  assert.equal(candidate.recordCount, 2);
  assert.equal(candidate.encodingEvidence.find(value => value.role === "data").encoding.encoding,
    "utf-16le");
});

test("valid JSONと補助HTMLを既存BEA adapterでcandidate化", async () => {
  const candidate = await Builder.buildCalendarCandidate({ sourceId: "us-bea-calendar",
    acquisitionResult: beaEnvelope() });
  assert.equal(candidate.candidateStatus, "available");
  assert.equal(candidate.recordCount, 8);
});

test("sanitized XLSXだけを既存JPX parserへ渡す", async () => {
  const candidate = await Builder.buildCalendarCandidate({ sourceId: "jp-jpx-derivatives-calendar",
    acquisitionResult: workbookEnvelope() });
  assert.equal(candidate.candidateStatus, "available");
  assert.equal(candidate.recordCount, 2);
  assert.equal(candidate.encodingEvidence[1].workbook.sanitized, true);
});

test("Census conflicting encoding warningを保持してUTF-8 candidate化", async () => {
  const candidate = await Builder.buildCalendarCandidate({ sourceId: "us-census-calendar",
    acquisitionResult: censusEnvelope() });
  assert.equal(candidate.candidateStatus, "available");
  assert.deepEqual(candidate.encodingEvidence[0].encoding.warnings,
    ["conflicting_declaration_ignored_by_priority"]);
});

test("unknown source・malformed・unavailable acquisitionをfail-closed", async () => {
  const unknown = await Builder.buildCalendarCandidate({ sourceId: "unknown",
    acquisitionResult: bojEnvelope() });
  const malformed = await Builder.buildCalendarCandidate({ sourceId: "jp-boj-calendar",
    acquisitionResult: {} });
  const unavailable = await Builder.buildCalendarCandidate({ sourceId: "jp-boj-calendar",
    acquisitionResult: { success: false, reason: "network_failed" } });
  assert.deepEqual([unknown.candidateStatus, malformed.candidateStatus, unavailable.candidateStatus],
    ["rejected", "rejected", "unavailable"]);
  assert.deepEqual([unknown.formalEligible, malformed.formalEligible, unavailable.formalEligible],
    [false, false, false]);
});

test("MIME・hash・encoding・XLSX safety evidence不正を拒否", async () => {
  const mime = bojEnvelope(); mime.documents[0].mime = "application/json";
  const digest = bojEnvelope(); digest.documents[0].parserInputSha256 = "0".repeat(64);
  const unknownEncoding = bojEnvelope(); unknownEncoding.documents[0].encoding = null;
  const unsafeWorkbook = workbookEnvelope(); unsafeWorkbook.documents[1].workbook.valid = false;
  for (const [sourceId, acquisitionResult] of [["jp-boj-calendar", mime],
    ["jp-boj-calendar", digest], ["jp-boj-calendar", unknownEncoding],
    ["jp-jpx-derivatives-calendar", unsafeWorkbook]]) {
    const value = await Builder.buildCalendarCandidate({ sourceId, acquisitionResult });
    assert.equal(value.candidateStatus, "rejected"); assert.equal(value.formalEligible, false);
  }
});

test("malformed HTML/XML/JSONとunexpected structureはFormal化しない", async () => {
  const html = bojEnvelope("<html>unexpected</html>"), xml = cpiEnvelope(), json = beaEnvelope();
  xml.documents[1] = document("data", xml.documents[1].finalUrl,
    new Uint8Array([0xff, 0xfe, 0x3c]), "application/xml", { encoding: encoding("utf-16le") });
  json.documents[0] = document("scheduleAuthority", json.documents[0].finalUrl,
    "{", "application/json");
  for (const [sourceId, acquisitionResult] of [["jp-boj-calendar", html], ["jp-stat-cpi", xml],
    ["us-bea-calendar", json]]) {
    const value = await Builder.buildCalendarCandidate({ sourceId, acquisitionResult });
    assert.equal(value.candidateStatus, "rejected"); assert.equal(value.formalEligible, false);
  }
});

test("parser blocking diagnosticとcanonical invalidをFormal化しない", async () => {
  const production = Adapters.create({ XLSX }).find(value => value.sourceId === "jp-boj-calendar"),
    blocking = { sourceId: "jp-boj-calendar", async acquire(input) { const value =
      await production.acquire(input); return { ...value, diagnostics: ["fixture_blocking"] }; } },
    invalid = { sourceId: "jp-boj-calendar", async acquire() { return { fetches: [], diagnostics: [],
      records: [{ sourceId: "jp-boj-calendar", sourceTitle: "invalid" }] }; } };
  for (const adapter of [blocking, invalid]) {
    const builder = Builder.createCalendarCandidateBuilder({ adapterMap: new Map([
      ["jp-boj-calendar", adapter]]) });
    const value = await builder.buildCalendarCandidate({ sourceId: "jp-boj-calendar",
      acquisitionResult: bojEnvelope() });
    assert.equal(value.candidateStatus, "rejected"); assert.equal(value.formalEligible, false);
  }
});

test("duplicate conflictとidentity collisionを明示して拒否", async () => {
  const production = Adapters.create({ XLSX }).find(value => value.sourceId === "jp-boj-calendar"),
    mutate = collision => ({ sourceId: "jp-boj-calendar", async acquire(input) { const value =
      await production.acquire(input), copy = structuredClone(value.records[collision ? 1 : 0]);
      if (collision) copy.sourceLocalSchedule.startDate = "2026-09-19";
      return { ...value, records: [...value.records, copy] }; } });
  for (const [adapter, diagnostic] of [[mutate(false), "duplicate:1"],
    [mutate(true), "identity_collision:1"]]) {
    const builder = Builder.createCalendarCandidateBuilder({ adapterMap: new Map([
      ["jp-boj-calendar", adapter]]) }), value = await builder.buildCalendarCandidate({
      sourceId: "jp-boj-calendar", acquisitionResult: bojEnvelope() });
    assert.equal(value.formalEligible, false);
    assert.equal(value.canonicalDiagnostics.includes(diagnostic), true, JSON.stringify(value));
  }
});

test("candidate identityはorder・runtime timestampに不変、semantic変更で変化", async () => {
  const firstInput = bojEnvelope(), reordered = structuredClone(firstInput);
  reordered.fetchedAt = "2026-09-24T00:01:00.000Z";
  reordered.requestedAt = "2026-09-24T00:01:00.000Z";
  reordered.documents[0] = Object.fromEntries(Object.entries(reordered.documents[0]).reverse());
  const changed = bojEnvelope(BOJ.replace("18日（金）15:30", "18日（金）16:30"));
  const [first, same, different] = await Promise.all([firstInput, reordered, changed].map(
    acquisitionResult => Builder.buildCalendarCandidate({ sourceId: "jp-boj-calendar",
      acquisitionResult })));
  assert.equal(first.candidateIdentity, same.candidateIdentity);
  assert.notEqual(first.candidateIdentity, different.candidateIdentity);
});

test("Builderはnetwork・storage・transition・writerへ接続しない", () => {
  const source = fs.readFileSync(path.join(__dirname,
    "../js/marketCalendarRuntime/calendarCandidateBuilder.js"), "utf8");
  assert.doesNotMatch(source, /fetch\(|indexedDB|localStorage|SourceCursor|transitionPlanner/);
  assert.doesNotMatch(source, /HistoryWriter|readwrite|previousObservations/);
});
