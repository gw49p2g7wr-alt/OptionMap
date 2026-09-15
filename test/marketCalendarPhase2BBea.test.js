"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Parsers = require("../js/marketCalendarShadow/representativeParsers.js");
const Adapters = require("../js/marketCalendarShadow/representativeAdapters.js");
const Shadow = require("../js/marketCalendarShadow/shadowAcquisition.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Fixtures = require("./fixtures/marketCalendar/beaCalendarFixtures.js");
const fetchedAt = "2026-09-15T00:00:00.000Z", hash = "a".repeat(64), encoder = new TextEncoder();
function context() { const source = Registry.getSource("us-bea-calendar"); return { sourceId: source.sourceId,
    sourceUrl: source.canonicalUrl, fetchedAt, parserId: source.parserId,
    parserVersion: source.parserVersion, rawContentHash: hash }; }
function response(sourceId, url, body, options = {}) { return { status: "success", reason: null, sourceId,
    requestId: options.requestId || "request-1", requestedUrl: url, finalUrl: url, startedAt: fetchedAt,
    fetchedAt: options.fetchedAt || fetchedAt, httpStatus: 200, redirects: [], contentType:
        url.endsWith(".json") ? "application/json" : "text/html", contentHash:
        options.contentHash || hash, bytes: encoder.encode(body) }; }
const fetcher = options => (sourceId, url) => Promise.resolve(response(sourceId, url,
    url.endsWith(".json") ? Fixtures.json : Fixtures.html, options));

test("BEA JSONをschedule authority、HTMLをrelease semanticsとして固定", () => {
    const source = Registry.getSource("us-bea-calendar");
    assert.equal(source.canonicalUrl, "https://apps.bea.gov/API/signup/release_dates.json");
    assert.deepEqual(source.allowedHosts, ["apps.bea.gov", "www.bea.gov"]);
    assert.equal(Registry.validateSourceUrl(source.sourceId, source.endpointRoles.scheduleAuthority).valid, true);
    assert.equal(Registry.validateSourceUrl(source.sourceId, source.endpointRoles.releaseSemantics).valid, true);
    assert.equal(Registry.validateSourceUrl(source.sourceId, "https://example.com/release_dates.json").valid, false);
});

test("GDP三editionを同じquarterの別identityにしstate・county GDPは混入させない", () => {
    const parsed = Parsers.parseBea(Fixtures.json, Fixtures.html, context()), q3 = parsed.records
        .filter(value => value.eventType === "US_GDP" && value.referencePeriod === "2026-Q3");
    assert.deepEqual(q3.map(value => value.edition), ["advance_estimate", "second_estimate", "third_estimate"]);
    assert.equal(parsed.records.filter(value => value.eventType === "US_GDP").length, 4);
    assert.equal(parsed.records.some(value => /by State|by County/.test(value.sourceTitle)), false);
});

test("Personal Income and Outlays packageを月ごとにUS_PCE一件へ写像", () => {
    const parsed = Parsers.parseBea(Fixtures.json, Fixtures.html, context()), pce = parsed.records
        .filter(value => value.eventType === "US_PCE");
    assert.deepEqual(pce.map(value => value.referencePeriod), ["2026-08", "2026-09", "2026-10", "2026-11"]);
    assert.equal(pce.every(value => value.releaseKind === "monthly_personal_income_and_outlays_package" &&
        value.titleJa === "米PCE"), true);
    assert.match(parsed.exclusions.map(value => value.reason).join(" "), /non_monthly_pio_release/);
});

test("JSON schema・日時・HTML照合不一致はfail-closed", () => {
    assert.match(Parsers.parseBea("not-json", Fixtures.html, context()).diagnostics.join(" "), /json_invalid/);
    const moved = Fixtures.json.replace("2026-10-29T12:30:00+00:00", "2026-10-30T12:30:00+00:00");
    assert.match(Parsers.parseBea(moved, Fixtures.html, context()).diagnostics.join(" "), /schedule_mismatch/);
});

test("BEA rescheduleは同一logical eventの新revision、欠落・TBAは状態を推測しない", async () => {
    assert.deepEqual(Parsers.BEA_REVISION_CONTRACT, { movedTimestamp: "same_logical_event_new_revision",
        omittedFromJson: "not_formalized_status_unknown", htmlTba: "not_formalized_status_unknown",
        restoredTimestamp: "same_logical_event_new_revision" });
    const original = Parsers.parseBea(Fixtures.json, Fixtures.html, context()).records.find(value =>
        value.eventType === "US_GDP" && value.referencePeriod === "2026-Q3" &&
        value.edition === "advance_estimate"), movedJson = Fixtures.json.replace(
            "2026-10-29T12:30:00+00:00", "2026-10-30T12:30:00+00:00"), movedHtml =
            Fixtures.html.replace("October 29", "October 30"), moved = Parsers.parseBea(movedJson,
                movedHtml, context()).records.find(value => value.eventType === "US_GDP" &&
                    value.referencePeriod === "2026-Q3" && value.edition === "advance_estimate"),
        first = (await Canonicalizer.canonicalize(original)).event,
        second = (await Canonicalizer.canonicalize(moved)).event;
    assert.equal(first.eventKey, second.eventKey); assert.notEqual(first.revisionKey, second.revisionKey);
    const omitted = Parsers.parseBea(Fixtures.json.replace(
        '"2026-10-29T12:30:00+00:00",', ""), Fixtures.html, context());
    assert.equal(omitted.records.some(value => value.authorityEventId === original.authorityEventId), false);
    assert.match(omitted.diagnostics.join(" "), /schedule_mismatch/);
});

test("BEA shadowはJSON優先でcanonicalizeしDSTをET wall timeへ解決", async () => {
    const source = (await Shadow.create({ adapters: [Adapters.createBea()], fetcher: fetcher(),
        runId: "run-1" }).run()).sources[0];
    assert.deepEqual([source.fetchStatus, source.parserStatus, source.canonicalizationStatus,
        source.timezoneResolution, source.duplicates, source.identityCollisions, source.formalEligible],
    ["success", "success", "success", "success", 0, 0, true]);
    assert.equal(source.eventCount, 8);
    assert.equal(source.formalCanonicalSet.every(value => value.schedule.sourceLocal.timeZone ===
        "America/New_York" && value.schedule.sourceLocal.startTime === "08:30"), true);
    const q3 = source.formalCanonicalSet.filter(value => value.logical.eventType === "US_GDP" &&
        value.logical.referencePeriod === "2026-Q3");
    assert.equal(new Set(q3.map(value => value.eventKey)).size, 3);
});

test("BEA再取得はsemantic revision安定・acquisition evidence更新", async () => {
    const adapter = Adapters.createBea(), first = (await Shadow.create({ adapters: [adapter],
        fetcher: fetcher(), runId: "run-1" }).run()).sources[0], previous = { [adapter.sourceId]: {
            rawContentSetHash: first.rawContentSetHash, semanticSetHash: first.semanticSetHash } }, second =
        (await Shadow.create({ adapters: [adapter], fetcher: fetcher({ requestId: "request-2",
            fetchedAt: "2026-09-15T00:01:00.000Z" }), previousObservations: previous,
            runId: "run-2" }).run()).sources[0];
    assert.equal(second.semanticSetHash, first.semanticSetHash);
    assert.notEqual(second.acquisitionEvidenceSetHash, first.acquisitionEvidenceSetHash);
    assert.equal(second.changeClassification, "raw_unchanged");
});
