"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Encoding = require("../js/marketCalendarShadow/xmlEncoding.js");
const Parsers = require("../js/marketCalendarShadow/representativeParsers.js");
const Adapters = require("../js/marketCalendarShadow/representativeAdapters.js");
const Shadow = require("../js/marketCalendarShadow/shadowAcquisition.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Fixture = require("./fixtures/marketCalendar/statCpiXmlFixture.js");

const fetchedAt = "2026-09-15T00:00:00.000Z", hashA = "a".repeat(64), hashB = "b".repeat(64);
function response(sourceId, url, bytes, options = {}) { return { status: "success", reason: null,
    sourceId, requestId: options.requestId || "request-1", requestedUrl: url, finalUrl: url,
    startedAt: fetchedAt, fetchedAt: options.fetchedAt || fetchedAt, httpStatus: 200, redirects: [],
    contentType: options.contentType || "application/xml", contentHash: options.contentHash || hashA, bytes }; }
function fetcher(options = {}) { return (sourceId, url) => Promise.resolve(url.endsWith(".xml")
    ? response(sourceId, url, Fixture.utf16le(), options) : response(sourceId, url,
        new TextEncoder().encode("<html>official CPI landing</html>"), { ...options, contentType: "text/html" })); }
function context() { const source = Registry.getSource("jp-stat-cpi"); return { sourceId: source.sourceId,
    sourceUrl: "https://www.stat.go.jp/data/kouhyou/e-stat_cpi.xml", fetchedAt,
    parserId: source.parserId, parserVersion: source.parserVersion, rawContentHash: hashA }; }

test("UTF-16 XMLはHTTP・BOM・declaration一致時だけ明示decode", () => {
    const decoded = Encoding.decodeUtf16Xml(Fixture.utf16le(), "application/xml; charset=UTF-16");
    assert.equal(decoded.ok, true); assert.equal(decoded.encoding, "utf-16le");
    assert.match(decoded.text, /東京都区部（中旬速報値）/);
    assert.deepEqual(decoded.evidence, { mediaType: "application/xml", httpCharset: "utf-16",
        bomEncoding: "utf-16le",
        xmlCharset: "utf-16" });
});

test("encoding不明・矛盾・decode failureはUTF-8 fallbackせずfail-closed", () => {
    assert.equal(Encoding.decodeUtf16Xml(Fixture.utf16le(Fixture.xml, false), "application/xml").reason,
        "encoding_bom_missing");
    assert.equal(Encoding.decodeUtf16Xml(Fixture.utf16le(), "application/xml; charset=UTF-8").reason,
        "encoding_http_bom_conflict");
    assert.equal(Encoding.decodeUtf16Xml(Fixture.utf16le(), "text/html; charset=UTF-16").reason,
        "encoding_content_type_not_xml");
    assert.equal(Encoding.decodeUtf16Xml(Fixture.utf16le(Fixture.xml.replace("UTF-16", "UTF-8")),
        "application/xml").reason, "encoding_xml_bom_conflict");
    assert.equal(Encoding.decodeUtf16Xml(new Uint8Array([0xff, 0xfe, 0x3c]), "application/xml").reason,
        "encoding_decode_failed");
});

test("全国・東京都区部の月次だけを別event identityへ抽出", async () => {
    const parsed = Parsers.parseStatCpiXml(Fixture.xml, context());
    assert.deepEqual(parsed.records.map(record => [record.eventType, record.referencePeriod,
        record.edition, record.scope]), [["JP_NATIONAL_CPI", "2026-08", "initial", "national"],
        ["JP_TOKYO_CPI", "2026-08", "preliminary", "tokyo"]]);
    assert.deepEqual(parsed.exclusions.map(value => value.reason), ["calendar_year_average",
        "fiscal_year_average", "benchmark_or_retrospective", "special_release"]);
    const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js"), events = [];
    for (const record of parsed.records) events.push((await Canonicalizer.canonicalize(record)).event);
    assert.equal(events[0].eventKey,
        "JP|JP_STATISTICS_BUREAU|JP_NATIONAL_CPI|2026-08|initial|national");
    assert.equal(events[1].eventKey,
        "JP|JP_STATISTICS_BUREAU|JP_TOKYO_CPI|2026-08|preliminary|tokyo");
    assert.notEqual(events[0].eventKey, events[1].eventKey);
});

test("unknown scopeとmalformed hierarchyはdiagnosticでFormal候補を拒否", () => {
    const unknown = Parsers.parseStatCpiXml(Fixture.xml.replace("全国", "未知地域"), context());
    assert.match(unknown.diagnostics.join(" "), /cpi_unknown_scope:未知地域/);
    const malformed = Parsers.parseStatCpiXml('<?xml version="1.0"?><class_1 name="全国"></class_1>',
        context());
    assert.deepEqual(malformed.diagnostics, ["cpi_scope_hierarchy_malformed:全国"]);
});

test("jp-stat-cpi shadowは除外理由を保持し月次2件だけFormal化", async () => {
    const result = await Shadow.create({ adapters: [Adapters.createStatCpi()], fetcher: fetcher(),
        runId: "run-1" }).run(), source = result.sources[0];
    assert.equal(source.fetchStatus, "success"); assert.equal(source.encoding.ok, true);
    assert.equal(source.parserStatus, "success"); assert.equal(source.canonicalizationStatus, "success");
    assert.deepEqual(source.eventTypes, { JP_NATIONAL_CPI: 1, JP_TOKYO_CPI: 1 });
    assert.equal(source.timezoneResolution, "success"); assert.equal(source.duplicates, 0);
    assert.equal(source.identityCollisions, 0); assert.equal(source.formalEligible, true);
    assert.equal(source.formalCanonicalSet.length, 2); assert.equal(source.exclusions.length, 4);
    assert.equal(source.formalCanonicalSet[0].source.requestId, "request-1");
    assert.equal(source.formalCanonicalSet[0].source.runId, "run-1");
});

test("jp-stat-cpi再取得はsemantic revision安定・acquisition evidence更新", async () => {
    const adapter = Adapters.createStatCpi(), first = (await Shadow.create({ adapters: [adapter],
        fetcher: fetcher(), runId: "run-1" }).run()).sources[0], previous = { [adapter.sourceId]: {
            rawContentSetHash: first.rawContentSetHash, semanticSetHash: first.semanticSetHash } },
        second = (await Shadow.create({ adapters: [adapter], fetcher: fetcher({ requestId: "request-2",
            fetchedAt: "2026-09-15T00:01:00.000Z" }), previousObservations: previous,
            runId: "run-2" }).run()).sources[0];
    assert.equal(second.semanticChange, "unchanged"); assert.equal(second.rawChange, "unchanged");
    assert.equal(second.changeClassification, "raw_unchanged");
    assert.equal(second.semanticSetHash, first.semanticSetHash);
    assert.notEqual(second.acquisitionEvidenceSetHash, first.acquisitionEvidenceSetHash);
    assert.deepEqual(second.formalCanonicalSet.map(event => event.revisionKey),
        first.formalCanonicalSet.map(event => event.revisionKey));
});

test("jp-stat-cpi encoding failureはFormal setへ昇格しない", async () => {
    const badFetcher = (sourceId, url) => Promise.resolve(url.endsWith(".xml") ? response(sourceId, url,
        new TextEncoder().encode(Fixture.xml), { contentType: "application/xml" })
        : response(sourceId, url, new TextEncoder().encode("landing"), { contentType: "text/html" })),
        source = (await Shadow.create({ adapters: [Adapters.createStatCpi()], fetcher: badFetcher }).run()).sources[0];
    assert.equal(source.parserStatus, "failure"); assert.equal(source.formalEligible, false);
    assert.equal(source.formalCanonicalSet.length, 0);
    assert.match(source.diagnostics.join(" "), /encoding_bom_missing/);
});
