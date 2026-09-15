"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Parsers = require("../js/marketCalendarShadow/representativeParsers.js");
const Adapters = require("../js/marketCalendarShadow/representativeAdapters.js");
const Shadow = require("../js/marketCalendarShadow/shadowAcquisition.js");
const Fixture = require("./fixtures/marketCalendar/jpxMarketHolidaysFixture.js");
const fetchedAt = "2026-09-15T00:00:00.000Z", hash = "a".repeat(64);
function context() { const source = Registry.getSource("jp-jpx-market-holidays"); return { sourceId:
    source.sourceId, sourceUrl: source.canonicalUrl, fetchedAt, parserId: source.parserId,
    parserVersion: source.parserVersion, rawContentHash: hash }; }
function response(options = {}) { const source = Registry.getSource("jp-jpx-market-holidays"); return {
    status: "success", reason: null, sourceId: source.sourceId, requestId: options.requestId || "request-1",
    requestedUrl: source.canonicalUrl, finalUrl: source.canonicalUrl, startedAt: fetchedAt,
    fetchedAt: options.fetchedAt || fetchedAt, httpStatus: 200, redirects: [], contentType: "text/html",
    contentHash: hash, bytes: Fixture.bytes }; }
const fetcher = options => () => Promise.resolve(response(options));

test("JPX公式休業日掲載行だけをall-day eventとして抽出", () => {
    const parsed = Parsers.parseJpxMarketHolidays(Fixture.html, context());
    assert.deepEqual(parsed.records.map(value => [value.referencePeriod, value.sourceTitle]), [
        ["2026-01-01", "元日"], ["2026-01-02", "休業日"], ["2026-09-22", "休日※"],
        ["2026-12-31", "休業日"], ["2027-01-01", "元日"]]);
    assert.equal(parsed.records.every(value => value.eventType === "JPX_MARKET_HOLIDAY" &&
        value.edition === "regular" && value.sourceLocalSchedule.kind === "all_day" &&
        value.sourceLocalSchedule.startTime === null), true);
});

test("休業日section・行構造の欠損はfail-closed", () => {
    assert.match(Parsers.parseJpxMarketHolidays("<html></html>", context()).diagnostics.join(" "),
        /section_not_found/);
    assert.match(Parsers.parseJpxMarketHolidays('<h2 id="heading_7">休業日一覧</h2>', context())
        .diagnostics.join(" "), /rows_not_found/);
});

test("JPX holiday shadowはUTF-8を確定しcanonicalize", async () => {
    const source = (await Shadow.create({ adapters: [Adapters.createJpxMarketHolidays()],
        fetcher: fetcher(), runId: "run-1" }).run()).sources[0];
    assert.deepEqual([source.fetchStatus, source.parserStatus, source.canonicalizationStatus,
        source.timezoneResolution, source.duplicates, source.identityCollisions, source.formalEligible],
    ["success", "success", "success", "success", 0, 0, true]);
    assert.equal(source.eventCount, 5); assert.equal(source.encoding.evidence.resolvedEncoding, "utf-8");
    assert.equal(source.formalCanonicalSet.every(value => value.schedule.canonicalStart === null &&
        value.schedule.sourceLocal.timeZone === "Asia/Tokyo"), true);
});

test("JPX holiday再取得はsemantic安定・acquisition evidence更新", async () => {
    const adapter = Adapters.createJpxMarketHolidays(), first = (await Shadow.create({ adapters: [adapter],
        fetcher: fetcher(), runId: "run-1" }).run()).sources[0], previous = { [adapter.sourceId]: {
            rawContentSetHash: first.rawContentSetHash, semanticSetHash: first.semanticSetHash } }, second =
        (await Shadow.create({ adapters: [adapter], fetcher: fetcher({ requestId: "request-2",
            fetchedAt: "2026-09-15T00:01:00.000Z" }), previousObservations: previous,
            runId: "run-2" }).run()).sources[0];
    assert.equal(second.semanticSetHash, first.semanticSetHash);
    assert.notEqual(second.acquisitionEvidenceSetHash, first.acquisitionEvidenceSetHash);
    assert.equal(second.changeClassification, "raw_unchanged");
});
