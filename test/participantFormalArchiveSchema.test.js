"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const Schema = require("../js/formalArchive/participantFormalArchiveSchema.js");
test("Formal Archive v1 fixes long-retention Participant stores and indexes", () => {
    assert.equal(Schema.DATABASE_NAME, "optionMapFormalArchive");
    assert.equal(Schema.DATABASE_VERSION, 1);
    assert.equal(Schema.RETENTION_POLICY, "preserve_formal_revisions");
    assert.deepEqual(Object.keys(Schema.STORE_DEFINITIONS), ["archiveMetadata",
        "participantEntries", "participantRevisions"]);
    assert.deepEqual(Schema.STORE_DEFINITIONS.participantEntries.indexes.map(item => item.name),
        ["bySourceDate", "byActiveRevisionKey"]);
    assert.deepEqual(Schema.STORE_DEFINITIONS.participantRevisions.indexes.map(item => item.name),
        ["byEntryKey", "bySourceDate", "byVersionKey", "byRevisionState"]);
});
test("active and replaced revision records have explicit integrity state", () => {
    const base = { revisionKey: "participant|2026-09-14|version-1",
        entryKey: "participant|2026-09-14", sourceDate: "2026-09-14", versionKey: "version-1",
        signatureAlgorithm: "sha256", signature: "a".repeat(64),
        contentSignature: "a".repeat(64),
        confirmedAt: "2026-09-14T01:00:00.000Z", completeSet: {} };
    assert.equal(Schema.validateRevision({ ...base, revisionState: "active", replacedAt: null }), true);
    assert.equal(Schema.validateRevision({ ...base, revisionState: "replaced",
        replacedAt: "2026-09-14T02:00:00.000Z" }), true);
    assert.equal(Schema.validateRevision({ ...base, revisionState: "active",
        replacedAt: "2026-09-14T02:00:00.000Z" }), false);
});
