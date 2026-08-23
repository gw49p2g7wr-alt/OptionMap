const test = require("node:test");
const assert = require("node:assert/strict");
const Freshness = require("../js/dataFreshness.js");

const CURRENT = "2026-08-24";
function daily(overrides = {}) {
    return Freshness.evaluateDailyFreshness({ sourceType: "qri", origin: "live",
        hasData: true, dataTradingDate: CURRENT, fetchedAt: `${CURRENT}T06:05:00+09:00`,
        expectedTradingDate: CURRENT, lastAttemptStatus: "success", validation: true,
        signatureValid: true, ...overrides });
}
function weekly(overrides = {}) {
    return Freshness.evaluateWeeklyFreshness({ sourceType: "weekly_futures", origin: "cache",
        hasData: true, sourceDate: "2026-08-14", fetchedAt: "2026-08-14T16:00:00+09:00",
        validation: true, signatureValid: true, remoteCheckStatus: "current", ...overrides });
}

test("daily current live is fresh", () => {
    const result = daily();
    assert.deepEqual([result.status, result.reason, result.displayEligible], ["fresh", "current", true]);
});
test("saved last-valid is visible but stale", () => {
    const result = daily({ origin: "cache", dataTradingDate: "2026-08-21" });
    assert.deepEqual([result.status, result.reason, result.displayEligible], ["stale", "saved_last_valid", true]);
});
test("failed update with cache keeps display and records both facts", () => {
    const result = daily({ origin: "cache", dataTradingDate: "2026-08-21",
        lastAttemptedAt: "2026-08-24T05:00:00+09:00", lastAttemptStatus: "failed" });
    assert.equal(result.reason, "saved_last_valid");
    assert.equal(result.staleReason, "data_older_than_expected");
    assert.ok(result.diagnostics.secondaryReasons.includes("fetch_failed"));
});
test("failed update without saved data is unavailable", () => {
    const result = daily({ hasData: false, dataTradingDate: null, fetchedAt: null,
        lastAttemptStatus: "failed" });
    assert.deepEqual([result.status, result.reason, result.displayEligible], ["unavailable", "fetch_failed", false]);
});
test("confirmed previous trading day is distinct", () => {
    assert.equal(daily({ dataTradingDate: "2026-08-21", isPreviousTradingDay: true }).reason,
        "previous_trading_day");
});
test("old date without expected trading date is not called previous trading day", () => {
    const result = daily({ expectedTradingDate: null, currentReferenceDate: CURRENT,
        dataTradingDate: "2026-08-21" });
    assert.deepEqual([result.reason, result.staleReason], ["source_not_updated", "date_unverifiable"]);
});
test("missing comparison date is date unverifiable", () => {
    assert.equal(daily({ expectedTradingDate: null, currentReferenceDate: null }).reason, "date_unverifiable");
});
test("live source not updated is stale", () => {
    assert.equal(daily({ dataTradingDate: "2026-08-21" }).reason, "source_not_updated");
});
test("invalid timestamp is diagnosed without throwing", () => {
    const result = daily({ sourceUpdatedAt: "not-a-time" });
    assert.ok(result.diagnostics.invalidFields.includes("sourceUpdatedAt"));
});
test("missing daily metadata is unavailable", () => {
    const result = Freshness.evaluateDailyFreshness({});
    assert.deepEqual([result.status, result.reason], ["unavailable", "no_saved_data"]);
});
test("live and cache origins remain explicit", () => {
    assert.equal(daily().origin, "live");
    assert.equal(daily({ origin: "cache" }).origin, "cache");
});
test("invalid saved data is not display eligible", () => {
    assert.equal(daily({ origin: "cache", validation: false }).displayEligible, false);
});
test("calculation eligibility defaults to undetermined", () => {
    assert.equal(daily().calculationEligible, "undetermined");
});
test("explicit calculation state is preserved without policy inference", () => {
    assert.equal(daily({ calculationEligible: "ineligible" }).calculationEligible, "ineligible");
});

