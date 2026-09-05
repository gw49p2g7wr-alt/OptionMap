const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { indexedDB } = require("fake-indexeddb");
const qri = require("../js/qriOptions.js");
const historyApi = require("../js/qriOptionsHistory.js");
const storeApi = require("../js/storage/qriOptionsHistoryStore.js");
const persistenceApi = require("../js/qriOptionsHistoryPersistence.js");

let databaseSequence = 0;
const timestamp = "2026-08-18T08:00:00.000Z";
const urlFor = contract => contract === "2026-09"
    ? "https://svc.qri.jp/jpx/nkopm/" : "https://svc.qri.jp/jpx/nkopm/1";

function canonical({ contract = "2026-09", tradingDate = "2026-08-18",
    pageUpdatedAt = "2026-08-18T16:00:00+09:00", value = 100,
    status = "available" } = {}) {
    const sourceUrl = urlFor(contract);
    const month = Number(contract.slice(5));
    const published = status === "available";
    return { parserVersion: 2, schemaVersion: 2, source: qri.SOURCE,
        sourceUrl, pageUpdatedAt, tradingDate, openInterestAsOf: null,
        contract, gengetsu: contract.replace("-", ""), contractLabel: `${month}月限月`,
        isActiveContract: true, lastTradingDate: `${contract}-10`,
        openInterestStatus: status,
        availableContracts: [{ contract, label: `${month}月限月`, url: sourceUrl,
            active: true, gengetsu: contract.replace("-", ""),
            lastTradingDate: `${contract}-10` }],
        records: [
            { contract, optionType: "call", strike: 40000, published, value: published ? value : null },
            { contract, optionType: "put", strike: 40000, published, value: published ? value + 1 : null },
            { contract, optionType: "call", strike: 40500, published, value: published ? 0 : null },
            { contract, optionType: "put", strike: 40500, published, value: published ? value + 2 : null }
        ] };
}

async function cache(options = {}) {
    return qri.createCacheV2(canonical(options), timestamp);
}
function makeStore() {
    return storeApi.createQriOptionsHistoryStore({ indexedDB,
        databaseName: `${storeApi.DATABASE_NAME}-test-${++databaseSequence}` });
}

test("candidate uses tradingDate and rejects v1, unavailable, signature and version tampering", async () => {
    const formal = await cache();
    const result = await historyApi.createHistoryCandidate(formal);
    assert.equal(result.ok, true);
    assert.equal(result.candidate.sourceDateKey, "2026-08-18");
    assert.equal(result.candidate.entryKey, "2026-09|2026-08-18");
    assert.equal((await historyApi.createHistoryCandidate({ version: 1 })).reason,
        "unsupported_cache_version");
    assert.equal((await historyApi.createHistoryCandidate(await cache({ status: "unavailable" }))).reason,
        "open_interest_unavailable");
    const signature = structuredClone(formal); signature.signature = "0".repeat(64);
    assert.equal((await historyApi.createHistoryCandidate(signature)).ok, false);
    const version = structuredClone(formal); version.versionKey += "x";
    assert.equal((await historyApi.createHistoryCandidate(version)).reason, "version_key_mismatch");
    const contract = structuredClone(formal); contract.contract = "2026-10";
    assert.equal((await historyApi.createHistoryCandidate(contract)).reason, "contract_mismatch");
    const record = structuredClone(formal); record.canonical.records[0].contract = "2026-10";
    assert.equal((await historyApi.createHistoryCandidate(record)).reason, "record_contract_mismatch");
});

test("future tradingDate is preserved while a new revision records its JST snapshot date", async () => {
    const original = canonical({ tradingDate: "2026-09-07",
        pageUpdatedAt: "2026-09-05T18:45:00+09:00" });
    const formal = await qri.createCacheV2(original, "2026-09-05T09:45:30.000Z");
    const candidate = (await historyApi.createHistoryCandidate(formal)).candidate;
    const merged = await historyApi.mergeCandidate(historyApi.createEmptyQriOptionsHistory(),
        candidate, { confirmedAt: "2026-09-05T09:46:00.000Z" });
    assert.equal(merged.changed, true);
    const entry = merged.history.entries[0];
    const revision = entry.revisions[0];
    assert.deepEqual({ sourceDateKey: entry.sourceDateKey, entryKey: entry.entryKey,
        tradingDate: revision.tradingDate, canonicalTradingDate: revision.canonical.tradingDate,
        pageUpdatedAt: revision.pageUpdatedAt,
        canonicalPageUpdatedAt: revision.canonical.pageUpdatedAt,
        snapshotDate: revision.snapshotDate }, {
        sourceDateKey: "2026-09-07", entryKey: "2026-09|2026-09-07",
        tradingDate: "2026-09-07", canonicalTradingDate: "2026-09-07",
        pageUpdatedAt: "2026-09-05T18:45:00+09:00",
        canonicalPageUpdatedAt: "2026-09-05T18:45:00+09:00",
        snapshotDate: "2026-09-05"
    });
    assert.equal((await historyApi.validateHistory(merged.history)).valid, true);
});

