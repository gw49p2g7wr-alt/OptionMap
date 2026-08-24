const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Ui = require("../js/qriIvSavedUiState.js");

function source(sourceKind = "saved", state = "saved_pending", extra = {}) {
    return { available: sourceKind !== "unavailable", sourceKind, state, reason: null,
        contract: "2026-09", liveStatus: state === "saved_fallback" ? "failed" : "pending",
        freshness: { status: "stale", reason: "saved_last_valid" },
        metadata: { tradingDate: "2026-08-25",
            pageUpdatedAt: "2026-08-24T19:59:00+09:00",
            fetchedAt: "2026-08-24T11:14:28.539Z" },
        rangePolicy: { defaultRange: sourceKind === "saved" ? "all" : "plus_minus_3000" },
        diagnostics: { contractMatched: true }, ...extra };
}
function side(availablePoints, message = null) {
    return { availablePoints, message };
}
function graph(extra = {}) {
    return { available: true, chartAvailable: true, state: "available", message: null,
        metadata: { contract: "2026-09", tradingDate: "2026-08-25",
            pageUpdatedAt: "2026-08-24T19:59:00+09:00", rangeMode: "all",
            rangeLabel: "全範囲" },
        series: { call: side(3), put: side(4) }, ...extra };
}
const build = (sourceState = source(), graphViewModel = graph(), rangeMode) =>
    Ui.buildQriIvSavedUiState({ graphSourceState: sourceState, graphViewModel, rangeMode });