test("fresh automatic current price is fresh", () => {
    const result = daily({ sourceType: "current_price", mode: "automatic",
        quotedAt: "2026-08-24T05:30:00+09:00", contract: "2026-09" });
    assert.equal(result.status, "fresh");
});
test("old automatic current price cannot be fresh", () => {
    const result = daily({ sourceType: "current_price", mode: "automatic",
        dataTradingDate: "2026-08-21", quotedAt: "2026-08-21T15:30:00+09:00" });
    assert.equal(result.status, "stale");
});
test("manual price is not automatic freshness", () => {
    const result = daily({ sourceType: "current_price", mode: "manual" });
    assert.deepEqual([result.status, result.staleReason], ["stale", "manual_not_automatic_freshness"]);
});
test("current price without quoted or trading date is date unverifiable", () => {
    const result = daily({ sourceType: "current_price", dataTradingDate: null,
        fetchedAt: "2026-08-24T05:30:00+09:00" });
    assert.equal(result.reason, "date_unverifiable");
});
test("contract mismatch remains visible but stale", () => {
    const result = daily({ sourceType: "current_price", contractMatches: false });
    assert.equal(result.status, "stale");
    assert.ok(result.diagnostics.secondaryReasons.includes("contract_mismatch"));
});

test("IV runtime live can be fresh", () => {
    const result = daily({ sourceType: "qri_iv", origin: "runtime", contract: "2026-09" });
    assert.deepEqual([result.status, result.origin], ["fresh", "runtime"]);
});
test("future IV cache is represented as stale saved last-valid", () => {
    const result = daily({ sourceType: "qri_iv", origin: "cache", dataTradingDate: "2026-08-21" });
    assert.equal(result.reason, "saved_last_valid");
});
test("no saved IV is unavailable", () => {
    const result = daily({ sourceType: "qri_iv", hasData: false,
        dataTradingDate: null, fetchedAt: null });
    assert.equal(result.status, "unavailable");
});
test("legacy unsigned QRI cache remains diagnosed", () => {
    const result = daily({ origin: "cache", signatureValid: undefined });
    assert.equal(result.diagnostics.signature, "unverified");
    assert.ok(result.diagnostics.secondaryReasons.includes("signature_unverified"));
});

test("latest validated weekly cache is fresh despite old-looking date", () => {
    assert.deepEqual([weekly().status, weekly().reason], ["fresh", "current"]);
});
test("weekly remote failure keeps validated cache visible", () => {
    const result = weekly({ remoteCheckStatus: "failed", lastAttemptStatus: "failed" });
    assert.deepEqual([result.status, result.reason, result.displayEligible], ["stale", "saved_last_valid", true]);
    assert.ok(result.diagnostics.secondaryReasons.includes("fetch_failed"));
});
test("weekly source not updated is stale", () => {
    assert.equal(weekly({ remoteCheckStatus: "not_updated" }).reason, "source_not_updated");
});
test("weekly newer revision available is explicit", () => {
    const result = weekly({ remoteCheckStatus: "newer_available" });
    assert.equal(result.reason, "source_not_updated");
    assert.ok(result.diagnostics.secondaryReasons.includes("new_revision_available"));
});
test("weekly does not infer staleness from calendar age", () => {
    assert.equal(weekly({ sourceDate: "2025-01-01" }).status, "fresh");
});
test("weekly invalid signature metadata is unavailable", () => {
    const result = weekly({ signatureValid: false });
    assert.deepEqual([result.status, result.displayEligible], ["unavailable", false]);
});

test("Morning Baseline is a session reference, not current freshness", () => {
    const result = Freshness.evaluateFreshness({ sourceType: "morning_baseline" });
    assert.deepEqual([result.status, result.reason, result.promotedToCurrent],
        ["not_applicable", "session_based_reference", false]);
});
test("Price Snapshot history is never promoted to current", () => {
    const result = Freshness.evaluateFreshness({ sourceType: "price_snapshot" });
    assert.deepEqual([result.status, result.reason, result.promotedToCurrent],
        ["not_applicable", "history_fact", false]);
});
test("Observation history is never promoted to current", () => {
    const result = Freshness.evaluateFreshness({ sourceType: "observation_history" });
    assert.deepEqual([result.status, result.reason, result.promotedToCurrent],
        ["not_applicable", "history_fact", false]);
});
test("unsupported policy is explicitly not applicable", () => {
    assert.equal(Freshness.evaluateFreshness({ sourceType: "other" }).status, "not_applicable");
});
test("module exposes no storage, fetch, UI, or Overall connector", () => {
    assert.deepEqual(Object.keys(Freshness).sort(), ["FOUNDATION_VERSION",
        "evaluateDailyFreshness", "evaluateFreshness", "evaluateWeeklyFreshness"].sort());
    const source = require("node:fs").readFileSync(require("node:path").join(__dirname,
        "../js/dataFreshness.js"), "utf8");
    assert.equal(/localStorage|indexedDB|\bfetch\s*\(|document\.|OverallV2/.test(source), false);
});
