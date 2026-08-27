const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const View = require("../js/morningComparisonV4View.js");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

function runtime() {
    return { status: "available", available: true, publicationGeneration: 1,
        selectedBaselineId: "mb4-a", scopeId: "scope", formalTradingDate: "2026-08-28",
        contract: "2026-09", formalSnapshotInputFingerprint: "fingerprint",
        baselineIdentity: { baselineId: "mb4-a", capturedAt: "2026-08-28T04:45:00+09:00" },
        diagnostics: { baselineIdentityMatched: true, raceGuardPassed: true }, comparison: {
            available: true, status: "comparable", baselineIdentity: { baselineId: "mb4-a" },
            overallV2: { baselineScore: -37, currentScore: -17, delta: 20,
                baselineLabel: "売り優勢", currentLabel: "中立" },
            price: { baselineValue: 65950, currentValue: 66120, delta: 170, percentDelta: 0.26 },
            divergence: { relation: "same_direction" }, dataQuality: {
                baselineStatus: "complete", currentStatus: "complete", transition: "unchanged",
                currentWarnings: ["週次データは検証済み正式historyを使用中"] },
            optionComponent: { available: true, baselineDirection: -12.5,
                currentDirection: 25, directionDelta: 37.5 }, weeklyComponent: { available: true,
                baselineDirection: -67.63504312301407, currentDirection: -67.63504312301407,
                directionDelta: 0 } } };
}

test("Morning header maps complete to 良好 without changing internal status", () => {
    const preview = read("js/mobileSummaryPreview.js");
    assert.match(preview, /品質 \$\{qualityLabel\(active\.dataQuality\.status\)\}/);
    assert.doesNotMatch(preview, /品質 \$\{active\.dataQuality\.status\}/);
    const value = runtime();
    View.createViewModel(value);
    assert.equal(value.comparison.dataQuality.currentStatus, "complete");
});

test("formal component direction and delta use one-decimal presentation", () => {
    const model = View.createViewModel(runtime());
    assert.deepEqual(model.components[0], { label: "オプション需給寄与", available: true,
        baseline: "-12.5", current: "+25", delta: "+37.5", movement: "買い方向へ +37.5" });
    assert.deepEqual(model.components[1], { label: "週次先物需給", available: true,
        baseline: "-67.6", current: "-67.6", delta: "0", movement: "変化なし" });
});

test("component formatting does not mutate Comparison precision", () => {
    const value = runtime();
    const before = structuredClone(value);
    View.createViewModel(value);
    assert.deepEqual(value, before);
    assert.equal(value.comparison.weeklyComponent.baselineDirection, -67.63504312301407);
});

test("formal history wording is informational Japanese", () => {
    const model = View.createViewModel(runtime());
    assert.deepEqual(model.dataQuality.warnings, ["週次データ：検証済みの正式履歴を使用"]);
    const preview = read("js/mobileSummaryPreview.js");
    assert.match(preview, /informational/);
});

test("12-group warning stays one line outside details", () => {
    const html = read("index.html");
    assert.equal((html.match(/参考分析・OverallV2には未使用/g) || []).length, 1);
    const start = html.indexOf('id="weeklyTwelveGroupDetails"');
    assert.doesNotMatch(html.slice(start, html.indexOf("</details>", start)),
        /参考分析・OverallV2には未使用/);
});

test("cleanup adds no scoring runtime storage fetch timer or reference sync", () => {
    const view = read("js/morningComparisonV4View.js");
    assert.doesNotMatch(view, /calculateOverall|buildMorning|localStorage|indexedDB|fetch\s*\(|setTimeout|setInterval/);
    const preview = read("js/mobileSummaryPreview.js");
    assert.doesNotMatch(preview, /publishMorningComparisonV4Runtime\?\.\(.*qualityLabel/s);
});
