"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const CalendarDate = require("../js/calendarDate/calendarDate.js");
const Navigation = require("../js/calendarDate/calendarDateNavigation.js");
const Availability = require("../js/calendarDate/calendarDateAvailability.js");
const Intent = require("../js/calendarDate/calendarNavigationIntent.js");
const Parser = require("../js/marketCalendar/parserContract.js");
const Identity = require("../js/marketCalendar/marketEventIdentity.js");
const Schedule = require("../js/marketCalendar/marketEventSchedule.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Revision = require("../js/marketCalendar/marketEventRevision.js");
const Importance = require("../js/marketCalendar/importancePolicy.js");
const Presentation = require("../js/marketCalendar/marketEventPresentation.js");
const Fixtures = require("./fixtures/marketCalendar/sourceFixtures.js");

const parsedRecord = name => Parser.parseFixtureDocument(Fixtures.variants[name]).records[0];
const canonical = async name => (await Canonicalizer.canonicalize(parsedRecord(name))).event;

test("Phase 1A CalendarDateはevent 0件でもfirst-classかつ月間42日を選択可能", () => {
    const empty = Availability.projection("2026-09-18", {
        events: { status: "available", count: 0 }, qriTimeTravel: { status: "available", count: 2 } });
    assert.equal(empty.selectable, true);
    assert.deepEqual(empty.availability.events, { status: "available", count: 0 });
    assert.notEqual(empty.availability.events.status, "unknown");
    const month = Navigation.buildMonth({ year: 2026, month: 9 });
    assert.equal(month.cells.length, 42); assert.equal(month.cells.every(cell => cell.selectable), true);
    assert.equal(month.cells.filter(cell => cell.inMonth).length, 30);
    assert.equal(CalendarDate.addDays("2028-02-28", 1), "2028-02-29");
});

test("Phase 1B availabilityは各domainを疎結合に合成", () => {
    const value = Availability.projection("2026-09-17", { events: { status: "available", count: 2,
        criticalCount: 1 }, wallHistory: { status: "partial", count: 1 } });
    assert.deepEqual(Object.keys(value.availability), Availability.DOMAINS);
    assert.deepEqual(value.availability.participant, { status: "unknown", count: null });
});

test("Phase 1C scheduledAtとtitleはlogical event identityに含まれない", () => {
    const base = { jurisdiction: "US", authority: "US_FED", eventType: "US_FOMC_POLICY_DECISION",
        referencePeriod: "2026-09-meeting", edition: "regular", scope: "federal" };
    const first = Identity.create({ ...base, scheduledAt: "2026-09-16T18:00:00Z", title: "First" });
    const moved = Identity.create({ ...base, scheduledAt: "2026-09-17T18:00:00Z", title: "Moved" });
    assert.equal(first.eventKey, moved.eventKey);
    assert.doesNotMatch(first.eventKey, /2026-09-16T/);
    const conference = Identity.create({ ...base, eventType: "US_FED_CHAIR_PRESS_CONFERENCE" });
    assert.notEqual(first.eventKey, conference.eventKey);
});

test("Phase 1D source wall timeとIANA timezoneを保持しDSTを正しく解決", () => {
    const summer = Schedule.canonicalize(parsedRecord("dstSummer").sourceLocalSchedule);
    const winter = Schedule.canonicalize(parsedRecord("dstWinter").sourceLocalSchedule);
    assert.equal(summer.sourceLocal.timeZone, "America/New_York");
    assert.equal(summer.sourceLocal.resolvedOffset, "-04:00");
    assert.equal(winter.sourceLocal.resolvedOffset, "-05:00");
    assert.equal(summer.canonicalStart, "2026-09-11T12:30:00.000Z");
    assert.equal(winter.canonicalStart, "2026-12-10T13:30:00.000Z");
});

test("Phase 1D date-only/all-day/date-rangeを偽instant化しない", () => {
    for (const name of ["timeUndecided", "allDay", "dateRange"]) {
        const value = Schedule.canonicalize(parsedRecord(name).sourceLocalSchedule);
        assert.equal(value.canonicalStart, null, name); assert.equal(value.canonicalEnd, null, name);
        assert.equal(value.sourceLocal.startTime, null, name);
    }
    const range = Schedule.canonicalize(parsedRecord("dateRange").sourceLocalSchedule);
    assert.deepEqual([range.sourceLocal.startDate, range.sourceLocal.endDate],
        ["2026-09-17", "2026-09-18"]);
});

test("Phase 1D canonical eventはsource事実とcontent hashを保持する", async () => {
    const event = await canonical("dstSummer");
    assert.match(event.eventKey, /^US\|US_BLS\|US_CPI\|2026-08\|initial\|national$/);
    assert.match(event.revisionKey, /\|sha256:[0-9a-f]{64}$/);
    assert.equal(event.validFrom, null); assert.equal(event.validTo, null);
    assert.equal(event.source.sourceId, "us-bls-calendar");
    assert.equal(event.source.fetchedAt, Fixtures.FETCHED_AT);
    assert.equal(Object.isFrozen(event.source), true);
    const rejected = await Canonicalizer.canonicalize({ ...parsedRecord("dstSummer"),
        sourceUrl: "https://example.com/calendar" });
    assert.deepEqual([rejected.ok, rejected.reason], [false, "source_url_not_allowed"]);
});

test("Phase 1E validFrom inclusive・validTo exclusiveでas-known-at revisionを選択", async () => {
    const oldEvent = await canonical("dstSummer"), movedEvent = await canonical("rescheduled");
    const old = { ...oldEvent, eventKey: "event", validFrom: "2026-01-01T00:00:00.000Z",
        validTo: "2026-09-10T00:00:00.000Z" };
    const moved = { ...movedEvent, eventKey: "event", validFrom: "2026-09-10T00:00:00.000Z", validTo: null };
    assert.equal(Revision.selectAsKnownAt([old, moved], "2026-09-09T23:59:59.999Z"), old);
    assert.equal(Revision.selectAsKnownAt([old, moved], "2026-09-10T00:00:00.000Z"), moved);
    assert.equal(Revision.selectAsKnownAt([old, moved], "2025-12-31T23:59:59.999Z"), null);
});

test("Phase 1E calendarDate＋knowledgeAtで変更前予定とdate-rangeを投影", async () => {
    const source = await canonical("dstSummer"), old = { ...source,
        validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-09-12T00:00:00.000Z" };
    const entry = { eventKey: old.eventKey, revisions: [old] };
    assert.equal(Revision.projectForCalendarDate({ entries: [entry], calendarDate: "2026-09-11",
        knowledgeAt: "2026-09-11T23:00:00.000Z" }).length, 1);
    assert.equal(Revision.projectForCalendarDate({ entries: [entry], calendarDate: "2026-09-11",
        knowledgeAt: "2026-09-12T00:00:00.000Z" }).length, 0);
    const rangeEvent = await canonical("dateRange"), range = { ...rangeEvent,
        validFrom: "2026-01-01T00:00:00.000Z", validTo: null };
    for (const date of ["2026-09-17", "2026-09-18"]) assert.equal(
        Revision.projectForCalendarDate({ entries: [{ revisions: [range] }], calendarDate: date,
            knowledgeAt: "2026-09-17T00:00:00.000Z" }).length, 1);
});

test("Phase 1F navigationはfuture/today/historical/event 0件をdate detailへ解決", () => {
    const scenarios = [
        ["2026-09-18", "future", 0, false], ["2026-09-17", "today", 2, false],
        ["2026-09-16", "historical", 1, true], ["2026-09-15", "historical", 0, true]
    ];
    for (const [calendarDate, relation, count, timeTravel] of scenarios) {
        const availability = Availability.projection(calendarDate, { events: { status: "available", count },
            qriTimeTravel: { status: timeTravel ? "available" : "unavailable", count: timeTravel ? 1 : 0 } });
        const value = Intent.resolve({ calendarDate, today: "2026-09-17", availability: availability.availability });
        assert.equal(value.relationToToday, relation); assert.equal(value.defaultDestination, "calendar_date_detail");
        assert.equal(value.destinations.timeTravel, timeTravel);
        assert.equal(value.destinations.scheduledEvents, true);
    }
});

test("Phase 1F presentationは翌日・残時間・変更・時刻未定を表現", async () => {
    const fomc = await Canonicalizer.canonicalize(Parser.parseFixtureDocument(
        Fixtures.document("us-fed-fomc-calendar")).records[0]);
    const view = Presentation.build(fomc.event, { now: "2026-09-16T16:00:00.000Z",
        selectedCalendarDate: "2026-09-17" });
    assert.deepEqual([view.calendarDate, view.timeLabel, view.stateLabel, view.importance],
        ["2026-09-17", "翌03:00", "あと2時間", "critical"]);
    const undecided = Presentation.build(await canonical("timeUndecided"), {
        now: "2026-09-16T00:00:00.000Z" });
    assert.equal(undecided.timeLabel, "時刻未定");
    const changed = Presentation.build(await canonical("rescheduled"), {
        now: "2026-09-16T00:00:00.000Z" });
    assert.equal(changed.stateLabel, "日程変更");
});

test("importance policyはidentityとsourceから分離", () => {
    assert.deepEqual(Importance.classify("US_CPI"), { policyVersion: 1, eventType: "US_CPI",
        importance: "critical", reasonCode: "initial_beta_policy" });
    assert.equal(Importance.classify("JP_INDUSTRIAL_PRODUCTION").importance, "medium");
});

test("Phase 1G foundationはstorage・network・DOM・scheduler・Time Travel・OverallV2に非接続", () => {
    const root = path.resolve(__dirname, ".."), directories = ["js/calendarDate", "js/marketCalendar"];
    const files = directories.flatMap(directory => fs.readdirSync(path.join(root, directory))
        .filter(file => file.endsWith(".js")).map(file => path.join(root, directory, file)));
    const source = files.map(file => fs.readFileSync(file, "utf8")).join("\n");
    assert.doesNotMatch(source, /indexedDB|localStorage|sessionStorage|\bfetch\s*\(|XMLHttpRequest/);
    assert.doesNotMatch(source, /document\.(?:get|query|create)|getElementById|querySelector|setInterval|setTimeout/);
    assert.doesNotMatch(source,
        /require\([^)]*(?:qriTimeTravel|wallHistory|participantHistory|overallJudgmentV2)|OptionMapOverallV2/);
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    assert.match(html, /js\/marketCalendarMvp\.js/);
});
