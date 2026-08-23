const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Shadow = require("../js/currentPriceFreshnessShadow.js");

const DATE = "2026-08-24";
const PRICE = Object.freeze({ value: 41850, source: "qri-nikkei225-futures",
    mode: "automatic", contract: "2026-09", quotedAt: "2026-08-24T05:30:00+09:00",
    fetchedAt: "2026-08-24T05:31:00+09:00" });
function evaluate(price = PRICE, context = {}) {
    return Shadow.evaluateCurrentPriceFreshness(price, {
        expectedTradingDate: DATE, currentReferenceDate: DATE,
        selectedContract: "2026-09", lastAttemptStatus: "success", ...context
    });
}

test("fresh live automatic price is a current candidate", () => {
    const result = evaluate();
    assert.deepEqual([result.freshness.status, result.freshness.reason,
        result.input.origin], ["fresh", "current", "live"]);
});
test("old automatic price cannot be fresh", () => {
    const result = evaluate({ ...PRICE, quotedAt: "2026-08-21T15:30:00+09:00",
        fetchedAt: "2026-08-21T15:31:00+09:00" });
    assert.deepEqual([result.freshness.status, result.freshness.reason],
        ["stale", "source_not_updated"]);
});
test("restored same-day automatic remains saved last-valid rather than live", () => {
    const result = evaluate(PRICE, { restored: true });
    assert.deepEqual([result.input.origin, result.freshness.status, result.freshness.reason],
        ["cache", "stale", "saved_last_valid"]);
});
test("restored old automatic is visible saved last-valid", () => {
    const result = evaluate({ ...PRICE, quotedAt: "2026-08-21T15:30:00+09:00" },
        { restored: true });
    assert.deepEqual([result.freshness.status, result.freshness.reason,
        result.freshness.displayEligible], ["stale", "saved_last_valid", true]);
});
test("manual value is not automatic freshness", () => {
    const result = evaluate({ value: 42000, source: "manual", mode: "manual",
        contract: null, quotedAt: null, fetchedAt: "2026-08-24T05:40:00+09:00" },
        { selectedContract: null });
    assert.deepEqual([result.freshness.status, result.freshness.reason,
        result.freshness.staleReason], ["stale", "date_unverifiable",
        "manual_not_automatic_freshness"]);
});
test("contract mismatch is stale and diagnosed", () => {
    const result = evaluate(PRICE, { selectedContract: "2026-12" });
    assert.equal(result.freshness.status, "stale");
    assert.equal(result.freshness.staleReason, "contract_mismatch");
    assert.ok(result.freshness.diagnostics.secondaryReasons.includes("contract_mismatch"));
});
test("missing quotedAt cannot become fresh even when fetchedAt exists", () => {
    const result = evaluate({ ...PRICE, quotedAt: null });
    assert.deepEqual([result.input.dataTradingDate, result.freshness.status,
        result.freshness.reason], [null, "stale", "date_unverifiable"]);
});
test("missing fetchedAt remains a factual input and is not inferred", () => {
    const result = evaluate({ ...PRICE, fetchedAt: null });
    assert.equal(result.input.fetchedAt, null);
    assert.equal(result.input.shadowMetadata.fetchedAtPresent, false);
    assert.equal(result.freshness.status, "fresh");
});
test("both timestamps missing cannot become fresh", () => {
    const result = evaluate({ ...PRICE, quotedAt: null, fetchedAt: null });
    assert.deepEqual([result.freshness.status, result.freshness.reason],
        ["stale", "date_unverifiable"]);
});
test("malformed timestamp is invalid and not display eligible", () => {
    const result = evaluate({ ...PRICE, quotedAt: "08/24 05:30" });
    assert.equal(result.input.validation, false);
    assert.equal(result.freshness.displayEligible, false);
    assert.deepEqual(result.input.shadowMetadata.invalidFields, ["quotedAt"]);
});
test("no saved price is unavailable", () => {
    const result = evaluate({}, { restored: true });
    assert.deepEqual([result.freshness.status, result.freshness.reason,
        result.freshness.displayEligible], ["unavailable", "no_saved_data", false]);
});
test("saved valid cache stays display eligible and calculation is undetermined", () => {
    const result = evaluate(PRICE, { restored: true });
    assert.equal(result.freshness.displayEligible, true);
    assert.equal(result.freshness.calculationEligible, "undetermined");
});
test("quotedAt date is used but fetchedAt is never substituted for market date", () => {
    assert.equal(evaluate().input.dataTradingDate, DATE);
    assert.equal(evaluate({ ...PRICE, quotedAt: null }).input.dataTradingDate, null);
});
test("explicit verified trading date may be supplied without mutating price", () => {
    const original = { ...PRICE, quotedAt: null };
    const before = JSON.stringify(original);
    const result = evaluate(original, { dataTradingDate: DATE });
    assert.equal(result.input.dataTradingDate, DATE);
    assert.equal(JSON.stringify(original), before);
});
test("adapter output is pure and detached from caller state", () => {
    const original = { ...PRICE };
    const result = evaluate(original);
    original.value = 1;
    assert.equal(result.priceState.value, 41850);
    assert.equal(result.input.shadowMetadata.value, 41850);
});
test("shadow module has no storage, fetch, UI, renderer, mobile or Overall wiring", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/currentPriceFreshnessShadow.js"), "utf8");
    assert.equal(/localStorage|indexedDB|\bfetch\s*\(|document\.|OverallV2|MobileSummary/.test(source), false);
    assert.deepEqual(Object.keys(Shadow).sort(), ["ADAPTER_VERSION", "QRI_SOURCE",
        "buildCurrentPriceFreshnessInput", "evaluateCurrentPriceFreshness"].sort());
});
