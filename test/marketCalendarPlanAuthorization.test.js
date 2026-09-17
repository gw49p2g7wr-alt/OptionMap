"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { indexedDB } = require("fake-indexeddb");
const Authorization = require("../js/marketCalendarHistory/planAuthorization.js");
const Plan = require("../js/marketCalendarHistory/planCanonicalizer.js");

const HASH = "a".repeat(64), TIME = "2026-09-16T21:56:57.950Z";
const STORE_COUNTS = Object.freeze({ marketCalendarSourceRuns: 7,
    marketCalendarEventEntries: 102, marketCalendarSemanticRevisions: 102,
    marketCalendarAcquisitionEvidence: 170, marketCalendarEventObservations: 170,
    marketCalendarSourceCursors: 4 });
const precondition = (overrides = {}) => ({ productionSnapshotFingerprint: "b".repeat(64),
    storeCounts: { ...STORE_COUNTS }, schemaFingerprint: "c".repeat(64), sourceCursor: null, ...overrides });
function plan({ requestId = "request-1", encoding = true, reverse = false } = {}) {
    const evidence = { sourceId: "source", authority: "AUTH", sourceUrl: "https://example.test/",
        sourcePublishedAt: null, sourceUpdatedAt: null, fetchedAt: TIME, rawContentHash: HASH,
        parserId: "parser", parserVersion: 1, requestId, runId: "run-1", httpMetadata: {
            httpStatus: 200, finalUrl: "https://example.test/", contentType: "text/html; charset=utf-8",
            redirects: [], ...(encoding ? { encodingEvidence: { httpCharset: "utf-8",
                resolvedEncoding: "utf-8", resolutionPolicyVersion: 1 }, encodingWarnings: [] } : {}) } },
        event = { eventKey: "event", revisionKey: `event|sha256:${HASH}`, schemaVersion: 1,
            logical: { eventKey: "event", jurisdiction: "US", authority: "AUTH",
                eventType: "EVENT", referencePeriod: "2026", edition: "regular", scope: "scope" },
            schedule: { kind: "date_only", canonicalStart: null, canonicalEnd: null,
                sourceLocal: { startDate: "2026-09-18", startTime: null, endDate: null,
                    endTime: null, timeZone: "America/New_York", resolvedOffset: null }, precision: "date_only" },
            lifecycleStatus: "scheduled", title: { ja: "event", en: "event" },
            change: { reason: null, supersedesRevisionKey: null }, canonicalContentHash: HASH,
            acquisitionEvidence: evidence, source: evidence, acquisitionEvidenceHash: HASH,
            acquisitionEvidenceKey: `source|sha256:${HASH}`, validFrom: TIME, validTo: null,
            revisionOrigin: "initial_observation" }, values = {
            sourceId: "source", runId: "run-1", acceptedAt: TIME,
            appendRuns: [{ sourceId: "source", runId: "run-1", acceptedAt: TIME,
                fetchedAt: [TIME], status: "accepted", semanticSetHash: HASH, contractVersion: 1 }],
            appendEntries: [{ eventKey: "event", sourceId: "source", activeRevisionKey: event.revisionKey,
                firstKnownAt: TIME, lastObservedAt: TIME }], updateEntries: [], closeRevisions: [],
            appendRevisions: [event], appendEvidence: [{ eventKey: "event", revisionKey: event.revisionKey,
                sourceId: "source", runId: "run-1", acceptedAt: TIME,
                acquisitionEvidenceKey: event.acquisitionEvidenceKey,
                evidenceLinkKey: `${event.revisionKey}|${event.acquisitionEvidenceKey}`,
                acquisitionEvidenceHash: HASH, fetchedAt: TIME, acquisitionEvidence: evidence }],
            appendObservations: [{ eventKey: "event", sourceId: "source", runId: "run-1",
                acceptedAt: TIME, state: "observed", coverageConfirmed: true }],
            updateCursors: [{ sourceId: "source", runId: "run-1", acceptedAt: TIME }] };
    if (reverse) for (const key of Plan.ARRAY_KEYS) values[key].reverse(); return values;
}

test("承認artifactはcanonical payloadを保持しwrite直前にbyte-equivalent rehydrate", async () => {
    const artifact = await Authorization.create(plan()), verified = await Authorization.verify(artifact, {
        sourceId: "source", acceptedAt: TIME, runId: "run-1",
        storageMutationHash: artifact.storageMutationHash,
        authorizationIdentityHash: artifact.authorizationIdentityHash });
    assert.equal(verified.ok, true);
    assert.equal(Plan.canonicalPayload(verified.plan), artifact.canonicalPayload);
    assert.equal(await Plan.planHash(verified.plan), artifact.storageMutationHash);
    assert.deepEqual(await Authorization.create(plan({ reverse: true })), artifact);
});

