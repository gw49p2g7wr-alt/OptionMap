const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Cache = require("../js/currentPriceLastValidCache.js");
const Shadow = require("../js/currentPriceFreshnessShadow.js");

const INPUT = Object.freeze({ source: "qri-nikkei225-futures", mode: "automatic", value: 66010,
    contract: "2026-09", tradingDate: "2026-08-24", quotedAtRaw: "8/24 05:30",
    fetchedAt: "2026-08-24T05:31:00+09:00", sourceUrl: "https://svc.qri.jp/jpx/nkopm/" });
const build = overrides => Cache.buildCurrentPriceLastValidCache({ ...INPUT, ...overrides });

test("valid automatic QRI price produces a validated cache", async () => {
    const result = await build();
    assert.equal(result.success, true);
    assert.equal(await Cache.validateCurrentPriceLastValidCache(result.cache), true);
    assert.equal(result.cache.value, 66010);
});
for (const [name, value] of [["zero", 0], ["negative", -1], ["NaN", NaN]]) {
    test(`${name} price is rejected`, async () => assert.equal((await build({ value })).success, false));
}
test("source mismatch is rejected", async () => {
    assert.equal((await build({ source: "manual" })).success, false);
});
test("manual mode is rejected", async () => {
    assert.equal((await build({ mode: "manual" })).success, false);
});
test("missing contract is rejected", async () => {
    assert.equal((await build({ contract: null })).success, false);
});
test("missing tradingDate is never inferred", async () => {
    const result = await build({ tradingDate: null });
    assert.equal(result.success, false);
    assert.equal(result.reason, "trading_date_invalid");
});
test("malformed tradingDate is rejected", async () => {
    assert.equal((await build({ tradingDate: "2026-02-30" })).success, false);
});
test("valid raw quote time normalizes only against explicit trading date", () => {
    assert.deepEqual(Cache.normalizeQuotedAt("8/24 05:30", "2026-08-24"),
        { value: "2026-08-24T05:30:00+09:00", reason: null });
});
test("malformed raw quote time is not normalized", () => {
    assert.equal(Cache.normalizeQuotedAt("05:30", "2026-08-24").value, null);
});
test("month or day mismatch stays null with a diagnostic", () => {
    const result = Cache.normalizeQuotedAt("8/23 05:30", "2026-08-24");
    assert.deepEqual(result, { value: null, reason: "quoted_at_trading_date_mismatch" });
});
test("invalid hour is not normalized", () => {
    assert.equal(Cache.normalizeQuotedAt("8/24 25:00", "2026-08-24").value, null);
});
test("builder stores the normalized timestamp", async () => {
    assert.equal((await build()).cache.quotedAtNormalized, "2026-08-24T05:30:00+09:00");
});
test("unverifiable normalization prevents cache construction", async () => {
    const result = await build({ quotedAtRaw: "8/23 05:30" });
    assert.deepEqual([result.success, result.cache], [false, null]);
});
test("valid fetchedAt is retained as acquisition fact", async () => {
    assert.equal((await build()).cache.fetchedAt, INPUT.fetchedAt);
});
test("malformed fetchedAt is rejected", async () => {
    assert.equal((await build({ fetchedAt: "8/24 05:31" })).success, false);
});
test("signature is stable", async () => {
    const cache = (await build()).cache;
    assert.equal(await Cache.createSignature(cache), await Cache.createSignature(cache));
});
test("signed field changes alter the integrity signature", async () => {
    const cache = (await build()).cache;
    assert.notEqual(await Cache.createSignature(cache),
        await Cache.createSignature({ ...cache, value: cache.value + 5 }));
    assert.notEqual(await Cache.createSignature(cache),
        await Cache.createSignature({ ...cache, fetchedAt: "2026-08-24T05:32:00+09:00" }));
});
test("signature is object-key-order independent", async () => {
    const cache = (await build()).cache;
    const reversed = Object.fromEntries(Object.entries(cache).reverse());
    assert.equal(await Cache.createSignature(cache), await Cache.createSignature(reversed));
});
test("versionKey is stable for one quote", async () => {
    const cache = (await build()).cache;
    assert.equal(cache.versionKey, await Cache.createVersionKey(cache));
});
test("same quote refetch changes integrity signature but preserves quote identity", async () => {
    const first = (await build()).cache;
    const second = (await build({ fetchedAt: "2026-08-24T05:35:00+09:00" })).cache;
    assert.notEqual(first.signature, second.signature);
    assert.equal(first.quoteSignature, second.quoteSignature);
    assert.equal(first.versionKey, second.versionKey);
});
test("legacy current price object is not accepted as cache v1", async () => {
    assert.equal(await Cache.validateCurrentPriceLastValidCache({ value: 66010,
        source: INPUT.source, contract: INPUT.contract, quotedAt: INPUT.quotedAtRaw,
        fetchedAt: INPUT.fetchedAt }), false);
});
test("cache can feed Freshness Shadow as a live candidate", async () => {
    const cache = (await build()).cache;
    const result = Shadow.evaluateCurrentPriceFreshness({ value: cache.value, source: cache.source,
        mode: cache.mode, contract: cache.contract, quotedAt: cache.quotedAtNormalized,
        fetchedAt: cache.fetchedAt }, { dataTradingDate: cache.tradingDate,
        expectedTradingDate: cache.tradingDate, selectedContract: cache.contract });
    assert.deepEqual([result.freshness.status, result.freshness.reason], ["fresh", "current"]);
});
test("restored cache feeds Freshness Shadow as stale saved last-valid", async () => {
    const cache = (await build()).cache;
    const result = Shadow.evaluateCurrentPriceFreshness({ value: cache.value, source: cache.source,
        mode: cache.mode, contract: cache.contract, quotedAt: cache.quotedAtNormalized,
        fetchedAt: cache.fetchedAt }, { restored: true, dataTradingDate: cache.tradingDate,
        expectedTradingDate: cache.tradingDate, selectedContract: cache.contract });
    assert.deepEqual([result.freshness.status, result.freshness.reason], ["stale", "saved_last_valid"]);
});
test("cache contract mismatch remains stale in Freshness Shadow", async () => {
    const cache = (await build()).cache;
    const result = Shadow.evaluateCurrentPriceFreshness({ value: cache.value, source: cache.source,
        mode: cache.mode, contract: cache.contract, quotedAt: cache.quotedAtNormalized,
        fetchedAt: cache.fetchedAt }, { dataTradingDate: cache.tradingDate,
        expectedTradingDate: cache.tradingDate, selectedContract: "2026-12" });
    assert.equal(result.freshness.staleReason, "contract_mismatch");
});
test("builder never mutates input", async () => {
    const input = { ...INPUT }; const before = JSON.stringify(input);
    await Cache.buildCurrentPriceLastValidCache(input);
    assert.equal(JSON.stringify(input), before);
});
test("tampering and unsupported URL fail validation", async () => {
    const cache = (await build()).cache;
    assert.equal(await Cache.validateCurrentPriceLastValidCache({ ...cache, value: 1 }), false);
    assert.equal(await Cache.validateCurrentPriceLastValidCache({ ...cache, unexpected: true }), false);
    assert.equal((await build({ sourceUrl: "https://example.com/price" })).success, false);
});
test("foundation has no storage, fetch, UI, renderer, mobile or Overall wiring", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/currentPriceLastValidCache.js"), "utf8");
    assert.equal(/localStorage|indexedDB|\bfetch\s*\(|document\.|OverallV2|MobileSummary/.test(source), false);
    assert.equal(Cache.STORAGE_KEY_CANDIDATE, "optionMapCurrentPriceLastValidV1");
});
