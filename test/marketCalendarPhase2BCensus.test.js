"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Encoding = require("../js/marketCalendarShadow/htmlEncoding.js");
const Parsers = require("../js/marketCalendarShadow/representativeParsers.js");
const Adapters = require("../js/marketCalendarShadow/representativeAdapters.js");
const Shadow = require("../js/marketCalendarShadow/shadowAcquisition.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Fixture = require("./fixtures/marketCalendar/censusCalendarFixture.js");
const fetchedAt = "2026-09-15T00:00:00.000Z", hash = "a".repeat(64);
function context() { const source = Registry.getSource("us-census-calendar"); return { sourceId: source.sourceId,
    sourceUrl: source.canonicalUrl, fetchedAt, parserId: source.parserId,
    parserVersion: source.parserVersion, rawContentHash: hash }; }
function response(options = {}) { const source = Registry.getSource("us-census-calendar"); return {
    status: "success", reason: null, sourceId: source.sourceId, requestId: options.requestId || "request-1",
    requestedUrl: source.canonicalUrl, finalUrl: source.canonicalUrl, startedAt: fetchedAt,
    fetchedAt: options.fetchedAt || fetchedAt, httpStatus: 200, redirects: [],
    contentType: "text/html;charset=UTF-8", contentHash: hash, bytes: Fixture.bytes }; }
const fetcher = options => () => Promise.resolve(response(options));

test("WHATWG順序でBOM・HTTP・1024-byte metaを決定し全evidenceを保持", () => {
    const decoded = Encoding.decodeHtml(Fixture.bytes, "text/html;charset=UTF-8");
    assert.equal(decoded.ok, true); assert.equal(decoded.encoding, "utf-8");
    assert.deepEqual(decoded.evidence, { httpCharset: "UTF-8", bom: null, html5MetaCharset: "utf-8",
        legacyMetaCharset: "iso-8859-1", resolvedEncoding: "utf-8", resolutionPolicyVersion: 1 });
    assert.deepEqual(decoded.warnings, ["encoding_declaration_conflict_resolved_by_higher_precedence"]);
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("<p>ok</p>")]);
    assert.equal(Encoding.decodeHtml(bom, "text/html;charset=iso-8859-1").encoding, "utf-8");
});

test("encoding不明・unsupported HTTP・strict decode failureはfail-closed", () => {
    assert.equal(Encoding.decodeHtml(new TextEncoder().encode("<p>x</p>"), "text/html").reason,
        "encoding_not_determined");
    assert.equal(Encoding.decodeHtml(Fixture.bytes, "text/html;charset=shift_jis").reason,
        "http_charset_unsupported");
    assert.equal(Encoding.decodeHtml(new Uint8Array([0xc3, 0x28]), "text/html;charset=utf-8").reason,
        "decode_failed");
});

test("Retail Sales通常月次だけをallowlistしreference periodと08:30 ETを抽出", () => {
    const parsed = Parsers.parseCensus(Fixture.html, context());
    assert.deepEqual(parsed.records.map(value => [value.eventType, value.referencePeriod,
        value.edition, value.sourceLocalSchedule.startTime]), [
        ["US_RETAIL_SALES", "2026-08", "advance", "08:30"],
        ["US_RETAIL_SALES", "2026-09", "advance", "08:30"]]);
    assert.equal(parsed.records.every(value => value.releaseKind === "advance_monthly_retail_sales"), true);
    assert.equal(parsed.exclusions.length, 2); assert.deepEqual(parsed.diagnostics, []);
});

test("Retail Sales recognized rowの欠損はfail-closed", () => {
    const parsed = Parsers.parseCensus(Fixture.html.replace("September 16, 2026", "TBA"), context());
    assert.match(parsed.diagnostics.join(" "), /retail_sales_row_incomplete/);
});

test("Census shadowはencoding evidenceを保持してFormal canonicalize", async () => {
    const source = (await Shadow.create({ adapters: [Adapters.createCensus()], fetcher: fetcher(),
        runId: "run-1" }).run()).sources[0];
    assert.deepEqual([source.fetchStatus, source.parserStatus, source.canonicalizationStatus,
        source.timezoneResolution, source.duplicates, source.identityCollisions, source.formalEligible],
    ["success", "success", "success", "success", 0, 0, true]);
    assert.equal(source.eventCount, 2); assert.equal(source.encoding.evidence.resolvedEncoding, "utf-8");
    assert.equal(source.formalCanonicalSet[0].acquisitionEvidence.httpMetadata.encodingEvidence
        .legacyMetaCharset, "iso-8859-1");
});

test("Census再取得はsemantic安定・acquisition evidence更新", async () => {
    const adapter = Adapters.createCensus(), first = (await Shadow.create({ adapters: [adapter],
        fetcher: fetcher(), runId: "run-1" }).run()).sources[0], previous = { [adapter.sourceId]: {
            rawContentSetHash: first.rawContentSetHash, semanticSetHash: first.semanticSetHash } }, second =
        (await Shadow.create({ adapters: [adapter], fetcher: fetcher({ requestId: "request-2",
            fetchedAt: "2026-09-15T00:01:00.000Z" }), previousObservations: previous,
            runId: "run-2" }).run()).sources[0];
    assert.equal(second.semanticSetHash, first.semanticSetHash);
    assert.notEqual(second.acquisitionEvidenceSetHash, first.acquisitionEvidenceSetHash);
    assert.equal(second.changeClassification, "raw_unchanged");
});
