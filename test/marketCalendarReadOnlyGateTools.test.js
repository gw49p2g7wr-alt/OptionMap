"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { indexedDB } = require("fake-indexeddb");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Canon = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Planner = require("../js/marketCalendarHistory/transitionPlanner.js");
const Writer = require("../js/marketCalendarHistory/productionHistoryWriter.js");
const Tools = require("../js/marketCalendarHistory/readOnlyGateTools.js");

const databaseName = () => `gate-tools-${Date.now()}-${Math.random()}`;
const open = name => new Promise((resolve, reject) => { const value = indexedDB.open(name, 1);
    value.onupgradeneeded = () => Schema.createInUpgrade(value.result);
    value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const specs = Object.freeze({
    "jp-boj-calendar": ["BOJ_POLICY_DECISION", "JP", "BOJ", "2026-09-meeting", "national"],
    "jp-jpx-market-holidays": ["JPX_MARKET_HOLIDAY", "JP", "JPX", "2026-09-21", "JPX_cash_markets"],
    "us-nyse-market-holidays": ["US_NYSE_MARKET_HOLIDAY", "US", "NYSE", "2026-09-07", "NYSE_cash_market"],
    "us-fed-fomc-calendar": ["US_FOMC_POLICY_DECISION", "US", "US_FED", "2026-09-meeting", "federal"]
});
async function event(sourceId, acceptedAt, runId) { const [eventType, jurisdiction, authority, referencePeriod,
    scope] = specs[sourceId], date = sourceId === "us-fed-fomc-calendar" ? "2026-09-16" :
        sourceId === "jp-boj-calendar" ? "2026-09-18" : referencePeriod, instant =
        sourceId === "us-fed-fomc-calendar", record = { sourceId, eventType, sourceTitle: eventType,
            titleJa: eventType, titleEn: eventType, referencePeriod, edition: "initial", scope,
            authorityEventId: null, sourceStatus: "scheduled", sourcePublishedAt: null, sourceUpdatedAt: null,
            sourceUrl: sourceId === "jp-boj-calendar" ? "https://www.boj.or.jp/about/calendar/" :
                sourceId === "jp-jpx-market-holidays" ? "https://www.jpx.co.jp/corporate/about-jpx/calendar/" :
                sourceId === "us-nyse-market-holidays" ? "https://www.nyse.com/trade/hours-calendars" :
                "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
            fetchedAt: acceptedAt, parserId: `${sourceId}-parser`, parserVersion: 1,
            rawContentHash: "a".repeat(64), requestId: `${runId}-request`, runId, httpMetadata: { httpStatus: 200 },
            sourceLocalSchedule: { kind: instant ? "instant" : "all_day", startDate: date,
                startTime: instant ? "14:00" : null, endDate: null, endTime: null,
                timeZone: jurisdiction === "US" ? "America/New_York" : "Asia/Tokyo",
                precision: instant ? "exact" : "all_day" } }, value = await Canon.canonicalize(record);
    assert.equal(value.ok, true, `${sourceId}:${value.reason}`); return value.event; }
async function seed() { const name = databaseName(), created = await open(name); created.close(); let snapshot =
    Planner.emptySnapshot(), minute = 0;
    for (const sourceId of ["jp-boj-calendar", "jp-jpx-market-holidays", "us-nyse-market-holidays"]) {
        const acceptedAt = `2026-09-17T00:0${minute}:00.000Z`, runId = `${sourceId}-run`, value =
            await event(sourceId, acceptedAt, runId), semanticSetHash = await Canon.sha256([value.revisionKey]),
            planned = Planner.planTransition({ snapshot, run: { sourceId, runId, acceptedAt,
                fetchedAt: [acceptedAt], status: "accepted", semanticSetHash }, canonicalSet: [value],
                coverage: { confirmed: true, eventKeys: [value.eventKey] } }), counts = {
                marketCalendarSourceRuns: snapshot.runs.length,
                marketCalendarEventEntries: snapshot.entries.length,
                marketCalendarSemanticRevisions: snapshot.revisions.length,
                marketCalendarAcquisitionEvidence: snapshot.evidence.length,
                marketCalendarEventObservations: snapshot.observations.length,
                marketCalendarSourceCursors: snapshot.cursors.length }, writer =
                Writer.createProductionHistoryWriter({ indexedDB, databaseName: name, enabled: true,
                    authorizationToken: "test" }), result = await writer.write({ authorization: "test",
                    plan: planned.plan, expectedPlanHash: await Canon.sha256(planned.plan),
                    expectedStoreCounts: counts, expectedCursor: null });
        assert.equal(result.saved, true, JSON.stringify(result)); snapshot = result.snapshot; minute += 1;
    }
    return { name, snapshot };
}
async function addFed(name, snapshot) { const sourceId = "us-fed-fomc-calendar",
    acceptedAt = "2026-09-17T01:00:00.000Z", runId = "fed-run", value = await event(
        sourceId, acceptedAt, runId), semanticSetHash = await Canon.sha256([value.revisionKey]), planned =
        Planner.planTransition({ snapshot, run: { sourceId, runId, acceptedAt, fetchedAt: [acceptedAt],
            status: "accepted", semanticSetHash }, canonicalSet: [value], coverage: { confirmed: true,
            eventKeys: [value.eventKey] } }), counts = Tools.storeCounts(snapshot), writer =
        Writer.createProductionHistoryWriter({ indexedDB, databaseName: name, enabled: true,
            authorizationToken: "test" }), result = await writer.write({ authorization: "test", plan: planned.plan,
            expectedPlanHash: await Canon.sha256(planned.plan), expectedStoreCounts: counts, expectedCursor: null });
    assert.equal(result.saved, true, JSON.stringify(result)); return { result, value, runId, semanticSetHash };
}

test("source-aware preflightはsnapshot・cursor・active semantic set・collisionを実データから返す", async () => {
    const fixture = await seed(), before = await Tools.preflight({ indexedDB, databaseName: fixture.name,
        sourceId: "us-fed-fomc-calendar", candidateEventKeys: [fixture.snapshot.entries[0].eventKey] });
    assert.equal(before.ok, true); assert.equal(before.sourceCursor, null);
    assert.deepEqual(before.counts, Tools.storeCounts(fixture.snapshot));
    assert.equal(before.productionPrecondition.productionSnapshotFingerprint,
        before.productionSnapshotFingerprint); assert.equal(before.crossSourceCollisionCount, 1);
    assert.equal(before.crossSourceCollisions[0].existingSourceId, "jp-boj-calendar");
    const fed = await addFed(fixture.name, fixture.snapshot), after = await Tools.preflight({ indexedDB,
        databaseName: fixture.name, sourceId: "us-fed-fomc-calendar", canonicalSet: [fed.value] });
    assert.equal(after.sourceCursor.runId, fed.runId); assert.equal(after.active.entryCount, 1);
    assert.equal(after.active.semanticSetHash, fed.semanticSetHash);
    assert.equal(after.crossSourceCollisionCount, 0);
    assert.match(after.productionPreconditionIdentityHash, /^[0-9a-f]{64}$/);
});

test("Acceptance auditorは4-source相当historyをreadonlyでmanifest・再構成・外部不変比較", async () => {
    const fixture = await seed(), baseline = await Tools.preflight({ indexedDB, databaseName: fixture.name,
        sourceId: "us-fed-fomc-calendar" }), fed = await addFed(fixture.name, fixture.snapshot), result =
        await Tools.acceptance({ indexedDB, databaseName: fixture.name, sourceId: "us-fed-fomc-calendar",
            runId: fed.runId, expectedExternalHistoryFingerprint: baseline.externalHistoryFingerprint });
    assert.equal(result.ok, true, JSON.stringify(result.errors)); assert.equal(result.semanticIntegrity.valid, true);
    assert.equal(result.storageIntegrity.valid, true); assert.equal(result.virtualRunManifest.ok, true);
    assert.equal(result.crossStoreIntegrity.valid, true);
    assert.equal(result.virtualRunManifest.manifest.itemCount, 1);
    assert.equal(result.semanticSetHashMatches, true); assert.equal(result.deterministicReconstruction, true);
    assert.equal(result.externalHistoryUnchanged, true); assert.equal(result.cursorMatchesRun, true);
});

test("外部history差分はAcceptanceでfail-closed", async () => { const fixture = await seed(), fed =
    await addFed(fixture.name, fixture.snapshot), result = await Tools.acceptance({ indexedDB,
        databaseName: fixture.name, sourceId: "us-fed-fomc-calendar", runId: fed.runId,
        expectedExternalHistoryFingerprint: "0".repeat(64) });
    assert.equal(result.ok, false); assert.ok(result.errors.includes("external_history_changed"));
});

test("Gate toolsはwrite capabilityとschema mutationを持たない", () => { const source = fs.readFileSync(
    path.resolve(__dirname, "../js/marketCalendarHistory/readOnlyGateTools.js"), "utf8");
    assert.doesNotMatch(source, /"readwrite"|createObjectStore|deleteObjectStore|\.put\(|\.add\(|\.delete\(|\.clear\(/);
    assert.doesNotMatch(source, /productionHistoryWriter|approvalArtifactDelivery/);
    assert.deepEqual(Object.keys(Tools).sort(), ["STORE_MAP", "STORE_NAMES", "acceptance",
        "externalHistoryFingerprint", "preflight", "storeCounts"].sort());
});
