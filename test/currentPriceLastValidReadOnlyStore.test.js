const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Cache = require("../js/currentPriceLastValidCache.js");
const Store = require("../js/storage/currentPriceLastValidReadOnlyStore.js");

const KEY = "optionMapCurrentPriceLastValidV1";
const INPUT = Object.freeze({ source: "qri-nikkei225-futures", mode: "automatic", value: 66010,
    contract: "2026-09", pageTradingDate: "2026-08-24",
    pageUpdatedAt: "2026-08-24T06:34:00+09:00", quotedAtRaw: "08/22 06:00",
    fetchedAt: "2026-08-24T06:34:30+09:00", sourceUrl: "https://svc.qri.jp/jpx/nkopm/" });
async function serialized() {
    const result = await Cache.buildCurrentPriceLastValidCacheV2(INPUT);
    assert.equal(result.success, true);
    return JSON.stringify(result.cache);
}
function storage(entries = []) {
    const values = new Map(entries); const calls = [];
    return { calls, values, getItem(key) { calls.push(key); return values.has(key) ? values.get(key) : null; } };
}
function fingerprint(store) {
    return crypto.createHash("sha256").update(JSON.stringify([...store.values.entries()].sort()))
        .digest("hex");
}

test("adapter exposes one fixed key", () => {
    assert.equal(Store.STORAGE_KEY, KEY);
    assert.equal(Store.readCurrentPriceLastValidSerialized.length, 1);
});
test("valid serialized value is read without parsing", async () => {
    const value = await serialized(); const source = storage([[KEY, value]]);
    const result = Store.readCurrentPriceLastValidSerialized(source);
    assert.deepEqual([result.status, result.serialized], ["available", value]);
});
test("missing fixed key is a normal state", () => {
    const result = Store.readCurrentPriceLastValidSerialized(storage());
    assert.deepEqual([result.status, result.reason, result.serialized], ["missing", null, null]);
});
test("null storage and missing getItem are unavailable", () => {
    assert.equal(Store.readCurrentPriceLastValidSerialized(null).reason, "storage_unavailable");
    assert.equal(Store.readCurrentPriceLastValidSerialized({}).reason, "storage_unavailable");
});
test("getItem failure is contained", () => {
    const result = Store.readCurrentPriceLastValidSerialized({ getItem() { throw new Error("blocked"); } });
    assert.deepEqual([result.status, result.reason], ["unavailable", "storage_read_error"]);
});
test("malformed serialized is read but rejected by restore", async () => {
    const result = await Store.readAndRestoreCurrentPriceLastValid(storage([[KEY, "{"]]));
    assert.deepEqual([result.status, result.reason, result.cache], ["invalid", "parse_error", null]);
});
test("legacy serialized is not repaired or restored", async () => {
    const legacy = JSON.stringify({ value: 66010, source: INPUT.source, quotedAt: "8/24 05:30" });
    const result = await Store.readAndRestoreCurrentPriceLastValid(storage([[KEY, legacy]]));
    assert.deepEqual([result.status, result.reason], ["invalid", "cache_invalid"]);
});
test("schema v1 serialized is explicitly unsupported", async () => {
    const legacy = await Cache.buildCurrentPriceLastValidCache({ source: INPUT.source,
        mode: INPUT.mode, value: INPUT.value, contract: INPUT.contract,
        tradingDate: "2026-08-24", quotedAtRaw: "08/24 05:30",
        fetchedAt: INPUT.fetchedAt, sourceUrl: INPUT.sourceUrl });
    const result = await Store.readAndRestoreCurrentPriceLastValid(
        storage([[KEY, JSON.stringify(legacy.cache)]]));
    assert.deepEqual([result.status, result.reason], ["invalid", "schema_v1_unsupported"]);
});
test("tampered serialized is rejected", async () => {
    const cache = JSON.parse(await serialized()); cache.value = 1;
    assert.equal((await Store.readAndRestoreCurrentPriceLastValid(
        storage([[KEY, JSON.stringify(cache)]]))).status, "invalid");
});
test("wrong cache version is rejected", async () => {
    const cache = JSON.parse(await serialized()); cache.cacheVersion = 2;
    assert.equal((await Store.readAndRestoreCurrentPriceLastValid(
        storage([[KEY, JSON.stringify(cache)]]))).status, "invalid");
});
test("valid fixture restores through the existing restore module", async () => {
    const result = await Store.readAndRestoreCurrentPriceLastValid(
        storage([[KEY, await serialized()]]), { expectedTradingDate: "2026-08-24",
            selectedContract: "2026-09" });
    assert.deepEqual([result.status, result.restore.success, result.cache.value],
        ["restored", true, 66010]);
});
test("restored fixture feeds Freshness Shadow as saved last-valid", async () => {
    const result = await Store.readAndRestoreCurrentPriceLastValid(
        storage([[KEY, await serialized()]]), { expectedTradingDate: "2026-08-24",
            selectedContract: "2026-09" });
    assert.deepEqual([result.freshness.status, result.freshness.reason, result.freshness.origin],
        ["stale", "saved_last_valid", "cache"]);
    assert.equal(result.freshness.displayEligible, true);
    assert.equal(result.freshness.calculationEligible, "undetermined");
});
test("caller cannot request an arbitrary key", async () => {
    const source = storage([[KEY, await serialized()], ["arbitrary", "secret"]]);
    Store.readCurrentPriceLastValidSerialized(source, "arbitrary");
    assert.deepEqual(source.calls, [KEY]);
});
test("legacy keys are never read", async () => {
    const source = storage([["optionMapCurrentPrice", "66010"],
        ["optionMapLastQriFuturesPrice", await serialized()]]);
    assert.equal(Store.readCurrentPriceLastValidSerialized(source).status, "missing");
    assert.deepEqual(source.calls, [KEY]);
});
test("read leaves entry count, entries and fingerprint unchanged", async () => {
    const source = storage([[KEY, await serialized()], ["unrelated", "keep"]]);
    const before = { count: source.values.size, entries: JSON.stringify([...source.values]),
        fingerprint: fingerprint(source) };
    await Store.readAndRestoreCurrentPriceLastValid(source,
        { expectedTradingDate: "2026-08-24", selectedContract: "2026-09" });
    const after = { count: source.values.size, entries: JSON.stringify([...source.values]),
        fingerprint: fingerprint(source) };
    assert.deepEqual(after, before);
});
test("adapter never asks storage for a write capability", async () => {
    const source = storage([[KEY, await serialized()]]);
    source.setItem = () => { throw new Error("write"); };
    source.removeItem = () => { throw new Error("remove"); };
    source.clear = () => { throw new Error("clear"); };
    assert.equal((await Store.readAndRestoreCurrentPriceLastValid(source)).status, "restored");
});
test("module has no writes, fetch, UI, runtime, mobile or Overall wiring", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/storage/currentPriceLastValidReadOnlyStore.js"), "utf8");
    assert.equal(/setItem|removeItem|\.clear\s*\(|\bfetch\s*\(|document\.|OverallV2|MobileSummary/.test(source), false);
    assert.equal(/optionMapCurrentPrice(?!LastValidV1)|optionMapLastQriFuturesPrice/.test(source), false);
});
