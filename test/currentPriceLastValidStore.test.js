const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Save = require("../js/storage/currentPriceLastValidStore.js");
const Read = require("../js/storage/currentPriceLastValidReadOnlyStore.js");

const KEY = "optionMapCurrentPriceLastValidV1";
const INPUT = Object.freeze({ price: Object.freeze({ source: "qri-nikkei225-futures",
    mode: "automatic", value: 66010, contract: "26年09月限", quotedAt: "08/22 06:00",
    fetchedAt: "2026-08-24T06:34:30+09:00" }), activeContract: "2026-09",
    pageTradingDate: "2026-08-24", pageUpdatedAt: "2026-08-24T06:34:00+09:00",
    sourceUrl: "https://svc.qri.jp/jpx/nkopm/" });
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
        status: "stale", reason: "source_not_updated", origin: "live",
        calculationEligible: "undetermined" } }; } };
}
function fakeCache(overrides = {}) {
    const cache = { source: INPUT.price.source, mode: INPUT.price.mode, value: INPUT.price.value,
        contract: INPUT.activeContract, pageTradingDate: INPUT.pageTradingDate,
        pageUpdatedAt: INPUT.pageUpdatedAt, quoteDate: "2026-08-22",
        quotedAtNormalized: "2026-08-22T06:00:00+09:00", fetchedAt: INPUT.price.fetchedAt };
    return { SOURCE: INPUT.price.source,
        async buildCurrentPriceLastValidCacheV2() { return { success: true, cache }; },
        async validateCurrentPriceLastValidCacheV2() { return true; }, ...overrides };
}

