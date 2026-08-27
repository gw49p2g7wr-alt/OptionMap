const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const View = require("../js/morningComparisonV4View.js");

function runtime(overrides = {}) {
    const baselineId = "mb4-formal";
    return { status: "available", reason: null, available: true, publicationGeneration: 4,
        selectedBaselineId: baselineId, scopeId: "morning-v4-scope|2026-09|2026-08-28|same_date_explicit",
        formalTradingDate: "2026-08-28", contract: "2026-09",
        formalSnapshotInputFingerprint: "formal-fingerprint",
        baselineIdentity: { baselineId, capturedAt: "2026-08-28T04:45:08+09:00" },
        diagnostics: { baselineIdentityMatched: true, raceGuardPassed: true }, comparison: {
            available: true, status: "comparable", baselineIdentity: { baselineId },
            overallV2: { baselineScore: -37, currentScore: -30, delta: 7,
                baselineLabel: "売り優勢", currentLabel: "売り優勢" },
            price: { baselineValue: 65950, currentValue: 66120, delta: 170,
                percentDelta: 0.257771 }, divergence: { relation: "same_direction" },
            dataQuality: { baselineStatus: "complete", currentStatus: "complete",
                transition: "unchanged", currentWarnings: [] },
            optionComponent: { available: true, baselineDirection: -12.5,
                currentDirection: 0, directionDelta: 12.5 },
            weeklyComponent: { available: true, baselineDirection: -67.6,
                currentDirection: -67.6, directionDelta: 0 } }, ...overrides };
}

test("formal runtime becomes a detached immutable user-facing model", () => {
    const model = View.createViewModel(runtime());
    assert.equal(model.available, true); assert.equal(Object.isFrozen(model), true);
    assert.equal(Object.isFrozen(model.identity), true);
    assert.match(model.capturedAt, /2026\/08\/28/);
    assert.deepEqual(model.score, { baseline: "-37", current: "-30", baselineLabel: "売り優勢",
        currentLabel: "売り優勢", delta: "+7", movement: "買い方向へ +7",
        scale: "-100（売り最大）／0（中立）／+100（買い最大）／確率ではありません" });
    assert.deepEqual(model.price, { baseline: "65,950\u2060円", current: "66,120\u2060円",
        delta: "+170円", percent: "+0.26%" });
    assert.equal(model.relation, "需給変化と価格変化：同方向");
});
test("identity binding retains diagnostics and fails closed on mismatch", () => {
    const model = View.createViewModel(runtime());
    assert.equal(model.identity.selectedBaselineId, "mb4-formal");
    assert.equal(model.identity.comparisonBaselineId, "mb4-formal");
    assert.equal(model.identity.restoreBindingVerified, true);
    assert.equal(View.createViewModel(runtime({ selectedBaselineId: "mb4-other" })).available, false);
});
test("unavailable runtime never exposes stale comparison values", () => {
    const model = View.createViewModel(runtime({ status: "unavailable", available: false,
        reason: "new_market_refresh" }));
    assert.equal(model.available, false); assert.equal(model.score, null);
    assert.equal(model.price, null); assert.deepEqual(model.components, []);
});
test("delta and relation presentation preserves existing taxonomy", () => {
    assert.equal(View.scoreMovement(1), "買い方向へ +1");
    assert.equal(View.scoreMovement(-1), "売り方向へ -1");
    assert.equal(View.scoreMovement(0), "変化なし");
    assert.equal(View.relation("opposite_direction"), "需給変化と価格変化：逆方向");
    assert.equal(View.relation("zero_involved"), "需給変化と価格変化：変化なしを含む");
    assert.equal(View.relation("unavailable"), "需給変化と価格変化：比較不可");
});
test("component and DataQuality facts pass through without zero filling", () => {
    const changed = runtime();
    changed.comparison.dataQuality = { baselineStatus: "partial", currentStatus: "complete",
        transition: "improved", currentWarnings: ["formal-warning"] };
    changed.comparison.weeklyComponent = { available: false };
    const model = View.createViewModel(changed);
    assert.deepEqual(model.components[0], { label: "オプション需給寄与", available: true,
        baseline: "-12.5", current: "0", delta: "+12.5", movement: "買い方向へ +12.5" });
    assert.deepEqual(model.components[1], { label: "週次先物需給", available: false,
        baseline: "—", current: "—", delta: "—", movement: "利用不可" });
    assert.deepEqual(model.dataQuality, { current: "良好", baseline: "一部データ不足",
        transition: "改善", warnings: ["formal-warning"] });
});
test("formal binding uses only runtime getter and reference UI stays explicitly separated", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/mobileSummaryPreview.js"), "utf8");
    const formal = source.slice(source.indexOf("function renderFormalComparisonV4"),
        source.indexOf("const elapsedLabel"));
    assert.match(formal, /getMorningComparisonV4RuntimeState/);
    assert.doesNotMatch(formal, /MorningBaselineStorage|MobileMorningComparison|mb1|localStorage|indexedDB|fetch\s*\(/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(html, /朝基準からの正式比較/); assert.match(html, /前回観測比（参考）/);
    assert.match(html, /当日QRI建玉変化（参考）/);
    assert.ok(html.indexOf("morningComparisonV4Runtime.js") < html.indexOf("morningComparisonV4View.js"));
    assert.ok(html.indexOf("morningComparisonV4View.js") < html.indexOf("mobileSummaryPreview.js"));
});
test("formal view does not contain scoring, comparison, storage, fetch, timer or DOM logic", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/morningComparisonV4View.js"), "utf8");
    assert.doesNotMatch(source, /buildMorning|calculate|weightedContribution|localStorage|sessionStorage|indexedDB|fetch\s*\(|setTimeout|setInterval|document\./);
});
