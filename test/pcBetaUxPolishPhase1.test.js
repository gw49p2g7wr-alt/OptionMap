const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const MorningView = require("../js/morningComparisonV4View.js");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("reference Overall is explicitly a generated snapshot with JST freshness", () => {
    const html = read("index.html");
    const preview = read("js/mobileSummaryPreview.js");
    assert.match(html, /参考情報生成時の総合判定/);
    assert.match(html, /mobileSummaryPreviewOverallGeneratedAt/);
    assert.match(preview, /timeZone: "Asia\/Tokyo"/);
    assert.match(preview, /生成時刻：.*（JST）/s);
    assert.match(preview, /summary\.generatedAt/);
});

test("reference snapshot remains independent from formal publication", () => {
    const preview = read("js/mobileSummaryPreview.js");
    const renderStart = preview.indexOf("function render(summary)");
    const renderEnd = preview.indexOf("async function createInput", renderStart);
    const render = preview.slice(renderStart, renderEnd);
    assert.match(render, /payload\.overallV2/);
    assert.doesNotMatch(render, /getOverallV2FormalEnvelope|getMorningComparisonV4RuntimeState/);
});

test("12-group reference warning appears once and not inside details", () => {
    const html = read("index.html");
    assert.equal((html.match(/参考分析・OverallV2には未使用/g) || []).length, 1);
    const details = html.slice(html.indexOf('id="weeklyTwelveGroupDetails"'),
        html.indexOf("</details>", html.indexOf('id="weeklyTwelveGroupDetails"')));
    assert.doesNotMatch(details, /参考分析・OverallV2には未使用/);
});

test("OverallV2 scale and Japanese presentation do not alter internal taxonomy", () => {
    const html = read("index.html");
    const script = read("js/script.js");
    assert.match(html, /-100 = 売り最大 ／ 0 = 中立 ／ \+100 = 買い最大（確率ではありません）/);
    assert.match(script, /complete: "完全"/);
    assert.match(script, /formatOptionMapV2Status\(result\.status\)/);
    assert.match(read("js/overallJudgmentV2.js"), /\? "complete"/);
});

test("agreement is rounded only at presentation", () => {
    const preview = read("js/mobileSummaryPreview.js");
    assert.match(preview, /Math\.round\(value\)/);
    assert.match(preview, /roundedPercent\(payload\.overallV2\.agreement\)/);
    assert.doesNotMatch(read("js/mobileSummary.js"), /Math\.round\([^\n]*agreement/);
});

test("unused components and Morning explanation are user-facing", () => {
    const html = read("index.html");
    const preview = read("js/mobileSummaryPreview.js");
    assert.match(html, /OverallV2判定には未使用：チャート/);
    assert.doesNotMatch(html, /チャート：未接続|参加者別：未接続|世界市場：未接続|IV：未接続/);
    assert.match(preview, /同じ取引日の朝基準と現在を比較しています/);
    assert.doesNotMatch(preview, /同一正式sessionのMorning v4比較です/);
});

test("Morning price keeps yen attached without changing numeric values", () => {
    const model = MorningView.createViewModel({ status: "available", available: true,
        publicationGeneration: 1, selectedBaselineId: "mb4-a", scopeId: "scope",
        formalTradingDate: "2026-08-28", contract: "2026-09",
        formalSnapshotInputFingerprint: "fingerprint",
        baselineIdentity: { baselineId: "mb4-a", capturedAt: "2026-08-28T04:45:00+09:00" },
        diagnostics: { baselineIdentityMatched: true, raceGuardPassed: true }, comparison: {
            available: true, status: "comparable", baselineIdentity: { baselineId: "mb4-a" },
            overallV2: { baselineScore: -37, currentScore: -17, delta: 20,
                baselineLabel: "売り優勢", currentLabel: "中立" },
            price: { baselineValue: 65950, currentValue: 66120, delta: 170, percentDelta: 0.26 },
            divergence: { relation: "same_direction" }, dataQuality: {
                baselineStatus: "complete", currentStatus: "complete", transition: "unchanged",
                currentWarnings: [] }, optionComponent: { available: false },
            weeklyComponent: { available: false } } });
    assert.equal(model.price.current, "66,120\u2060円");
    assert.equal(model.price.delta, "+170円");
});

test("polish adds no scoring runtime storage fetch or timer wiring", () => {
    const testSource = read("test/pcBetaUxPolishPhase1.test.js");
    const view = read("js/morningComparisonV4View.js");
    assert.doesNotMatch(view, /buildMorning|calculateOverall|localStorage|indexedDB|fetch\s*\(|setTimeout|setInterval/);
    assert.doesNotMatch(testSource, /publishMorningComparisonV4Runtime\?\.|MobileSummaryPreview\?\.update/);
});
