const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { indexedDB } = require("fake-indexeddb");
const Iv = require("../js/qriOptionIv.js");
const History = require("../js/qriOptionIvHistory.js");
const Store = require("../js/storage/qriOptionIvHistoryStore.js");

let sequence = 0;
const makeStore = custom => Store.createStore({ indexedDB,
    databaseName: `${Store.DATABASE_NAME}-test-${++sequence}`, ...custom });
const canonical = (contract = "2026-09", tradingDate = "2026-09-07", value = 30) => ({
    parserVersion: 1, schemaVersion: 1, source: Iv.SOURCE,
    sourceUrl: contract === "2026-09" ? "https://svc.qri.jp/jpx/nkopm/" :
        "https://svc.qri.jp/jpx/nkopm/1", valueUnit: "percent_points", contract, tradingDate,
    pageUpdatedAt: `${tradingDate}T06:00:00+09:00`, lastTradingDate: `${contract}-10`, records: [
        { optionType: "call", strike: 40000,
            iv: { status: "available", value, sourceFormat: "plain_number" } },
        { optionType: "put", strike: 40000,
            iv: { status: "available", value: value + 1, sourceFormat: "plain_number" } }
    ] });
async function candidate(contract = "2026-09", tradingDate = "2026-09-07", value = 30,
    overrides = {}) {
    return (await History.createHistoryCandidate(canonical(contract, tradingDate, value), {
        acquisitionRole: contract === "2026-09" ? "active" : "next",
        parentMarketRefreshRequestId: "market-1", requestId: `${contract}-${tradingDate}-${value}`,
        acquisitionGeneration: value, formalPublicationGeneration: value + 1,
        parentOptionsVersionKey: `parent-${contract}`, fetchedAt: "2026-09-06T21:00:10Z",
        confirmedAt: "2026-09-06T21:00:20Z", formalStatus: "saved",
        origin: "formal_live", ...overrides })).candidate;
}

test("fresh independent DB initializes exactly three stores", async () => {
    const store = makeStore(); assert.deepEqual(await store.initialize(),
        { status: "ready", reason: null });
    const db = await store.openDatabase();
    assert.equal(db.name.startsWith(Store.DATABASE_NAME), true); assert.equal(db.version, 1);
    assert.deepEqual([...db.objectStoreNames].sort(), [Store.META_STORE, Store.ENTRY_STORE,
        Store.REVISION_STORE].sort());
    assert.equal((await store.loadHistory()).status, "empty");
});

test("round trip supports exact entry/revision lookup across contracts and dates", async () => {
    const store = makeStore();
    for (const item of [await candidate(), await candidate("2026-09", "2026-09-08", 31,
        { confirmedAt: "2026-09-07T21:00:20Z" }), await candidate("2026-10")])
        assert.equal((await store.persistCandidate(item)).saved, true);
    assert.deepEqual((await store.listContracts()).contracts, ["2026-09", "2026-10"]);
    assert.deepEqual((await store.listTradingDates("2026-09")).tradingDates,
        ["2026-09-07", "2026-09-08"]);
    assert.equal((await store.getEntry("2026-09", "2026-09-07")).entry.entryKey,
        "2026-09|2026-09-07");
    assert.equal((await store.getEntryByKey("2026-09|2026-09-07")).status, "available");
    assert.equal((await store.getActiveRevision("2026-09", "2026-09-07")).revision.contract,
        "2026-09");
    assert.equal((await store.getEntry("2026-11", "2026-09-07")).reason,
        "exact_entry_not_found");
    assert.equal((await store.getActiveRevision("2026-09", "2026-09-09")).reason,
        "exact_revision_not_found");
    assert.equal((await store.getEntry("2026-09", "2026-09-09")).entry, null);
});

test("revision and confirmation persistence dedupe atomically", async () => {
    const store = makeStore(); const first = await candidate();
    await store.persistCandidate(first);
    assert.equal((await store.persistCandidate(first)).outcome, "same_version");
    const nextRole = await History.createHistoryCandidate(first.canonical, {
        ...first.confirmations[0], acquisitionRole: "next", requestId: "next-request",
        confirmedAt: "2026-09-06T21:05:00Z", fetchedAt: first.fetchedAt,
        formalStatus: "unchanged", origin: "formal_live" });
    assert.equal((await store.persistCandidate(nextRole.candidate)).outcome, "confirmation_added");
    const revision = await candidate("2026-09", "2026-09-07", 35,
        { confirmedAt: "2026-09-06T22:00:20Z" });
    assert.equal((await store.persistCandidate(revision)).outcome, "revision_added");
    const entry = (await store.getEntry("2026-09", "2026-09-07")).entry;
    assert.equal(entry.revisions.length, 2);
    assert.equal(entry.revisions[0].confirmations.length, 2);
    assert.equal(entry.activeVersionKey, revision.versionKey);
});

