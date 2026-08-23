const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Save = require("../js/storage/currentPriceLastValidStore.js");
const Read = require("../js/storage/currentPriceLastValidReadOnlyStore.js");

const KEY = "optionMapCurrentPriceLastValidV1";
const INPUT = Object.freeze({ price: Object.freeze({ source: "qri-nikkei225-futures",
    mode: "automatic", value: 66010, contract: "26年09月限", quotedAt: "8/24 05:30",
    fetchedAt: "2026-08-24T05:31:00+09:00" }), activeContract: "2026-09",
    tradingDate: "2026-08-24", sourceUrl: "https://svc.qri.jp/jpx/nkopm/" });
const CONTEXT = Object.freeze({ requestMode: "auto", requestOrigin: "live",
    responseStatus: "success", isCurrent: true });
function storage(entries = []) {
    const values = new Map(entries); const writes = [];
    return { values, writes, getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { writes.push([key, value]); values.set(key, value); } };
}
const save = (store, input = INPUT, context = CONTEXT) =>
    Save.buildAndSaveCurrentPriceLastValid(store, input, context);
function browserStore(cacheApi, shadowApi) {
    const window = { document: {}, OptionMapCurrentPriceLastValidCache: cacheApi,
        OptionMapCurrentPriceFreshnessShadow: shadowApi };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,
        "../js/storage/currentPriceLastValidStore.js"), "utf8"),
    { window, globalThis: window, URL, console });
    return window.OptionMapCurrentPriceLastValidStore;
}
function fakeShadow() {
    return { evaluateCurrentPriceFreshness() { return { freshness: {
        status: "fresh", reason: "current", origin: "live" } }; } };
}
function fakeCache(overrides = {}) {
    const cache = { source: INPUT.price.source, mode: INPUT.price.mode, value: INPUT.price.value,
        contract: INPUT.activeContract, tradingDate: INPUT.tradingDate,
        quotedAtNormalized: "2026-08-24T05:30:00+09:00", fetchedAt: INPUT.price.fetchedAt };
    return { SOURCE: INPUT.price.source,
        async buildCurrentPriceLastValidCache() { return { success: true, cache }; },
        async validateCurrentPriceLastValidCache() { return true; }, ...overrides };
}