test("snapshotDate uses Asia/Tokyo calendar boundaries", () => {
    assert.equal(historyApi.snapshotDateFromConfirmedAt("2026-09-05T14:59:59.999Z"),
        "2026-09-05");
    assert.equal(historyApi.snapshotDateFromConfirmedAt("2026-09-05T15:00:00.000Z"),
        "2026-09-06");
    assert.equal(historyApi.snapshotDateFromConfirmedAt("2026-09-05T00:01:00+09:00"),
        "2026-09-05");
});

test("legacy revision without snapshotDate remains valid and explicit mismatch is rejected", async () => {
    const candidate = (await historyApi.createHistoryCandidate(await cache())).candidate;
    const history = (await historyApi.mergeCandidate(historyApi.createEmptyQriOptionsHistory(),
        candidate, { confirmedAt: "2026-09-05T15:00:00.000Z" })).history;
    const legacy = structuredClone(history);
    delete legacy.entries[0].revisions[0].snapshotDate;
    assert.equal((await historyApi.validateHistory(legacy)).valid, true);
    assert.equal(historyApi.effectiveSnapshotDate(legacy.entries[0].revisions[0]),
        "2026-09-06");
    assert.equal("snapshotDate" in legacy.entries[0].revisions[0], false);
    const mismatch = structuredClone(history);
    mismatch.entries[0].revisions[0].snapshotDate = "2026-09-05";
    assert.deepEqual((await historyApi.validateHistory(mismatch)).errors,
        ["2026-09|2026-08-18:snapshot_date_mismatch"]);
});

test("history stores first entry, multiple dates, contract roll and active revisions", async () => {
    let history = historyApi.createEmptyQriOptionsHistory();
    for (const [options, confirmedAt] of [
        [{ tradingDate: "2026-08-17" }, "2026-08-17T08:00:00Z"],
        [{ tradingDate: "2026-08-18" }, "2026-08-18T08:00:00Z"],
        [{ contract: "2026-10", tradingDate: "2026-08-18" }, "2026-08-18T08:01:00Z"]
    ]) {
        const candidate = (await historyApi.createHistoryCandidate(await cache(options))).candidate;
        const merged = await historyApi.mergeCandidate(history, candidate, { confirmedAt });
        assert.equal(merged.changed, true); history = merged.history;
    }
    assert.deepEqual(historyApi.listContracts(history), ["2026-09", "2026-10"]);
    assert.deepEqual(historyApi.listSourceDates(history, "2026-09"),
        ["2026-08-17", "2026-08-18"]);
    const revised = (await historyApi.createHistoryCandidate(await cache({ value: 200,
        pageUpdatedAt: "2026-08-18T17:00:00+09:00" }))).candidate;
    const merged = await historyApi.mergeCandidate(history, revised,
        { confirmedAt: "2026-08-18T09:00:00Z" });
    const entry = merged.history.entries.find(item => item.entryKey === "2026-09|2026-08-18");
    assert.equal(entry.revisions.length, 2);
    assert.equal(entry.revisions[0].replacedAt, "2026-08-18T09:00:00Z");
    assert.equal(historyApi.getActiveRevision(merged.history, "2026-09", "2026-08-18")
        .canonical.records[0].value, 200);
    assert.equal((await historyApi.mergeCandidate(merged.history, revised,
        { confirmedAt: "2026-08-18T10:00:00Z" })).outcome, "same_version");
    assert.equal((await historyApi.validateHistory(merged.history)).valid, true);
});

