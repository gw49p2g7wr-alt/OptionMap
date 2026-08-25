const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Ui = require("../js/qriOptionsSavedReferenceUiState.js");

function analysis(overrides = {}) {
    return { analysisStateVersion: 1, accepted: true, available: true,
        reason: null, sourceKind: "saved", sourceState: "saved_fallback",
        referenceOnly: true, calculationEligible: false,
        identity: { contract: "2026-09", tradingDate: "2026-08-25",
            pageUpdatedAt: "2026-08-25T05:50:00+09:00",
            fetchedAt: "2026-08-25T06:10:00Z",
            canonicalSignature: "a".repeat(64),
            canonicalVersionKey: "qri-options-v2|2026-09|saved",
            displayGeneration: 7 },
        freshness: { tier: "same_trading_date_verified", status: "stale",
            reason: "saved_last_valid", calendarContextResolved: true },
        call: { topOpenInterest: [
            { strike: 67000, openInterest: 3250 },
            { strike: 68000, openInterest: 2840 },
            { strike: 70000, openInterest: 2120 }],
        maximumOpenInterest: { strike: 67000, openInterest: 3250 } },
        put: { topOpenInterest: [
            { strike: 62000, openInterest: 4100 },
            { strike: 61000, openInterest: 2900 }],
        maximumOpenInterest: { strike: 62000, openInterest: 4100 } },
        strikeRows: [], comparison: null, judgment: null, overallV2: null,
        currentPrice: null, analysisPolicy: { allowReferenceAnalysis: true,
            allowFormalAnalysis: false, allowLegacyAnalysis: false,
            allowOverallV2: false, calculationEligible: false },
        diagnostics: {}, ...overrides };
}

const build = value => Ui.buildQriOptionsSavedReferenceUiState({
    referenceAnalysisState: value });

test("valid saved reference analysis is visible and neutral", () => {
    const result = build(analysis());
    assert.deepEqual([result.visible, result.state, result.severity,
        result.referenceOnly, result.calculationEligible],
    [true, "saved_reference_visible", "neutral", true, false]);
});

test("live legacy unavailable invalid and superseded inputs are hidden and cleared", () => {
    const cases = [
        analysis({ sourceKind: "live" }),
        analysis({ sourceKind: "legacy" }),
        analysis({ sourceKind: "unavailable", available: false }),
        analysis({ accepted: false, available: false }),
        analysis({ sourceState: "superseded" })
    ];
    for (const input of cases) {
        const result = build(input);
        assert.deepEqual([result.visible, result.title, result.subtitle,
            result.call.topItems, result.put.topItems, result.metadataLines,
            result.note], [false, null, null, [], [], [], null]);
    }
    assert.equal(build(cases.at(-1)).state, "superseded");
});

test("title and note identify saved reference information without market inference", () => {
    const result = build(analysis());
    assert.equal(result.title, "保存済み建玉からの参考情報");
    assert.equal(result.note,
        "保存済みデータからの参考情報です。現在の相場判断には使用していません。");
});

test("CALL and PUT items retain analysis order and format deterministic units", () => {
    const result = build(analysis());
    assert.equal(result.call.label, "CALL 建玉上位");
    assert.equal(result.put.label, "PUT 建玉上位");
    assert.deepEqual(result.call.topItems.map(item => item.text), [
        "1. 67,000円　3,250枚", "2. 68,000円　2,840枚",
        "3. 70,000円　2,120枚"]);
    assert.deepEqual(result.put.topItems.map(item => item.text), [
        "1. 62,000円　4,100枚", "2. 61,000円　2,900枚"]);
    assert.deepEqual(result.call.topItems.map(item => item.strike),
        [67000, 68000, 70000]);
});

test("maximum is retained in state and marked on matching top item", () => {
    const result = build(analysis());
    assert.deepEqual(result.call.maximumItem, { rank: 1, strike: 67000,
        openInterest: 3250, strikeText: "67,000円", openInterestText: "3,250枚",
        text: "1. 67,000円　3,250枚", isMaximum: true });
    assert.equal(result.call.topItems[0].isMaximum, true);
    assert.equal(result.call.topItems[1].isMaximum, false);
});

test("empty CALL and PUT report publication facts without calling them failures", () => {
    const emptyCall = analysis({ call: { topOpenInterest: [], maximumOpenInterest: null } });
    assert.deepEqual([build(emptyCall).call.topItems, build(emptyCall).call.emptyText],
        [[], "CALL：公表建玉なし"]);
    const emptyPut = analysis({ put: { topOpenInterest: [], maximumOpenInterest: null } });
    assert.deepEqual([build(emptyPut).put.topItems, build(emptyPut).put.emptyText],
        [[], "PUT：公表建玉なし"]);
    assert.doesNotMatch(build(emptyCall).call.emptyText, /失敗|エラー/);
});

