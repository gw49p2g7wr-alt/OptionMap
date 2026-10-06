"use strict";

// Offline G1 parser facts, converted explicitly to the typed application contract.
const Parser = require("../../../js/marketCalendarIsolated/mofJgbParser.js");
const Canonical = require("../../../js/marketCalendar/marketEventCanonicalizer.js");
const G1 = require("./mofJgbFixture.js");
const SOURCE_ID = "jp-mof-jgb-auction-calendar";
const URL = "https://www.mof.go.jp/jgbs/auction/calendar/2610.htm";
function isolated(overrides = {}) {
    const parsed = Parser.parseMonth(G1.current, { sourceUrl: URL, fetchedAt: "2026-10-07T00:00:00.000Z",
        rawContentHash: "a".repeat(64) });
    if (!parsed.ok) throw Error("registration_fixture_invalid");
    return { ...parsed.records.find(r => r.maturity === "10Y"), ...overrides };
}
function typed(overrides = {}) {
    return { ...Canonical.toTypedJgbRecord(isolated()), ...overrides };
}
module.exports = Object.freeze({ SOURCE_ID, URL, isolated, typed });
