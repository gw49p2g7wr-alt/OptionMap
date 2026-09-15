"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Taxonomy = require("../js/marketCalendar/eventTaxonomy.js");
const Policy = require("../js/marketCalendar/authorityPolicy.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const Parser = require("../js/marketCalendar/parserContract.js");
const Diagnostics = require("../js/marketCalendar/adapterDiagnostics.js");
const Fixtures = require("./fixtures/marketCalendar/sourceFixtures.js");

test("Phase 0A taxonomyの全event typeに一次authorityがある", () => {
    assert.deepEqual(Object.keys(Taxonomy.EVENT_TYPES).sort(),
        Object.keys(Policy.FORMAL_SOURCE_BY_EVENT_TYPE).sort());
    for (const [eventType, sourceId] of Object.entries(Policy.FORMAL_SOURCE_BY_EVENT_TYPE)) {
        const source = Registry.getSource(sourceId);
        assert.equal(source.authorityLevel, "primary", eventType);
        assert.equal(source.formalEligible, true, eventType);
    }
    assert.equal(Policy.FALLBACK_MODE, "none");
});

test("Phase 0B registryは公式HTTPS hostとIANA timezoneを固定", () => {
    assert.equal(Object.keys(Registry.SOURCES).length, 13);
    for (const source of Object.values(Registry.SOURCES)) {
        assert.equal(Registry.validateSourceUrl(source.sourceId, source.canonicalUrl).valid, true);
        assert.equal(Registry.validateSourceUrl(source.sourceId, "https://example.com/calendar").valid, false);
        assert.doesNotThrow(() => new Intl.DateTimeFormat("en", { timeZone: source.sourceTimeZone }));
    }
});

test("Phase 0C fixture parserは初期βの全sourceを受理", () => {
    assert.deepEqual(Fixtures.allSources.map(value => value.sourceId).sort(),
        Object.keys(Registry.SOURCES).sort());
    for (const fixture of Fixtures.allSources) {
        const parsed = Parser.parseFixtureDocument(fixture);
        assert.equal(parsed.status, "success", `${fixture.sourceId}: ${parsed.diagnostics}`);
        const eligibility = Policy.evaluateFormalEligibility(parsed.records[0],
            Registry.getSource(fixture.sourceId));
        assert.equal(eligibility.eligible, true, fixture.sourceId);
    }
});

test("Phase 0C fixturesはDST・時刻未定・all-day・date-range・変更・malformedを含む", () => {
    for (const name of ["dstSummer", "dstWinter", "timeUndecided", "allDay", "dateRange", "rescheduled"])
        assert.equal(Parser.parseFixtureDocument(Fixtures.variants[name]).status, "success", name);
    const malformed = Parser.parseFixtureDocument(Fixtures.variants.malformed);
    assert.equal(malformed.status, "rejected");
    assert.match(malformed.diagnostics.join(" "), /start_date_invalid|start_time_invalid/);
});

test("Phase 0D adapter diagnosticsはredirect・HTTP・parser診断をfail-closedにする", () => {
    const source = Registry.getSource("us-bls-calendar"), base = { sourceId: source.sourceId,
        requestedUrl: source.canonicalUrl, finalUrl: source.canonicalUrl, httpStatus: 200,
        adapterVersion: 1, records: [{}], diagnostics: [] };
    assert.deepEqual(Diagnostics.evaluateFetchEnvelope(base).status, "success");
    assert.equal(Diagnostics.evaluateFetchEnvelope({ ...base, finalUrl: "https://example.com/" }).status,
        "rejected");
    assert.equal(Diagnostics.evaluateFetchEnvelope({ ...base, diagnostics: ["record_0:invalid"] }).status,
        "partial");
    assert.equal(Diagnostics.evaluateFetchEnvelope({ ...base, httpStatus: 500 }).formalReady, false);
});

test("非一次sourceとAI/web検索由来recordはFormal authorityにならない", () => {
    const record = { sourceId: "ai-web-search", eventType: "US_CPI" };
    assert.equal(Policy.evaluateFormalEligibility(record, null).eligible, false);
    assert.equal(Policy.evaluateFormalEligibility({ sourceId: "us-bea-calendar", eventType: "US_CPI" },
        Registry.getSource("us-bea-calendar")).eligible, false);
});
