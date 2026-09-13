"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const { indexedDB, IDBKeyRange } = require("fake-indexeddb");
const Schema = require("../js/formalArchive/participantFormalArchiveSchema.js");
const Store = require("../js/storage/participantFormalArchiveStore.js");
const unique = name => `${name}-${Date.now()}-${Math.random()}`;
const request = value => new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error); tx.onerror = () => undefined; });
function records(sourceDate, suffix = "1") { const entryKey = Schema.entryKeyFor(sourceDate),
    versionKey = `version-${sourceDate}-${suffix}`, revisionKey = `${entryKey}|${versionKey}`,
    confirmedAt = `${sourceDate}T01:00:00.000Z`;
    return { entry: { entryKey, sourceDate, activeRevisionKey: revisionKey,
        firstSeenAt: confirmedAt, lastSeenAt: confirmedAt }, revision: { revisionKey, entryKey,
        sourceDate, versionKey, signatureAlgorithm: "sha256", signature: "a".repeat(64),
        confirmedAt, replacedAt: null, revisionState: "active", completeSet: { sourceDate } } }; }
async function seed(store, rows) { const db = await store.openArchive(), tx = db.transaction([
    Schema.META_STORE, Schema.ENTRY_STORE, Schema.REVISION_STORE], "readwrite");
    for (const row of rows) { tx.objectStore(Schema.ENTRY_STORE).put(row.entry);
        tx.objectStore(Schema.REVISION_STORE).put(row.revision); }
    tx.objectStore(Schema.META_STORE).put({ id: Schema.META_KEY, archiveSchemaVersion: 1,
        dataset: "participant", authorityClass: "formal", retentionPolicy:
        "preserve_formal_revisions", createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-14T00:00:00.000Z", integrityAlgorithm: "sha256",
        entryCount: rows.length, revisionCount: rows.length }); await done(tx); }
test("opening a new archive creates only the specified v1 stores and indexes", async () => {
    const store = Store.createParticipantFormalArchiveStore({ indexedDB, IDBKeyRange,
        databaseName: unique("schema") }), db = await store.openArchive();
    assert.deepEqual([...db.objectStoreNames], ["archiveMetadata", "participantEntries",
        "participantRevisions"]); const tx = db.transaction(Schema.REVISION_STORE, "readonly");
    assert.deepEqual([...tx.objectStore(Schema.REVISION_STORE).indexNames],
        ["byEntryKey", "byRevisionState", "bySourceDate", "byVersionKey"]); await done(tx);
    store.closeArchive();
});
test("range and revision reads are lazy and cursor based", async () => {
    const store = Store.createParticipantFormalArchiveStore({ indexedDB, IDBKeyRange,
        databaseName: unique("range") }), rows = [records("2026-09-10"), records("2026-09-11"),
            records("2026-09-14")]; await seed(store, rows);
    const first = await store.readRange({ from: "2026-09-01", to: "2026-09-30", limit: 2 });
    assert.deepEqual(first.entries.map(item => item.sourceDate), ["2026-09-10", "2026-09-11"]);
    assert.equal(first.nextCursor, "2026-09-11");
    const second = await store.readRange({ from: "2026-09-01", to: "2026-09-30", limit: 2,
        afterSourceDate: first.nextCursor }); assert.deepEqual(second.entries.map(item => item.sourceDate),
        ["2026-09-14"]);
    assert.equal((await store.readRevision(rows[0].revision.revisionKey)).status, "available");
    assert.equal((await store.readLatest()).entry.sourceDate, "2026-09-14"); store.closeArchive();
});
test("integrity and capacity diagnostics are explicit read operations", async () => {
    const store = Store.createParticipantFormalArchiveStore({ indexedDB, IDBKeyRange,
        databaseName: unique("diagnostic"), storageManager: { estimate: async () =>
            ({ usage: 1000, quota: 100000 }) }, validateRevisionPayload: async () => true }),
        rows = [records("2026-09-14")];
    await seed(store, rows); const integrity = await store.readIntegrity();
    assert.equal(integrity.status, "ready"); assert.equal(integrity.orphanRevisionCount, 0);
    const capacity = await store.readCapacityDiagnostic(); assert.equal(capacity.status, "available");
    assert.ok(capacity.archivePayloadBytes > 0); assert.equal(capacity.originQuotaBytes, 100000);
    store.closeArchive();
});
test("integrity never reports signatures verified without a payload validator", async () => {
    const store = Store.createParticipantFormalArchiveStore({ indexedDB, IDBKeyRange,
        databaseName: unique("unverified") }), rows = [records("2026-09-14")];
    await seed(store, rows); const integrity = await store.readIntegrity();
    assert.equal(integrity.status, "unverified"); assert.equal(integrity.unverifiedRevisionCount, 1);
    store.closeArchive();
});
test("public store contract has no write migration delete or pruning API", () => {
    const store = Store.createParticipantFormalArchiveStore({ indexedDB, IDBKeyRange,
        databaseName: unique("boundary") });
    for (const name of ["write", "put", "commit", "migrate", "delete", "clear", "prune"])
        assert.equal(Object.keys(store).some(key => key.toLowerCase().includes(name)), false);
});
