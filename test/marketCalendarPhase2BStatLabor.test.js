"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Parsers = require("../js/marketCalendarShadow/representativeParsers.js");
const Adapters = require("../js/marketCalendarShadow/representativeAdapters.js");
const Shadow = require("../js/marketCalendarShadow/shadowAcquisition.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Fixture = require("./fixtures/marketCalendar/statLaborXmlFixture.js");

const fetchedAt = "2026-09-15T00:00:00.000Z", hash = "a".repeat(64);
function context() { const source = Registry.getSource("jp-stat-labor"); return { sourceId: source.sourceId,
    sourceUrl: "https://www.stat.go.jp/data/kouhyou/e-stat_roudou.xml", fetchedAt,
    parserId: source.parserId, parserVersion: source.parserVersion, rawContentHash: hash }; }
function response(sourceId, url, bytes, options = {}) { return { status: "success", reason: null, sourceId,
    requestId: options.requestId || "request-1", requestedUrl: url, finalUrl: url, startedAt: fetchedAt,
    fetchedAt: options.fetchedAt || fetchedAt, httpStatus: 200, redirects: [], contentType:
        options.contentType || "application/xml", contentHash: hash, bytes }; }
const fetcher = options => (sourceId, url) => Promise.resolve(url.endsWith(".xml") ? response(sourceId, url,
    Fixture.utf16le(), options) : response(sourceId, url, new TextEncoder().encode("landing"),
        { ...options, contentType: "text/html" }));

test("Labor contractは全角・半角月を基本集計月次reference periodへ正規化", () => {
    const parsed = Parsers.parseStatLaborXml(Fixture.xml, context());
    assert.deepEqual(parsed.records.map(value => value.referencePeriod), ["2026-01", "2026-03", "2026-12"]);
    assert.equal(parsed.records.every(value => value.eventType === "JP_LABOR_FORCE" &&
        value.edition === "initial" && value.scope === "national"), true);
});

test("四半期・年・年度・詳細集計を理由付きinformational exclusionにする", () => {
    const parsed = Parsers.parseStatLaborXml(Fixture.xml, context());
    assert.deepEqual(parsed.exclusions.map(value => value.reason), ["basic_quarterly_average",
        "basic_fiscal_year_average", "detailed_quarterly_average", "basic_calendar_year_average",
        "detailed_calendar_year_average"]);
    assert.deepEqual(parsed.diagnostics, []);
});

test("月次基本集計は複数指標を分割せず公式release単位のlogical event", async () => {
    const record = Parsers.parseStatLaborXml(Fixture.xml, context()).records[0], event =
        (await Canonicalizer.canonicalize(record)).event;
    assert.equal(event.eventKey,
        "JP|JP_STATISTICS_BUREAU|JP_LABOR_FORCE|2026-01|initial|national");
    assert.equal(event.title.ja, "労働力調査（基本集計・月次）");
});

test("unknown hierarchy・ambiguous period・malformed日時はfail-closed", () => {
    const unknown = Parsers.parseStatLaborXml(Fixture.xml.replace("基本集計（2026年１月分）",
        "未知集計（2026年１月分）"), context());
    assert.match(unknown.diagnostics.join(" "), /labor_unknown_release_kind/);
    const ambiguous = Parsers.parseStatLaborXml(Fixture.xml.replace("基本集計（2026年１月分）",
        "基本集計（2026年２月分）"), context());
    assert.match(ambiguous.diagnostics.join(" "), /labor_ambiguous_period/);
    const malformed = Parsers.parseStatLaborXml(Fixture.xml.replace("<release_hour>8</release_hour>",
        "<release_hour></release_hour>"), context());
    assert.match(malformed.diagnostics.join(" "), /labor_monthly_release_incomplete/);
});

test("jp-stat-labor shadowは月次だけをFormal canonical setへ昇格", async () => {
    const source = (await Shadow.create({ adapters: [Adapters.createStatLabor()], fetcher: fetcher(),
        runId: "run-1" }).run()).sources[0];
    assert.equal(source.encoding.ok, true); assert.equal(source.parserStatus, "success");
    assert.equal(source.canonicalizationStatus, "success"); assert.equal(source.eventCount, 3);
    assert.deepEqual(source.eventTypes, { JP_LABOR_FORCE: 3 });
    assert.equal(source.timezoneResolution, "success"); assert.equal(source.duplicates, 0);
    assert.equal(source.identityCollisions, 0); assert.equal(source.formalEligible, true);
    assert.equal(source.exclusions.length, 5);
    assert.equal(source.formalCanonicalSet[0].source.requestId, "request-1");
    assert.equal(source.formalCanonicalSet[0].source.runId, "run-1");
    assert.equal(source.formalCanonicalSet[0].source.httpMetadata.httpStatus, 200);
});

test("jp-stat-labor連続取得はrevision安定・acquisition evidence更新", async () => {
    const adapter = Adapters.createStatLabor(), first = (await Shadow.create({ adapters: [adapter],
        fetcher: fetcher(), runId: "run-1" }).run()).sources[0], previous = { [adapter.sourceId]: {
            rawContentSetHash: first.rawContentSetHash, semanticSetHash: first.semanticSetHash } }, second =
        (await Shadow.create({ adapters: [adapter], fetcher: fetcher({ requestId: "request-2",
            fetchedAt: "2026-09-15T00:01:00.000Z" }), previousObservations: previous,
            runId: "run-2" }).run()).sources[0];
    assert.equal(second.semanticSetHash, first.semanticSetHash);
    assert.notEqual(second.acquisitionEvidenceSetHash, first.acquisitionEvidenceSetHash);
    assert.equal(second.semanticChange, "unchanged"); assert.equal(second.duplicates, 0);
    assert.equal(second.identityCollisions, 0);
});
