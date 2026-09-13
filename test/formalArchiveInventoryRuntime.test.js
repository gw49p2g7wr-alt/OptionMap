"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const fs = require("node:fs"); const path = require("node:path");
const { indexedDB } = require("fake-indexeddb");
const Runtime = require("../js/formalArchiveInventoryRuntime.js");
function storage(values = {}) { return { length: Object.keys(values).length,
    key: index => Object.keys(values)[index] || null,
    getItem: key => Object.hasOwn(values, key) ? values[key] : null,
    setItem: () => { throw new Error("write_forbidden"); },
    removeItem: () => { throw new Error("write_forbidden"); } }; }
async function createDatabase(descriptor) { await new Promise((resolve, reject) => {
    const request = indexedDB.open(descriptor.name, descriptor.version);
    request.onupgradeneeded = () => descriptor.stores.forEach(name =>
        request.result.createObjectStore(name)); request.onsuccess = () => {
            request.result.close(); resolve(); }; request.onerror = () => reject(request.error); }); }
test("runtime inventories existing databases without changing fingerprints", async () => {
    for (const descriptor of Runtime.DATABASES) await createDatabase(descriptor);
    const local = storage({ optionMapWeeklyFuturesHistory: JSON.stringify({ version: 1,
        entries: [] }) }); const result = await Runtime.runReadOnlyInventory({
            localStorage: local, indexedDB });
    assert.equal(result.readOnly, true); assert.equal(result.indexedDbUpgradeAttempted, false);
    assert.equal(result.fingerprintMatched, true);
    assert.equal(Object.values(result.databaseStatus).every(item => item.status === "ready"), true);
});
test("runtime source owns no storage write or schema upgrade API", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/formalArchiveInventoryRuntime.js"), "utf8");
    assert.doesNotMatch(source,
        /setItem|removeItem|\.clear\s*\(|\.put\s*\(|\.add\s*\(|createObjectStore|createIndex|readwrite/);
});
test("renderer exposes diagnostics only and does not wire UI Full Export Morning or Overall", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(html, /formalArchiveInventoryProjection\.js[\s\S]*formalArchiveInventoryRuntime\.js/);
    const collector = fs.readFileSync(path.join(__dirname, "../js/fullExportCollector.js"), "utf8");
    for (const source of [html.match(/<body[\s\S]*<\/body>/)?.[0] || "", collector]) {
        assert.doesNotMatch(source, /id="[^"]*formalArchiveInventory/i);
    }
    assert.doesNotMatch(collector, /FormalArchiveInventory|formalArchiveInventory/);
});