test("live uses normal presentation without a saved badge or message", () => {
    const result = build(source("live", "live_available", { liveStatus: "success" }));
    assert.deepEqual([result.sourceKind, result.showSavedBadge, result.statusLabel,
        result.message], ["live", false, null, null]);
});
test("live preserves graph publication message unchanged", () => {
    assert.equal(build(source("live", "selected_live"), graph({
        message: "この範囲にはIV公表データがありません", chartAvailable: false,
        state: "empty" })).message, "この範囲にはIV公表データがありません");
});
test("saved pending is visible neutral and explicitly labelled", () => {
    const result = build();
    assert.deepEqual([result.visible, result.state, result.showSavedBadge,
        result.statusLabel, result.severity],
    [true, "saved_pending", true, "保存済みIV", "neutral"]);
    assert.equal(result.message, "保存済みIVを表示中 — 最新IVを確認中…");
});
test("saved fallback is caution and explains acquisition failure", () => {
    const result = build(source("saved", "saved_fallback"));
    assert.deepEqual([result.severity, result.message], ["caution",
        "IV取得に失敗しました。保存済みIVを表示しています"]);
});
test("saved stale technical word is not exposed in display strings", () => {
    const result = build();
    assert.doesNotMatch([result.statusLabel, result.message].join(" "), /stale/i);
    assert.equal(result.diagnostics.freshnessStatus, "stale");
});
test("sparse graph keeps existing side messages and is not an error", () => {
    const result = build(source(), graph({ series: {
        call: side(2, "公表点のみ表示"), put: side(1, "IVデータ1点のみ") } }));
    assert.deepEqual(result.sideMessages, ["公表点のみ表示", "IVデータ1点のみ"]);
    assert.equal(result.graphAvailable, true);
});
test("saved all-missing is neutral with publication-specific empty text", () => {
    const result = build(source(), graph({ chartAvailable: false, state: "empty",
        message: "この範囲にはIV公表データがありません",
        series: { call: side(0, "IV公表データなし"), put: side(0, "IV公表データなし") } }));
    assert.deepEqual([result.graphAvailable, result.severity], [false, "neutral"]);
    assert.equal(result.message,
        "保存済みIVはありますが、この範囲にはIV公表データがありません");
});
test("contract mismatch has a scoped unavailable message and no badge", () => {
    const result = build(source("unavailable", "contract_mismatch"));
    assert.deepEqual([result.graphAvailable, result.showSavedBadge, result.message],
        [false, false, "選択中の限月では保存済みIVを利用しません"]);
});
test("selected unavailable and general unavailable have distinct messages", () => {
    assert.equal(build(source("unavailable", "selected_unavailable")).message,
        "選択した限月のIVデータを表示できません");
    assert.equal(build(source("unavailable", "unavailable")).message,
        "IVデータを表示できません");
});
test("selected live remains live and never receives active saved labels", () => {
    const result = build(source("live", "selected_live", { channel: "selected" }));
    assert.deepEqual([result.sourceKind, result.state, result.showSavedBadge],
        ["live", "selected_live", false]);
});
test("superseded result cannot retain saved label or message", () => {
    const result = build(source("live", "live_available", { liveStatus: "success" }));
    assert.deepEqual([result.statusLabel, result.showSavedBadge, result.message],
        [null, false, null]);
});
test("saved metadata is formatted without system-time guessing", () => {
    const result = build();
    assert.deepEqual([result.contractText, result.tradingDateText,
        result.pageUpdatedAtText, result.fetchedAtText, result.rangeText],
    ["2026年9月限", "8/25", "8/24 19:59", "8/24 20:14", "全範囲"]);
});
test("range modes have fixed Japanese labels", () => {
    assert.deepEqual([build(source(), graph(), "plus_minus_3000").rangeText,
        build(source(), graph(), "plus_minus_5000").rangeText,
        build(source(), graph(), "all").rangeText], ["±3,000円", "±5,000円", "全範囲"]);
});
test("saved default range follows source policy and does not inspect CurrentPrice", () => {
    assert.equal(build(source(), null).rangeText, "全範囲");
});
test("saved status and title never claim to be current or latest IV", () => {
    for (const state of [source(), source("saved", "saved_fallback")]) {
        const result = build(state);
        assert.doesNotMatch(`${result.statusLabel}`, /最新IV|現在のIV/);
    }
});
test("diagnostics retain technical facts outside display strings", () => {
    assert.deepEqual(build().diagnostics, { sourceKind: "saved",
        graphSourceState: "saved_pending", freshnessStatus: "stale",
        freshnessReason: "saved_last_valid", contractContext: true,
        graphAvailable: true, rangeMode: "all", liveStatus: "pending",
        savedReason: null, graphState: "available" });
});
test("input remains unchanged and output is deeply frozen", () => {
    const input = { graphSourceState: source(), graphViewModel: graph(), rangeMode: "all" };
    const before = JSON.stringify(input); const result = Ui.buildQriIvSavedUiState(input);
    assert.equal(JSON.stringify(input), before);
    assert.equal([result, result.sideMessages, result.diagnostics].every(Object.isFrozen), true);
});
test("state table remains consistent across live saved and unavailable", () => {
    const cases = [[source("live", "live_available"), "live", false],
        [source("saved", "saved_pending"), "saved", true],
        [source("saved", "saved_fallback"), "saved", true],
        [source("unavailable", "unavailable"), "unavailable", false]];
    for (const [input, kind, badge] of cases) {
        const result = build(input);
        assert.deepEqual([result.sourceKind, result.showSavedBadge], [kind, badge]);
    }
});
test("pure module has no storage fetch DOM Chart runtime CurrentPrice or calculation wiring", () => {
    const moduleSource = fs.readFileSync(path.join(__dirname,
        "../js/qriIvSavedUiState.js"), "utf8");
    assert.doesNotMatch(moduleSource, /localStorage|indexedDB|\bfetch\s*\(|document\.|Chart\b/);
    assert.doesNotMatch(moduleSource,
        /currentQriOptionIv|CurrentPrice|OverallV2|calculationEligible|setTimeout|setInterval/);
});
test("pure module is renderer-loaded after source state without embedding DOM logic", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal(html.includes("qriIvSavedUiState.js"), true);
    assert.equal(html.indexOf("qriIvGraphSourceState.js") <
        html.indexOf("qriIvSavedUiState.js"), true);
});