test("valid fresh automatic QRI price saves once to the fixed key", async () => {
    const target = storage(); const result = await save(target);
    assert.deepEqual([result.success, result.saved, target.writes.length], [true, true, 1]);
    assert.equal(target.writes[0][0], KEY);
});
test("saved value is a valid serialized cache", async () => {
    const target = storage(); await save(target);
    const cache = JSON.parse(target.values.get(KEY));
    assert.deepEqual([cache.cacheVersion, cache.schemaVersion, cache.contract], [1, 1, "2026-09"]);
});
test("saved cache passes read-back restore", async () => {
    const target = storage(); await save(target);
    const read = await Read.readAndRestoreCurrentPriceLastValid(target,
        { expectedTradingDate: "2026-08-24", selectedContract: "2026-09" });
    assert.deepEqual([read.status, read.restore.success], ["restored", true]);
});
for (const [name, input, context, reason] of [
    ["manual", { ...INPUT, price: { ...INPUT.price, mode: "manual" } }, CONTEXT, "price_source_ineligible"],
    ["stale automatic", INPUT, { ...CONTEXT, responseStatus: "stale" }, "stale_response"],
    ["restored", { ...INPUT, restored: true }, CONTEXT, "restored_price_ineligible"],
    ["tradingDate missing", { ...INPUT, tradingDate: null }, CONTEXT, "cache_builder_failed"],
    ["tradingDate malformed", { ...INPUT, tradingDate: "2026-02-30" }, CONTEXT, "cache_builder_failed"],
    ["quotedAt mismatch", { ...INPUT, price: { ...INPUT.price, quotedAt: "8/23 05:30" } }, CONTEXT, "cache_builder_failed"],
    ["contract mismatch", { ...INPUT, activeContract: "2026-12" }, CONTEXT, "contract_mismatch"],
    ["source mismatch", { ...INPUT, price: { ...INPUT.price, source: "manual" } }, CONTEXT, "price_source_ineligible"],
    ["specific", INPUT, { ...CONTEXT, requestMode: "specific" }, "request_context_ineligible"],
    ["stale ignored", INPUT, { ...CONTEXT, responseStatus: "stale_ignored" }, "stale_response"]
]) {
    test(`${name} is not saved`, async () => {
        const target = storage(); const result = await save(target, input, context);
        assert.deepEqual([result.saved, result.reason, target.writes.length], [false, reason, 0]);
    });
}
test("two-digit price contract is verified only against explicit canonical contract", () => {
    assert.equal(Save.contractsMatch("26年09月限", "2026-09"), true);
    assert.equal(Save.contractsMatch("26年09月限", "2027-09"), false);
    assert.equal(Save.contractsMatch("26年10月限", "2026-09"), false);
});
test("setItem and quota failures are isolated", async () => {
    const result = await save({ setItem() { throw new Error("quota"); } });
    assert.deepEqual([result.success, result.reason], [false, "storage_write_error"]);
});
test("builder exception is isolated without a write", async () => {
    const api = browserStore(fakeCache({
        async buildCurrentPriceLastValidCache() { throw new Error("builder"); }
    }), fakeShadow());
    const target = storage(); const result = await api.buildAndSaveCurrentPriceLastValid(
        target, INPUT, CONTEXT);
    assert.deepEqual([result.reason, target.writes.length], ["cache_builder_error", 0]);
});
test("validator failure is isolated without a write", async () => {
    const api = browserStore(fakeCache({
        async validateCurrentPriceLastValidCache() { return false; }
    }), fakeShadow());
    const target = storage(); const result = await api.buildAndSaveCurrentPriceLastValid(
        target, INPUT, CONTEXT);
    assert.deepEqual([result.reason, target.writes.length], ["cache_validation_failed", 0]);
});
test("serialization failure is isolated without a partial write", async () => {
    const circular = fakeCache();
    circular.buildCurrentPriceLastValidCache = async () => {
        const cache = { source: INPUT.price.source, mode: INPUT.price.mode, value: INPUT.price.value,
            contract: INPUT.activeContract, tradingDate: INPUT.tradingDate,
            quotedAtNormalized: "2026-08-24T05:30:00+09:00", fetchedAt: INPUT.price.fetchedAt };
        cache.circular = cache;
        return { success: true, cache };
    };
    const api = browserStore(circular, fakeShadow());
    const target = storage(); const result = await api.buildAndSaveCurrentPriceLastValid(
        target, INPUT, CONTEXT);
    assert.deepEqual([result.reason, target.writes.length], ["serialization_error", 0]);
});
test("same quote refetch overwrites with new fetchedAt and stable versionKey", async () => {
    const target = storage(); const first = await save(target);
    const second = await save(target, { ...INPUT, price: { ...INPUT.price,
        fetchedAt: "2026-08-24T05:35:00+09:00" } });
    assert.equal(target.writes.length, 2);
    assert.equal(first.cache.versionKey, second.cache.versionKey);
    assert.notEqual(first.cache.signature, second.cache.signature);
    assert.equal(JSON.parse(target.values.get(KEY)).fetchedAt, "2026-08-24T05:35:00+09:00");
});
test("request becoming stale during async build is not saved", async () => {
    const target = storage(); let checks = 0;
    const result = await save(target, INPUT, { ...CONTEXT, isCurrent: () => ++checks === 1 });
    assert.deepEqual([result.reason, target.writes.length], ["stale_response", 0]);
});
test("non-target and legacy entries remain unchanged", async () => {
    const entries = [["optionMapCurrentPrice", "65000"],
        ["optionMapLastQriFuturesPrice", "legacy"], ["unrelated", "keep"]];
    const target = storage(entries); const before = new Map(target.values);
    await save(target);
    for (const [key, value] of before) assert.equal(target.values.get(key), value);
    assert.deepEqual(target.writes.map(item => item[0]), [KEY]);
});
test("storage write is one atomic serialized value", async () => {
    const target = storage(); await save(target);
    assert.equal(target.writes.length, 1);
    assert.doesNotThrow(() => JSON.parse(target.writes[0][1]));
});
test("input and formal price facts are not mutated", async () => {
    const input = JSON.parse(JSON.stringify(INPUT)); const before = JSON.stringify(input);
    await save(storage(), input);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(input.price, INPUT.price);
});
test("module touches no IndexedDB, history, fetch, UI, mobile or Overall system", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/storage/currentPriceLastValidStore.js"), "utf8");
    assert.equal(/indexedDB|\bfetch\s*\(|document\.|OverallV2|MobileSummary|History/.test(source), false);
    assert.equal(/optionMapCurrentPrice(?!LastValidV1)|optionMapLastQriFuturesPrice/.test(source), false);
});
test("renderer wiring saves only after active price application and adds no boot restore", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(html, /applyQriNikkei225FuturesPrice[\s\S]+?buildAndSaveCurrentPriceLastValid/);
    assert.doesNotMatch(html, /readAndRestoreCurrentPriceLastValid\s*\(/);
    assert.doesNotMatch(html, /CurrentPriceLastValidReadOnlyStore/);
});
