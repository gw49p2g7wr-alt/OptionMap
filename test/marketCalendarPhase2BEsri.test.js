"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Parsers = require("../js/marketCalendarShadow/representativeParsers.js");
const Adapters = require("../js/marketCalendarShadow/representativeAdapters.js");
const Shadow = require("../js/marketCalendarShadow/shadowAcquisition.js");
const Fixtures = require("./fixtures/marketCalendar/esriCalendarFixtures.js");
const fetchedAt = "2026-09-15T00:00:00.000Z", hash = "a".repeat(64), encoder = new TextEncoder();
function context(sourceId) { const source = Registry.getSource(sourceId); return { sourceId, sourceUrl:
    source.canonicalUrl, fetchedAt, parserId: source.parserId, parserVersion: source.parserVersion,
    rawContentHash: hash }; }
function response(sourceId, url, body, options = {}) { return { status: "success", reason: null, sourceId,
    requestId: options.requestId || "request-1", requestedUrl: url, finalUrl: url, startedAt: fetchedAt,
    fetchedAt: options.fetchedAt || fetchedAt, httpStatus: 200, redirects: [], contentType: "text/html",
    contentHash: hash, bytes: encoder.encode(body) }; }
const fetcher = options => (sourceId, url) => Promise.resolve(response(sourceId, url,
    sourceId === "jp-esri-sna-calendar" ? Fixtures.sna : Fixtures.machinery, options));

test("ESRI source identityを機械受注とSNAへ分割しauthorityは共通", () => {
    const machinery = Registry.getSource("jp-esri-machinery-orders-calendar"),
        sna = Registry.getSource("jp-esri-sna-calendar");
    assert.equal(machinery.authority, "JP_ESRI"); assert.equal(sna.authority, "JP_ESRI");
    assert.notEqual(machinery.sourceId, sna.sourceId); assert.notEqual(machinery.canonicalUrl, sna.canonicalUrl);
    assert.equal(Registry.getSource("jp-esri-calendar"), null);
});

test("機械受注は専用列の月次releaseだけを08:50で抽出", () => {
    const parsed = Parsers.parseEsriMachineryOrders(Fixtures.machinery,
        context("jp-esri-machinery-orders-calendar"));
    assert.deepEqual(parsed.records.map(value => value.referencePeriod),
        ["2026-07", "2026-08", "2026-09", "2026-10"]);
    assert.equal(parsed.records.every(value => value.eventType === "JP_MACHINERY_ORDERS" &&
        value.edition === "initial" && value.sourceLocalSchedule.startTime === "08:50"), true);
    assert.deepEqual(parsed.diagnostics, []);
});

test("GDP 1次・2次速報は同一reference periodの異なるedition", () => {
    const parsed = Parsers.parseEsriSna(Fixtures.sna, context("jp-esri-sna-calendar"));
    assert.deepEqual(parsed.records.map(value => [value.referencePeriod, value.edition]), [
        ["2026-Q3", "first_preliminary"], ["2026-Q3", "second_preliminary"],
        ["2026-Q4", "first_preliminary"], ["2026-Q4", "second_preliminary"]]);
    assert.equal(parsed.records.every(value => value.eventType === "JP_GDP" &&
        value.sourceLocalSchedule.startTime === "08:50"), true);
});

test("ESRI unknown構造・GDP日時欠損はfail-closed", () => {
    assert.match(Parsers.parseEsriMachineryOrders("<html></html>",
        context("jp-esri-machinery-orders-calendar")).diagnostics.join(" "), /table_not_found/);
    const malformed = Parsers.parseEsriSna(Fixtures.sna.replace("8時50分", "未定"),
        context("jp-esri-sna-calendar"));
    assert.match(malformed.diagnostics.join(" "), /gdp_row_incomplete/);
});

test("ESRI両shadowはcanonical/timezone/identityが衝突せずFormal化", async () => {
    const sources = (await Shadow.create({ adapters: [Adapters.createEsriMachineryOrders(),
        Adapters.createEsriSna()], fetcher: fetcher(), runId: "run-1" }).run()).sources;
    assert.deepEqual(sources.map(value => value.eventCount), [4, 4]);
    for (const source of sources) { assert.equal(source.fetchStatus, "success");
        assert.equal(source.parserStatus, "success"); assert.equal(source.canonicalizationStatus, "success");
        assert.equal(source.timezoneResolution, "success"); assert.equal(source.duplicates, 0);
        assert.equal(source.identityCollisions, 0); assert.equal(source.formalEligible, true); }
    const gdp = sources[1].formalCanonicalSet.filter(value => value.logical.referencePeriod === "2026-Q3");
    assert.notEqual(gdp[0].eventKey, gdp[1].eventKey);
});

test("ESRI両sourceの再取得はsemantic安定・evidence更新", async () => {
    const adapters = [Adapters.createEsriMachineryOrders(), Adapters.createEsriSna()], first =
        await Shadow.create({ adapters, fetcher: fetcher(), runId: "run-1" }).run(), previous =
        Object.fromEntries(first.sources.map(source => [source.sourceId, { rawContentSetHash:
            source.rawContentSetHash, semanticSetHash: source.semanticSetHash }])), second = await Shadow.create({
                adapters, fetcher: fetcher({ requestId: "request-2", fetchedAt:
                    "2026-09-15T00:01:00.000Z" }), previousObservations: previous, runId: "run-2" }).run();
    for (let index = 0; index < first.sources.length; index += 1) {
        assert.equal(second.sources[index].semanticSetHash, first.sources[index].semanticSetHash);
        assert.notEqual(second.sources[index].acquisitionEvidenceSetHash,
            first.sources[index].acquisitionEvidenceSetHash);
        assert.equal(second.sources[index].semanticChange, "unchanged"); }
});
