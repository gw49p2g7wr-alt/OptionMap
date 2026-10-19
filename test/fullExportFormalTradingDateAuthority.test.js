const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const authority = require("../js/fullExportFormalTradingDateAuthority.js");
const freshness = require("../js/fullExportFreshness.js");

function holiday(date, overrides = {}) {
    return { sourceId: authority.SOURCE_ID, validTo: null, calendarDateStart: date,
        calendarDateEnd: date, logical: { eventType: authority.EVENT_TYPE,
            scope: authority.SCOPE, referencePeriod: date }, ...overrides };
}
const result = (...events) => ({ status: "available", events });

test("F1 normal weekday resolves current formal trading date", () => {
    const value = authority.resolveFromCalendar({ observedAt: "2026-10-15T07:46:11+09:00",
        calendarResult: result(holiday("2026-01-01")) });
    assert.equal(value.status, "available");
    assert.equal(value.formalTradingDate, "2026-10-15");
    assert.equal(value.previousValidTradingDate, "2026-10-14");
    assert.equal(value.nextValidTradingDate, "2026-10-16");
    assert.equal(value.relation, "current_trading_day");
});

test("F2 older QRI remains stale against independent expected date", () => {
    const adapter = freshness.createFullExportFreshnessAdapter({
        getMarketSession: () => ({ formalTradingDate: "2026-10-15" }),
        getQriFormalIdentity: () => ({ status: "available", fact: { identityVerified: true,
            acquisitionVerified: true, usingFallback: false, referenceOnly: false, origin: "live",
            tradingDate: "2026-10-14", pageUpdatedAt: "2026-10-14T07:30:00+09:00",
            fetchedAt: "2026-10-14T07:31:00+09:00", contract: "2026-11",
            canonicalSignature: "signature" } }),
        getFetchState: () => ({ status: "success", fetchedAt: "2026-10-14T07:31:00+09:00" }) });
    const value = adapter.getSectionFreshness("qriOptions");
    assert.equal(value.status, "stale");
    assert.equal(value.reason, "source_not_updated");
});

test("F3 unavailable formal date preserves date_unverifiable fail-closed", () => {
    const value = authority.resolveFromCalendar({ observedAt: "2026-10-15T07:46:11+09:00",
        calendarResult: { status: "unavailable", events: [] } });
    assert.equal(value.status, "unavailable");
    assert.equal(value.formalTradingDate, null);
});

test("F4/F5 Full Export wiring uses formal authority independently of Morning V4 state", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const wiring = html.slice(html.indexOf("window.OptionMapFullExportUi.configure"),
        html.indexOf("const qriOptionsHistoryPersistence"));
    assert.match(wiring, /OptionMapFullExportFormalTradingDateAuthority[\s\S]*?\.resolve\(/);
    assert.match(wiring, /getMarketSession:\s*\(\)\s*=>\s*freshnessSession/);
    assert.match(wiring, /getMarketSession:\s*\(\)\s*=>\s*session\s*\?/);
    assert.doesNotMatch(wiring, /createFullExportFreshnessAdapter\(\{[\s\S]*?getMarketSession:\s*\(\)\s*=>\s*session,/);
});

test("F6 weekend and accepted JPX holiday resolve by existing calendar semantics", () => {
    const weekend = authority.resolveFromCalendar({ observedAt: "2026-10-17T12:00:00+09:00",
        calendarResult: result(holiday("2026-01-01")) });
    assert.equal(weekend.formalTradingDate, "2026-10-16");
    assert.equal(weekend.calendarStatus, "weekend");
    const monday = authority.resolveFromCalendar({ observedAt: "2026-10-19T12:00:00+09:00",
        calendarResult: result(holiday("2026-01-01")) });
    assert.equal(monday.formalTradingDate, "2026-10-19");
    assert.equal(monday.relation, "current_trading_day");
    assert.notEqual(weekend.formalTradingDate, monday.formalTradingDate);
    const closed = authority.resolveFromCalendar({ observedAt: "2026-10-12T12:00:00+09:00",
        calendarResult: result(holiday("2026-01-01"), holiday("2026-10-12")) });
    assert.equal(closed.formalTradingDate, "2026-10-09");
    assert.equal(closed.calendarStatus, "jpx_holiday");
});

test("malformed or absent exact JPX holiday authority fails closed", () => {
    assert.equal(authority.resolveFromCalendar({ observedAt: "2026-10-15T07:46:11+09:00",
        calendarResult: result() }).status, "unavailable");
    assert.equal(authority.resolveFromCalendar({ observedAt: "2026-10-15T07:46:11+09:00",
        calendarResult: result(holiday("2026-01-01", { logical: { eventType: authority.EVENT_TYPE,
            scope: "JPX_derivatives", referencePeriod: "2026-01-01" } })) }).status, "unavailable");
});

test("adjacent year without Formal Calendar coverage fails closed", () => {
    const value = authority.resolveFromCalendar({ observedAt: "2026-12-31T17:00:00+09:00",
        calendarResult: result(holiday("2026-01-01"), holiday("2026-12-31")) });
    assert.equal(value.status, "unavailable");
    assert.equal(value.reason, "adjacent_trading_date_resolution_exhausted");
});

test("resolver performs one bounded readonly Calendar query", async () => {
    const calls = [];
    const value = await authority.resolve({ observedAt: "2026-10-15T07:46:11+09:00",
        indexedDB: {}, keyRange: {}, query: async input => { calls.push(input);
            return result(holiday("2026-01-01")); } });
    assert.equal(value.formalTradingDate, "2026-10-15");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].startDate, "2025-01-01");
    assert.equal(calls[0].endDate, "2027-12-31");
});

test("next valid trading date uses the same formal weekend and holiday authority", () => {
    const friday = authority.resolveFromCalendar({ observedAt: "2026-10-16T17:00:00+09:00",
        calendarResult: result(holiday("2026-01-01"), holiday("2026-10-19"),
            holiday("2026-10-20")) });
    assert.equal(friday.formalTradingDate, "2026-10-16");
    assert.equal(friday.previousValidTradingDate, "2026-10-15");
    assert.equal(friday.nextValidTradingDate, "2026-10-21");
    const yearEnd = authority.resolveFromCalendar({ observedAt: "2026-12-30T17:00:00+09:00",
        calendarResult: result(holiday("2026-01-01"), holiday("2026-12-31"),
            holiday("2027-01-01")) });
    assert.equal(yearEnd.nextValidTradingDate, "2027-01-04");
});

test("module has no write, network, Morning, QRI, or freshness policy authority", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/fullExportFormalTradingDateAuthority.js"), "utf8");
    assert.doesNotMatch(source, /readwrite|\.put\s*\(|\.delete\s*\(|\bfetch\s*\(|Morning|evaluateDailyFreshness|getQriFormalIdentity/);
});
