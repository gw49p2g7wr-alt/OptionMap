"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const XLSX = require("xlsx");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Fetch = require("../js/marketCalendarShadow/readOnlyFetch.js");
const Parsers = require("../js/marketCalendarShadow/representativeParsers.js");
const Adapters = require("../js/marketCalendarShadow/representativeAdapters.js");
const Shadow = require("../js/marketCalendarShadow/shadowAcquisition.js");

const encoder = new TextEncoder(), hash = "a".repeat(64), fetchedAt = "2026-09-15T00:00:00.000Z";
const BOJ = '<h2 id="p02">次回</h2><p>2026年9月17日（木）、18日（金）</p>' +
    '<h2 id="p03">会見</h2><p>2026年9月18日（金）15:30～（ライブ配信予定）</p>';
const FED = '<a id="x">2026 FOMC Meetings</a><div class="row fomc-meeting">' +
    '<div class="fomc-meeting__month"><strong>September</strong></div>' +
    '<div class="fomc-meeting__date">15-16*</div></div><div class="panel-footer">end</div>';
const BLS = fs.readFileSync(path.join(__dirname, "fixtures/marketCalendar/blsMonthlyCalendar.html"), "utf8");
const JPX = '<a href="/derivatives/rules/last-trading-day/files/2026_indexfutures_options_1_j.xlsx">Excel</a>';
function workbookBytes() { const workbook = XLSX.utils.book_new(), sheet = XLSX.utils.aoa_to_sheet([
    ["商品", "限月取引", "9桁コード", "限月コード", "取引最終日", "権利行使日"],
    ["日経225オプション", "2026年9月限月", "-", "-", "2026/09/10 (aaa)", "2026/09/11 (aaa)"]]);
    XLSX.utils.book_append_sheet(workbook, sheet, "2026"); return XLSX.write(workbook,
        { type: "buffer", bookType: "xlsx" }); }
const htmlBySource = { "jp-boj-calendar": BOJ, "us-bls-calendar": BLS,
    "us-fed-fomc-calendar": FED, "jp-jpx-derivatives-calendar": JPX };
function response(sourceId, url, body, overrides = {}) { return Object.freeze({ status: "success", reason: null,
    sourceId, requestedUrl: url, finalUrl: url, startedAt: fetchedAt, fetchedAt, httpStatus: 200,
    redirects: Object.freeze([]), contentType: "text/html", contentHash: hash,
    bytes: body instanceof Uint8Array ? body : encoder.encode(body), ...overrides }); }
function fixtureFetcher(sourceId, url) { const child = url.endsWith(".xlsx"); return Promise.resolve(response(sourceId,
    url, child ? workbookBytes() : htmlBySource[sourceId], child ? { contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } : {})); }

test("代表parserはBOJ・BLS・Fed・JPXのeventをsource contract形へ抽出", () => {
    const context = sourceId => { const source = Registry.getSource(sourceId); return { sourceId,
        sourceUrl: source.canonicalUrl, fetchedAt, parserId: source.parserId, parserVersion: 1,
        rawContentHash: hash }; };
    assert.deepEqual(Parsers.parseBoj(BOJ, context("jp-boj-calendar")).records.map(x => x.eventType),
        ["BOJ_MPM", "BOJ_POLICY_DECISION", "BOJ_GOVERNOR_PRESS_CONFERENCE"]);
    assert.deepEqual(Parsers.parseBls(BLS, context("us-bls-calendar")).records.map(x => x.eventType),
        ["US_JOLTS", "US_EMPLOYMENT_SITUATION", "US_PPI", "US_CPI"]);
    assert.equal(Parsers.parseFed(FED, context("us-fed-fomc-calendar")).records.length, 3);
    const rows = XLSX.utils.sheet_to_json(XLSX.read(workbookBytes()).Sheets["2026"], { header: 1, raw: false });
    assert.deepEqual(Parsers.parseJpxWorkbook(rows, context("jp-jpx-derivatives-calendar"))
        .records.map(x => x.eventType), ["JPX_NIKKEI225_LAST_TRADING_DAY", "JPX_NIKKEI225_MAJOR_SQ"]);
});

