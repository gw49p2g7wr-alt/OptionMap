"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const S = require("../js/marketCalendarIsolated/mofJgbSource.js");
const P = require("../js/marketCalendarIsolated/mofJgbParser.js");
const C = require("../js/marketCalendarIsolated/mofJgbCanonical.js");
const F = require("./fixtures/marketCalendar/mofJgbFixture.js");
const url = code => `https://www.mof.go.jp/jgbs/auction/calendar/${code}.htm`;
const context = code => ({ sourceUrl: url(code), fetchedAt: "2026-10-07T00:00:00Z", rawContentHash: "a".repeat(64) });
const parse = (html, code = "2610") => P.parseMonth(html, context(code));
const response = (html, status = 200, contentType = "text/html") => new Response(html,
  { status, headers: { "content-type": contentType } });
const request = { sourceId: S.SOURCE_ID, assessmentDateJst: "2026-10-07" };
async function fixtureAcquire(pages = { [S.INDEX_URL]: F.index(["2610", "2611"]), [url("2610")]: F.current, [url("2611")]: F.future }) {
  const calls = [], acquirer = S.createAcquirer({ fetchImpl: async (u, opts) => {
    calls.push({ url: u, opts }); return response(pages[u]);
  } });
  const acquired = await acquirer.acquire(request);
  return { acquired, calls, acquirer };
}
for (const [id, label, include, reason] of [
  ["J1", "5年利付国債", true], ["J2", "5年クライメート・トランジション利付国債", false, "climate_transition"],
  ["J3", "10年利付国債", true], ["J4", "10年物価連動国債", false, "inflation_linked"],
  ["J5", "国庫短期証券（3ヶ月）", false, "treasury_bill"], ["J6", "流動性供給入札（残存期間5年超11年以下）", false, "liquidity_enhancement"]
]) test(`${id}: strict product classification ${label}`, () => {
  const p = parse(F.month("2610", [F.row("10月8日", label)]));
  assert.equal(p.ok, true); assert.equal(p.records.length, include ? 1 : 0);
  if (reason) assert.equal(p.diagnostics.excludedRows[reason], 1);
});
for (const maturity of P.MATURITIES) test(`maturity ${maturity}Y date-only / JST / deterministic title`, () => {
  const p = parse(F.month("2610", [F.row("10月8日", `${maturity}年利付国債`)]));
  assert.equal(p.ok, true); const r = p.records[0];
  assert.equal(r.maturity, `${maturity}Y`); assert.equal(r.time, null);
  assert.equal(r.titleJa, `${maturity}年国債 入札`); assert.equal(r.sourceLocalSchedule.timeZone, "Asia/Tokyo");
  assert.equal(r.sourceLocalSchedule.kind, "date_only"); assert.equal(r.absenceAuthority, "none");
});
test("current and future tables: linked and unlinked details both work", () => {
  assert.equal(parse(F.current).records.length, 5); const f = parse(F.future, "2611");
  assert.equal(f.records.length, 6); assert.equal(f.diagnostics.excludedRows.climate_transition, 1);
  assert.equal(f.diagnostics.excludedRows.inflation_linked, 1);
});
test("official completed T-bill label with issue number remains explicitly excluded", () => {
  for (const label of ["国庫短期証券（3ヶ月） (第1410回)", "国庫短期証券（6ヶ月） (第1411回)",
    "国庫短期証券（3ヶ月） (第1412回)"]) {
    const p = parse(F.month("2610", [F.row("10月8日", label)]));
    assert.equal(p.ok, true); assert.equal(p.records.length, 0);
    assert.equal(p.diagnostics.excludedRows.treasury_bill, 1); assert.equal(p.diagnostics.unknownProductCount, 0);
  }
  assert.equal(P.classify("国庫短期証券（3ヶ月） (第1410回)新商品").reason, "unknown_product");
});
test("formatting/issue number never changes canonical event or semantic identity", async () => {
  const records = ["５ 年 利付国債", "5年利付国債（第99回）", "5年利付国債"].map(label =>
    parse(F.month("2610", [F.row("10月8日", label)])).records[0]);
  const events = await Promise.all(records.map(C.canonicalize)); assert.ok(events.every(e => e.ok));
  assert.equal(new Set(events.map(e => e.event.eventKey)).size, 1);
  assert.equal(new Set(events.map(e => e.event.canonicalContentHash)).size, 1);
  assert.match(events[0].event.eventKey, /^JP\|MOF\|JP_JGB_AUCTION\|auction-date:2026-10-08\|normal-fixed-rate\|5Y$/);
});
test("URL/hash/acquisition/amount/update metadata are not semantic identity", async () => {
  const r = parse(F.current).records[0], a = await C.canonicalize(r), b = await C.canonicalize({ ...r,
    sourceUrl: url("2611"), evidenceUrl: url("2611"), sourcePageMonth: "2026-11", rawContentHash: "b".repeat(64),
    fetchedAt: "2026-10-08T00:00:00Z", issueAmount: "2.6 trillion", pageUpdateTimestamp: "ignored", resultTime: "12:35" });
  assert.equal(b.ok, true); assert.equal(a.event.eventKey, b.event.eventKey);
  assert.equal(a.event.canonicalContentHash, b.event.canonicalContentHash);
  assert.notEqual(a.event.acquisitionEvidenceKey, b.event.acquisitionEvidenceKey);
  assert.equal(a.event.schedule.canonicalStart, null); assert.equal(a.event.schedule.sourceLocal.startTime, null);
});
test("date revision is distinct identity; no cancelled/delete synthesis", async () => {
  const a = await C.canonicalize(parse(F.month("2610", [F.row("10月8日", "5年利付国債")])).records[0]);
  const b = await C.canonicalize(parse(F.month("2610", [F.row("10月9日", "5年利付国債")])).records[0]);
  assert.notEqual(a.event.eventKey, b.event.eventKey); assert.equal(a.event.lifecycleStatus, "scheduled");
  assert.equal(b.event.change.supersedesRevisionKey, null);
});
test("identity exact dedupe only; same date different maturity remains distinct", () => {
  const p = parse(F.month("2610", [F.row("10月8日", "5年利付国債"), F.row("10月8日", "5年利付国債（第99回）"),
    F.row("10月8日", "10年利付国債")]));
  assert.equal(p.records.length, 2); assert.equal(p.diagnostics.duplicateCount, 1);
});
test("malformed, impossible, wrong-month dates fail entire page; no silent partial", () => {
  for (const date of ["10月32日", "9月8日", "invalid"]) {
    const p = parse(F.month("2610", [F.row("10月8日", "5年利付国債"), F.row(date, "10年利付国債")]));
    assert.equal(p.ok, false); assert.equal(p.records.length, 0); assert.equal(p.diagnostics.malformedCount, 1);
  }
});
test("leap-year/date rollover use real calendar dates", () => {
  assert.equal(parse(F.month("2402", [F.row("2月29日", "2年利付国債")]), "2402").ok, true);
  assert.equal(parse(F.month("2502", [F.row("2月29日", "2年利付国債")]), "2502").ok, false);
  assert.equal(parse(F.month("2701", [F.row("1月5日", "2年利付国債")]), "2701").records[0].eventDate, "2027-01-05");
  for (const value of [null, "2026-02-30", "2026-13-01", "2026-00-01", "2026-01-00"]) assert.equal(S.validDate(value), false);
});
test("unknown maturity/product rejects, not ordinary fixed-rate by substring", () => {
  for (const label of ["7年利付国債", "5年新商品利付国債", "変動利付10年国債", "10年利付国債追加商品"]) {
    const p = parse(F.month("2610", [F.row("10月8日", label)]));
    assert.equal(p.ok, false); assert.equal(p.diagnostics.unknownProductCount, 1); assert.equal(p.records.length, 0);
  }
});
test("buyback/special-account tables never become auction candidates", () => {
  const p = parse(F.month("2610", [], `<table><tr><td>10月8日</td><td>10年利付国債</td></tr></table>`));
  assert.equal(p.ok, true); assert.equal(p.records.length, 0); assert.equal(P.classify("買入消却").reason, "buyback");
  assert.equal(P.classify("特別会計借入金").reason, "special_account_borrowing");
});
test("unexpected header/table/section/row structure is fail-closed", () => {
  for (const html of [F.current.replace("入札予定日", "公表日"), F.current.replace("（１）", "（９）"),
    F.current.replace("<tbody>", "<tbody><tr><td>broken</td></tr>"), F.current.replace("<td>", '<td rowspan="2">'),
    F.current.replace("</table>", "</table><table></table>"), F.current.replace("<h1>", "<h2>")]) {
    assert.equal(parse(html).ok, false);
  }
  assert.equal(parse(F.current, "2611").reason, "month_heading_mismatch");
});
test("explicit empty/no qualifying month succeeds with bounded coverage only", () => {
  for (const html of [F.month("2610"), F.month("2610", [F.row("10月8日", "国庫短期証券（3ヶ月）")])]) {
    const p = parse(html); assert.equal(p.ok, true); assert.equal(p.records.length, 0); assert.equal(p.absenceAuthority, "none");
  }
});
test("index discovery deterministic, duplicate-free, current/future only; gaps not invented", () => {
  const a = S.discoverMonths(F.index(["2701", "2612", "2609", "2610", "2612"]), "2026-10-07");
  assert.equal(a.ok, true); assert.deepEqual(a.months.map(m => m.month), ["2026-10", "2026-12", "2027-01"]);
  assert.equal(a.duplicateCount, 1); assert.equal(a.months.some(m => m.month === "2026-11"), false);
  assert.deepEqual(a.months, S.discoverMonths(F.index(["2610", "2612", "2701"]), "2026-10-07").months);
});
test("missing/unpublished future month is not failed completeness", async () => {
  const { acquired } = await fixtureAcquire({ [S.INDEX_URL]: F.index(["2610"]), [url("2610")]: F.current });
  const result = await C.assess(acquired); assert.equal(result.outcome, "complete");
  assert.equal(result.coverage, "published_months_only"); assert.equal(result.absenceAuthority, "none");
});
test("unsafe index month links/header/label reject; result/notice links ignored", () => {
  for (const href of ["https://evil.test/jgbs/auction/calendar/2610.htm", "2610.htm?x=1", "../calendar/2610.htm", "2613.htm", "2611.htm", "%32%36%31%30.htm"])
    assert.equal(S.discoverMonths(`<h1>入札カレンダー</h1><a href="${href}">10月</a>`, "2026-10-07").ok, false);
  assert.equal(S.discoverMonths(F.index().replace("<h1>", "<h2>"), "2026-10-07").ok, false);
  assert.equal(S.discoverMonths(F.index() + '<a href="2610a.htm">予定変更</a><a href="yotei/auct20261001.htm">詳細</a>', "2026-10-07").months.length, 3);
});
test("strict exact HTTPS/host/path, no credentials/query/fragment/normalization aliases", () => {
  assert.equal(S.validateUrl(S.INDEX_URL).valid, true); assert.equal(S.validateUrl(url("2610")).valid, true);
  for (const value of [url("2610").replace("https:", "http:"), url("2610") + "?x=1", url("2610") + "#x",
    url("2610").replace("www.mof.go.jp", "mof.go.jp"), url("2610").replace("www.mof.go.jp", "www.mof.go.jp:443"),
    url("2610").replace("www.mof.go.jp", "user@www.mof.go.jp"), url("2610").replace("/2610", "/x/../2610"), url("2610a"),
    url("2610").replace("2610", "%32%36%31%30"), "file:///2610.htm", null]) assert.equal(S.validateUrl(value).valid, false);
});
test("strict UTF-8 declaration contract; invalid bytes/conflicting charset rejected", () => {
  assert.equal(S.decode(Buffer.from(F.current), "text/html").ok, true);
  for (const [bytes, mime] of [[Buffer.from("<h1>no declaration</h1>"), "text/html"], [Buffer.from(F.current), "application/json"],
    [Buffer.from(F.current), "text/html;charset=Shift_JIS"], [Buffer.from(F.current.replace("UTF-8", "windows-1252")), "text/html;charset=UTF-8"],
    [Buffer.concat([Buffer.from('<meta charset="UTF-8">'), Buffer.from([0xff])]), "text/html"], [Buffer.alloc(0), "text/html"]])
    assert.equal(S.decode(bytes, mime).ok, false);
});
test("bounded acquisition request schema / no arbitrary URL / no ambient transport", async () => {
  assert.throws(() => S.createAcquirer(), /isolated_transport_required/); let calls = 0;
  const a = S.createAcquirer({ fetchImpl: async () => { calls++; return response(F.index()); } });
  for (const r of [{ ...request, url: url("2610") }, { ...request, sourceId: "unknown" }, { ...request, assessmentDateJst: "2026-02-30" }])
    assert.equal((await a.acquire(r)).reason, "request_shape_invalid");
  assert.equal(calls, 0);
});
test("acquisition -> assessment, exact fixture counts, all resources closed", async () => {
  const { acquired, calls, acquirer } = await fixtureAcquire(), result = await C.assess(acquired);
  assert.equal(result.outcome, "complete"); assert.equal(result.candidateCount, 11); assert.equal(result.futureCandidateCount, 10);
  assert.deepEqual(result.byMaturity, { "2Y": 2, "5Y": 2, "10Y": 2, "20Y": 2, "30Y": 2, "40Y": 1 });
  assert.equal(result.diagnostics.pagesDiscovered, 2); assert.equal(result.diagnostics.pagesFetched, 2);
  assert.equal(result.diagnostics.rowsExamined, 15); assert.equal(result.diagnostics.qualifyingRows, 11);
  assert.equal(result.writeAllowed, false); assert.equal(result.productionActive, false);
  assert.deepEqual(acquirer.diagnostics(), { activeTasks: 0, activeTimers: 0, requests: 3 });
  assert.ok(calls.every(c => c.opts.method === "GET" && c.opts.redirect === "manual" && c.opts.credentials === "omit"));
  assert.ok(calls.every(c => Object.keys(c.opts.headers).join() === "accept"));
});
test("month failure makes source failed, no silent candidate subset", async () => {
  const a = S.createAcquirer({ fetchImpl: async u => u === url("2611") ? response(null, 403) :
    response(u === S.INDEX_URL ? F.index(["2610", "2611"]) : F.current) });
  const result = await C.assess(await a.acquire(request)); assert.equal(result.outcome, "failed"); assert.equal(result.candidateCount, 0);
  assert.equal(a.diagnostics().requests, 3); assert.equal(a.diagnostics().activeTasks, 0);
});
test("HTTP 403 and MIME rejection never read body; no retries", async () => {
  for (const [status, mime, expected] of [[403, "text/html", "http_status_rejected"], [200, "text/plain", "mime_invalid"]]) {
    let reads = 0, calls = 0; const a = S.createAcquirer({ fetchImpl: async () => { calls++; return {
      status, headers: new Headers({ "content-type": mime }), body: { getReader() { reads++; throw Error(); }, cancel: async () => {} }
    }; } });
    assert.equal((await a.acquire(request)).reason, expected); assert.equal(reads, 0); assert.equal(calls, 1);
  }
});
test("redirect every hop validates host/path and discovered page binding", async () => {
  for (const target of ["https://evil.test/2610.htm", url("2610"), S.INDEX_URL + "?x=1", "/jgbs/auction/calendar/x/../index.htm"])
    assert.equal((await S.createAcquirer({ fetchImpl: async () => new Response(null, { status: 302,
      headers: { location: target } }) }).acquire(request)).reason, "redirect_not_allowed");
  const a = S.createAcquirer({ fetchImpl: async () => new Response(null, { status: 302, headers: { location: S.INDEX_URL } }) });
  assert.equal((await a.acquire(request)).reason, "redirect_limit_or_location_invalid"); assert.equal(a.diagnostics().requests, 4);
});
test("implicit redirect and response final URL mismatch rejected", async () => {
  const a = S.createAcquirer({ fetchImpl: async () => ({ status: 200, redirected: true, headers: new Headers(), body: null }) });
  assert.equal((await a.acquire(request)).reason, "implicit_redirect_rejected");
});
test("declared byte ceiling/truncated stream/body overflow fail closed", async () => {
  for (const [value, expected] of [[String(S.MAX_BYTES + 1), "content_length_exceeded"], ["invalid", "content_length_invalid"], ["1", "truncated_response"]]) {
    const a = S.createAcquirer({ fetchImpl: async () => new Response(F.index(), { headers: {
      "content-type": "text/html", "content-length": value } }) });
    assert.equal((await a.acquire(request)).reason, expected); assert.equal(a.diagnostics().activeTimers, 0);
  }
  const a = S.createAcquirer({ fetchImpl: async () => response("x".repeat(S.MAX_BYTES + 1)) });
  assert.equal((await a.acquire(request)).reason, "body_size_exceeded");
});
test("request/body timeout abort and clean resources without retry", async () => {
  let aborted = 0;
  const a = S.createAcquirer({ requestTimeoutMs: 5, fetchImpl: (_, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener("abort", () => { aborted++; reject(Error("aborted")); }, { once: true });
  }) });
  assert.equal((await a.acquire(request)).reason, "request_timeout"); assert.equal(aborted, 1);
  assert.deepEqual(a.diagnostics(), { activeTasks: 0, activeTimers: 0, requests: 1 });
  const b = S.createAcquirer({ bodyTimeoutMs: 5, fetchImpl: async () => new Response(new ReadableStream({
    pull() { return new Promise(() => {}); }, cancel() {}
  }), { headers: { "content-type": "text/html" } }) });
  assert.equal((await b.acquire(request)).reason, "body_timeout"); assert.equal(b.diagnostics().activeTimers, 0);
});
test("cross-document exact identity dedupe and deterministic assessment order", async () => {
  const { acquired } = await fixtureAcquire();
  const first = await C.assess(acquired), repeated = await C.assess({ ...acquired,
    discovery: { ...acquired.discovery, months: [acquired.discovery.months[0], ...acquired.discovery.months] },
    documents: [acquired.documents[0], acquired.documents[1], ...acquired.documents.slice(1)] });
  assert.equal(repeated.candidateCount, first.candidateCount); assert.equal(repeated.diagnostics.duplicateCount, 5);
  assert.equal(repeated.candidateIdentity, first.candidateIdentity);
  const reversed = await C.assess({ ...acquired, discovery: { ...acquired.discovery, months: [...acquired.discovery.months].reverse() },
    documents: [acquired.documents[0], ...acquired.documents.slice(1).reverse()] });
  assert.equal(reversed.candidateIdentity, first.candidateIdentity);
});
test("canonical input malformed/source mismatch rejects", async () => {
  const r = parse(F.current).records[0];
  for (const changes of [{ sourceId: "unknown" }, { sourceId: null }, { eventType: "US_CPI" }, { time: "12:35" },
    { maturity: "7Y" }, { referencePeriod: "2026-10" }, { sourceStatus: "cancelled" }, { rawContentHash: "invalid" },
    { rawLabel: "10年物価連動国債", sourceTitle: "10年物価連動国債" }, { maturity: "5Y", scope: "5Y" },
    { sourceLocalSchedule: { ...r.sourceLocalSchedule, startDate: "2026-10-09" } }])
    assert.equal((await C.canonicalize({ ...r, ...changes })).ok, false);
});
test("production canonicalizer/registry/taxonomy reject isolated proposal unchanged", async () => {
  const registry = require("../js/marketCalendar/sourceRegistry.js"), taxonomy = require("../js/marketCalendar/eventTaxonomy.js");
  assert.equal(registry.getSource(S.SOURCE_ID), null); assert.equal(taxonomy.isEventType(S.EVENT_TYPE), false);
  const result = await require("../js/marketCalendar/marketEventCanonicalizer.js").canonicalize(parse(F.current).records[0]);
  assert.equal(result.ok, false); assert.equal(result.reason, "source_unregistered");
});
test("isolated modules have no writer/storage/runtime startup reachability", () => {
  const files = ["mofJgbSource.js", "mofJgbParser.js", "mofJgbCanonical.js"], seen = new Set();
  const visit = file => { if (seen.has(file)) return; seen.add(file); const code = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(file, /marketCalendarHistory|writerSafety|RuntimeState|main\.js$/);
    for (const m of code.matchAll(/require\(["'](\.[^"']+)["']\)/g)) visit(require.resolve(path.resolve(path.dirname(file), m[1])));
  };
  files.forEach(file => visit(path.resolve(__dirname, "../js/marketCalendarIsolated", file)));
  for (const file of ["../main.js", "../preload.js", "../js/marketCalendar/sourceRegistry.js",
    "../js/marketCalendarRuntime/calendarManualCheckService.js", "../js/marketCalendarRuntime/automaticFormalShadowRuntime.js"])
    assert.doesNotMatch(fs.readFileSync(path.resolve(__dirname, file), "utf8"), /mofJgb|jp-mof-jgb-auction-calendar/);
});
test("native harness is import-only and keeps package identity with no UA override", () => {
  const h = require("../scripts/marketCalendarG1MofJgbIsolated.js"); assert.equal(typeof h.runNative, "function");
  const code = fs.readFileSync(require.resolve("../scripts/marketCalendarG1MofJgbIsolated.js"), "utf8");
  assert.doesNotMatch(code, /setUserAgent|["']user-agent["']\s*:|BrowserWindow|marketCalendarHistory/);
  assert.match(code, /userAgent: session\.defaultSession\.getUserAgent\(\)/);
  assert.match(code, /name: meta\.name/); assert.match(code, /version: meta\.version/);
});