test("validator rejects active, contract, record, signature, version and duplicate corruption", async () => {
    const candidate = (await historyApi.createHistoryCandidate(await cache())).candidate;
    const history = (await historyApi.mergeCandidate(historyApi.createEmptyQriOptionsHistory(),
        candidate, { confirmedAt: timestamp })).history;
    for (const mutate of [
        value => { value.parserVersion = 1; },
        value => { value.schemaVersion = 1; },
        value => { value.entries[0].activeVersionKey = "missing"; },
        value => { value.entries[0].revisions[0].contract = "2026-10"; },
        value => { value.entries[0].revisions[0].canonical.records[0].contract = "2026-10"; },
        value => { value.entries[0].revisions[0].signature = "0".repeat(64); },
        value => { value.entries[0].revisions[0].versionKey += "x"; },
        value => { value.entries.push(structuredClone(value.entries[0])); }
    ]) {
        const broken = structuredClone(history); mutate(broken);
        assert.equal((await historyApi.validateHistory(broken)).valid, false);
    }
});

test("IndexedDB initializes three stores and atomically persists, restores and lists", async () => {
    const store = makeStore();
    const db = await store.openHistoryStore();
    assert.deepEqual([...db.objectStoreNames].sort(), [storeApi.ENTRY_STORE,
        storeApi.META_STORE, storeApi.REVISION_STORE].sort());
    const first = (await historyApi.createHistoryCandidate(await cache())).candidate;
    assert.deepEqual(await store.persistCandidate(first, { confirmedAt: timestamp }),
        { saved: true, outcome: "added" });
    assert.equal((await store.loadHistoryMeta()).historyVersion, 1);
    assert.deepEqual(await store.listContracts(), ["2026-09"]);
    assert.deepEqual(await store.listSourceDates("2026-09"), ["2026-08-18"]);
    assert.equal((await store.getActiveRevision("2026-09", "2026-08-18")).status,
        "available");
    assert.equal((await store.persistCandidate(first, { confirmedAt: timestamp })).outcome,
        "same_version");
    store.closeHistoryStore();
    assert.equal((await store.loadHistory()).status, "ready");
});

test("history read projects no data and opens no readwrite transaction", async () => {
    const store = makeStore();
    const first = (await historyApi.createHistoryCandidate(await cache())).candidate;
    await store.persistCandidate(first, { confirmedAt: timestamp });
    const db = await store.openHistoryStore();
    const transaction = db.transaction.bind(db);
    let readwriteTransactions = 0;
    db.transaction = (...args) => {
        if (args[1] === "readwrite") readwriteTransactions += 1;
        return transaction(...args);
    };
    const loaded = await store.loadHistory();
    assert.equal(loaded.status, "ready");
    assert.equal(readwriteTransactions, 0);
});

test("same-day revision is atomic and injected transaction failure preserves existing history", async () => {
    const store = makeStore();
    const first = (await historyApi.createHistoryCandidate(await cache())).candidate;
    await store.persistCandidate(first, { confirmedAt: timestamp });
    const before = (await store.loadHistory()).history;
    const revision = (await historyApi.createHistoryCandidate(await cache({ value: 300,
        pageUpdatedAt: "2026-08-18T18:00:00+09:00" }))).candidate;
    const failed = await store.persistCandidate(revision,
        { confirmedAt: "2026-08-18T10:00:00Z", failAfter: "revisions" });
    assert.equal(failed.outcome, "transaction_failed");
    assert.deepEqual((await store.loadHistory()).history, before);
    const saved = await store.persistCandidate(revision,
        { confirmedAt: "2026-08-18T10:00:00Z" });
    assert.equal(saved.outcome, "revision_added");
    assert.equal((await store.loadEntry("2026-09", "2026-08-18")).entry.revisions.length, 2);
});

test("corrupted stored history is rejected instead of repaired", async () => {
    const store = makeStore();
    const first = (await historyApi.createHistoryCandidate(await cache())).candidate;
    await store.persistCandidate(first, { confirmedAt: timestamp });
    const db = await store.openHistoryStore();
    const meta = await store.loadHistoryMeta();
    const tx = db.transaction(storeApi.META_STORE, "readwrite");
    tx.objectStore(storeApi.META_STORE).put({ ...meta, parserVersion: 1 });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
    assert.equal((await store.loadHistory()).status, "corrupted");
    assert.equal((await store.persistCandidate(first, { confirmedAt: timestamp })).outcome,
        "corrupted_existing_history");
});