test("representative shadowはfetch/hash/parser/canonical/identity/timezoneを診断", async () => {
    const result = await Shadow.create({ adapters: Adapters.create({ XLSX }), fetcher: fixtureFetcher }).run();
    assert.equal(result.sources.length, 4); assert.equal(result.storageWrite, false);
    for (const source of result.sources) { assert.equal(source.fetchStatus, "success", source.sourceId);
        assert.equal(source.parserStatus, "success", source.sourceId);
        assert.equal(source.canonicalizationStatus, "success", source.sourceId);
        assert.equal(source.timezoneResolution, "success", source.sourceId);
        assert.equal(source.duplicates, 0); assert.equal(source.identityCollisions, 0);
        assert.equal(source.formalEligible, true, `${source.sourceId}:${source.diagnostics}`);
        assert.equal(source.formalCanonicalSet.length, source.eventCount); }
});

test("partial/failureはFormal canonical setへ昇格せず補完しない", async () => {
    const adapters = Adapters.create({ XLSX }), fetcher = async (sourceId, url) => sourceId === "us-bls-calendar"
        ? response(sourceId, url, "forbidden", { status: "failure", reason: "http_status_rejected",
            httpStatus: 403 }) : fixtureFetcher(sourceId, url);
    const result = await Shadow.create({ adapters, fetcher }).run(), bls =
        result.sources.find(source => source.sourceId === "us-bls-calendar");
    assert.deepEqual([bls.fetchStatus, bls.parserStatus, bls.canonicalizationStatus,
        bls.eventCount, bls.formalEligible, bls.formalCanonicalSet.length],
    ["failure", "failure", "failure", 0, false, 0]);
    assert.match(bls.diagnostics.join(" "), /http_status_rejected/);
});

test("duplicate・identity collisionを明示する", async () => {
    const source = Registry.getSource("us-bls-calendar"), baseAdapter = Adapters.create({ XLSX })
        .find(value => value.sourceId === source.sourceId), duplicateAdapter = { sourceId: source.sourceId,
            async acquire(input) { const value = await baseAdapter.acquire(input); return { ...value,
                records: [...value.records, value.records[0]] }; } };
    const duplicate = (await Shadow.create({ adapters: [duplicateAdapter], fetcher: fixtureFetcher }).run()).sources[0];
    assert.equal(duplicate.duplicates, 1);
    assert.equal(duplicate.formalEligible, false); assert.equal(duplicate.formalCanonicalSet.length, 0);
    const changed = { ...duplicateAdapter, async acquire(input) { const value = await baseAdapter.acquire(input),
        moved = structuredClone(value.records[0]); moved.sourceLocalSchedule.startDate = "2026-09-12";
        return { ...value, records: [...value.records, moved] }; } };
    const collision = (await Shadow.create({ adapters: [changed], fetcher: fixtureFetcher }).run()).sources[0];
    assert.equal(collision.identityCollisions, 1); assert.equal(collision.formalEligible, false);
});

test("semantic revisionは取得証跡から独立し、予定の意味の変更だけで変化", async () => {
    const context = { sourceId: "us-bls-calendar", sourceUrl: Registry.getSource("us-bls-calendar").canonicalUrl,
        fetchedAt, parserId: "bls-release-calendar", parserVersion: 1, rawContentHash: hash },
        base = Parsers.parseBls(BLS, context).records[3], first = (await require("../js/marketCalendar/marketEventCanonicalizer.js")
            .canonicalize(base)).event,
        refetched = (await require("../js/marketCalendar/marketEventCanonicalizer.js").canonicalize({ ...base,
            fetchedAt: "2026-09-15T00:01:00.000Z", rawContentHash: "b".repeat(64), requestId: "request-2",
            runId: "run-2", httpMetadata: { httpStatus: 200 } })).event;
    assert.equal(first.revisionKey, refetched.revisionKey);
    assert.notEqual(first.acquisitionEvidenceKey, refetched.acquisitionEvidenceKey);
    for (const changed of [
        { sourceLocalSchedule: { ...base.sourceLocalSchedule, startTime: "09:30" } },
        { sourceLocalSchedule: { ...base.sourceLocalSchedule, startDate: "2026-09-12" } },
        { sourceStatus: "cancelled" }, { sourceStatus: "postponed" }
    ]) assert.notEqual((await require("../js/marketCalendar/marketEventCanonicalizer.js")
        .canonicalize({ ...base, ...changed })).event.revisionKey, first.revisionKey);
});

