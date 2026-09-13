"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const { indexedDB, IDBKeyRange } = require("fake-indexeddb");
const Schema = require("../js/formalArchive/participantFormalArchiveSchema.js");
const Writer = require("../js/formalArchive/participantFormalArchiveMigrationWriter.js");
const unique = () => `writer-${Date.now()}-${Math.random()}`;
function preview() { const sourceDate = "2026-09-14", entryKey = Schema.entryKeyFor(sourceDate),
    versionKey = "participant-set|2026-09-14|sha256:" + "a".repeat(64),
    revisionKey = `${entryKey}|${versionKey}`, timestamp = "2026-09-14T12:00:00.000Z",
    completeSet = { sourceDate, versionKey, signature: "a".repeat(64) }, metadata = {
        id: Schema.META_KEY, archiveSchemaVersion: 1, dataset: "participant", authorityClass: "formal",
        retentionPolicy: "preserve_formal_revisions", createdAt: timestamp, updatedAt: timestamp,
        integrityAlgorithm: "sha256", entryCount: 1, revisionCount: 1 }, entries = [{ entryKey,
        sourceDate, activeRevisionKey: revisionKey, firstSeenAt: timestamp, lastSeenAt: timestamp }],
    revisions = [{ revisionKey, entryKey, sourceDate, versionKey, contentSignature: "a".repeat(64),
        signatureAlgorithm: "sha256", signature: "a".repeat(64), confirmedAt: timestamp,
        replacedAt: null, revisionState: "active", completeSet }];
    return { semanticEquivalence: true, projectedArchiveFingerprint: null,
        counts: { projectedActiveRevisionCount: 1 }, projectedArchive: { metadata, entries, revisions } }; }
async function hashProjection(value) { const crypto = require("node:crypto"), canonical = item =>
    Array.isArray(item) ? `[${item.map(canonical).join(",")}]` : item && typeof item === "object" ?
        `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}` :
        JSON.stringify(item); return crypto.createHash("sha256").update(canonical(value)).digest("hex"); }
test("writer is forbidden without an explicit injected test or profile-copy target", async () => {
    for (const configuration of [{}, { indexedDB }, { indexedDB, targetEnvironment: "production",
        writeAuthorization: Writer.WRITE_AUTHORIZATION }]) { const writer =
            Writer.createParticipantFormalArchiveMigrationWriter(configuration);
        assert.equal((await writer.writeProjection(preview())).status, "forbidden"); }
});
test("test DB write is atomic and read-back matches counts active signature and fingerprint", async () => {
    const value = preview(); value.projectedArchiveFingerprint = await hashProjection(value.projectedArchive);
    const writer = Writer.createParticipantFormalArchiveMigrationWriter({ indexedDB, IDBKeyRange,
        databaseName: unique(), targetEnvironment: "test", writeAuthorization: Writer.WRITE_AUTHORIZATION,
        validateRevisionPayload: async () => true });
    const result = await writer.writeProjection(value);
    assert.equal(result.status, "verified"); assert.equal(result.entryCount, 1);
    assert.equal(result.revisionCount, 1); assert.equal(result.activeRevisionCount, 1);
    assert.equal(result.countsMatch, true); assert.equal(result.signaturesMatch, true);
    assert.equal(result.fingerprintMatched, true); assert.equal(result.integrity.status, "ready"); writer.close();
});
test("writer refuses a non-empty target and exposes no prune delete or clear API", async () => {
    const value = preview(); value.projectedArchiveFingerprint = await hashProjection(value.projectedArchive);
    const writer = Writer.createParticipantFormalArchiveMigrationWriter({ indexedDB, IDBKeyRange,
        databaseName: unique(), targetEnvironment: "profile_copy",
        writeAuthorization: Writer.WRITE_AUTHORIZATION, validateRevisionPayload: async () => true });
    assert.equal((await writer.writeProjection(value)).status, "verified");
    const second = await writer.writeProjection(value); assert.equal(second.reason, "target_archive_not_empty");
    for (const term of ["prune", "delete", "clear"]) assert.equal(Object.keys(writer)
        .some(key => key.toLowerCase().includes(term)), false); writer.close();
});
