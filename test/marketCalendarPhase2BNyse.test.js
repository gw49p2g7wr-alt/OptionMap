"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Parsers = require("../js/marketCalendarShadow/representativeParsers.js");
const Adapters = require("../js/marketCalendarShadow/representativeAdapters.js");
const Shadow = require("../js/marketCalendarShadow/shadowAcquisition.js");
const Schedule = require("../js/marketCalendar/marketEventSchedule.js");
const Fixture = require("./fixtures/marketCalendar/nyseMarketHolidaysFixture.js");
const fetchedAt = "2026-09-15T00:00:00.000Z", hash = "b".repeat(64);
function context() { const source = Registry.getSource("us-nyse-market-holidays"); return { sourceId:
    source.sourceId, sourceUrl: source.canonicalUrl, fetchedAt, parserId: source.parserId,
    parserVersion: source.parserVersion, rawContentHash: hash }; }
function response(options = {}) { const source = Registry.getSource("us-nyse-market-holidays"); return {
    status: "success", reason: null, sourceId: source.sourceId, requestId: options.requestId || "request-1",
    requestedUrl: source.canonicalUrl, finalUrl: source.canonicalUrl, startedAt: fetchedAt,
    fetchedAt: options.fetchedAt || fetchedAt, httpStatus: 200, redirects: [],
    contentType: "text/html; charset=utf-8", contentHash: hash, bytes: Fixture.bytes }; }
const fetcher = options => () => Promise.resolve(response(options));

test("NYSE現行endpointと旧endpointの同一host置換理由を固定", () => {
    const source = Registry.getSource("us-nyse-market-holidays");
    assert.equal(source.canonicalUrl, "https://www.nyse.com/trade/hours-calendars");
    assert.deepEqual(source.endpointHistory, [{ url: "https://www.nyse.com/markets/hours-calendars",
        status: "replaced", replacement: source.canonicalUrl,
        reason: "official_same_host_redirect_to_trade_hours_calendars" }]);
    assert.equal(Registry.validateSourceUrl(source.sourceId, source.canonicalUrl).valid, true);
});

test("完全休場とcash equities短縮取引を別event/scheduleとして抽出", () => {
    const parsed = Parsers.parseNyseMarketHolidays(Fixture.html, context()), holidays = parsed.records
        .filter(value => value.eventType === "US_NYSE_MARKET_HOLIDAY"), closes = parsed.records
        .filter(value => value.eventType === "US_NYSE_EARLY_CLOSE");
    assert.equal(holidays.length, 8); assert.equal(closes.length, 4);
    assert.equal(holidays.every(value => value.scope === "nyse_cash_equities" &&
        value.sourceLocalSchedule.kind === "all_day" && value.sourceLocalSchedule.startTime === null), true);
    assert.equal(closes.every(value => value.scope === "nyse_cash_equities" &&
        value.sourceLocalSchedule.kind === "instant" && value.sourceLocalSchedule.startTime === "13:00" &&
        value.sourceLocalSchedule.timeZone === "America/New_York"), true);
    assert.equal(new Set(parsed.records.map(value => value.authorityEventId)).size, parsed.records.length);
    assert.equal(parsed.exclusions.some(value => value.reason === "different_market_scope_nyse_options"), true);
});

test("NYSE authority構造・Eastern Time表記の欠損はfail-closed", () => {
    assert.match(Parsers.parseNyseMarketHolidays("<html></html>", context()).diagnostics.join(" "),
        /authority_heading_not_found/);
    const ambiguous = Fixture.html.replace(/ All times are Eastern Time\./g, "");
    assert.match(Parsers.parseNyseMarketHolidays(ambiguous, context()).diagnostics.join(" "),
        /timezone_missing/);
});

test("NYSE shadowはDSTとJST日付跨ぎを解決しcanonicalize", async () => {
    const source = (await Shadow.create({ adapters: [Adapters.createNyseMarketHolidays()],
        fetcher: fetcher(), runId: "run-1" }).run()).sources[0];
    assert.deepEqual([source.fetchStatus, source.parserStatus, source.canonicalizationStatus,
        source.timezoneResolution, source.duplicates, source.identityCollisions, source.formalEligible],
    ["success", "success", "success", "success", 0, 0, true]);
    assert.deepEqual(source.eventTypes, { US_NYSE_MARKET_HOLIDAY: 8, US_NYSE_EARLY_CLOSE: 4 });
    const july = source.formalCanonicalSet.find(value => value.logical.eventType === "US_NYSE_EARLY_CLOSE" &&
        value.logical.referencePeriod === "2028-07-03"), november = source.formalCanonicalSet.find(value =>
        value.logical.eventType === "US_NYSE_EARLY_CLOSE" && value.logical.referencePeriod === "2026-11-27");
    assert.deepEqual([july.schedule.sourceLocal.resolvedOffset, july.schedule.canonicalStart],
        ["-04:00", "2028-07-03T17:00:00.000Z"]);
    assert.deepEqual([november.schedule.sourceLocal.resolvedOffset, november.schedule.canonicalStart],
        ["-05:00", "2026-11-27T18:00:00.000Z"]);
    assert.deepEqual([Schedule.calendarDateFor(july.schedule), Schedule.calendarDateFor(november.schedule)],
        ["2028-07-04", "2026-11-28"]);
});

test("NYSE再取得はsemantic安定・acquisition evidence更新", async () => {
    const adapter = Adapters.createNyseMarketHolidays(), first = (await Shadow.create({ adapters: [adapter],
        fetcher: fetcher(), runId: "run-1" }).run()).sources[0], previous = { [adapter.sourceId]: {
            rawContentSetHash: first.rawContentSetHash, semanticSetHash: first.semanticSetHash } }, second =
        (await Shadow.create({ adapters: [adapter], fetcher: fetcher({ requestId: "request-2",
            fetchedAt: "2026-09-15T00:01:00.000Z" }), previousObservations: previous,
            runId: "run-2" }).run()).sources[0];
    assert.equal(second.semanticSetHash, first.semanticSetHash);
    assert.notEqual(second.acquisitionEvidenceSetHash, first.acquisitionEvidenceSetHash);
    assert.equal(second.changeClassification, "raw_unchanged");
});
