const test = require("node:test");
const assert = require("node:assert/strict");
const {
    CONFIG,
    getDirectionLabel,
    calculateOverallJudgmentV2
} = require("../js/overallJudgmentV2.js");

const component = (
    normalizedDirection,
    qualityFactor = 1,
    evidenceFactor = Math.abs(normalizedDirection),
    notes = []
) => ({
    available: true,
    normalizedDirection,
    qualityFactor,
    evidenceFactor,
    notes
});

const unavailable = { available: false };

test("normalization settings match the current component logic", () => {
    assert.equal(CONFIG.optionNormalizationBase, 8);
    assert.equal(CONFIG.weeklyNormalizationBase, 0.10);
    assert.deepEqual(CONFIG.weights, { option: 55, weekly: 45 });
});

test("both strong buy components produce a complete strong buy result", () => {
    const result = calculateOverallJudgmentV2({
        option: component(1, 1, 1),
        weekly: component(1, 1, 1)
    });
    assert.equal(result.status, "complete");
    assert.equal(result.direction, 100);
    assert.equal(result.directionLabel, "強い買い優勢");
    assert.equal(result.confidence, 100);
});

test("both strong sell components produce a complete strong sell result", () => {
    const result = calculateOverallJudgmentV2({
        option: component(-1, 1, 1),
        weekly: component(-1, 1, 1)
    });
    assert.equal(result.direction, -100);
    assert.equal(result.directionLabel, "強い売り優勢");
});

test("opposing strong components reduce direction and agreement", () => {
    const result = calculateOverallJudgmentV2({
        option: component(1, 1, 1),
        weekly: component(-1, 1, 1)
    });
    assert.equal(result.direction, 10);
    assert.equal(result.directionLabel, "中立");
    assert.equal(result.confidenceFactors.agreement, 0);
    assert.ok(result.confidence < 100);
});

test("one available component remains directional but partial", () => {
    const optionOnly = calculateOverallJudgmentV2({
        option: component(0.8, 1, 0.8),
        weekly: unavailable
    });
    const weeklyOnly = calculateOverallJudgmentV2({
        option: unavailable,
        weekly: component(-0.8, 1, 0.8)
    });
    assert.equal(optionOnly.status, "partial");
    assert.equal(optionOnly.direction, 80);
    assert.equal(optionOnly.metadata.coverage, 50);
    assert.equal(optionOnly.confidenceFactors.agreement, 50);
    assert.equal(weeklyOnly.status, "partial");
    assert.equal(weeklyOnly.direction, -80);
});

test("no available components returns unavailable without NaN", () => {
    const result = calculateOverallJudgmentV2({
        option: unavailable,
        weekly: unavailable
    });
    assert.equal(result.status, "unavailable");
    assert.equal(result.direction, null);
    assert.equal(result.confidence, 0);
});

test("neutral remains available and distinct from missing data", () => {
    const bothNeutral = calculateOverallJudgmentV2({
        option: component(0, 1, 0.4),
        weekly: component(0, 1, 0)
    });
    const neutralAndBuy = calculateOverallJudgmentV2({
        option: component(0, 1, 0.4),
        weekly: component(0.5, 1, 0.5)
    });
    const buyAndNeutral = calculateOverallJudgmentV2({
        option: component(0.5, 1, 0.6),
        weekly: component(0, 1, 0)
    });
    assert.equal(bothNeutral.status, "complete");
    assert.equal(bothNeutral.direction, 0);
    assert.equal(neutralAndBuy.direction, 23);
    assert.equal(buyAndNeutral.direction, 28);
});

test("fallback option lowers effective weight and confidence", () => {
    const live = calculateOverallJudgmentV2({
        option: component(0.5, 1, 0.8),
        weekly: component(0.5, 1, 0.5)
    });
    const fallback = calculateOverallJudgmentV2({
        option: component(0.5, 0.7, 0.8, ["fallback"]),
        weekly: component(0.5, 1, 0.5)
    });
    assert.equal(fallback.direction, 50);
    assert.ok(fallback.confidence < live.confidence);
    assert.equal(fallback.components.option.qualityFactor, 0.7);
    assert.deepEqual(fallback.metadata.warnings, ["fallback"]);
});

test("cache/current weekly quality is represented without exclusion", () => {
    const result = calculateOverallJudgmentV2({
        option: component(0.4, 1, 0.8),
        weekly: component(0.4, 0.95, 0.4)
    });
    assert.equal(result.status, "complete");
    assert.equal(result.components.weekly.qualityFactor, 0.95);
});

test("lower weekly quality states remain usable when validated upstream", () => {
    for (const quality of [0.7, 0.5]) {
        const result = calculateOverallJudgmentV2({
            option: unavailable,
            weekly: component(0.6, quality, 0.6)
        });
        assert.equal(result.status, "partial");
        assert.equal(result.direction, 60);
        assert.equal(result.components.weekly.qualityFactor, quality);
    }
});

test("two agreeing components have higher confidence than one", () => {
    const one = calculateOverallJudgmentV2({
        option: component(0.6, 1, 0.6),
        weekly: unavailable
    });
    const two = calculateOverallJudgmentV2({
        option: component(0.6, 1, 0.6),
        weekly: component(0.6, 1, 0.6)
    });
    assert.ok(two.confidence > one.confidence);
});

test("direction label boundaries are exact", () => {
    assert.equal(getDirectionLabel(19), "中立");
    assert.equal(getDirectionLabel(20), "買い優勢");
    assert.equal(getDirectionLabel(59), "買い優勢");
    assert.equal(getDirectionLabel(60), "強い買い優勢");
    assert.equal(getDirectionLabel(-19), "中立");
    assert.equal(getDirectionLabel(-20), "売り優勢");
    assert.equal(getDirectionLabel(-59), "売り優勢");
    assert.equal(getDirectionLabel(-60), "強い売り優勢");
});

test("NaN and Infinity are rejected as invalid input", () => {
    for (const invalidValue of [NaN, Infinity, -Infinity]) {
        const result = calculateOverallJudgmentV2({
            option: component(invalidValue, 1, 1),
            weekly: unavailable
        });
        assert.equal(result.status, "invalid_input");
        assert.equal(result.direction, null);
        assert.equal(result.confidence, 0);
    }
});

test("calculation does not mutate its input", () => {
    const input = {
        option: component(0.5, 0.7, 0.8, ["fallback"]),
        weekly: component(0.2, 1, 0.2)
    };
    const before = structuredClone(input);
    calculateOverallJudgmentV2(input);
    assert.deepEqual(input, before);
});
