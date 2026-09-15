"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { indexedDB } = require("fake-indexeddb");
const Inventory = require("../js/marketCalendarHistory/readOnlyProductionInventory.js");
const name = suffix => `phase3f-${suffix}-${Date.now()}-${Math.random()}`;
const openSeed = databaseName => new Promise((resolve, reject) => { const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("existing", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });

test("存在しないDBはopenせず作成もしない", async () => {
    const databaseName = name("absent"), before = await indexedDB.databases(), result = await Inventory.inspect({
        indexedDB, databaseName, expectedStores: ["entries"] }), after = await indexedDB.databases();
    assert.equal(result.status, "absent"); assert.equal(result.opened, false);
    assert.equal(before.some(item => item.name === databaseName), false);
    assert.equal(after.some(item => item.name === databaseName), false);
});

test("既存DBはreadonly inventoryだけ取得", async () => {
    const databaseName = name("existing"), db = await openSeed(databaseName);
    let tx = db.transaction("existing", "readwrite"); tx.objectStore("existing").add({ id: 1 });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = reject; }); db.close();
    const result = await Inventory.inspect({ indexedDB, databaseName, expectedStores: ["existing"] });
    assert.equal(result.status, "compatible"); assert.equal(result.counts.existing, 1);
    assert.deepEqual(result.missingStores, []);
});

test("databases APIなしではopenを試みずunsupported", async () => {
    let opened = false; const result = await Inventory.inspect({ indexedDB: { open() { opened = true; } },
        databaseName: "production" });
    assert.equal(result.status, "unsupported"); assert.equal(opened, false);
});

test("production inventory moduleにschema mutation/readwrite経路がない", () => {
    const source = fs.readFileSync(path.resolve(__dirname,
        "../js/marketCalendarHistory/readOnlyProductionInventory.js"), "utf8");
    assert.doesNotMatch(source, /createObjectStore|deleteObjectStore|\"readwrite\"|\.put\(|\.add\(|\.delete\(|\.clear\(/);
    assert.doesNotMatch(source, /indexedDB\s*=\s*configuration\.indexedDB\s*\|\|/);
});
