"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { IDBFactory } = require("fake-indexeddb");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Tools = require("../js/marketCalendarHistory/readOnlyGateTools.js");
const Probe = require("../scripts/marketCalendarReadOnlyProbe.js");
const ReadOnlySchema = require("../scripts/marketCalendarReadOnlySchema.js");
const name = Schema.DATABASE_NAME;
const create = (indexedDB, valid = true) => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => valid ? Schema.createInUpgrade(request.result) :
        request.result.createObjectStore("wrongStore");
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
});
const run = (indexedDB, gateTools = Tools) => Probe.run({ indexedDB, gateTools,
    sourceId: "us-bea-calendar", databaseName: name, origin: "file://isolated",
    session: "isolated-test" });
const stages = value => value.stages.map(item => item.stage);

test("isolated normal snapshot uses browser-compatible read-only Gate tools and closes connections", async () => {
    const indexedDB = new IDBFactory(); await create(indexedDB); const value = await run(indexedDB);
    assert.equal(value.ok, true, JSON.stringify(value));
    assert.equal(value.result.inventory.status, "compatible");
    assert.equal(value.result.counts.marketCalendarEventEntries, 0);
    assert.equal(value.result.sourceCursor, null);
    assert.match(value.result.externalHistoryFingerprint, /^[a-f0-9]{64}$/);
    for (const stage of ["probe_started", "origin_session_confirmed", "db_catalog_confirmed",
        "target_db_checked", "indexeddb_open_started", "indexeddb_open_success",
        "readonly_transaction_started", "readonly_transaction_complete",
        "schema_inventory_confirmed", "snapshot_counts_fingerprint_acquired",
        "source_cursor_acquired", "source_excluded_fingerprint_acquired", "connection_close",
        "probe_finished"]) assert.ok(stages(value).includes(stage), stage);
    assert.equal(value.resources.openConnections, 0);
    assert.equal(value.resources.activeTransactions, 0);
});
test("absent target is rejected without any open", async () => { const value = await run(new IDBFactory());
    assert.equal(value.ok, false); assert.equal(value.result.inventory.status, "absent");
    assert.equal(value.resources.openAttempts, 0);
    assert.equal(value.resources.activeTransactions, 0);
    assert.equal(stages(value).includes("indexeddb_open_started"), false);
});
test("catalog-only mode never opens a database", async () => {
    const indexedDB = new IDBFactory(); await create(indexedDB);
    const value = await Probe.run({ indexedDB, mode: "catalog", databaseName: name,
        origin: "file://isolated", session: "isolated-test" });
    assert.equal(value.ok, true);
    assert.equal(value.outcome, "catalog_only_complete");
    assert.equal(value.resources.openAttempts, 0);
    assert.equal(value.resources.openConnections, 0);
    assert.equal(value.resources.activeTransactions, 0);
});
test("schema mismatch is rejected and its inventory connection closes", async () => {
    const indexedDB = new IDBFactory(); await create(indexedDB, false); const value = await run(indexedDB);
    assert.equal(value.ok, false); assert.equal(value.result.inventory.status, "incompatible");
    assert.equal(value.resources.openConnections, 0);
    assert.ok(stages(value).includes("connection_close"));
});
test("open failure is rejected", async () => { const real = new IDBFactory(); await create(real);
    const indexedDB = { databases: () => real.databases(), open: () => { throw Error("open_failed"); } },
        value = await run(indexedDB);
    assert.equal(value.ok, false); assert.equal(value.result.inventory.reason, "readonly_open_failed");
    assert.equal(value.resources.openConnections, 0);
});
test("catalog race aborts upgrade and does not create the target", async () => {
    const real = new IDBFactory(), indexedDB = { databases: async () => [{ name }],
        open: target => real.open(target) }, value = await run(indexedDB);
    assert.equal(value.ok, false);
    assert.ok(stages(value).includes("version_upgrade_forbidden"));
    assert.equal((await real.databases()).some(item => item.name === name), false);
});
test("transaction failure closes the opened connection", async () => {
    const indexedDB = new IDBFactory(); await create(indexedDB);
    const gateTools = { preflight: async ({ indexedDB: guarded }) => { await guarded.databases();
        const database = await new Promise((resolve, reject) => { const request = guarded.open(name);
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        assert.throws(() => database.transaction(["wrongStore"], "readonly"));
        throw Error("transaction_failed"); } }, value = await run(indexedDB, gateTools);
    assert.equal(value.ok, false); assert.equal(value.error, "transaction_failed");
    assert.equal(value.resources.openConnections, 0);
    assert.ok(stages(value).includes("connection_close"));
});
test("mid-probe termination equivalent is never success and cleans up", async () => {
    const indexedDB = new IDBFactory(); await create(indexedDB);
    const gateTools = { preflight: async ({ indexedDB: guarded }) => { await guarded.databases();
        await new Promise((resolve, reject) => { const request = guarded.open(name);
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        throw Error("probe_interrupted"); } }, value = await run(indexedDB, gateTools);
    assert.equal(value.ok, false); assert.equal(value.error, "probe_interrupted");
    assert.equal(value.resources.openConnections, 0);
    assert.ok(stages(value).includes("connection_close"));
});
test("readwrite transaction is blocked at the guard boundary", async () => {
    const indexedDB = new IDBFactory(); await create(indexedDB);
    const gateTools = { preflight: async ({ indexedDB: guarded }) => { await guarded.databases();
        const database = await new Promise((resolve, reject) => { const request = guarded.open(name);
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        assert.throws(() => database.transaction([], "readwrite"), /readwrite_transaction_forbidden/);
        throw Error("guard_verified"); } }, value = await run(indexedDB, gateTools);
    assert.equal(value.ok, false); assert.equal(value.resources.openConnections, 0);
});
test("open request exposes abort only, and database facade exposes no writer", async () => {
    const indexedDB = new IDBFactory(); await create(indexedDB);
    const guard = Probe.createGuard(indexedDB, name, () => {});
    await guard.guard.databases();
    const database = await new Promise((resolve, reject) => { const request = guard.guard.open(name);
        request.onsuccess = () => { assert.equal(request.transaction, null);
            resolve(request.result); }; request.onerror = () => reject(request.error); });
    assert.deepEqual(Object.keys(database).sort(), ["close", "name", "objectStoreNames",
        "transaction", "version"].sort());
    assert.equal(database.createObjectStore, undefined);
    assert.equal(database.deleteObjectStore, undefined);
    assert.throws(() => database.transaction([], "readwrite"), /readwrite_transaction_forbidden/);
    guard.closeAll(); await guard.settle();
    assert.equal(guard.state().openConnections, 0);
    assert.equal(guard.state().activeTransactions, 0);
});
test("probe and host expose no mutation or dynamic module injection", () => {
    const source = fs.readFileSync(path.resolve(__dirname,
        "../scripts/marketCalendarReadOnlyProbe.js"), "utf8"), html = fs.readFileSync(path.resolve(__dirname,
        "../scripts/marketCalendarReadOnlyProbe.html"), "utf8"), host = fs.readFileSync(path.resolve(__dirname,
        "../scripts/marketCalendarReadOnlyProbeHost.js"), "utf8"), schema = fs.readFileSync(
        path.resolve(__dirname, "../scripts/marketCalendarReadOnlySchema.js"), "utf8");
    assert.doesNotMatch(source, /node:vm|\beval\s*\(|new Function\s*\(|"readwrite"|createObjectStore\s*\(/);
    assert.doesNotMatch(html, /productionHistoryWriter|approvalArtifactDelivery|<script(?!\s+src=)/);
    assert.match(host, /render-process-gone/);
    assert.match(host, /mkdtempSync/);
    assert.doesNotMatch(schema, /createObjectStore|deleteObjectStore|"readwrite"/);
    assert.deepEqual(Object.keys(ReadOnlySchema).sort(), ["DATABASE_NAME", "inspect", "fingerprint"].sort());
});
test("packaged probe includes only read-only browser assets", () => {
    const files = require("../package.json").build.files;
    for (const file of ["scripts/marketCalendarReadOnlyProbe.html",
        "scripts/marketCalendarReadOnlyProbeEarly.js", "scripts/marketCalendarReadOnlyProbe.js",
        "scripts/marketCalendarReadOnlyProbeBoot.js",
        "scripts/marketCalendarReadOnlyAuditReportPreload.js",
        "scripts/marketCalendarReadOnlySchema.js"]) assert.ok(files.includes(file), file);
    assert.equal(files.includes("scripts/marketCalendarReadOnlyProbeFixture.html"), false);
    assert.equal(files.includes("scripts/marketCalendarReadOnlyProbeHost.js"), false);
});
test("read-only browser schema projection matches production schema fingerprint", async () => {
    const indexedDB = new IDBFactory(); await create(indexedDB);
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { assert.equal(await ReadOnlySchema.fingerprint(ReadOnlySchema.inspect(database)),
        Schema.EXPECTED_FINGERPRINT); } finally { database.close(); }
});
