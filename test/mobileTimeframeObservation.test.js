const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const api = require("../js/mobileTimeframeObservation.js");

const change = delta => ({ available: true, currentPrice: { available: true, delta } });
const overall = (direction, directionLabel) => ({ available: true, direction, directionLabel });
const summary = (delta, direction, directionLabel) => ({ payload: {
    changeSinceMorning: change(delta), overallV2: overall(direction, directionLabel)
} });

test("price delta is mapped without a threshold", () => {
    assert.deepEqual([api.shortPriceDirection(change(1)).direction,
        api.shortPriceDirection(change(1)).label], ["up", "上昇"]);
    assert.deepEqual([api.shortPriceDirection(change(-1)).direction,
        api.shortPriceDirection(change(-1)).label], ["down", "下落"]);
    assert.deepEqual([api.shortPriceDirection(change(0)).direction,
        api.shortPriceDirection(change(0)).label], ["neutral", "横ばい"]);
    const unavailable = api.shortPriceDirection({ available: false, reason: "not_captured" });
    assert.deepEqual([unavailable.available, unavailable.label, unavailable.reason],
        [false, "判定不能", "not_captured"]);
});

test("alignment covers matching, diverged, neutral and unavailable states", () => {
    const cases = [
        [summary(1, 20, "買い優勢"), "aligned"],
        [summary(-1, -20, "売り優勢"), "aligned"],
        [summary(1, -20, "売り優勢"), "diverged"],
        [summary(-1, 20, "買い優勢"), "diverged"],
        [summary(0, 20, "買い優勢"), "neutral_mixed"],
        [summary(1, 0, "中立"), "neutral_mixed"]
    ];
    for (const [input, expected] of cases) {
        assert.equal(api.createTimeframeObservation(input).alignment.status, expected);
    }
    const unavailable = api.createTimeframeObservation({ payload: {
        changeSinceMorning: { available: false, reason: "not_captured" },
        overallV2: overall(20, "買い優勢")
    } });
    assert.equal(unavailable.alignment.status, "unavailable");
    assert.equal(unavailable.alignment.reason, "short_term_unavailable");
});

test("runtime observation does not mutate summary or alter formal values", () => {
    const input = summary(-390, 54, "買い優勢");
    input.dataQuality = { status: "complete", warnings: [] };
    const before = structuredClone(input);
    const result = api.createTimeframeObservation(input);
    assert.deepEqual(input, before);
    assert.equal(input.payload.overallV2.direction, 54);
    assert.equal(input.payload.changeSinceMorning.currentPrice.delta, -390);
    assert.deepEqual(input.dataQuality, before.dataQuality);
    assert.equal(result.alignment.status, "diverged");
});

test("UI keeps the v2 name, horizon disclaimer and runtime-only wiring", () => {
    const root = path.resolve(__dirname, "..");
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const preview = fs.readFileSync(path.join(root, "js/mobileSummaryPreview.js"), "utf8");
    assert.match(html, /総合判定v2 ／ 1日～数日の総合需給/);
    assert.match(html, /短期売買タイミングを直接示すものではありません/);
    assert.match(html, /mobileSummaryPreviewShortTerm/);
    assert.match(html, /mobileSummaryPreviewMediumTerm/);
    assert.match(html, /mobileSummaryPreviewAlignment/);
    assert.match(preview, /createTimeframeObservation\(summary\)/);
    assert.doesNotMatch(preview, /summary\.payload\.(?:overallV2|changeSinceMorning)\s*=/);
});