test("persistence saves auto only, rejects stale and never treats unpublished as zero", async () => {
    const store = makeStore();
    const persistence = persistenceApi.createQriOptionsHistoryPersistence({ store,
        now: () => timestamp });
    await persistence.openPersistence();
    assert.equal((await persistence.persistActiveContractCache(await cache(),
        { mode: "specific" })).reason, "specific_display_not_persisted");
    assert.equal((await store.loadHistory()).status, "empty");
    assert.equal((await persistence.persistActiveContractCache(await cache(),
        { mode: "auto", isCurrentRequest: () => false })).reason, "stale_request");
    assert.equal((await persistence.persistActiveContractCache(await cache(),
        { mode: "auto", isCurrentRequest: () => true })).status, "saved");
    const revision = (await store.getActiveRevision("2026-09", "2026-08-18")).revision;
    assert.equal(revision.canonical.records.find(item => item.value === 0).published, true);
});

test("reference history adds a separate contract without changing the existing entry", async () => {
    const store = makeStore();
    const persistence = persistenceApi.createQriOptionsHistoryPersistence({ store,
        now: () => timestamp });
    await persistence.openPersistence();
    await persistence.persistActiveContractCache(await cache(),
        { mode: "auto", isCurrentRequest: () => true });
    const existing = structuredClone((await store.loadHistory()).history.entries[0]);
    const referenceCache = await cache({ contract: "2026-10" });
    const inputBefore = structuredClone(referenceCache);
    const result = await persistence.persistReferenceContractCache(referenceCache, {
        mode: "reference_history", acquisitionOrigin: "live", requestId: "reference-1",
        requestedContract: "2026-10", sourceUrl: urlFor("2026-10"),
        isCurrentRequest: () => true
    });
    assert.equal(result.status, "saved");
    const history = (await store.loadHistory()).history;
    assert.deepEqual(historyApi.listContracts(history), ["2026-09", "2026-10"]);
    assert.deepEqual(history.entries.find(entry => entry.contract === "2026-09"), existing);
    const reference = history.entries.find(entry => entry.contract === "2026-10");
    assert.equal(reference.entryKey, "2026-10|2026-08-18");
    assert.equal(reference.activeVersionKey, reference.revisions[0].versionKey);
    assert.notEqual(reference.activeVersionKey, existing.activeVersionKey);
    assert.notEqual(reference.revisions[0].signature, existing.revisions[0].signature);
    assert.deepEqual(referenceCache, inputBefore);
});

test("reference history preserves revision and duplicate semantics", async () => {
    let clock = timestamp;
    const store = makeStore();
    const persistence = persistenceApi.createQriOptionsHistoryPersistence({ store,
        now: () => clock });
    await persistence.openPersistence();
    const options = { mode: "reference_history", acquisitionOrigin: "live",
        requestId: "reference-2", requestedContract: "2026-10",
        sourceUrl: urlFor("2026-10"), isCurrentRequest: () => true };
    const first = await cache({ contract: "2026-10" });
    assert.equal((await persistence.persistReferenceContractCache(first, options)).status, "saved");
    assert.equal((await persistence.persistReferenceContractCache(first, options)).status, "unchanged");
    assert.equal((await store.loadEntry("2026-10", "2026-08-18")).entry.revisions.length, 1);
    clock = "2026-08-18T09:00:00.000Z";
    const second = await cache({ contract: "2026-10", value: 200,
        pageUpdatedAt: "2026-08-18T17:00:00+09:00" });
    assert.equal((await persistence.persistReferenceContractCache(second, options)).reason,
        "revision_added");
    const entry = (await store.loadEntry("2026-10", "2026-08-18")).entry;
    assert.equal(entry.revisions.length, 2);
    assert.equal(entry.revisions[0].replacedAt, clock);
    assert.equal(entry.activeVersionKey, second.versionKey);
    assert.equal(entry.revisions[1].replacedAt, null);
});

