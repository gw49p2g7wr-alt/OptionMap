"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Canon = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Planner = require("../js/marketCalendarHistory/transitionPlanner.js");
const Plan = require("../js/marketCalendarHistory/planCanonicalizer.js");
const Mapper = require("../js/marketCalendarHistory/storageRecordMapper.js");
const SOURCE = "jp-jpx-derivatives-calendar", T1 = "2026-09-16T11:09:51.610Z",
    T2 = "2026-09-16T19:58:08.148Z", HASH = "a".repeat(64), EVIDENCE_HASH = "b".repeat(64);
const event = suffix => ({ eventKey: `event-${suffix}`, revisionKey: `event-${suffix}|sha256:${HASH}`,
    canonicalContentHash: HASH, acquisitionEvidenceKey: `${SOURCE}|sha256:${EVIDENCE_HASH}`,
    acquisitionEvidenceHash: EVIDENCE_HASH, acquisitionEvidence: { fetchedAt: T2, runId: "r2" },
    schedule: { sourceLocal: { startDate: `2026-0${suffix}-01` } } });
const entry = suffix => ({ eventKey: `event-${suffix}`, sourceId: SOURCE,
    activeRevisionKey: `event-${suffix}|sha256:${HASH}`, firstKnownAt: T1, lastObservedAt: T1 });
const revision = suffix => ({ ...event(suffix), sourceId: SOURCE, validFrom: T1, validTo: null,
    revisionOrigin: "initial_observation", calendarDateStart: `2026-0${suffix}-01`,
    calendarDateEnd: `2026-0${suffix}-01` });
const run = { sourceId: SOURCE, runId: "r2", acceptedAt: T2, fetchedAt: [T2], status: "accepted",
    semanticSetHash: HASH };
const snapshot = order => ({ entries: order.map(entry), revisions: order.map(revision), runs: [],
    evidence: [], observations: [], cursors: [{ sourceId: SOURCE, acceptedAt: T1 }] });

test("plan payload/hashはcanonical source setとstorage read順に非依存", async () => {
    const first = Planner.planTransition({ snapshot: snapshot([1, 2]), run,
        canonicalSet: [event(1), event(2)] }).plan;
    const second = Planner.planTransition({ snapshot: snapshot([2, 1]), run: { ...run },
        canonicalSet: [event(2), event(1)] }).plan;
    assert.equal(Plan.canonicalPayload(first), Plan.canonicalPayload(second));
    assert.equal(await Plan.planHash(first), await Plan.planHash(second));
    assert.deepEqual(first.updateEntries.map(value => value.eventKey), ["event-1", "event-2"]);
    assert.deepEqual(first.appendEvidence.map(value => value.eventKey), ["event-1", "event-2"]);
    assert.deepEqual(first.appendObservations.map(value => value.eventKey), ["event-1", "event-2"]);
    assert.equal(Plan.canonicalPayload(Mapper.mapPlan(first)), Plan.canonicalPayload(Mapper.mapPlan(second)));
});

test("object key順・undefined・Dateをcanonical payloadへ正規化", async () => {
    const left = { updateEntries: [{ eventKey: "b", optional: undefined }, { eventKey: "a" }],
        acceptedAt: new Date(T2), sourceId: SOURCE, appendRuns: [{ fetchedAt: [T2, T1], runId: "r2",
            sourceId: SOURCE, acceptedAt: T2 }] };
    const right = { sourceId: SOURCE, acceptedAt: T2, appendRuns: [{ acceptedAt: T2, sourceId: SOURCE,
        runId: "r2", fetchedAt: [T1, T2] }], updateEntries: [{ eventKey: "a" }, { eventKey: "b" }] };
    assert.equal(Plan.canonicalPayload(left), Plan.canonicalPayload(right));
    assert.equal(await Plan.planHash(left), await Plan.planHash(right));
    assert.doesNotMatch(Plan.canonicalPayload(left), /optional|undefined/);
});

test("legacy raw plan hashは配列順に依存しcanonical plan hashは一致", async () => {
    const a = { appendEvidence: [{ eventKey: "b" }, { eventKey: "a" }] },
        b = { appendEvidence: [...a.appendEvidence].reverse() };
    assert.notEqual(await Canon.sha256(a), await Canon.sha256(b));
    assert.equal(await Plan.planHash(a), await Plan.planHash(b));
});