test("semantic・acquisition・storage・authorization identityを責務分離", async () => {
    const approved = await Authorization.create(plan()), requestChanged = await Authorization.create(
        plan({ requestId: "request-2" })), encodingMissing = await Authorization.create(
        plan({ encoding: false }));
    assert.equal(requestChanged.semanticPlanHash, approved.semanticPlanHash);
    assert.equal(encodingMissing.semanticPlanHash, approved.semanticPlanHash);
    for (const changed of [requestChanged, encodingMissing]) {
        assert.notEqual(changed.acquisitionEvidenceIdentityHash, approved.acquisitionEvidenceIdentityHash);
        assert.notEqual(changed.storageMutationHash, approved.storageMutationHash);
        assert.notEqual(changed.authorizationIdentityHash, approved.authorizationIdentityHash); }
});

test("payload・identity改変と取得証跡欠落をfail-closed", async () => {
    const artifact = await Authorization.create(plan()), tamperedPayload = { ...artifact,
        canonicalPayload: artifact.canonicalPayload.replace("request-1", "request-x") };
    assert.equal((await Authorization.verify(tamperedPayload)).ok, false);
    assert.equal((await Authorization.verify({ ...artifact, storageMutationHash: HASH })).ok, false);
    const missing = await Authorization.create(plan({ encoding: false }));
    assert.equal((await Authorization.verify(missing, {
        authorizationIdentityHash: artifact.authorizationIdentityHash })).ok, false);
});

test("承認artifactはfake IndexedDB round-trip後も同一planへdeterministicに復元", async () => {
    const artifact = await Authorization.create(plan()), name = `plan-authorization-${Date.now()}-` +
        Math.random(), database = await new Promise((resolve, reject) => { const request = indexedDB.open(name, 1);
            request.onupgradeneeded = () => request.result.createObjectStore("artifacts", { keyPath: "sourceId" });
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const write = database.transaction("artifacts", "readwrite"); write.objectStore("artifacts").add(artifact);
    await new Promise((resolve, reject) => { write.oncomplete = resolve; write.onabort = () => reject(write.error); });
    const read = database.transaction("artifacts", "readonly"), request = read.objectStore("artifacts").get("source");
    const stored = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error); }); database.close();
    const verified = await Authorization.verify(stored, { authorizationIdentityHash:
        artifact.authorizationIdentityHash, storageMutationHash: artifact.storageMutationHash });
    assert.equal(verified.ok, true);
    assert.equal(Plan.canonicalPayload(verified.plan), artifact.canonicalPayload);
});

test("v2はproduction precondition identityをauthorizationへ独立束縛する", async () => {
    const artifact = await Authorization.createV2(plan(), precondition()), verified =
        await Authorization.verify(artifact, { contractVersion: 2,
            productionPreconditionIdentityHash: artifact.productionPreconditionIdentityHash,
            authorizationIdentityHash: artifact.authorizationIdentityHash });
    assert.equal(artifact.contractVersion, 2); assert.equal(verified.ok, true);
    assert.deepEqual(verified.productionPrecondition, precondition());
    assert.equal(await Authorization.productionPreconditionIdentity(precondition()),
        artifact.productionPreconditionIdentityHash);
    assert.notEqual((await Authorization.createV2(plan(), precondition({
        productionSnapshotFingerprint: "d".repeat(64) }))).authorizationIdentityHash,
    artifact.authorizationIdentityHash);
});

test("v2 verifierはprecondition欠落・変更・null/omitted差をfail-closed", async () => {
    const artifact = await Authorization.createV2(plan(), precondition()), cases = [
        { ...artifact, productionPrecondition: undefined },
        { ...artifact, productionPrecondition: { ...artifact.productionPrecondition,
            productionSnapshotFingerprint: "d".repeat(64) } },
        { ...artifact, productionPrecondition: { ...artifact.productionPrecondition,
            storeCounts: { ...artifact.productionPrecondition.storeCounts,
                marketCalendarEventEntries: 103 } } },
        { ...artifact, productionPrecondition: { ...artifact.productionPrecondition,
            schemaFingerprint: "d".repeat(64) } },
        { ...artifact, productionPrecondition: { ...artifact.productionPrecondition,
            sourceCursor: { sourceId: "source", runId: "r", acceptedAt: TIME,
                runKey: "source|r" } } },
        { ...artifact, productionPrecondition: Object.fromEntries(Object.entries(
            artifact.productionPrecondition).filter(([key]) => key !== "sourceCursor")) }
    ];
    for (const value of cases) assert.equal((await Authorization.verify(value)).ok, false);
});

test("v1はimmutable legacyとして検証しv2扱い・unknown version・暗黙昇格を拒否", async () => {
    const legacy = await Authorization.create(plan());
    assert.equal((await Authorization.verify(legacy)).ok, true);
    assert.equal((await Authorization.verify(legacy, { contractVersion: 2 })).ok, false);
    assert.equal((await Authorization.verify({ ...legacy, contractVersion: 2 })).ok, false);
    assert.equal((await Authorization.verify({ ...legacy, contractVersion: 99 })).ok, false);
    assert.equal("productionPrecondition" in legacy, false);
    assert.equal("productionPreconditionIdentityHash" in legacy, false);
});