test("reference history rejects unsupported context and invalid candidates", async () => {
    const store = makeStore();
    const persistence = persistenceApi.createQriOptionsHistoryPersistence({ store,
        now: () => timestamp });
    await persistence.openPersistence();
    const reference = await cache({ contract: "2026-10" });
    const eligible = { mode: "reference_history", acquisitionOrigin: "live",
        requestId: "reference-3", requestedContract: "2026-10",
        sourceUrl: urlFor("2026-10"), isCurrentRequest: () => true };
    for (const [change, reason] of [
        [value => { value.mode = "specific"; }, "reference_context_invalid"],
        [value => { value.requestedContract = "2026-09"; }, "requested_contract_mismatch"],
        [value => { value.sourceUrl = urlFor("2026-09"); }, "source_url_mismatch"],
        [value => { value.isCurrentRequest = () => false; }, "stale_request"]
    ]) {
        const context = { ...eligible }; change(context);
        assert.equal((await persistence.persistReferenceContractCache(reference, context)).reason, reason);
    }
    const unavailable = await cache({ contract: "2026-10", status: "unavailable" });
    const invalidCandidates = [
        [(() => { const value = structuredClone(reference); value.contract = "2026-09"; return value; })(),
            "requested_contract_mismatch"],
        [unavailable, "open_interest_unavailable"],
        [(() => { const value = structuredClone(reference); value.signature = "0".repeat(64); return value; })(),
            "signature_mismatch"],
        [(() => { const value = structuredClone(reference); value.versionKey += "x"; return value; })(),
            "version_key_mismatch"],
        [(() => { const value = structuredClone(reference); value.canonical.records = []; return value; })(),
            "invalid_canonical"],
        [(() => { const value = structuredClone(reference); value.canonical.tradingDate = "invalid"; return value; })(),
            "invalid_canonical"]
    ];
    for (const [candidate, reason] of invalidCandidates) {
        assert.equal((await persistence.persistReferenceContractCache(candidate, eligible)).reason, reason);
    }
    assert.equal((await store.loadHistory()).status, "empty");
    assert.equal((await persistence.persistActiveContractCache(reference,
        { mode: "specific", isCurrentRequest: () => true })).reason,
    "specific_display_not_persisted");
});

test("reference persistence is storage-only and production calls it only through reference wiring", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsHistoryPersistence.js"), "utf8");
    assert.doesNotMatch(source, /publishQriFormalIdentity|FormalOptionAvailability|CurrentPrice|OverallV2|Morning|LastValid|optionMapLastValid|optionMapQriOptionsLastValid|option signal|document\.|localStorage|fetch-option-page/);
    const referenceMethod = source.slice(source.indexOf("async function persistReferenceContractCache"),
        source.indexOf("const getState"));
    assert.doesNotMatch(referenceMethod, /isActiveContract/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const referenceWiring = html.slice(
        html.indexOf("function initializeQriReferenceAcquisitionRuntime"),
        html.indexOf("function validateQriPayload"));
    assert.match(referenceWiring, /persistReferenceContractCache/);
    assert.equal((html.match(/persistReferenceContractCache/g) || []).length, 1);
});

test("renderer wiring persists only in fetchQriData and leaves specific path disconnected", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    const specific = html.slice(html.indexOf("async function showSpecificQriContract"),
        html.indexOf("async function updateQriContractManifest"));
    const normal = html.slice(html.indexOf("async function fetchQriData"),
        html.indexOf("function handleQriFetchError"));
    assert.doesNotMatch(specific, /persistActiveContractCache|persistQriOptionsHistory/);
    assert.match(normal, /persistQriOptionsHistory/);
    assert.doesNotMatch(normal, /optionMapJpxSnapshots/);
});

test("active refreshはpartial manifestを生成し非active QRIを巡回しない", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    const update = html.slice(html.indexOf("async function updateQriContractManifest"),
        html.indexOf('qriContractSelect?.addEventListener("change"'));
    assert.match(update, /createPartialManifest\(defaultPayload\.canonicalV2\)/);
    assert.doesNotMatch(update, /Promise\.all|fetch-option-page|parseQriOptionsBundle/);
});

test("unresolved lazy fetchは表示専用でsequence確認後だけmanifestへ反映する", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    const lazy = html.slice(html.indexOf("async function showUnresolvedQriEntry"),
        html.indexOf("async function updateQriContractManifest"));
    assert.match(lazy, /qriLazyManifestResolver\.resolve/);
    assert.match(lazy, /optionMapBridge\.fetchQriOptionPage\(url\)/);
    assert.match(lazy, /sequence !== qriContractSelectionState\.requestSequence/);
    assert.match(lazy, /qriContractManifest = resolved\.manifest/);
    assert.doesNotMatch(lazy, /persistQriOptionsHistory|morningBaseline|overallJudgment/);
});
