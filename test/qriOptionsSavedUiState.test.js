const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Ui = require("../js/qriOptionsSavedUiState.js");

function source(sourceKind, state, extra = {}) {
    return { sourceStateVersion: 1, sourceKind, state,
        analysisPolicy: { allowFormalAnalysis: sourceKind === "live",
            allowLegacyAnalysis: sourceKind === "legacy",
            calculationSourcePolicy: sourceKind === "saved" ? "none" : `existing_${sourceKind}_policy` },
        diagnostics: { analysisSuppressed: !["live", "legacy"].includes(sourceKind) },
        ...extra };
}
function build(value) {
    return Ui.buildQriOptionsSavedUiState({ displaySourceState: value });
}
const metadata = { contract: "2026-09", tradingDate: "2026-08-25",
    pageUpdatedAt: "2026-08-25T05:50:00+09:00",
    fetchedAt: "2026-08-25T06:10:00Z" };

test("live leaves existing UI semantics untouched", () => {
    for (const state of ["live_available", "specific_live"]) {
        const result = build(source("live", state));
        assert.deepEqual([result.visible, result.showSavedBadge, result.badgeText,
            result.message], [false, false, null, null]);
    }
});

test("saved pending has neutral saved disclosure", () => {
    const result = build(source("saved", "saved_pending", { metadata }));
    assert.deepEqual([result.visible, result.showSavedBadge, result.badgeText,
        result.message, result.severity, result.note], [true, true, "保存済み建玉",
        "保存済み建玉を表示中 — 最新建玉を確認中…", "neutral", null]);
});

test("saved fallback reports acquisition failure without market inference", () => {
    const result = build(source("saved", "saved_fallback", { metadata }));
    assert.equal(result.message, "QRI取得に失敗しました。保存済み建玉を表示しています");
    assert.equal(result.severity, "caution");
    assert.doesNotMatch(result.message, /休場|休市/);
});

test("normal and stale saved remain neutral and hide technical wording", () => {
    const normal = build(source("saved", "saved_available", { metadata }));
    const stale = build(source("saved", "saved_stale", { metadata,
        freshness: { status: "stale", reason: "saved_last_valid" } }));
    assert.deepEqual([normal.message, normal.severity], ["保存済み建玉を表示中", "neutral"]);
    assert.deepEqual([stale.message, stale.severity], ["前回取得した建玉データです", "neutral"]);
    assert.doesNotMatch(stale.message, /stale/i);
});

test("legacy remains delegated to the compatible existing UI", () => {
    const result = build(source("legacy", "legacy_fallback"));
    assert.deepEqual([result.visible, result.showSavedBadge, result.showLegacyNotice,
        result.message], [false, false, false, null]);
});

test("unavailable states have scoped messages and no saved badge", () => {
    const cases = [["unavailable", "建玉データを表示できません"],
        ["contract_mismatch", "選択中の限月では保存済み建玉を利用できません"],
        ["specific_unavailable", "選択した限月の建玉データを表示できません"]];
    for (const [state, message] of cases) {
        const result = build(source("unavailable", state));
        assert.deepEqual([result.visible, result.showSavedBadge, result.message],
            [true, false, message]);
    }
});

test("specific live and superseding live clear every saved presentation field", () => {
    const saved = build(source("saved", "saved_pending", { metadata }));
    assert.equal(saved.showSavedBadge, true);
    for (const state of ["specific_live", "live_available"]) {
        const result = build(source("live", state, { metadata }));
        assert.deepEqual([result.showSavedBadge, result.badgeText, result.message,
            result.contractText, result.fetchedAtText], [false, null, null, null, null]);
    }
});

test("saved metadata is deterministically formatted in JST", () => {
    const result = build(source("saved", "saved_pending", { metadata }));
    assert.deepEqual([result.contractText, result.tradingDateText,
        result.pageUpdatedAtText, result.fetchedAtText],
    ["2026年9月限", "2026/08/25", "05:50", "8/25 15:10"]);
    assert.equal(Ui.formatPageUpdatedAt("2026-08-24T23:50:00Z", "2026-08-24"),
        "8/25 08:50");
});

test("invalid metadata is omitted rather than guessed", () => {
    const result = build(source("saved", "saved_available", { metadata: {
        contract: "September", tradingDate: "25/08/2026", pageUpdatedAt: "bad",
        fetchedAt: "bad" } }));
    assert.deepEqual([result.contractText, result.tradingDateText,
        result.pageUpdatedAtText, result.fetchedAtText], [null, null, null, null]);
});

test("diagnostics retain analysis separation without enabling calculation", () => {
    const input = source("saved", "saved_pending", { metadata,
        freshness: { status: "stale", reason: "saved_last_valid" } });
    const result = build(input);
    assert.deepEqual(result.diagnostics, { sourceKind: "saved",
        displayState: "saved_pending", freshnessStatus: "stale",
        freshnessReason: "saved_last_valid", contractContext: "2026-09",
        analysisSuppressed: true, allowFormalAnalysis: false,
        allowLegacyAnalysis: false, calculationSourcePolicy: "none",
        legacyMode: false, uiStateVersion: 1 });
});

test("output is detached, deeply frozen, and input is unchanged", () => {
    const displaySourceState = source("saved", "saved_pending", { metadata: { ...metadata },
        freshness: { status: "stale" } });
    const before = JSON.stringify(displaySourceState);
    const result = build(displaySourceState);
    assert.equal(JSON.stringify(displaySourceState), before);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.diagnostics), true);
    assert.notStrictEqual(result.diagnostics, displaySourceState.diagnostics);
});

test("badge title and labels never describe saved data as current or latest", () => {
    for (const state of ["saved_pending", "saved_fallback", "saved_available", "saved_stale"]) {
        const result = build(source("saved", state, { metadata }));
        assert.doesNotMatch(result.badgeText || "", /現在の建玉|最新建玉|現在建玉|最新データ/);
    }
});

test("pure module stays isolated after renderer dependency wiring", () => {
    const code = fs.readFileSync(path.join(__dirname, "../js/qriOptionsSavedUiState.js"), "utf8");
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|\bfetch\s*\(/);
    assert.doesNotMatch(code, /document\.|querySelector|drawJpxPriceChart|OverallV2/);
    assert.doesNotMatch(code, /setTimeout|setInterval|allJpx|optionMapJudgmentState/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal(html.includes("qriOptionsSavedUiState.js"), true);
});
