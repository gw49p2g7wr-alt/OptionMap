"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { indexedDB } = require("fake-indexeddb");
const Canon = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Planner = require("../js/marketCalendarHistory/transitionPlanner.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Mapper = require("../js/marketCalendarHistory/storageRecordMapper.js");
const Integrity = require("../js/marketCalendarHistory/historyIntegrity.js");
const Writer = require("../js/marketCalendarHistory/productionHistoryWriter.js");
const Authorization = require("../js/marketCalendarHistory/planAuthorization.js");
const T1 = "2026-09-16T06:00:00.000Z", T2 = "2026-09-16T07:00:00.000Z",
    T3 = "2026-09-16T08:00:00.000Z", SOURCE = "jp-jpx-market-holidays";
const storeCounts = (entries = 0, revisions = 0, evidence = 0, observations = 0, runs = 0, cursors = 0) => ({
    marketCalendarSourceRuns: runs, marketCalendarEventEntries: entries,
    marketCalendarSemanticRevisions: revisions, marketCalendarAcquisitionEvidence: evidence,
    marketCalendarEventObservations: observations, marketCalendarSourceCursors: cursors });
const open = name => new Promise((resolve, reject) => { const value = indexedDB.open(name, 1);
    value.onupgradeneeded = () => Schema.createInUpgrade(value.result);
    value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const createDatabase = async suffix => { const name = `phase3i-production-schema-${suffix}-${Date.now()}-${Math.random()}`,
    db = await open(name); db.close(); return name; };
const run = (runId, acceptedAt, semanticSetHash) => ({ sourceId: SOURCE, runId, acceptedAt,
    fetchedAt: [acceptedAt], status: "accepted", semanticSetHash });
async function event(date, acceptedAt, runId, titleSuffix = "") { const logical = { eventKey:
    `JP|JPX|JPX_MARKET_HOLIDAY|${date}|regular|JPX_cash_markets`, jurisdiction: "JP", authority: "JPX",
    eventType: "JPX_MARKET_HOLIDAY", referencePeriod: date, edition: "regular", scope: "JPX_cash_markets",
    authorityEventId: `JPX market holiday|${date}` }, semantic = { schemaVersion: 1, logical,
        schedule: { kind: "all_day", canonicalStart: null, canonicalEnd: null, sourceLocal: {
            startDate: date, startTime: null, endDate: null, endTime: null, timeZone: "Asia/Tokyo",
            resolvedOffset: null }, precision: "all_day" }, lifecycleStatus: "scheduled",
        title: { ja: `JPX休場${titleSuffix}`, en: "JPX Market Holiday" }, change: { reason: null,
            supersedesRevisionKey: null } }, acquisitionEvidence = { sourceId: SOURCE, authority: "JPX",
            sourceUrl: "https://www.jpx.co.jp/corporate/about-jpx/calendar/", sourcePublishedAt: null,
            sourceUpdatedAt: null, fetchedAt: acceptedAt, rawContentHash: "a".repeat(64),
            parserId: "jp-jpx-market-holidays-parser", parserVersion: 1, requestId: `${runId}-fetch`, runId,
            httpMetadata: { httpStatus: 200 } }, canonicalContentHash = await Canon.sha256(semantic),
        acquisitionEvidenceHash = await Canon.sha256(acquisitionEvidence);
    return { ...semantic, source: acquisitionEvidence, acquisitionEvidence, eventKey: logical.eventKey,
        revisionKey: `${logical.eventKey}|sha256:${canonicalContentHash}`, canonicalContentHash,
        acquisitionEvidenceHash, acquisitionEvidenceKey: `${SOURCE}|sha256:${acquisitionEvidenceHash}` }; }
async function events(at, runId, changedIndex = -1) { const result = [];
    for (let index = 0; index < 41; index += 1) { const date = new Date(Date.UTC(2026, 0, index + 1))
        .toISOString().slice(0, 10); result.push(await event(date, at, runId,
            index === changedIndex ? "（変更）" : "")); } return result; }
const semanticHash = values => Canon.sha256(values.map(value => value.revisionKey).sort());
async function plan(snapshot, values, runId, at) { const acceptedRun = run(runId, at, await semanticHash(values));
    return Planner.planTransition({ snapshot, run: acceptedRun, canonicalSet: values,
        coverage: { confirmed: true, eventKeys: values.map(value => value.eventKey) } }); }
const writer = (databaseName, extra = {}) => Writer.createProductionHistoryWriter({ indexedDB, databaseName,
    enabled: true, authorizationToken: "AUTHORIZED", ...extra });
async function commit(value, databaseName, expectedStoreCounts, expectedCursor = null, options = {}) {
    return writer(databaseName).write({ authorization: "AUTHORIZED", plan: value.plan,
        expectedPlanHash: await Canon.sha256(value.plan), expectedStoreCounts, expectedCursor, ...options }); }
async function v2Precondition(snapshot, counts, cursor = null) { return {
    productionSnapshotFingerprint: await Authorization.productionSnapshotFingerprint(snapshot),
    storeCounts: counts, schemaFingerprint: Schema.EXPECTED_FINGERPRINT, sourceCursor: cursor }; }
async function commitV2(value, databaseName, precondition) { const artifact =
    await Authorization.createV2(value.plan, precondition); return writer(databaseName).write({
        authorization: "AUTHORIZED", approvalArtifact: artifact,
        expectedArtifactDigest: await Authorization.artifactDigest(artifact),
        expectedAuthorizationIdentityHash: artifact.authorizationIdentityHash }); }
async function mutate(name, stores, callback) { const database = await open(name), tx =
    database.transaction(stores, "readwrite"); await callback(tx); await new Promise((resolve, reject) => {
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => undefined; });
    database.close(); }

test("production schema v1 fingerprintと明示storage mappingを固定", async () => {
    assert.equal(await Schema.fingerprint(), Schema.EXPECTED_FINGERPRINT);
    const values = await events(T1, "r1"), value = await plan(Planner.emptySnapshot(), values, "r1", T1),
        mapped = Mapper.mapPlan(value.plan);
    assert.equal(mapped.appendRuns[0].runKey, `${SOURCE}|r1`);
    assert.equal(mapped.appendObservations[0].observationKey,
        `${values[0].eventKey}|${T1}|r1`);
    assert.equal(mapped.updateCursors[0].runKey, `${SOURCE}|r1`);
    assert.equal(mapped.appendRevisions[0].sourceId, SOURCE);
    assert.equal(mapped.appendRevisions[0].calendarDateStart, "2026-01-01");
});

test("JPX 41件の初回commitとsemantic unchanged再取得", async () => {
    const name = await createDatabase("jpx"), firstEvents = await events(T1, "r1"), firstPlan = await plan(
        Planner.emptySnapshot(), firstEvents, "r1", T1), first = await commit(firstPlan, name, storeCounts());
    assert.equal(first.saved, true, JSON.stringify(first)); assert.deepEqual(first.semantic.counts,
        { entries: 41, revisions: 41, evidence: 41, observations: 41 });
    assert.equal(first.snapshot.runs.length, 1); assert.equal(first.snapshot.cursors.length, 1);
    const beforeEntries = first.snapshot.entries.map(value => ({ ...value })), secondEvents = await events(T2, "r2"),
        secondPlan = await plan(first.snapshot, secondEvents, "r2", T2);
    assert.equal(secondPlan.plan.appendRevisions.length, 0);
    const second = await commit(secondPlan, name, storeCounts(41, 41, 41, 41, 1, 1),
        first.snapshot.cursors[0]); assert.equal(second.saved, true);
    assert.deepEqual([second.snapshot.entries.length, second.snapshot.revisions.length,
        second.snapshot.evidence.length, second.snapshot.observations.length,
        second.snapshot.runs.length, second.snapshot.cursors.length], [41, 41, 82, 82, 2, 1]);
    second.snapshot.entries.forEach((value, index) => { assert.equal(value.lastObservedAt, T2);
        assert.deepEqual({ ...value, lastObservedAt: T1 }, beforeEntries[index]); });
});

test("semantic revision変更は同一境界でcloseとappend", async () => {
    const name = await createDatabase("revision"), initial = await events(T1, "r1"), p1 = await plan(
        Planner.emptySnapshot(), initial, "r1", T1), first = await commit(p1, name, storeCounts()),
        changed = await events(T2, "r2", 0), p2 = await plan(first.snapshot, changed, "r2", T2), second =
        await commit(p2, name, storeCounts(41, 41, 41, 41, 1, 1), first.snapshot.cursors[0]);
    assert.equal(second.saved, true); assert.equal(second.snapshot.revisions.length, 42);
    const own = second.snapshot.revisions.filter(value => value.eventKey === initial[0].eventKey)
        .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    assert.equal(own[0].validTo, T2); assert.equal(own[1].validFrom, T2);
});

test("duplicate runはidempotent、内容違いはconflict", async () => {
    const values = await events(T1, "r1"), p1 = await plan(Planner.emptySnapshot(), values, "r1", T1),
        name = await createDatabase("duplicate"), first = await commit(p1, name, storeCounts()),
        same = await plan(first.snapshot, values, "r1", T1), conflictRun = { ...run("r1", T2, "b".repeat(64)) },
        conflict = Planner.planTransition({ snapshot: first.snapshot, run: conflictRun, canonicalSet: values });
    assert.equal(same.outcome, "already_committed"); assert.equal(conflict.outcome, "duplicate_run_conflict");
});

test("key collision・quota・途中例外は全store rollback", async () => {
    for (const mode of ["collision", "quota", "semantic", "evidence"]) { const name = await createDatabase(mode),
        values = await events(T1, "r1"), p1 = await plan(Planner.emptySnapshot(), values, "r1", T1);
        const candidate = mode === "collision" ? { ...p1, plan: JSON.parse(JSON.stringify(p1.plan)) } : p1;
        if (mode === "collision") candidate.plan.appendEntries[1].eventKey = candidate.plan.appendEntries[0].eventKey;
        const result = await commit(candidate, name, storeCounts(), null, mode === "collision" ? {} :
            { injectFailureAfter: mode }); assert.equal(result.saved, false);
        const db = await open(name), tx = db.transaction(Object.keys(Schema.STORES), "readonly");
        for (const store of Object.keys(Schema.STORES)) assert.equal(await new Promise((resolve, reject) => {
            const request = tx.objectStore(store).count(); request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error); }), 0); db.close(); }
});

test("cursor・counts precondition mismatchとschema mismatchはwrite前拒否", async () => {
    const values = await events(T1, "r1"), p1 = await plan(Planner.emptySnapshot(), values, "r1", T1),
        name = await createDatabase("precondition");
    assert.equal((await commit(p1, name, storeCounts(1))).saved, false);
    assert.equal((await commit(p1, name, storeCounts(), { sourceId: SOURCE })).saved, false);
    const badName = `phase3i-bad-${Date.now()}`, db = await new Promise((resolve, reject) => {
        const value = indexedDB.open(badName, 1); value.onupgradeneeded = () => {
            for (const [storeName, spec] of Object.entries(Schema.STORES)) value.result.createObjectStore(storeName,
                { keyPath: spec.keyPath }); }; value.onsuccess = () => resolve(value.result);
        value.onerror = () => reject(value.error); }); db.close();
    const bad = await commit(p1, badName, storeCounts()); assert.equal(bad.saved, false);
    assert.match(bad.error, /schema_fingerprint_mismatch/);
});

test("default disabledはcatalog openもwriteもしない", async () => {
    let opened = false; const guarded = { databases: () => indexedDB.databases(), open() { opened = true;
        throw new Error("must_not_open"); } }, instance = Writer.createProductionHistoryWriter({ indexedDB: guarded,
            databaseName: "anything" }), result = await instance.write({ authorization: "x", plan: {} });
    assert.equal(result.outcome, "production_write_disabled"); assert.equal(result.opened, false);
    assert.equal(opened, false); assert.equal(instance.diagnostics.defaultDisabled, true);
    assert.deepEqual([...instance.diagnostics.transactionStores].sort(), Object.keys(Schema.STORES).sort());
});

test("storage integrityは必須keyPath/index field欠損をreject", async () => {
    const values = await events(T1, "r1"), p1 = await plan(Planner.emptySnapshot(), values, "r1", T1),
        mapped = Mapper.mapPlan(p1.plan), snapshot = { entries: mapped.appendEntries,
            revisions: mapped.appendRevisions, evidence: mapped.appendEvidence,
            observations: mapped.appendObservations, runs: mapped.appendRuns, cursors: mapped.updateCursors };
    assert.equal(Integrity.auditStorageSnapshot(snapshot).valid, true);
    delete snapshot.revisions[0].sourceId;
    assert.ok(Integrity.auditStorageSnapshot(snapshot).errors.includes("revision:sourceId_missing"));
});

test("v2 artifact由来preconditionはtransaction前と内部で一致時だけcommit", async () => {
    const name = await createDatabase("v2-commit"), values = await events(T1, "r1"), value =
        await plan(Planner.emptySnapshot(), values, "r1", T1), precondition = await v2Precondition(
            Planner.emptySnapshot(), storeCounts()), result = await commitV2(value, name, precondition);
    assert.equal(result.saved, true, JSON.stringify(result)); assert.equal(result.outcome, "committed");
    assert.deepEqual([result.snapshot.runs.length, result.snapshot.entries.length,
        result.snapshot.revisions.length, result.snapshot.evidence.length,
        result.snapshot.observations.length, result.snapshot.cursors.length], [1, 41, 41, 41, 41, 1]);
});

test("v2承認後のsnapshot/counts/cursor変化はfake IndexedDBでwrite 0", async () => {
    for (const mode of ["snapshot", "counts", "cursor"]) { const name = await createDatabase(`v2-${mode}`),
        initial = await events(T1, "r1"), firstPlan = await plan(Planner.emptySnapshot(), initial, "r1", T1),
        first = await commit(firstPlan, name, storeCounts()), nextEvents = await events(T2, "r2"), nextPlan =
        await plan(first.snapshot, nextEvents, "r2", T2), approved = await Authorization.createV2(nextPlan.plan,
            await v2Precondition(first.snapshot, storeCounts(41, 41, 41, 41, 1, 1), first.snapshot.cursors[0]));
        if (mode === "snapshot") await mutate(name, ["marketCalendarEventEntries"], async tx => {
            const store = tx.objectStore("marketCalendarEventEntries"), current = await new Promise((resolve,
                reject) => { const request = store.get(first.snapshot.entries[0].eventKey);
                request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
            store.put({ ...current, firstKnownAt: T2 }); });
        if (mode === "counts") await mutate(name, ["marketCalendarSourceRuns"], async tx => {
            tx.objectStore("marketCalendarSourceRuns").add({ sourceId: "other", runId: "tamper",
                runKey: "other|tamper", acceptedAt: T2, fetchedAt: [T2], status: "accepted",
                semanticSetHash: "a".repeat(64), contractVersion: 1 }); });
        if (mode === "cursor") await mutate(name, ["marketCalendarSourceCursors"], async tx => {
            tx.objectStore("marketCalendarSourceCursors").put({ sourceId: SOURCE, runId: "tamper",
                runKey: `${SOURCE}|tamper`, acceptedAt: T2 }); });
        const result = await writer(name).write({ authorization: "AUTHORIZED", approvalArtifact: approved,
            expectedArtifactDigest: await Authorization.artifactDigest(approved),
            expectedAuthorizationIdentityHash: approved.authorizationIdentityHash });
        assert.equal(result.saved, false); assert.equal(result.outcome, "rolled_back");
        const database = await open(name), tx = database.transaction(Object.keys(Schema.STORES), "readonly"),
            evidenceCount = await new Promise((resolve, reject) => { const request = tx.objectStore(
                "marketCalendarAcquisitionEvidence").count(); request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error); }); database.close();
        assert.equal(evidenceCount, 41); }
});

test("v2 preconditionはtransaction開始直前のraceもtransaction内部でwrite 0", async () => {
    const name = await createDatabase("v2-inside-race"), initial = await events(T1, "r1"), firstPlan =
        await plan(Planner.emptySnapshot(), initial, "r1", T1), first = await commit(firstPlan, name,
            storeCounts()), nextEvents = await events(T2, "r2"), nextPlan = await plan(first.snapshot,
            nextEvents, "r2", T2), artifact = await Authorization.createV2(nextPlan.plan,
            await v2Precondition(first.snapshot, storeCounts(41, 41, 41, 41, 1, 1), first.snapshot.cursors[0])),
        instance = writer(name, { beforeWriteTransaction: async database => { const tx = database.transaction(
            "marketCalendarEventEntries", "readwrite"), store = tx.objectStore("marketCalendarEventEntries"),
            current = await new Promise((resolve, reject) => { const request = store.get(
                first.snapshot.entries[0].eventKey); request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error); }); store.put({ ...current, firstKnownAt: T2 });
            await new Promise((resolve, reject) => { tx.oncomplete = resolve;
                tx.onabort = () => reject(tx.error); }); } }), result = await instance.write({
            authorization: "AUTHORIZED", approvalArtifact: artifact,
            expectedArtifactDigest: await Authorization.artifactDigest(artifact),
            expectedAuthorizationIdentityHash: artifact.authorizationIdentityHash });
    assert.equal(result.saved, false); assert.equal(result.error, "production_precondition_failed");
    const database = await open(name), tx = database.transaction("marketCalendarAcquisitionEvidence", "readonly"),
        count = await new Promise((resolve, reject) => { const request = tx.objectStore(
            "marketCalendarAcquisitionEvidence").count(); request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error); }); database.close(); assert.equal(count, 41);
});
