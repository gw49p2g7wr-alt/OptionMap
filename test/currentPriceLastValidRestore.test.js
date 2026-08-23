const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Cache = require("../js/currentPriceLastValidCache.js");
const Restore = require("../js/currentPriceLastValidRestore.js");

const INPUT = Object.freeze({ source: "qri-nikkei225-futures", mode: "automatic", value: 66010,
    contract: "2026-09", tradingDate: "2026-08-24", quotedAtRaw: "8/24 05:30",
    fetchedAt: "2026-08-24T05:31:00+09:00", sourceUrl: "https://svc.qri.jp/jpx/nkopm/" });
async function valid(overrides = {}) {
    const result = await Cache.buildCurrentPriceLastValidCache({ ...INPUT, ...overrides });
    assert.equal(result.success, true);
    return result.cache;
}

test("valid serialized cache restores", async () => {
    const result = await Restore.restoreCurrentPriceLastValidCache(JSON.stringify(await valid()));
    assert.deepEqual([result.success, result.reason, result.diagnostics.inputType],
        [true, null, "serialized"]);
});
test("valid parsed object restores", async () => {
    assert.equal((await Restore.restoreCurrentPriceLastValidCache(await valid())).success, true);
});
test("null, undefined and blank remain distinct", async () => {
    assert.equal((await Restore.restoreCurrentPriceLastValidCache(null)).reason, "input_null");
    assert.equal((await Restore.restoreCurrentPriceLastValidCache(undefined)).reason, "input_undefined");
    assert.equal((await Restore.restoreCurrentPriceLastValidCache("  ")).reason, "input_blank");
});
test("malformed JSON is contained", async () => {
    const result = await Restore.restoreCurrentPriceLastValidCache("{");
    assert.deepEqual([result.success, result.reason, result.cache], [false, "parse_error", null]);
});
test("parse API separates parsing from validation", async () => {
    const result = Restore.parseCurrentPriceLastValidCache(JSON.stringify(await valid()));
    assert.deepEqual([result.success, result.diagnostics.parsed,
        result.diagnostics.validated], [true, true, false]);
});
test("legacy object is never migrated or restored", async () => {
    const legacy = { value: 66010, source: INPUT.source, contract: INPUT.contract,
        quotedAt: "8/24 05:30", fetchedAt: INPUT.fetchedAt };
    assert.equal((await Restore.restoreCurrentPriceLastValidCache(legacy)).reason, "cache_invalid");
});

for (const [name, field, value] of [
    ["cacheVersion", "cacheVersion", 2], ["schemaVersion", "schemaVersion", 2],
    ["source", "source", "manual"], ["mode", "mode", "manual"],
    ["value", "value", 0], ["contract", "contract", null],
    ["tradingDate", "tradingDate", null], ["quotedAtRaw", "quotedAtRaw", "bad"],
    ["quotedAtNormalized", "quotedAtNormalized", "bad"],
    ["fetchedAt", "fetchedAt", "bad"], ["sourceUrl", "sourceUrl", "https://example.com/"],
    ["quoteSignature", "quoteSignature", "0".repeat(64)],
    ["signature", "signature", "0".repeat(64)], ["versionKey", "versionKey", "bad"]
]) {
    test(`${name} tamper is rejected`, async () => {
        const result = await Restore.restoreCurrentPriceLastValidCache({ ...await valid(), [field]: value });
        assert.deepEqual([result.success, result.reason, result.cache], [false, "cache_invalid", null]);
    });
}
test("unknown field is rejected through the formal validator", async () => {
    assert.equal((await Restore.restoreCurrentPriceLastValidCache({ ...await valid(), extra: true })).success, false);
});
test("restore returns a detached clone", async () => {
    const input = JSON.parse(JSON.stringify(await valid()));
    const result = await Restore.restoreCurrentPriceLastValidCache(input);
    assert.notEqual(result.cache, input);
    input.value = 1;
    assert.equal(result.cache.value, 66010);
});
test("restore never mutates its input", async () => {
    const input = JSON.parse(JSON.stringify(await valid())); const before = JSON.stringify(input);
    await Restore.restoreCurrentPriceLastValidCache(input);
    assert.equal(JSON.stringify(input), before);
});
test("successful result and cache are deeply frozen", async () => {
    const result = await Restore.restoreCurrentPriceLastValidCache(await valid());
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.cache), true);
    assert.equal(Object.isFrozen(result.diagnostics), true);
});
test("old tradingDate cache remains restorable when internally valid", async () => {
    const cache = await valid({ tradingDate: "2026-08-21", quotedAtRaw: "8/21 15:30",
        fetchedAt: "2026-08-21T15:31:00+09:00" });
    assert.equal((await Restore.restoreCurrentPriceLastValidCache(cache)).success, true);
});
test("old restored cache is stale in Freshness Shadow", async () => {
    const cache = await valid({ tradingDate: "2026-08-21", quotedAtRaw: "8/21 15:30",
        fetchedAt: "2026-08-21T15:31:00+09:00" });
    const result = await Restore.restoreCurrentPriceLastValidWithFreshness(cache,
        { expectedTradingDate: "2026-08-24", selectedContract: "2026-09" });
    assert.deepEqual([result.freshness.status, result.freshness.reason,
        result.freshness.origin], ["stale", "saved_last_valid", "cache"]);
});
test("restored same-day cache is saved last-valid, not live", async () => {
    const result = await Restore.restoreCurrentPriceLastValidWithFreshness(await valid(),
        { expectedTradingDate: "2026-08-24", selectedContract: "2026-09" });
    assert.deepEqual([result.freshness.status, result.freshness.reason,
        result.freshness.displayEligible, result.freshness.calculationEligible],
        ["stale", "saved_last_valid", true, "undetermined"]);
});
test("contract mismatch belongs to Freshness context, not restore validation", async () => {
    const result = await Restore.restoreCurrentPriceLastValidWithFreshness(await valid(),
        { expectedTradingDate: "2026-08-24", selectedContract: "2026-12" });
    assert.equal(result.success, true);
    assert.equal(result.freshness.staleReason, "contract_mismatch");
});
test("invalid restore has no partial cache or freshness", async () => {
    const result = await Restore.restoreCurrentPriceLastValidWithFreshness({ value: 1 });
    assert.deepEqual([result.cache, result.freshness, result.shadow], [null, null, null]);
});
test("module is fixture-only with no storage, fetch, UI, renderer, mobile or Overall wiring", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/currentPriceLastValidRestore.js"), "utf8");
    assert.equal(/localStorage|indexedDB|\bfetch\s*\(|document\.|OverallV2|MobileSummary/.test(source), false);
    assert.equal(/optionMapCurrentPrice|optionMapLastQriFuturesPrice/.test(source), false);
});