test("concurrent same-revision roles retain both confirmations", async () => {
    const store = makeStore();
    const next = await candidate("2026-12", "2026-10-16", 40,
        { acquisitionRole: "next", requestId: "next-request" });
    const majorSq = await History.createHistoryCandidate(next.canonical, {
        ...next.confirmations[0], acquisitionRole: "major_sq", requestId: "major-request",
        confirmedAt: "2026-10-15T21:00:21Z", fetchedAt: next.fetchedAt,
        formalStatus: "unchanged", origin: "formal_live" });
    const results = await Promise.all([
        store.persistCandidate(next), store.persistCandidate(majorSq.candidate)
    ]);
    assert.deepEqual(results.map(item => item.outcome), ["added", "confirmation_added"]);
    const entry = (await store.getEntry("2026-12", "2026-10-16")).entry;
    assert.deepEqual(entry.revisions[0].confirmations.map(item => item.acquisitionRole).sort(),
        ["major_sq", "next"]);
});

test("failed transaction and quota failure preserve previous history", async () => {
    const store = makeStore(); await store.persistCandidate(await candidate());
    const before = (await store.loadHistory()).history;
    const revision = await candidate("2026-09", "2026-09-07", 40,
        { confirmedAt: "2026-09-06T22:00:20Z" });
    assert.equal((await store.persistCandidate(revision,
        { failAfter: "revisions" })).outcome, "indexeddb_transaction_failed");
    assert.deepEqual((await store.loadHistory()).history, before);
    assert.equal((await store.persistCandidate(revision, { failWith: "quota" })).outcome,
        "quota_failure");
    assert.deepEqual((await store.loadHistory()).history, before);
});

async function corrupt(store, storeName, record) {
    const db = await store.openDatabase(); const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(record); await new Promise((resolve, reject) => {
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
}

test("malformed entry, corrupted revision and orphan revision fail closed", async () => {
    for (const kind of ["entry", "revision", "orphan"]) {
        const store = makeStore(); const first = await candidate(); await store.persistCandidate(first);
        const entry = (await store.getEntry("2026-09", "2026-09-07")).entry;
        if (kind === "entry") await corrupt(store, Store.ENTRY_STORE,
            { entryKey: entry.entryKey, contract: entry.contract, tradingDate: "bad",
                activeVersionKey: entry.activeVersionKey, firstSeenAt: entry.firstSeenAt,
                lastSeenAt: entry.lastSeenAt });
        else {
            const revision = entry.revisions[0]; const stored = { revisionKey:
                `${entry.entryKey}|${revision.versionKey}`, entryKey: kind === "orphan" ? "missing" : entry.entryKey,
                ...structuredClone(revision) };
            if (kind === "revision") stored.signature = "0".repeat(64);
            await corrupt(store, Store.REVISION_STORE, stored);
        }
        assert.equal((await store.loadHistory()).status, "corrupted");
    }
});

test("malformed metadata is rejected without repair", async () => {
    const store = makeStore(); await store.persistCandidate(await candidate());
    const metadata = (await store.loadHistoryMetadata()).metadata;
    await corrupt(store, Store.META_STORE, { ...metadata, id: "history", extra: true });
    const loaded = await store.loadHistory();
    assert.equal(loaded.status, "corrupted");
    assert.equal((await store.persistCandidate(await candidate())).outcome,
        "corrupted_existing_history");
});

test("unavailable and open failure return explicit status without throwing", async () => {
    assert.deepEqual(await Store.createStore({ indexedDB: null }).initialize(),
        { status: "unavailable", reason: "indexeddb_unavailable" });
    const failing = Store.createStore({ indexedDB: { open() {
        const request = {}; queueMicrotask(() => { request.error = new Error("open failed");
            request.onerror(); }); return request; } } });
    assert.equal((await failing.loadHistory()).status, "unavailable");
    const blocked = Store.createStore({ indexedDB: { open() {
        const request = {}; queueMicrotask(() => request.onblocked()); return request;
    } } });
    assert.deepEqual(await blocked.initialize(),
        { status: "unavailable", reason: "indexeddb_open_blocked" });
});

test("read outputs are detached/deeply frozen and unrelated databases remain untouched", async () => {
    const store = makeStore(); await store.persistCandidate(await candidate());
    const loaded = await store.loadHistory(); assert.equal(Object.isFrozen(loaded), true);
    assert.equal(Object.isFrozen(loaded.history.entries[0].revisions[0].canonical.records), true);
    const otherName = `unrelated-${++sequence}`; const request = indexedDB.open(otherName, 1);
    const other = await new Promise((resolve, reject) => { request.onupgradeneeded = () =>
        request.result.createObjectStore("keep"); request.onsuccess = () => resolve(request.result);
        request.onerror = reject; });
    assert.deepEqual([...other.objectStoreNames], ["keep"]); other.close();
});

test("store is isolated from existing DB names, Node, IPC, filesystem and repair APIs", () => {
    const source = fs.readFileSync("js/storage/qriOptionIvHistoryStore.js", "utf8");
    assert.match(source, /optionMapQriOptionIvHistory/);
    assert.doesNotMatch(source, /optionMapQriOptionsHistory["']/);
    assert.doesNotMatch(source, /localStorage|ipcRenderer|require\(["'](?:fs|path)|fetch\s*\(|repair|deleteDatabase/);
});