test("valid stale automatic QRI price saves once to the fixed key", async () => {
    const target = storage(); const result = await save(target);
    assert.deepEqual([result.success, result.saved, target.writes.length], [true, true, 1]);
    assert.equal(target.writes[0][0], KEY);
});
test("saved value is a valid serialized cache", async () => {
    const target = storage(); await save(target);
    const cache = JSON.parse(target.values.get(KEY));
    assert.deepEqual([cache.cacheVersion, cache.schemaVersion, cache.contract], [1, 2, "2026-09"]);
    assert.deepEqual([cache.quoteDate, cache.quotedAtNormalized,
        cache.quoteDateResolution], ["2026-08-22", "2026-08-22T06:00:00+09:00",
        "nearest_not_after_page_updated_at"]);
});
test("saved cache passes read-back restore", async () => {
    const target = storage(); await save(target);
    const read = await Read.readAndRestoreCurrentPriceLastValid(target,
        { expectedTradingDate: "2026-08-24", selectedContract: "2026-09" });
    assert.deepEqual([read.status, read.restore.success], ["restored", true]);
});
for (const [name, pageTradingDate, pageUpdatedAt, quotedAt, quoteDate] of [
    ["same-day", "2026-07-23", "2026-07-23T05:33:00+09:00", "07/23 05:31", "2026-07-23"],
    ["one-day earlier", "2026-07-29", "2026-07-28T20:26:00+09:00", "07/28 20:26", "2026-07-28"],
    ["two-day earlier", "2026-07-27", "2026-07-27T05:44:00+09:00", "07/25 06:00", "2026-07-25"],
    ["three-day earlier", "2026-07-21", "2026-07-18T07:49:00+09:00", "07/18 06:00", "2026-07-18"]
]) test(`${name} valid quote is saved independently of pageTradingDate`, async () => {
    const target = storage();
    const result = await save(target, { ...INPUT, pageTradingDate, pageUpdatedAt,
        price: { ...INPUT.price, quotedAt, fetchedAt: pageUpdatedAt } });
    assert.deepEqual([result.saved, result.cache.quoteDate], [true, quoteDate]);
});
test("valid unresolved raw quote is saved without becoming calculation eligible", async () => {
    const target = storage();
    const result = await save(target, { ...INPUT, price: { ...INPUT.price,
        quotedAt: "07/01 06:00" } });
    assert.equal(result.saved, true);
    assert.deepEqual([result.cache.quotedAtRaw, result.cache.quoteDate,
        result.cache.quotedAtNormalized, result.cache.quoteDateResolution],
    ["07/01 06:00", null, null, "unresolved"]);
    assert.equal(result.freshness.calculationEligible, "undetermined");
});
for (const [name, input, context, reason] of [
    ["manual", { ...INPUT, price: { ...INPUT.price, mode: "manual" } }, CONTEXT, "price_source_ineligible"],
    ["stale automatic", INPUT, { ...CONTEXT, responseStatus: "stale" }, "stale_response"],
    ["restored", { ...INPUT, restored: true }, CONTEXT, "restored_price_ineligible"],
    ["pageTradingDate missing", { ...INPUT, pageTradingDate: null }, CONTEXT, "cache_builder_failed"],
    ["pageTradingDate malformed", { ...INPUT, pageTradingDate: "2026-02-30" }, CONTEXT, "cache_builder_failed"],
    ["pageUpdatedAt missing", { ...INPUT, pageUpdatedAt: null }, CONTEXT, "cache_builder_failed"],
    ["pageUpdatedAt malformed", { ...INPUT, pageUpdatedAt: "8/24 06:34" }, CONTEXT, "cache_builder_failed"],
    ["quotedAt malformed", { ...INPUT, price: { ...INPUT.price, quotedAt: "06:00" } }, CONTEXT, "cache_builder_failed"],
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
        async buildCurrentPriceLastValidCacheV2() { throw new Error("builder"); }
    }), fakeShadow());
    const target = storage(); const result = await api.buildAndSaveCurrentPriceLastValid(
        target, INPUT, CONTEXT);
    assert.deepEqual([result.reason, target.writes.length], ["cache_builder_error", 0]);
});
test("validator failure is isolated without a write", async () => {
    const api = browserStore(fakeCache({
        async validateCurrentPriceLastValidCacheV2() { return false; }
    }), fakeShadow());
    const target = storage(); const result = await api.buildAndSaveCurrentPriceLastValid(
        target, INPUT, CONTEXT);
    assert.deepEqual([result.reason, target.writes.length], ["cache_validation_failed", 0]);
});
test("serialization failure is isolated without a partial write", async () => {
    const circular = fakeCache();
    circular.buildCurrentPriceLastValidCacheV2 = async () => {
        const cache = { source: INPUT.price.source, mode: INPUT.price.mode, value: INPUT.price.value,
            contract: INPUT.activeContract, pageTradingDate: INPUT.pageTradingDate,
            pageUpdatedAt: INPUT.pageUpdatedAt, quoteDate: "2026-08-22",
            quotedAtNormalized: "2026-08-22T06:00:00+09:00", fetchedAt: INPUT.price.fetchedAt };
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
        fetchedAt: "2026-08-24T06:35:00+09:00" } });
    assert.equal(target.writes.length, 2);
    assert.equal(first.cache.versionKey, second.cache.versionKey);
    assert.notEqual(first.cache.signature, second.cache.signature);
    assert.equal(JSON.parse(target.values.get(KEY)).fetchedAt, "2026-08-24T06:35:00+09:00");
});
test("same quote republished on a later page keeps identity and updates acquisition facts", async () => {
    const target = storage(); const first = await save(target);
    const second = await save(target, { ...INPUT, pageTradingDate: "2026-08-25",
        pageUpdatedAt: "2026-08-25T05:00:00+09:00",
        price: { ...INPUT.price, fetchedAt: "2026-08-25T05:01:00+09:00" } });
    assert.equal(first.cache.quoteSignature, second.cache.quoteSignature);
    assert.equal(first.cache.versionKey, second.cache.versionKey);
    assert.notEqual(first.cache.signature, second.cache.signature);
    assert.deepEqual([second.cache.pageTradingDate, second.cache.pageUpdatedAt,
        second.cache.fetchedAt], ["2026-08-25", "2026-08-25T05:00:00+09:00",
        "2026-08-25T05:01:00+09:00"]);
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
test("renderer wiring loads restore diagnostics without adding boot restore", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(html, /applyQriNikkei225FuturesPrice[\s\S]+?buildAndSaveCurrentPriceLastValid/);
    assert.match(html, /pageTradingDate:\s*payload\.canonicalV2\?\.tradingDate/);
    assert.match(html, /pageUpdatedAt:\s*payload\.canonicalV2\?\.pageUpdatedAt/);
    const scripts = ["js/currentPriceFreshnessShadow.js", "js/currentPriceLastValidCache.js",
        "js/storage/currentPriceLastValidStore.js", "js/currentPriceLastValidRestore.js",
        "js/storage/currentPriceLastValidReadOnlyStore.js"];
    const positions = scripts.map(source => html.indexOf(`<script src="${source}"></script>`));
    assert.equal(positions.every(position => position >= 0), true);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    assert.doesNotMatch(html, /readAndRestoreCurrentPriceLastValid\s*\(/);
});