test("raw変化とparsed semantic変化を別diagnosticに分類", async () => {
    const adapter = Adapters.create({ XLSX }).find(value => value.sourceId === "us-bls-calendar"),
        first = (await Shadow.create({ adapters: [adapter], fetcher: fixtureFetcher, runId: "run-1" }).run()).sources[0],
        previous = { [adapter.sourceId]: { rawContentSetHash: first.rawContentSetHash,
            semanticSetHash: first.semanticSetHash } }, changedRawFetcher = (sourceId, url) => Promise.resolve(response(
                sourceId, url, BLS, { contentHash: "b".repeat(64), fetchedAt: "2026-09-15T00:01:00.000Z" })),
        rawOnly = (await Shadow.create({ adapters: [adapter], fetcher: changedRawFetcher,
            previousObservations: previous, runId: "run-2" }).run()).sources[0],
        unchanged = (await Shadow.create({ adapters: [adapter], fetcher: fixtureFetcher,
            previousObservations: previous, runId: "run-3" }).run()).sources[0];
    assert.deepEqual([rawOnly.rawChange, rawOnly.semanticChange, rawOnly.changeClassification],
        ["changed", "unchanged", "raw_changed_parsed_semantic_unchanged"]);
    assert.equal(rawOnly.semanticSetHash, first.semanticSetHash);
    assert.deepEqual([unchanged.rawChange, unchanged.semanticChange, unchanged.changeClassification],
        ["unchanged", "unchanged", "raw_unchanged"]);
    const movedAdapter = { sourceId: adapter.sourceId, async acquire(input) { const value = await adapter.acquire(input),
        records = value.records.map((record, index) => index ? record : { ...record, sourceLocalSchedule:
            { ...record.sourceLocalSchedule, startDate: "2026-09-02" } }); return { ...value, records }; } },
        semantic = (await Shadow.create({ adapters: [movedAdapter], fetcher: fixtureFetcher,
            previousObservations: previous, runId: "run-4" }).run()).sources[0];
    assert.deepEqual([semantic.rawChange, semantic.semanticChange, semantic.changeClassification],
        ["unchanged", "changed", "parsed_semantic_changed"]);
});

test("BLS recognized releaseのmalformed scheduleはfail-closed", () => {
    const malformed = '<h1>September 2026</h1><table><td id="d0911"><p class="day">11</p>' +
        '<p><strong>Consumer Price Index<br></strong>August 2026<br>TBD</p></td></table>',
        source = Registry.getSource("us-bls-calendar"), parsed = Parsers.parseBls(malformed, {
            sourceId: source.sourceId, sourceUrl: source.canonicalUrl, fetchedAt,
            parserId: source.parserId, parserVersion: 1, rawContentHash: hash });
    assert.equal(parsed.records.length, 0);
    assert.deepEqual(parsed.diagnostics, ["bls_release_incomplete:US_CPI"]);
});

test("read-only fetchはallowlist外redirectを拒否しcontent hashを返す", async () => {
    const source = Registry.getSource("us-bls-calendar"); let accept = null;
    const ok = await Fetch.acquire(source.sourceId,
        source.canonicalUrl, { fetchImpl: async (url, options) => { accept = options.headers.accept; return {
            status: 200, ok: true, url, headers: new Headers({ "content-type": "text/html" }),
            arrayBuffer: async () => encoder.encode("body").buffer }; } });
    assert.match(accept, /application\/json/);
    assert.match(ok.contentHash, /^[0-9a-f]{64}$/); assert.equal(ok.status, "success");
    const blocked = await Fetch.acquire(source.sourceId, source.canonicalUrl, { fetchImpl: async () => ({
        status: 302, ok: false, url: source.canonicalUrl,
        headers: new Headers({ location: "https://example.com/" }) }) });
    assert.deepEqual([blocked.status, blocked.reason], ["failure", "redirect_not_allowed"]);
});

test("Phase 2はproduction storage・UI・Time Travel・scheduler・notification・OverallV2に非接続", () => {
    const root = path.resolve(__dirname, ".."), files = fs.readdirSync(path.join(root,
        "js/marketCalendarShadow")).map(file => path.join(root, "js/marketCalendarShadow", file));
    const source = files.map(file => fs.readFileSync(file, "utf8")).join("\n"), html =
        fs.readFileSync(path.join(root, "index.html"), "utf8");
    assert.doesNotMatch(source, /indexedDB|localStorage|sessionStorage|setItem|objectStore/);
    assert.doesNotMatch(source, /document\.(?:get|query|create)|getElementById|setInterval|setTimeout|Notification/);
    assert.doesNotMatch(source, /require\([^)]*(?:qriTimeTravel|overallJudgmentV2)|OptionMapOverallV2/);
    assert.doesNotMatch(html, /marketCalendarShadow/);
});