test("metadata is deterministic and retains the four source facts", () => {
    const result = build(analysis());
    assert.deepEqual(result.metadataLines.map(line => line.text), [
        "限月：2026年9月限", "取引日：2026/08/25",
        "QRI更新：2026/08/25 05:50 JST", "最終取得：2026/08/25 15:10 JST"
    ]);
    assert.deepEqual([Ui.formatInteger(67000), Ui.formatInteger(3250)],
        ["67,000", "3,250"]);
});

test("freshness tiers use plain wording without previous-day inference", () => {
    const cases = [
        ["same_trading_date_verified", "保存時点の建玉データです"],
        ["older_trading_date", "以前に取得した建玉データです"],
        ["reference_date_unknown", "取得時点を確認できる保存データです"],
        ["calendar_context_unresolved", "取得時点を確認できる保存データです"]
    ];
    for (const [tier, expected] of cases) {
        const input = analysis(); input.freshness.tier = tier;
        const subtitle = build(input).subtitle;
        assert.equal(subtitle, expected);
        assert.doesNotMatch(subtitle, /前営業日|tier|unresolved|unknown/);
    }
});

test("visible user strings contain no protected formal or directional wording", () => {
    const result = build(analysis());
    const userStrings = JSON.stringify({ title: result.title, subtitle: result.subtitle,
        call: result.call, put: result.put, metadataLines: result.metadataLines,
        note: result.note });
    assert.doesNotMatch(userStrings,
        /CALL壁候補|PUT壁候補|現在の壁|最新の壁|支持線|抵抗線|買い優勢|売り優勢|強い買い|強い売り|市場診断|Advantage Score/);
});

test("analysis separation and identity are retained only as facts", () => {
    const result = build(analysis());
    assert.deepEqual([result.referenceOnly, result.calculationEligible,
        result.diagnostics.contract, result.diagnostics.tradingDate,
        result.diagnostics.canonicalVersionKey, result.diagnostics.displayGeneration],
    [true, false, "2026-09", "2026-08-25",
        "qri-options-v2|2026-09|saved", 7]);
    assert.deepEqual([result.diagnostics.currentPriceAccessed,
        result.diagnostics.historyAccessed, result.diagnostics.storageAccessed,
        result.diagnostics.judgmentGenerated, result.diagnostics.overallV2Generated],
    [false, false, false, false, false]);
});

test("invalid policy and missing identity are hidden", () => {
    const policy = analysis(); policy.analysisPolicy.allowFormalAnalysis = true;
    assert.equal(build(policy).visible, false);
    const identityMissing = analysis(); identityMissing.identity.canonicalVersionKey = null;
    assert.equal(build(identityMissing).visible, false);
});

test("input is unchanged and every output branch is deeply frozen", () => {
    const input = analysis(); const before = JSON.stringify(input); const result = build(input);
    assert.equal(JSON.stringify(input), before);
    for (const value of [result, result.call, result.call.topItems,
        result.call.topItems[0], result.call.maximumItem, result.put,
        result.put.topItems, result.metadataLines, result.metadataLines[0],
        result.diagnostics]) assert.equal(Object.isFrozen(value), true);
    const hidden = build(analysis({ sourceKind: "live" }));
    for (const value of [hidden, hidden.call, hidden.call.topItems,
        hidden.put, hidden.put.topItems, hidden.metadataLines,
        hidden.diagnostics]) assert.equal(Object.isFrozen(value), true);
});

test("module is pure and index remains disconnected", () => {
    const code = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsSavedReferenceUiState.js"), "utf8");
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|setItem|removeItem/);
    assert.doesNotMatch(code, /\bfetch\s*\(|ipcRenderer|document\.|querySelector|\bChart\b/);
    assert.doesNotMatch(code, /drawJpxPriceChart|allJpx|updateWallCandidates/);
    assert.doesNotMatch(code, /calculateOptionMarketJudgment|optionMapJudgmentState/);
    assert.doesNotMatch(code, /require\([^)]*overallJudgmentV2|OptionMapOverallJudgmentV2/);
    assert.doesNotMatch(code, /setTimeout|setInterval|migration|backfill/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal(html.includes("qriOptionsSavedReferenceUiState.js"), false);
});
