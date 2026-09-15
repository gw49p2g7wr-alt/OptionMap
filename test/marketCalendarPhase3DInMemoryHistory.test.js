"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Memory = require("../js/marketCalendarHistory/inMemoryHistory.js");
const T1 = "2026-09-16T05:15:58.893Z", T2 = "2026-09-16T06:15:58.893Z";
async function event(date, fetchedAt, parserVersion = 1) { const logical = { eventKey:
    "JP|BOJ|BOJ_MPM|2026-09|regular|national", jurisdiction: "JP", authority: "BOJ",
    eventType: "BOJ_MPM", referencePeriod: "2026-09", edition: "regular", scope: "national" },
    semantic = { schemaVersion: 1, logical, schedule: { kind: "date_only", canonicalStart: null,
        canonicalEnd: null, sourceLocal: { startDate: date, startTime: null, endDate: null,
            endTime: null, timeZone: "Asia/Tokyo", resolvedOffset: null }, precision: "date_only" },
        lifecycleStatus: "scheduled", title: { ja: "会合", en: null },
        change: { reason: null, supersedesRevisionKey: null } }, acquisitionEvidence = {
        sourceId: "source", fetchedAt, parserVersion }, canonicalContentHash = await Canonicalizer.sha256(semantic),
    acquisitionEvidenceHash = await Canonicalizer.sha256(acquisitionEvidence);
    return { ...semantic, eventKey: logical.eventKey,
        revisionKey: `${logical.eventKey}|sha256:${canonicalContentHash}`, canonicalContentHash,
        acquisitionEvidence, acquisitionEvidenceHash,
        acquisitionEvidenceKey: `source|sha256:${acquisitionEvidenceHash}` }; }
const run = (id, at) => ({ sourceId: "source", runId: id, acceptedAt: at, fetchedAt: [at],
    status: "accepted", semanticSetHash: "a".repeat(64) });

test("initial/unchanged/changeをin-memory atomic apply", async () => {
    const firstEvent = await event("2026-09-18", T1), first = await Memory.accept({},
        { run: run("r1", T1), canonicalSet: [firstEvent] });
    assert.equal(first.committed, true); assert.equal(first.snapshot.revisions.length, 1);
    const unchangedEvent = await event("2026-09-18", T2), unchanged = await Memory.accept(first.snapshot,
        { run: run("r2", T2), canonicalSet: [unchangedEvent] });
    assert.equal(unchanged.snapshot.revisions.length, 1); assert.equal(unchanged.snapshot.evidence.length, 2);
    const T3 = "2026-09-16T07:15:58.893Z", changedEvent = await event("2026-09-19", T3),
        changed = await Memory.accept(unchanged.snapshot, { run: run("r3", T3),
            canonicalSet: [changedEvent] });
    assert.equal(changed.snapshot.revisions.length, 2);
    assert.equal(changed.snapshot.revisions[0].validTo, T3);
    assert.equal(changed.snapshot.revisions[1].validFrom, T3);
});

test("途中failureは入力snapshotを変更せずrollback", async () => {
    const e1 = await event("2026-09-18", T1), first = await Memory.accept({},
        { run: run("r1", T1), canonicalSet: [e1] }), before = JSON.stringify(first.snapshot),
        e2 = await event("2026-09-19", T2), failed = await Memory.accept(first.snapshot,
            { run: run("r2", T2), canonicalSet: [e2] }, { failAfter: "close" });
    assert.equal(failed.committed, false); assert.equal(failed.outcome, "rolled_back");
    assert.equal(JSON.stringify(first.snapshot), before); assert.deepEqual(failed.snapshot, first.snapshot);
});

test("同じrun retryはno-op、異なるpayloadはconflict", async () => {
    const e = await event("2026-09-18", T1), first = await Memory.accept({},
        { run: run("r1", T1), canonicalSet: [e] }), retry = await Memory.accept(first.snapshot,
            { run: run("r1", T1), canonicalSet: [e] });
    assert.equal(retry.outcome, "already_committed");
    const conflict = await Memory.accept(first.snapshot, { run: { ...run("r1", T1),
        semanticSetHash: "b".repeat(64) }, canonicalSet: [e] });
    assert.equal(conflict.outcome, "duplicate_run_conflict");
});

test("parser changeはauthority changeと別origin", async () => {
    const first = await Memory.accept({}, { run: run("r1", T1),
        canonicalSet: [await event("2026-09-18", T1)] });
    const second = await Memory.accept(first.snapshot, { run: run("r2", T2),
        canonicalSet: [await event("2026-09-19", T2, 2)], parserChanged: true });
    assert.equal(second.snapshot.revisions[1].revisionOrigin, "parser_interpretation_change");
});
