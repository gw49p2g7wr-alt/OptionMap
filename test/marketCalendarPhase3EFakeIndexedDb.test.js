"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { indexedDB } = require("fake-indexeddb");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Store = require("../js/marketCalendarHistory/fakeIndexedDbHistoryStore.js");
const T1 = "2026-09-16T05:15:58.893Z", T2 = "2026-09-16T06:15:58.893Z";
async function event(date, at) { const logical = { eventKey: "JP|BOJ|BOJ_MPM|p|regular|national",
    jurisdiction: "JP", authority: "BOJ", eventType: "BOJ_MPM", referencePeriod: "p",
    edition: "regular", scope: "national" }, semantic = { schemaVersion: 1, logical,
        schedule: { kind: "date_only", canonicalStart: null, canonicalEnd: null,
            sourceLocal: { startDate: date, startTime: null, endDate: null, endTime: null,
                timeZone: "Asia/Tokyo", resolvedOffset: null }, precision: "date_only" },
        lifecycleStatus: "scheduled", title: { ja: "会合", en: null },
        change: { reason: null, supersedesRevisionKey: null } }, acquisitionEvidence = {
        sourceId: "source", fetchedAt: at, parserVersion: 1 },
    canonicalContentHash = await Canonicalizer.sha256(semantic),
    acquisitionEvidenceHash = await Canonicalizer.sha256(acquisitionEvidence);
    return { ...semantic, eventKey: logical.eventKey,
        revisionKey: `${logical.eventKey}|sha256:${canonicalContentHash}`, canonicalContentHash,
        acquisitionEvidence, acquisitionEvidenceHash,
        acquisitionEvidenceKey: `source|sha256:${acquisitionEvidenceHash}` }; }
const run = (id, at) => ({ sourceId: "source", runId: id, acceptedAt: at, fetchedAt: [at],
    status: "accepted", semanticSetHash: "a".repeat(64) });
const makeStore = suffix => Store.createFakeIndexedDbHistoryStore({ indexedDB, targetEnvironment: "test",
    databaseName: `${Store.TEST_PREFIX}${suffix}-${Date.now()}-${Math.random()}` });

test("adapterはinjected fake IndexedDBとtest専用名を必須にする", () => {
    assert.throws(() => Store.createFakeIndexedDbHistoryStore({ indexedDB,
        targetEnvironment: "production", databaseName: `${Store.TEST_PREFIX}x` }),
    /test_store_configuration_required/);
    assert.throws(() => Store.createFakeIndexedDbHistoryStore({ indexedDB,
        targetEnvironment: "test", databaseName: "optionMapProduction" }),
    /test_store_configuration_required/);
});

test("全recordを単一transactionでcommitして復元", async () => {
    const store = makeStore("commit"), result = await store.accept({ run: run("r1", T1),
        canonicalSet: [await event("2026-09-18", T1)] }), loaded = await store.load();
    assert.equal(result.committed, true); assert.equal(loaded.entries.length, 1);
    assert.equal(loaded.revisions.length, 1); assert.equal(loaded.evidence.length, 1);
    assert.equal(loaded.observations[0].state, "observed"); store.close();
});

test("途中failureはIndexedDB transaction全体をrollback", async () => {
    const store = makeStore("rollback"); await store.accept({ run: run("r1", T1),
        canonicalSet: [await event("2026-09-18", T1)] }); const before = await store.load(),
        failed = await store.accept({ run: run("r2", T2), canonicalSet: [await event(
            "2026-09-19", T2)] }, { storage: { failAfter: "revisions" } }), after = await store.load();
    assert.equal(failed.committed, false); assert.equal(failed.outcome, "rolled_back");
    assert.deepEqual(after, before); store.close();
});

test("同じsource runのretryはDB上でもidempotent", async () => {
    const store = makeStore("retry"), input = { run: run("r1", T1),
        canonicalSet: [await event("2026-09-18", T1)] };
    await store.accept(input); const retry = await store.accept(input), loaded = await store.load();
    assert.equal(retry.outcome, "already_committed"); assert.equal(loaded.runs.length, 1);
    store.close();
});
