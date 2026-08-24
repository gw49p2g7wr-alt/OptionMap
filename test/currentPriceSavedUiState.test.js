const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Ui = require("../js/currentPriceSavedUiState.js");

function boot(overrides = {}) {
    return {
        status: "candidate", reason: null, displayEligible: true,
        calculationEligible: "undetermined",
        freshness: { status: "stale", reason: "saved_last_valid",
            staleReason: "saved_data_origin" },
        candidate: { origin: "cache", value: 65660, source: "qri-nikkei225-futures",
            mode: "automatic", contract: "2026-09", quoteDate: "2026-08-24",
            quotedAtRaw: "08/24 17:47",
            quotedAtNormalized: "2026-08-24T17:47:00+09:00",
            fetchedAt: "2026-08-24T09:04:05.391Z", pageTradingDate: "2026-08-25",
            pageUpdatedAt: "2026-08-24T17:48:00+09:00" },
        diagnostics: { integrityVerified: true, restoreStatus: "verified" },
        ...overrides
    };
}
const build = overrides => Ui.buildCurrentPriceSavedUiState({
    bootShadowState: boot(), liveFetchState: { status: "pending" },
    currentPriceMode: "automatic", ...overrides });

test("saved pending is visible and neutral", () => {
    const result = build();
    assert.deepEqual([result.visible, result.state, result.severity],
        [true, "saved_pending", "neutral"]);
});
test("pending uses the checking message", () => {
    assert.equal(build().message, "最新価格を確認中…");
});
test("unknown live state uses the unconfirmed message", () => {
    assert.equal(build({ liveFetchState: { status: "unknown" } }).message,
        "最新価格は未確認です");
});
test("not-started live state is an unconfirmed saved pending state", () => {
    const result = build({ liveFetchState: "not_started" });
    assert.deepEqual([result.state, result.message],
        ["saved_pending", "最新価格は未確認です"]);
});
test("failed live acquisition creates a caution fallback", () => {
    const result = build({ liveFetchState: { status: "failed" } });
    assert.deepEqual([result.state, result.severity], ["saved_fallback", "caution"]);
});
test("fallback message separates failure from the saved price", () => {
    assert.equal(build({ liveFetchState: "failed" }).message,
        "価格取得に失敗しました。保存済み価格を表示しています。");
});
test("unresolved quote creates a caution source-fact state", () => {
    const unresolved = boot(); unresolved.candidate.quoteDate = null;
    unresolved.candidate.quotedAtNormalized = null;
    const result = build({ bootShadowState: unresolved });
    assert.deepEqual([result.state, result.severity, result.message],
        ["saved_unresolved", "caution", "価格日時の年を確認できません"]);
});
test("unresolved quote retains raw time without adding a year", () => {
    const unresolved = boot(); unresolved.candidate.quoteDate = null;
    unresolved.candidate.quotedAtNormalized = null;
    assert.equal(build({ bootShadowState: unresolved }).metadataLines[0],
        "価格時刻：08/24 17:47");
});
test("live success always hides the saved candidate", () => {
    assert.equal(build({ liveFetchState: "success" }).diagnostics.hiddenReason, "live_success");
});
test("superseded state is hidden even when candidate remains", () => {
    const result = build({ bootShadowState: boot({ status: "superseded",
        reason: "replaced_by_live" }) });
    assert.deepEqual([result.visible, result.diagnostics.hiddenReason],
        [false, "replaced_by_live"]);
});
for (const status of ["missing", "invalid", "tampered", "unavailable"]) {
    test(`${status} boot state is hidden`, () => {
        const result = build({ bootShadowState: boot({ status }) });
        assert.deepEqual([result.visible, result.state], [false, "hidden"]);
    });
}
test("candidate missing is hidden", () => {
    assert.equal(build({ bootShadowState: boot({ candidate: null }) }).visible, false);
});
test("explicit integrity failure is treated as tampered and hidden", () => {
    const result = build({ bootShadowState: boot({ diagnostics:
        { integrityVerified: false, restoreStatus: "rejected" } }) });
    assert.equal(result.diagnostics.hiddenReason, "candidate_invalid");
});
test("display-ineligible cache never becomes a fallback", () => {
    const result = build({ bootShadowState: boot({ displayEligible: false }),
        liveFetchState: "failed" });
    assert.equal(result.diagnostics.hiddenReason, "display_ineligible");
});
test("manual current price hides automatic saved price", () => {
    assert.equal(build({ currentPriceMode: "manual" }).diagnostics.hiddenReason, "manual_mode");
});
test("explicit contract mismatch is hidden", () => {
    const result = build({ activeContract: "2026-12" });
    assert.deepEqual([result.visible, result.diagnostics.hiddenReason,
        result.diagnostics.contractContext], [false, "contract_mismatch", "mismatch"]);
});
test("freshness contract mismatch is hidden", () => {
    const mismatch = boot(); mismatch.freshness.staleReason = "contract_mismatch";
    assert.equal(build({ bootShadowState: mismatch }).visible, false);
});
test("unknown active contract does not hide a valid candidate", () => {
    const result = build({ activeContract: null });
    assert.deepEqual([result.visible, result.diagnostics.contractContext], [true, "unknown"]);
});
test("canonical and QRI label contracts reuse the formal matcher", () => {
    assert.equal(build({ activeContract: "26年09月限" }).visible, true);
});
test("price is formatted as Japanese yen", () => {
    assert.equal(Ui.formatPrice(65660), "65,660円");
});
test("zero, NaN and negative prices are invalid", () => {
    assert.deepEqual([Ui.formatPrice(0), Ui.formatPrice(NaN), Ui.formatPrice(-1)],
        [null, null, null]);
});
test("canonical contract is formatted without guessing", () => {
    assert.deepEqual([Ui.formatContract("2026-09"), Ui.formatContract("bad")],
        ["2026年9月限", null]);
});
test("invalid candidate contract hides the state", () => {
    const invalid = boot(); invalid.candidate.contract = "26年09月限";
    assert.equal(build({ bootShadowState: invalid }).visible, false);
});
test("non-QRI candidate source is not shown as a saved automatic price", () => {
    const invalid = boot(); invalid.candidate.source = "manual";
    assert.equal(build({ bootShadowState: invalid }).diagnostics.hiddenReason,
        "candidate_invalid");
});
test("normalized quote time is displayed in explicit JST", () => {
    assert.equal(build().metadataLines[0], "価格時刻：8/24 17:47");
});
test("UTC fetchedAt is displayed in explicit JST", () => {
    assert.equal(build().metadataLines[1], "最終取得：8/24 18:04");
});
test("invalid normalized quote falls back to raw and unresolved state", () => {
    const invalid = boot(); invalid.candidate.quotedAtNormalized = "bad";
    const result = build({ bootShadowState: invalid });
    assert.deepEqual([result.state, result.metadataLines[0]],
        ["saved_unresolved", "価格時刻：08/24 17:47"]);
});
test("display metadata excludes page and integrity internals", () => {
    const text = JSON.stringify(build().metadataLines);
    assert.equal(/pageTradingDate|pageUpdatedAt|signature|versionKey/.test(text), false);
});
test("note explicitly marks reference-only non-application", () => {
    assert.equal(build().note, "参考表示・現在値には未反映");
});
test("saved title and price never use prohibited live labels", () => {
    const result = build();
    assert.equal(/現在値|最新価格|現在の価格/.test(`${result.title}${result.priceText}`), false);
});
test("all visible states use only neutral or caution severity", () => {
    const pending = build();
    const fallback = build({ liveFetchState: "failed" });
    const unresolved = boot(); unresolved.candidate.quoteDate = null;
    unresolved.candidate.quotedAtNormalized = null;
    assert.deepEqual([pending.severity, fallback.severity,
        build({ bootShadowState: unresolved }).severity], ["neutral", "caution", "caution"]);
});
test("diagnostics separate technical state from display strings", () => {
    const result = build({ activeContract: "2026-09" });
    assert.deepEqual(result.diagnostics, { uiStateVersion: 1, hiddenReason: null,
        bootStatus: "candidate", liveStatus: "pending", contractContext: "matched",
        freshnessStatus: "stale", freshnessReason: "saved_last_valid" });
});
test("input is not mutated", () => {
    const input = { bootShadowState: boot(), liveFetchState: { status: "pending" },
        currentPriceMode: "automatic", activeContract: "2026-09" };
    const before = JSON.stringify(input); Ui.buildCurrentPriceSavedUiState(input);
    assert.equal(JSON.stringify(input), before);
});
test("visible and hidden outputs are deeply frozen", () => {
    const shown = build(); const hidden = build({ liveFetchState: "success" });
    assert.equal([shown, shown.metadataLines, shown.diagnostics, hidden,
        hidden.metadataLines, hidden.diagnostics].every(Object.isFrozen), true);
});
test("Phase 5.1 live fixture is pending before and hidden after live success", () => {
    const before = build({ liveFetchState: "pending" });
    const after = build({ bootShadowState: boot({ status: "superseded",
        reason: "replaced_by_live" }), liveFetchState: "success" });
    assert.deepEqual([before.priceText, before.visible, after.visible],
        ["65,660円", true, false]);
});
test("module has no storage, fetch, DOM, CSS, currentPrice, Mobile or Overall wiring", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/currentPriceSavedUiState.js"), "utf8");
    assert.equal(/localStorage|indexedDB|\bfetch\s*\(|document\.|\.style\b|classList/.test(source), false);
    assert.equal(/applyCurrentPrice|setCurrentPrice|MobileSummary|OverallV2/.test(source), false);
});
test("pure module is not loaded by renderer", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal(html.includes("currentPriceSavedUiState.js"), false);
});
