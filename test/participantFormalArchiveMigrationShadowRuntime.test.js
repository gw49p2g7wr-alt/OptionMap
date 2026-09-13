"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const fs = require("node:fs"); const path = require("node:path");
const Runtime = require("../js/formalArchive/participantFormalArchiveMigrationShadowRuntime.js");
test("runtime reads only the existing Participant key and returns blocked diagnostics", async () => {
    const calls = [], storage = { getItem(key) { calls.push(key); return JSON.stringify({ entries: [] }); },
        setItem() { throw new Error("write forbidden"); } };
    const result = await Runtime.runShadowPreview(storage);
    assert.deepEqual(calls, ["optionMapParticipantHistory"]); assert.equal(result.status, "blocked");
    assert.equal(result.result.diagnostics.storageWritten, false);
});
test("shadow source owns no DB write upgrade UI or Full Export connection", () => {
    const files = ["js/formalArchive/participantFormalArchiveMigrationPreview.js",
        "js/formalArchive/participantFormalArchiveMigrationShadowRuntime.js"], source = files.map(file =>
        fs.readFileSync(path.join(__dirname, "..", file), "utf8")).join("\n");
    assert.doesNotMatch(source, /indexedDB|\.openArchive|\.setItem|\.removeItem|createObjectStore|readwrite|\.put\(|\.add\(|\.delete\(|\.clear\(|getElementById|querySelector|OptionMapFullExport/i);
    assert.match(source, /fullExportConnected:\s*false/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    for (const file of files) assert.equal(html.includes(file), false);
});
