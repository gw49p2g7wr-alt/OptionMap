"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const fs = require("node:fs"); const path = require("node:path");
const Adapter = require("../js/formalArchive/participantFormalArchiveReadAdapter.js");
test("dual-read prefers archive and does not consult legacy", async () => { let legacyReads = 0;
    const adapter = Adapter.createParticipantFormalArchiveReadAdapter({ archiveReader: {
        readLatest: async () => ({ status: "available", revision: { versionKey: "archive" } }) },
    legacyReader: { readLatest: async () => { legacyReads += 1; return { status: "available" }; } } });
    const result = await adapter.readLatest(); assert.equal(result.source, "formal_archive");
    assert.equal(legacyReads, 0);
});
test("dual-read preserves existing history fallback boundary", async () => {
    const adapter = Adapter.createParticipantFormalArchiveReadAdapter({ archiveReader: {
        readRange: async () => ({ status: "corrupted", reason: "integrity_failed" }) },
    legacyReader: { readRange: async () => ({ status: "available", entries: ["legacy"] }) } });
    const result = await adapter.readRange({ limit: 2 });
    assert.equal(result.source, "legacy_participant_history"); assert.equal(result.fallback.used, true);
    assert.equal(result.fallback.archiveStatus, "corrupted");
});
test("Phase 2 remains disconnected from UI Full Export and legacy storage", () => {
    const files = ["js/formalArchive/participantFormalArchiveSchema.js",
        "js/storage/participantFormalArchiveStore.js",
        "js/formalArchive/participantFormalArchiveReadAdapter.js"];
    const source = files.map(file => fs.readFileSync(path.join(__dirname, "..", file), "utf8")).join("\n");
    assert.doesNotMatch(source, /localStorage|fullExport|document\.|optionMapParticipantHistory/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    for (const file of files) assert.equal(html.includes(file), false);
});
