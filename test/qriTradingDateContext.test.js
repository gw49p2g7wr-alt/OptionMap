"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const context = require("../js/qriTradingDateContext.js");

function authority(calendarDate, formalTradingDate, nextValidTradingDate) {
    const previous = new Date(`${formalTradingDate}T00:00:00.000Z`);
    do { previous.setUTCDate(previous.getUTCDate() - 1); }
    while ([0, 6].includes(previous.getUTCDay()));
    return { status: "available", authority: "formal_calendar_history_readonly",
        calendarDate, previousValidTradingDate: previous.toISOString().slice(0, 10),
        formalTradingDate, nextValidTradingDate };
}

test("day session accepts the same formal trading date", () => {
    const value = context.resolve({ observedAt: "2026-10-19T09:00:00+09:00",
        payloadTradingDate: "2026-10-19",
        calendarAuthority: authority("2026-10-19", "2026-10-19", "2026-10-20") });
    assert.deepEqual([value.valid, value.sessionClass, value.relation,
        value.expectedTradingDate], [true, "day", "same_trading_date", "2026-10-19"]);
});

test("normal weekday night session accepts only the formal next trading date", () => {
    const value = context.resolve({ observedAt: "2026-10-19T19:40:00+09:00",
        payloadTradingDate: "2026-10-20",
        calendarAuthority: authority("2026-10-19", "2026-10-19", "2026-10-20") });
    assert.deepEqual([value.valid, value.sessionClass, value.sessionKey,
        value.relation, value.expectedTradingDate],
    [true, "night", "2026-10-19", "night_session_next_trading_date", "2026-10-20"]);
});

test("night session stays one authority across midnight", () => {
    const value = context.resolve({ observedAt: "2026-10-20T01:00:00+09:00",
        payloadTradingDate: "2026-10-20",
        calendarAuthority: authority("2026-10-20", "2026-10-20", "2026-10-21") });
    assert.equal(value.valid, true);
    assert.equal(value.relation, "night_session_next_trading_date");
});

for (const fixture of [
    ["Friday to Monday", "2026-10-16T17:00:00+09:00", "2026-10-19"],
    ["holiday eve", "2026-10-09T17:00:00+09:00", "2026-10-13"],
    ["consecutive holidays", "2026-10-16T17:00:00+09:00", "2026-10-21"],
    ["year end", "2026-12-30T17:00:00+09:00", "2027-01-04"]
]) test(`${fixture[0]} accepts the Calendar-authorized next date`, () => {
    const calendarDate = fixture[1].slice(0, 10);
    const value = context.resolve({ observedAt: fixture[1], payloadTradingDate: fixture[2],
        calendarAuthority: authority(calendarDate, calendarDate, fixture[2]) });
    assert.deepEqual([value.valid, value.expectedTradingDate, value.relation],
        [true, fixture[2], "night_session_next_trading_date"]);
});

test("wrong future trading date fails closed", () => {
    const value = context.resolve({ observedAt: "2026-10-19T19:40:00+09:00",
        payloadTradingDate: "2026-10-21",
        calendarAuthority: authority("2026-10-19", "2026-10-19", "2026-10-20") });
    assert.deepEqual([value.valid, value.relation, value.reason],
        [false, "date_mismatch", "date_mismatch"]);
});

test("older payload is an explicit historical reference", () => {
    const value = context.resolve({ observedAt: "2026-10-20T09:00:00+09:00",
        payloadTradingDate: "2026-10-19",
        calendarAuthority: authority("2026-10-20", "2026-10-20", "2026-10-21") });
    assert.deepEqual([value.valid, value.relation, value.reason],
        [false, "historical_reference", "source_not_updated"]);
});

test("unknown or wrong Calendar authority remains unresolved", () => {
    for (const calendarAuthority of [null, { status: "unavailable" },
        { ...authority("2026-10-19", "2026-10-19", "2026-10-20"),
            authority: "untrusted" }]) {
        const value = context.resolve({ observedAt: "2026-10-19T19:40:00+09:00",
            payloadTradingDate: "2026-10-20", calendarAuthority });
        assert.deepEqual([value.valid, value.relation, value.expectedTradingDate],
            [false, "date_context_unresolved", null]);
    }
});

test("weekend night does not reuse Friday authority as a new session", () => {
    const value = context.resolve({ observedAt: "2026-10-17T19:40:00+09:00",
        payloadTradingDate: "2026-10-19",
        calendarAuthority: authority("2026-10-17", "2026-10-16", "2026-10-19") });
    assert.equal(value.valid, false);
    assert.equal(value.relation, "date_context_unresolved");
});
