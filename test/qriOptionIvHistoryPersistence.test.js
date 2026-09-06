"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Iv = require("../js/qriOptionIv.js");
const Options = require("../js/qriOptions.js");
const History = require("../js/qriOptionIvHistory.js");
const Persistence = require("../js/qriOptionIvHistoryPersistence.js");

const fetchedAt = "2026-09-07T01:00:00.000Z";
const confirmedAt = "2026-09-07T01:00:01.000Z";
function iv(contract = "2026-10") {
    return { parserVersion: 1, schemaVersion: 1, source: Iv.SOURCE,
        sourceUrl: "https://svc.qri.jp/jpx/nkopm/1", valueUnit: "percent_points",
        contract, tradingDate: "2026-09-07", pageUpdatedAt: "2026-09-07T09:30:00+09:00",
        lastTradingDate: `${contract}-10`, records: [
            { optionType: "call", strike: 40000,
                iv: { status: "available", value: 20, sourceFormat: "plain_number" } },
            { optionType: "put", strike: 40000,
                iv: { status: "available", value: 21, sourceFormat: "plain_number" } }
        ] };
}
function parent(contract = "2026-10") {
    const sourceUrl = "https://svc.qri.jp/jpx/nkopm/1"; const label = "10月限月";
    return { parserVersion: 2, schemaVersion: 2, source: Options.SOURCE, sourceUrl,
        pageUpdatedAt: "2026-09-07T09:30:00+09:00", tradingDate: "2026-09-07",
        openInterestAsOf: null, contract, gengetsu: contract.replace("-", ""),
        contractLabel: label, isActiveContract: true, lastTradingDate: `${contract}-10`,
        openInterestStatus: "available",
        availableContracts: [{ contract, label, url: sourceUrl, active: true }], records: [
            { contract, optionType: "call", strike: 40000, published: true, value: 10 },
            { contract, optionType: "put", strike: 40000, published: true, value: 11 }
        ] };
}
async function input(overrides = {}) {
    const ivCanonical = iv(); const parentOptionsCanonical = parent();
    const parentCache = await Options.createCacheV2(parentOptionsCanonical, fetchedAt);
    return { acquisitionRole: "next", ivCanonical,
        ivSignature: await Iv.createSignature(ivCanonical),
        ivVersionKey: await Iv.createVersionKey(ivCanonical), fetchedAt, confirmedAt,
        parentPersistenceStatus: "saved", parentOptionsCanonical,
        parentOptionsVersionKey: parentCache.versionKey,
        parentOptionsSignature: parentCache.signature,
        parentMarketRefreshRequestId: "market-1", requestId: "next-1",
        acquisitionGeneration: 1, formalPublicationGeneration: 2,
        expectedContract: ivCanonical.contract, expectedTradingDate: ivCanonical.tradingDate,
        expectedPageUpdatedAt: ivCanonical.pageUpdatedAt,
        expectedSourceUrl: ivCanonical.sourceUrl, ...overrides };
}
function memoryStore(options = {}) {
    let history = History.createEmptyHistory(); let calls = 0;
    return { get history() { return history; }, get calls() { return calls; },
        async persistCandidate(candidate) {
            calls += 1;
            if (options.fail) return { saved: false, outcome: options.fail };
            if (options.beforeResolve) await options.beforeResolve();
            const merged = await History.mergeCandidate(history, candidate);
            if (merged.changed) history = merged.history;
            return { saved: merged.changed, outcome: merged.outcome };
        } };
}

test("parent saved and unchanged authorize exact Formal IV persistence", async () => {
    for (const status of ["saved", "unchanged"]) {
        const store = memoryStore(); const api = Persistence.createPersistence({ store,
            now: () => confirmedAt });
        const result = await api.persist(await input({ parentPersistenceStatus: status }),
            { isCurrentRequest: () => true });
        assert.equal(result.status, "saved"); assert.equal(store.calls, 1);
        assert.equal(store.history.entries[0].revisions[0].formalStatus, status);
        assert.equal(Object.isFrozen(api.getState()), true);
    }
});

test("input is not mutated and repeated output is deterministic and deeply frozen", async () => {
    const value = await input(); const before = structuredClone(value);
    const firstStore = memoryStore(); const secondStore = memoryStore();
    const first = await Persistence.createPersistence({ store: firstStore,
        now: () => confirmedAt }).persist(value, { isCurrentRequest: () => true });
    const second = await Persistence.createPersistence({ store: secondStore,
        now: () => confirmedAt }).persist(value, { isCurrentRequest: () => true });
    assert.deepEqual(value, before); assert.deepEqual(first, second);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(firstStore.history.entries[0].revisions[0].canonical), true);
});

test("parent rejection, invalid role/request/generation and stale guard never write", async () => {
    for (const [change, reason, guard = true] of [
        [{ parentPersistenceStatus: "failed" }, "parent_persistence_not_accepted"],
        [{ parentPersistenceStatus: "skipped" }, "parent_persistence_not_accepted"],
        [{ acquisitionRole: "other" }, "acquisition_role_invalid"],
        [{ requestId: "" }, "request_identity_invalid"],
        [{ parentMarketRefreshRequestId: "" }, "request_identity_invalid"],
        [{ acquisitionGeneration: -1 }, "generation_identity_invalid"],
        [{ formalPublicationGeneration: 0.5 }, "generation_identity_invalid"],
        [{}, "stale_request", false]
    ]) {
        const store = memoryStore(); const api = Persistence.createPersistence({ store,
            now: () => confirmedAt });
        assert.equal((await api.persist(await input(change),
            { isCurrentRequest: () => guard })).reason, reason);
        assert.equal(store.calls, 0);
    }
});

