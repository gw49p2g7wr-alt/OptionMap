"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Integrity = require("../js/marketCalendarHistory/historyIntegrity.js");
const T1 = "2026-09-16T05:00:00.000Z", T2 = "2026-09-17T05:00:00.000Z";
async function revision(validFrom = T1, validTo = null, date = "2026-09-18") {
    const semantic = { schemaVersion: 1, logical: { eventKey: "JP|BOJ|BOJ_MPM|p|regular|national",
        jurisdiction: "JP", authority: "BOJ", eventType: "BOJ_MPM", referencePeriod: "p",
        edition: "regular", scope: "national" }, schedule: { kind: "date_only", canonicalStart: null,
        canonicalEnd: null, sourceLocal: { startDate: date, startTime: null, endDate: null,
            endTime: null, timeZone: "Asia/Tokyo", resolvedOffset: null }, precision: "date_only" },
        lifecycleStatus: "scheduled", title: { ja: "会合", en: null },
        change: { reason: null, supersedesRevisionKey: null } };
    const hash = await Canonicalizer.sha256(semantic), eventKey = semantic.logical.eventKey;
    return { ...semantic, eventKey, revisionKey: `${eventKey}|sha256:${hash}`,
        canonicalContentHash: hash, validFrom, validTo, revisionOrigin: "initial_observation" };
}
async function snapshot() { const rev = await revision(); return { entries: [{ eventKey: rev.eventKey,
    sourceId: "jp-boj-calendar", activeRevisionKey: rev.revisionKey }], revisions: [rev], evidence: [],
    observations: [{ eventKey: rev.eventKey, sourceId: "jp-boj-calendar", runId: "r1",
        acceptedAt: T1, state: "observed", coverageConfirmed: true }] }; }

test("integrity auditorはhash/key/active intervalを再検証", async () => {
    const value = await snapshot(); assert.equal((await Integrity.audit(value)).valid, true);
    value.revisions[0].title.ja = "改ざん";
    assert.ok((await Integrity.audit(value)).errors.includes("canonical_hash_mismatch"));
});

test("gapとoverlapはfail-closed", async () => {
    const first = await revision(T1, T2), second = await revision("2026-09-17T06:00:00.000Z", null,
        "2026-09-19"), value = { entries: [{ eventKey: first.eventKey, sourceId: "source",
            activeRevisionKey: second.revisionKey }], revisions: [first, second] };
    assert.ok((await Integrity.audit(value)).errors.includes("revision_interval_gap"));
});

test("calendarDate+knowledgeAtは決定的にrevisionと当時のobservationを返す", async () => {
    const value = await snapshot(), options = { calendarDate: "2026-09-18", knowledgeAt: T2 };
    const first = await Integrity.queryAsKnownAt(value, options), second = await Integrity.queryAsKnownAt(
        { ...value, evidence: [] }, options);
    assert.equal(first.status, "available"); assert.equal(first.events.length, 1);
    assert.deepEqual(first, second); assert.equal(first.events[0].observation.state, "observed");
});

test("event 0件は成功しhistory破損時は結果を返さない", async () => {
    const value = await snapshot();
    assert.deepEqual((await Integrity.queryAsKnownAt(value, { calendarDate: "2026-09-19",
        knowledgeAt: T2 })).events, []);
    value.entries[0].activeRevisionKey = "missing";
    assert.equal((await Integrity.queryAsKnownAt(value, { calendarDate: "2026-09-18",
        knowledgeAt: T2 })).status, "corrupted");
});
