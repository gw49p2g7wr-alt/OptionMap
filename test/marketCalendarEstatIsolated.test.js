"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const Route = require("../js/marketCalendarIsolated/estatRoute.js");
const Parser = require("../js/marketCalendarIsolated/estatParser.js");
const Coverage = require("../js/marketCalendarIsolated/estatCoverage.js");
const Canonical = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Legacy = require("../js/marketCalendarShadow/representativeParsers.js");
const F = require("./fixtures/marketCalendar/estatHtmlFixture.js");
const CPI = "jp-stat-cpi", LABOR = "jp-stat-labor", day = "2026-12-20";
const fetchedAt = "2026-09-26T00:00:00.000Z";
function acquisition(sourceId, html, changes = {}) {
  const parserInput = Buffer.from(html);
  return { success: true, sourceId, fetchedAt, document: { finalUrl: Route.ROUTES[sourceId].url,
    httpStatus: 200, redirects: [], mime: "text/html", contentType: "text/html; charset=UTF-8",
    byteCount: parserInput.length, contentSha256: Route.hash(parserInput), parserInput }, ...changes };
}
const candidate = (sourceId, rows) => Parser.buildCandidate({ sourceId, acquisitionResult: acquisition(sourceId, F.page(sourceId, rows)) });
function normal(sourceId = CPI) {
  return (sourceId === CPI ? ["national", "tokyo"] : ["basic"]).flatMap(lane => [
    F.monthly(sourceId, lane, "2026-11", "2026-12-01"),
    F.monthly(sourceId, lane, "2026-12", "2027-01-01"),
    F.monthly(sourceId, lane, "2027-01", "2027-02-01")]);
}
async function assess(rows = normal(), sourceId = CPI, assessmentDateJst = day) {
  const built = await candidate(sourceId, rows);
  return Coverage.assessCoverage({ sourceId, classifiedRows: built.classifiedRows,
    parserStatus: built.parserStatus, assessmentDateJst });
}
test("inactive route is source-specific exact URL, never accepts arbitrary request fields", async () => {
  for (const sourceId of [CPI, LABOR]) {
    assert.equal(Route.validateUrl(sourceId, Route.ROUTES[sourceId].url).valid, true);
    for (const url of [Route.ROUTES[sourceId].url + "?x=1", Route.ROUTES[sourceId].url + "#fragment",
      Route.ROUTES[sourceId].url.replace("https:", "http:"), Route.ROUTES[sourceId].url.replace("www.", "evil."),
      Route.ROUTES[sourceId].url.replace("https://", "https://user:secret@"),
      Route.ROUTES[sourceId === CPI ? LABOR : CPI].url, "https://www.e-stat.go.jp/other"])
      assert.equal(Route.validateUrl(sourceId, url).valid, false);
  }
  let calls = 0; const acquirer = Route.createAcquirer({ fetchImpl: () => { calls++; } });
  for (const request of [{ sourceId: CPI, url: "https://evil.test" }, { sourceId: CPI, headers: {} },
    { sourceId: "unknown" }, { sourceId: "__proto__" }, { sourceId: "constructor" }, null])
    assert.equal((await acquirer.acquire(request)).reason, "request_shape_invalid");
  assert.equal(calls, 0);
});
test("acquisition reuses Phase A limits, UTF-8 validation and fixed safe metadata", async () => {
  const html = F.page(CPI, normal()); let calls = 0;
  const service = Route.createAcquirer({ fetchImpl: async (url, options) => {
    calls++; assert.equal(url, Route.ROUTES[CPI].url);
    assert.deepEqual(Object.keys(options.headers), ["accept"]);
    assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "manual");
    return new Response(html, { headers: { "content-type": "text/html; charset=UTF-8" } });
  } });
  const result = await service.acquire({ sourceId: CPI });
  assert.equal(result.success, true); assert.equal(result.document.byteCount, Buffer.byteLength(html));
  assert.equal(calls, 1); assert.deepEqual(service.diagnostics(), { activeTasks: 0, activeTimers: 0, requestCount: 1 });
  assert.equal((await Parser.buildCandidate({ sourceId: CPI, acquisitionResult: result })).recordCount, 6);
  assert.equal(Route.ROUTES[CPI].maxBytes, 2000000);
});
test("redirect each hop revalidated, cross-source/downgrade rejected, max three", async () => {
  for (const location of ["http://www.e-stat.go.jp/", Route.ROUTES[LABOR].url, "https://evil.test/?secret=1"] ) {
    let calls = 0; const service = Route.createAcquirer({ fetchImpl: async () => { calls++;
      return new Response("", { status: 302, headers: { location } }); } });
    const result = await service.acquire({ sourceId: CPI });
    assert.equal(result.reason, "redirect_route_rejected"); assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes("secret"), false);
  }
  let calls = 0; const service = Route.createAcquirer({ fetchImpl: async () => { calls++;
    return new Response("", { status: 302, headers: { location: Route.ROUTES[CPI].url } }); } });
  assert.equal((await service.acquire({ sourceId: CPI })).reason, "redirect_hop_exceeded");
  assert.equal(calls, 4);
});
test("MIME/charset/invalid UTF-8 fail closed", async () => {
  for (const [body, contentType] of [["<html></html>", "application/json"], ["a", "text/html"],
    ["a", "text/html; charset=shift_jis"], [new Uint8Array([0xff]), "text/html; charset=UTF-8"],
    ['<meta charset="windows-1252">', "text/html; charset=UTF-8"]]) {
    const service = Route.createAcquirer({ fetchImpl: async () => new Response(body, { headers: { "content-type": contentType } }) });
    assert.equal((await service.acquire({ sourceId: CPI })).success, false);
  }
});
test("declared/actual bytes, truncation, request/body timeout bounded with cleanup", async () => {
  for (const [body, length, reason] of [["a", "bad", "content_length_invalid"],
    ["a", "2000001", "content_length_exceeded"], ["a", "2", "truncated_response"],
    [new Uint8Array(2000001), null, "body_size_exceeded"]]) {
    const service = Route.createAcquirer({ fetchImpl: async () => new Response(body, {
      headers: { "content-type": "text/html; charset=UTF-8", ...(length ? { "content-length": length } : {}) } }) });
    assert.equal((await service.acquire({ sourceId: CPI })).reason, reason);
    assert.equal(service.diagnostics().activeTasks, 0);
  }
  const service = Route.createAcquirer({ requestTimeoutMs: 5, fetchImpl: (_url, options) =>
    new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error(), { code: "request_timeout" })))) });
  assert.equal((await service.acquire({ sourceId: CPI })).reason, "request_timeout");
  assert.equal(service.diagnostics().activeTimers, 0);
  let cancelled = false;
  const bodyService = Route.createAcquirer({ bodyTimeoutMs: 5, fetchImpl: async () => new Response(
    new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "text/html; charset=UTF-8" } }) });
  assert.equal((await bodyService.acquire({ sourceId: CPI })).reason, "body_timeout");
  assert.equal(cancelled, true); assert.equal(bodyService.diagnostics().activeTasks, 0);
});
test("parser monthly mapping, nonmonthly classification and validated group inheritance", async () => {
  const rows = normal(); rows[1] = { ...rows[1] }; delete rows[1].group;
  rows.push({ group: "全国", title: "2026年平均", date: "2027-01-22" },
    { title: "2025年度平均", date: "2026-04-24" },
    { title: "2025年基準による指数 遡及結果及び接続指数（2025年1月分～2026年6月分）", date: "2026-08-07" },
    { title: "特別集計", date: "2026-09-01" });
  const result = await candidate(CPI, rows);
  assert.equal(result.recordCount, 6); assert.equal(result.classifiedRows.length, 10);
  assert.deepEqual(new Set(result.canonicalRecords.map(e => e.logical.edition)), new Set(["initial", "preliminary"]));
  assert.equal(result.canonicalRecords.every(e => e.acquisitionEvidence.sourceUrl === Route.ROUTES[CPI].url), true);
  assert.equal(result.canonicalRecords.every(e => e.source.sourcePublishedAt === null), true);
  const labor = await candidate(LABOR, [...normal(LABOR),
    { group: "2026年12月分", title: "基本集計（2026年10～12月期平均）", date: "2027-01-29" },
    { title: "詳細集計（2026年平均）", date: "2027-02-12" },
    { title: "別の公表資料", date: "2027-02-12" }]);
  assert.equal(labor.recordCount, 3); assert.equal(labor.classifiedRows.length, 6);
});
test("structure, heading inheritance boundaries and identity ambiguity fail closed", async () => {
  const html = F.page(CPI, normal());
  const variants = [html.replace("総務省", "別組織"), html.replace("消費者物価指数", "労働力調査"),
    html.replace("全国", "未知scope"), html.replace('<div class="detail_list_header">全国</div>', ""),
    html.replace('<div class="detail_list_title">', '<h3>別集計</h3><div class="detail_list_title">'),
    html.replace("</tr>", "</tr><section>unrelated</section>"), html.replace("</div></td>", "</td>"),
    html.replace("2026-12-01", "2026-02-30"), html.replace("&nbsp;08:30", "&nbsp;"),
    html.replace("2026年11月分", "2026年13月分")];
  for (const malformed of variants) assert.equal((await Parser.buildCandidate({ sourceId: CPI,
    acquisitionResult: acquisition(CPI, malformed) })).formalEligible, false);
  const inherited = [{ ...normal()[0] }, { ...normal()[1] }]; delete inherited[1].group;
  const boundary = F.page(CPI, inherited).replace("</tr>", "</tr></tbody><tbody>");
  assert.equal((await Parser.buildCandidate({ sourceId: CPI, acquisitionResult: acquisition(CPI, boundary) })).formalEligible, false);
  assert.equal((await candidate(CPI, [normal()[0], normal()[0]])).diagnostics[0], "duplicate_identity");
  const wrong = F.monthly(LABOR, "basic", "2026-12", "2027-01-29"); wrong.group = "2026年11月分";
  assert.equal((await candidate(LABOR, [wrong])).formalEligible, false);
});
test("sanitized candidate rejects forged acquisition and never contains raw body", async () => {
  const a = acquisition(CPI, F.page(CPI, normal())); a.document.contentSha256 = "0".repeat(64);
  assert.equal((await Parser.buildCandidate({ sourceId: CPI, acquisitionResult: a })).formalEligible, false);
  const b = acquisition(CPI, F.page(CPI, normal())); b.document.contentType = "application/json; charset=UTF-8";
  assert.equal((await Parser.buildCandidate({ sourceId: CPI, acquisitionResult: b })).formalEligible, false);
  const result = await candidate(CPI, normal());
  assert.doesNotMatch(JSON.stringify(result), /<html|parserInput|<table/);
  assert.equal(result.writerEnabled, false); assert.equal(result.productionActive, false);
});
test("existing XML overlapping months: semantic hash and event identity exact parity", async () => {
  for (const [sourceId, fixture, method] of [[CPI, "statCpiXmlFixture", "parseStatCpiXml"],
    [LABOR, "statLaborXmlFixture", "parseStatLaborXml"]]) {
    const legacy = Legacy[method](require(`./fixtures/marketCalendar/${fixture}.js`).xml, {
      sourceId, sourceUrl: Registry.getSource(sourceId).canonicalUrl, fetchedAt,
      parserId: Registry.getSource(sourceId).parserId, parserVersion: 1, rawContentHash: "a".repeat(64) });
    const rows = legacy.records.map(r => F.monthly(sourceId, r.scope, r.referencePeriod, r.sourceLocalSchedule.startDate));
    const result = await candidate(sourceId, rows);
    assert.equal(result.formalEligible, true);
    for (const record of legacy.records) {
      const old = (await Canonical.canonicalize(record)).event;
      const fresh = result.canonicalRecords.find(e => e.eventKey === old.eventKey);
      assert.equal(fresh.revisionKey, old.revisionKey); assert.equal(fresh.canonicalContentHash, old.canonicalContentHash);
      assert.notEqual(fresh.acquisitionEvidenceKey, old.acquisitionEvidenceKey);
    }
  }
});
test("A normal year turn: separate CPI lanes and inclusive 42 days", async () => {
  for (const sourceId of [CPI, LABOR]) {
    const result = await assess(normal(sourceId), sourceId);
    assert.equal(result.coverageState, "sufficient"); assert.equal(result.operationalRequiredThrough, "2027-01-30");
    assert.equal(result.absenceAuthority, "none"); assert.equal(Object.hasOwn(result, "confirmed"), false);
  }
});
test("B/D future short and G missing intermediate month never sufficient", async () => {
  for (const rows of [normal().filter(row => row.date < "2027-01-30"), normal().filter(row => row.date !== "2027-01-01")]) {
    const result = await assess(rows); assert.equal(result.coverageState, "partial");
    assert.equal(result.eligibleEventCount, rows.length);
  }
  assert.deepEqual((await assess(normal().filter(row => row.date !== "2027-01-01"))).laneAssessments[0].missingTargetMonths, ["2026-12"]);
});
test("C refreshed page: past disappearance leaves history untouched, unknown start boundary", async () => {
  const history = Object.freeze([{ eventKey: "previous-january-event", lifecycleStatus: "scheduled" }]);
  const before = JSON.stringify(history);
  const result = await assess(normal().filter(row => row.date >= "2027-01-01"));
  assert.equal(result.coverageState, "unknown"); assert.equal(JSON.stringify(history), before);
  assert.doesNotMatch(JSON.stringify(result), /cancelled|deleted|unobserved/);
});
test("E nonmonthly only: no empty Formal success or annual future bracket", async () => {
  const rows = [{ group: "全国", title: "2026年平均", date: "2027-01-22" },
    { group: "東京都区部（中旬速報値）", title: "2026年度平均", date: "2027-03-26" }];
  const result = await candidate(CPI, rows);
  assert.equal(result.formalEligible, false); assert.equal(result.candidateIdentity, null);
  assert.equal((await assess(rows)).coverageState, "partial");
});
test("F invalid parse / invalid date / duplicate rows remain invalid", async () => {
  assert.equal((await Coverage.assessCoverage({ sourceId: CPI, parserStatus: "invalid", classifiedRows: [], assessmentDateJst: day })).coverageState, "invalid");
  assert.equal((await assess(normal(), CPI, "2026-02-30")).coverageState, "invalid");
  const result = await candidate(CPI, normal());
  assert.equal((await Coverage.assessCoverage({ sourceId: CPI, parserStatus: "success", assessmentDateJst: day,
    classifiedRows: [...result.classifiedRows, result.classifiedRows[0]] })).coverageState, "invalid");
});
test("H one sufficient CPI lane cannot mask other lane shortfall", async () => {
  const result = await assess(normal().filter(row => !(row.group.includes("東京") && row.date === "2027-02-01")));
  assert.equal(result.coverageState, "partial");
  assert.equal(result.laneAssessments[0].coverageState, "sufficient");
});
test("I order and runtime timestamp invariant; J UI-independent; K coverage identity separated", async () => {
  const rows = normal(), first = await candidate(CPI, rows), second = await candidate(CPI, [...rows].reverse());
  assert.equal(first.candidateIdentity, second.candidateIdentity);
  const changed = normal(); changed[0].date = "2026-12-02";
  assert.notEqual((await candidate(CPI, changed)).candidateIdentity, first.candidateIdentity);
  const a = acquisition(CPI, F.page(CPI, rows), { fetchedAt: "2027-01-01T00:00:00Z" });
  assert.equal((await Parser.buildCandidate({ sourceId: CPI, acquisitionResult: a })).candidateIdentity, first.candidateIdentity);
  assert.deepEqual(await assess(rows), await assess([...rows].reverse()));
  const input = { sourceId: CPI, classifiedRows: first.classifiedRows, parserStatus: "success", assessmentDateJst: day };
  assert.deepEqual(await Coverage.assessCoverage({ ...input, selectedMonth: "2026-01" }),
    await Coverage.assessCoverage({ ...input, selectedMonth: "2028-12" }));
  const before = JSON.stringify(first.canonicalRecords);
  const c1 = await Coverage.assessCoverage(input), c2 = await Coverage.assessCoverage({ ...input, assessmentDateJst: "2027-02-01" });
  assert.notEqual(c1.coverageAssessmentIdentity, c2.coverageAssessmentIdentity);
  assert.equal(JSON.stringify(first.canonicalRecords), before);
});
test("renderer import graph cannot reach alternative route/parser; legacy policies unchanged", () => {
  const root = path.resolve(__dirname, ".."), visited = new Set();
  const visit = file => {
    if (visited.has(file)) return; visited.add(file);
    assert.doesNotMatch(file, /estat(Route|Parser|Coverage)\.js$/);
    const code = fs.readFileSync(file, "utf8");
    for (const match of code.matchAll(/require\(["'](\.[^"']+)["']\)/g)) {
      const next = path.resolve(path.dirname(file), match[1]);
      visit(path.extname(next) ? next : next + ".js");
    }
    if (file.endsWith("index.html")) for (const match of code.matchAll(/<script[^>]*src=["']([^"']+)["']/g))
      if (!match[1].startsWith("http")) visit(path.resolve(root, match[1]));
  };
  // D2d3-Labor authorizes the main-only Labor path. Its source/network gate is covered by
  // marketCalendarLaborProduction.test.js; renderer and legacy acquisition stay isolated.
  for (const file of ["preload.js", "index.html", "js/marketCalendarRuntime/updatePolicy.js"]) visit(path.join(root, file));
  const policy = require("../js/marketCalendarRuntime/calendarNetworkPolicy.js");
  for (const sourceId of [CPI, LABOR]) {
    assert.match(Registry.getSource(sourceId).canonicalUrl, /^https:\/\/www\.stat\.go\.jp\//);
    assert.equal(Registry.validateSourceUrl(sourceId, Route.ROUTES[sourceId].url).valid, false);
    assert.equal(policy.validateUrl(sourceId, policy.getPolicy(sourceId).documents[0], Route.ROUTES[sourceId].url).valid, false);
  }
  for (const name of ["estatRoute", "estatParser", "estatCoverage"]) assert.doesNotMatch(
    fs.readFileSync(path.join(root, `js/marketCalendarIsolated/${name}.js`), "utf8"),
    /require\([^)]*(?:History|storage|RuntimeState)|localStorage|indexedDB|writeFile/);
  const context = { window: { document: {} } };
  const vm = require("node:vm");
  for (const file of ["sourceContract", "marketEventCanonicalizer"]) vm.runInNewContext(
    fs.readFileSync(path.join(root, `js/marketCalendar/${file}.js`), "utf8"), context);
  assert.equal(context.window.OptionMapMarketEventCanonicalizer.createCanonicalizer, undefined);
  assert.equal(context.window.OptionMapMarketEventSourceContract.createSourceContract, undefined);
});
