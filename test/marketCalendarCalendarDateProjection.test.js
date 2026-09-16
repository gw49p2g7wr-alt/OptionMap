"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Schedule = require("../js/marketCalendar/marketEventSchedule.js");
const Revision = require("../js/marketCalendar/marketEventRevision.js");
const Mapper = require("../js/marketCalendarHistory/storageRecordMapper.js");

const exact = (startDate, startTime, timeZone) => Schedule.canonicalize({ kind: "instant",
    startDate, startTime, endDate: null, endTime: null, timeZone, precision: "exact" });
const dateSchedule = (kind, startDate, endDate = null, timeZone = "Asia/Tokyo") =>
    Schedule.canonicalize({ kind, startDate, startTime: null, endDate, endTime: null,
        timeZone, precision: kind === "date_range" ? "range" : kind });
const revision = (eventKey, schedule) => ({ eventKey, revisionKey: `${eventKey}|r1`, schedule,
    validFrom: "2026-01-01T00:00:00.000Z", validTo: null });
const project = (value, calendarDate, displayTimeZone = "Asia/Tokyo") =>
    Revision.projectForCalendarDate({ entries: [{ revisions: [value] }], calendarDate,
        knowledgeAt: "2026-09-17T00:00:00.000Z", displayTimeZone });

test("NYSE 13:00 exactはEDT/EST canonical instantからJST翌日に所属", () => {
    const edt = exact("2028-07-03", "13:00", "America/New_York"),
        est = exact("2026-11-27", "13:00", "America/New_York");
    assert.deepEqual([edt.sourceLocal.resolvedOffset, edt.canonicalStart,
        Schedule.calendarDateFor(edt, "Asia/Tokyo")],
    ["-04:00", "2028-07-03T17:00:00.000Z", "2028-07-04"]);
    assert.deepEqual([est.sourceLocal.resolvedOffset, est.canonicalStart,
        Schedule.calendarDateFor(est, "Asia/Tokyo")],
    ["-05:00", "2026-11-27T18:00:00.000Z", "2026-11-28"]);
    assert.equal(project(revision("edt", edt), "2028-07-03").length, 0);
    assert.equal(project(revision("edt", edt), "2028-07-04").length, 1);
    assert.equal(project(revision("est", est), "2026-11-28").length, 1);
});

test("exactはJST同日・UTC日付跨ぎ・year boundaryをdisplay timezoneごとに決定", () => {
    const jst = exact("2026-09-18", "15:30", "Asia/Tokyo"),
        utcCrossing = exact("2026-09-18", "20:00", "America/New_York"),
        yearBoundary = exact("2026-12-31", "20:00", "America/New_York");
    assert.equal(Schedule.calendarDateFor(jst, "Asia/Tokyo"), "2026-09-18");
    assert.deepEqual([utcCrossing.canonicalStart, Schedule.calendarDateFor(utcCrossing, "UTC"),
        Schedule.calendarDateFor(utcCrossing, "America/New_York")],
    ["2026-09-19T00:00:00.000Z", "2026-09-19", "2026-09-18"]);
    assert.deepEqual([yearBoundary.canonicalStart, Schedule.calendarDateFor(yearBoundary, "UTC")],
        ["2027-01-01T01:00:00.000Z", "2027-01-01"]);
});

test("DST前後もcanonical instantとresolved offsetから決定", () => {
    const before = exact("2026-03-06", "13:00", "America/New_York"),
        after = exact("2026-03-09", "13:00", "America/New_York");
    assert.deepEqual([before.sourceLocal.resolvedOffset, before.canonicalStart],
        ["-05:00", "2026-03-06T18:00:00.000Z"]);
    assert.deepEqual([after.sourceLocal.resolvedOffset, after.canonicalStart],
        ["-04:00", "2026-03-09T17:00:00.000Z"]);
});

test("date-only/all-dayはdisplay timezoneでも偽instant化せずauthority日を維持", () => {
    for (const kind of ["date_only", "all_day"]) { const value = dateSchedule(kind, "2026-09-18",
        null, "America/New_York");
        assert.deepEqual([value.canonicalStart, value.canonicalEnd, value.sourceLocal.startTime],
            [null, null, null]);
        assert.deepEqual(Schedule.calendarDateIntervalFor(value, "Asia/Tokyo"),
            { start: "2026-09-18", end: "2026-09-18" });
    }
});

test("date-rangeはauthorityの開始・終了日をinclusiveに包含", () => {
    const schedule = dateSchedule("date_range", "2026-09-17", "2026-09-19"),
        value = revision("range", schedule);
    assert.deepEqual(Schedule.calendarDateIntervalFor(schedule, "America/New_York"),
        { start: "2026-09-17", end: "2026-09-19" });
    assert.deepEqual(["2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"]
        .map(date => project(value, date, "America/New_York").length), [0, 1, 1, 1, 0]);
});

test("storage CalendarDate indexもexactは既定display timezoneの投影日を使用", () => {
    const value = revision("nyse", exact("2028-07-03", "13:00", "America/New_York")), mapped =
        Mapper.mapPlan({ sourceId: "source", runId: "r", acceptedAt: "2026-01-01T00:00:00.000Z",
            appendRuns: [], appendEntries: [], updateEntries: [], closeRevisions: [],
            appendRevisions: [value], appendEvidence: [], appendObservations: [], updateCursors: [] });
    assert.deepEqual([mapped.appendRevisions[0].calendarDateStart,
        mapped.appendRevisions[0].calendarDateEnd], ["2028-07-04", "2028-07-04"]);
});
