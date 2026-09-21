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
const machineryContext = () => context("jp-esri-machinery-orders-calendar");
const parseMachinery = html => Parsers.parseEsriMachineryOrders(html, machineryContext());
async function machineryShadow(html) { return (await Shadow.create({ adapters: [
    Adapters.createEsriMachineryOrders()], fetcher: (sourceId, url) => Promise.resolve(
        response(sourceId, url, html)), runId: "machinery-boundary-test" }).run()).sources[0]; }

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

test("現行公式形式の機械受注4件を月次Formalとして抽出", async () => {
    const html = Fixtures.machinery.replace("12月16日<br>(10月分)",
        "令和9年 1月18日<br>(11月分)").replace("11月19日<br>(9月分)",
            "12月16日<br>(10月分)").replace("10月15日<br>(8月分)",
                "11月19日<br>(9月分)").replace("令和8年 9月16日<br>(7月分)",
                    "令和8年10月15日<br>(8月分)");
    const result = await machineryShadow(html);
    assert.equal(result.formalEligible, true); assert.equal(result.eventCount, 4);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.formalCanonicalSet.map(value => value.logical.referencePeriod),
        ["2026-08", "2026-09", "2026-10", "2026-11"]);
    assert.equal(result.formalCanonicalSet.every(value => value.logical.edition === "initial" &&
        value.logical.scope === "national" && value.schedule.sourceLocal.timeZone === "Asia/Tokyo" &&
        value.schedule.sourceLocal.startTime === "08:50"), true);
});

test("機械受注のrecognized monthly rowは必須field異常をexclusionへ落とさない", async () => {
    const original = "11月19日<br>(9月分)", variants = [
        ["malformed_release_date", "11月??日<br>(9月分)"],
        ["missing_release_date", "<br>(9月分)"],
        ["missing_release_and_period", "未定"],
        ["missing_reference_period", "11月19日"],
        ["malformed_reference_period", "11月19日<br>(9月??分)"],
        ["invalid_release_date", "11月32日<br>(9月分)"] ];
    for (const [name, replacement] of variants) {
        const html = Fixtures.machinery.replace(original, replacement), parsed = parseMachinery(html),
            result = await machineryShadow(html);
        assert.notEqual(html, Fixtures.machinery, name);
        assert.equal(parsed.records.length, 3, name);
        assert.match(parsed.diagnostics.join(" "), /esri_machinery_monthly_row_(?:incomplete|invalid)/, name);
        assert.deepEqual(parsed.exclusions, [], name);
        assert.equal(result.formalEligible, false, name);
        assert.deepEqual(result.formalCanonicalSet, [], name);
    }
});

test("機械受注の公表時刻が不明ならFormal化せず対象外cellは分離", async () => {
    const noTime = Fixtures.machinery.replace("8:50公表", "時刻未定"), result =
        await machineryShadow(noTime);
    assert.equal(result.formalEligible, false);
    assert.match(result.diagnostics.join(" "), /release_time_unresolved/);
    assert.deepEqual(result.formalCanonicalSet, []);
    const changedTime = await machineryShadow(Fixtures.machinery.replace("8:50公表", "9:00公表"));
    assert.equal(changedTime.formalEligible, false);
    assert.match(changedTime.diagnostics.join(" "), /release_time_unresolved/);
    const outside = Fixtures.machinery.replace("11月19日<br>(9月分)",
        "令和8年12月10日<br>(10-12月期)"), parsed = parseMachinery(outside);
    assert.equal(parsed.records.length, 3);
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(parsed.exclusions.length, 1);
    assert.equal(parsed.exclusions[0].reason, "non_monthly_or_empty_machinery_cell");
    const empty = parseMachinery(Fixtures.machinery.replace("11月19日<br>(9月分)", "&nbsp;"));
    assert.equal(empty.records.length, 3);
    assert.deepEqual(empty.diagnostics, []);
    assert.equal(empty.exclusions.length, 1);
    const missingCell = parseMachinery(Fixtures.machinery.replace(
        "<td>11月19日<br>(9月分)</td>", ""));
    assert.match(missingCell.diagnostics.join(" "), /cell_missing/);
    assert.deepEqual(missingCell.exclusions, []);
});

test("機械受注のduplicateと同一identity異revisionをFormal拒否", async () => {
    const extra = value => Fixtures.machinery.replace("<tr><td>11月 9日",
        `<tr><td>対象外</td><td>対象外</td><td>${value}</td><td>対象外</td></tr>` +
            "<tr><td>11月 9日");
    const duplicate = await machineryShadow(extra("10月15日<br>(8月分)"));
    assert.equal(duplicate.duplicates, 1);
    assert.equal(duplicate.formalEligible, false);
    const collision = await machineryShadow(extra("10月16日<br>(8月分)"));
    assert.equal(collision.identityCollisions, 1);
    assert.equal(collision.formalEligible, false);
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