test("canonical and recomputed identity validation is fail-closed", async () => {
    const cases = [
        [value => { value.ivCanonical.records = []; }, "iv_canonical_invalid"],
        [value => { value.parentOptionsCanonical.records = []; }, "parent_canonical_invalid"],
        [value => { value.ivSignature = "0".repeat(64); }, "iv_identity_mismatch"],
        [value => { value.ivVersionKey += "x"; }, "iv_identity_mismatch"],
        [value => { value.parentOptionsSignature = "0".repeat(64); }, "parent_identity_mismatch"],
        [value => { value.parentOptionsVersionKey += "x"; }, "parent_identity_mismatch"]
    ];
    for (const [mutate, reason] of cases) {
        const value = await input(); mutate(value); const store = memoryStore();
        const result = await Persistence.createPersistence({ store, now: () => confirmedAt })
            .persist(value, { isCurrentRequest: () => true });
        assert.equal(result.reason, reason); assert.equal(store.calls, 0);
    }
});

test("contract/date/update/url/last-trading-date binding mismatches never write", async () => {
    for (const [field, reason] of [["expectedContract", "contract_mismatch"],
        ["expectedTradingDate", "trading_date_mismatch"],
        ["expectedPageUpdatedAt", "page_updated_at_mismatch"],
        ["expectedSourceUrl", "source_url_mismatch"]]) {
        const store = memoryStore(); const value = await input({ [field]: "mismatch" });
        assert.equal((await Persistence.createPersistence({ store, now: () => confirmedAt })
            .persist(value, { isCurrentRequest: () => true })).reason, reason);
        assert.equal(store.calls, 0);
    }
    const value = await input(); value.ivCanonical.lastTradingDate = "2026-10-11";
    value.ivSignature = await Iv.createSignature(value.ivCanonical);
    value.ivVersionKey = await Iv.createVersionKey(value.ivCanonical);
    const store = memoryStore();
    assert.equal((await Persistence.createPersistence({ store, now: () => confirmedAt })
        .persist(value, { isCurrentRequest: () => true })).reason,
    "last_trading_date_mismatch");
});

test("same revision dedupes while next and major_sq add distinct confirmations", async () => {
    const store = memoryStore(); const api = Persistence.createPersistence({ store,
        now: () => confirmedAt });
    const first = await input();
    assert.equal((await api.persist(first, { isCurrentRequest: () => true })).status, "saved");
    assert.equal((await api.persist(first, { isCurrentRequest: () => true })).status, "unchanged");
    const major = await input({ acquisitionRole: "major_sq", requestId: "major-1" });
    assert.equal((await api.persist(major, { isCurrentRequest: () => true })).status,
        "confirmation_added");
    assert.equal(store.history.entries.length, 1);
    assert.equal(store.history.entries[0].revisions.length, 1);
    assert.deepEqual(store.history.entries[0].revisions[0].confirmations
        .map(item => item.acquisitionRole), ["major_sq", "next"]);
});

test("storage failure is contained and stale-after-write is not published to runtime state", async () => {
    const failed = Persistence.createPersistence({ store: memoryStore({ fail: "quota_failure" }),
        now: () => confirmedAt });
    assert.equal((await failed.persist(await input(),
        { isCurrentRequest: () => true })).status, "failed");
    let valid = true; let release;
    const store = memoryStore({ beforeResolve: () => new Promise(resolve => { release = resolve; }) });
    const api = Persistence.createPersistence({ store, now: () => confirmedAt });
    const pending = api.persist(await input(), { isCurrentRequest: () => valid });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    valid = false; release();
    const result = await pending;
    assert.equal(result.status, "stale_ignored"); assert.equal(store.history.entries.length, 1);
    assert.equal(api.getState().roles.next, null);
});

test("production wiring preserves Formal-before-IV-before-session ordering", () => {
    const reference = fs.readFileSync("js/qriOptionsReferenceAcquisition.js", "utf8");
    const major = fs.readFileSync("js/qriOptionsMajorSqAcquisition.js", "utf8");
    for (const source of [reference, major]) {
        assert.ok(source.indexOf("persistReference(cache") <
            source.indexOf("persistAcceptedIvHistory"));
        assert.ok(source.indexOf("persistAcceptedIvHistory") <
            source.indexOf("publishAcceptedReference"));
    }
    const html = fs.readFileSync("index.html", "utf8");
    assert.match(html, /getQriOptionIvHistoryPersistenceState/);
    assert.doesNotMatch(fs.readFileSync("js/qriOptionIvHistoryPersistence.js", "utf8"),
        /localStorage|sessionStorage|ipcRenderer|preload|fetch\s*\(|eval\s*\(|innerHTML/);
});
