const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const api = require("../js/mobileMultiTimeframeView.js");

const AS_OF = "2026-08-21T03:00:00.000Z";
const directionValue = direction => ({ up: 20, down: -20, neutral: 0 })[direction];
const summary = (morning = "up", medium = "up", mediumStatus = "complete") => ({
    generatedAt: AS_OF, marketDate: "2026-08-21", dataQuality: { status: "complete" }, payload: {
        changeSinceMorning: { available: true, baselineCapturedAt: "2026-08-21T00:00:00.000Z",
            comparedAt: AS_OF, currentPrice: { available: true, delta: directionValue(morning),
                current: { contract: "2026-09" } }, dataQuality: { baselineStatus: "complete",
                currentStatus: "complete" } },
        overallV2: { available: true, status: mediumStatus, direction: directionValue(medium),
            directionLabel: medium === "up" ? "買い優勢" : medium === "down" ? "売り優勢" : "中立",
            confidence: 80, coverage: 100, agreement: 75 }
    }
});
const comparison = (direction = "up") => ({ available: true, reason: null, direction,
    priceDelta: directionValue(direction), percentChange: directionValue(direction) / 100,
    elapsedMs: 30 * 60 * 1000, contract: "2026-09", boundary: null,
    previous: { snapshotId: "previous", observedAt: "2026-08-21T02:30:00.000Z",
        contract: "2026-09" },
    current: { snapshotId: "current", observedAt: AS_OF, contract: "2026-09" } });
const records = (status = "complete") => ["previous", "current"].map(snapshotId => ({
    snapshotId, dataQuality: { status }
}));

test("all-up and all-down are shown as three aligned directions", () => {
    const up = api.createView(summary("up", "up"), comparison("up"), records());
    assert.equal(up.summary, "朝 ↑ / 前回 ↑（30分） / 中期 ↑");
    assert.equal(up.relationship, "3方向が同方向");
    const down = api.createView(summary("down", "down"), comparison("down"), records());
    assert.equal(down.summary, "朝 ↓ / 前回 ↓（30分） / 中期 ↓");
    assert.equal(down.relationship, "3方向が同方向");
});

test("directional relationship wording comes from builder relationships", () => {
    const cases = [
        ["down", "up", "up", "前回観測区間では中期需給と同方向"],
        ["down", "down", "up", "朝基準・前回観測とも中期需給と反対方向"],
        ["up", "down", "up", "前回観測のみ他の2方向と反対"],
        ["up", "up", "down", "朝基準・前回観測とも中期需給と反対方向"]
    ];
    for (const [a, b, c, expected] of cases) {
        const view = api.createView(summary(a, c), comparison(b), records());
        assert.equal(view.relationship, expected);
    }
});

test("previous observation always includes elapsed time including hours", () => {
    const input = comparison("up"); input.elapsedMs = 72 * 60 * 1000;
    input.previous.observedAt = "2026-08-21T01:48:00.000Z";
    assert.match(api.createView(summary(), input, records()).summary, /前回 ↑（1時間12分）/);
});

test("A, B and C unavailable remain visibly unavailable", () => {
    const a = summary(); a.payload.changeSinceMorning = { available: false, reason: "not_captured" };
    assert.match(api.createView(a, comparison(), records()).summary, /朝 比較待ち/);
    assert.equal(api.createView(a, comparison(), records()).relationship,
        "朝基準の比較データがありません");
    const b = api.createView(summary(), { available: false,
        reason: "previous_comparable_unavailable" }, records());
    assert.match(b.summary, /前回 比較待ち/);
    assert.equal(b.relationship, "前回観測の比較データがありません");
    const c = summary(); c.payload.overallV2.available = false;
    const cView = api.createView(c, comparison(), records());
    assert.match(cView.summary, /中期 判定不能/);
    assert.equal(cView.relationship, "中期需給を確認できません");
});

test("neutral stays mixed without a new threshold", () => {
    const view = api.createView(summary("neutral", "up"), comparison("up"), records());
    assert.match(view.summary, /朝 →/);
    assert.equal(view.relationship, "朝基準価格は横ばい");
    assert.equal(view.state.relationship.morningVsMedium, "neutral_mixed");
});

test("builder partial is shown and overall quality does not overwrite medium quality", () => {
    const view = api.createView(summary("up", "up", "partial"), comparison("up"), records());
    assert.equal(view.state.status, "partial");
    assert.equal(view.state.mediumTerm.quality.status, "partial");
    assert.equal(view.quality, "中期需給：一部材料不足");
});

test("UI wiring remains runtime-only and leaves protected cards and schema untouched", () => {
    const root = path.resolve(__dirname, "..");
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const preview = fs.readFileSync(path.join(root, "js/mobileSummaryPreview.js"), "utf8");
    const view = fs.readFileSync(path.join(root, "js/mobileMultiTimeframeView.js"), "utf8");
    assert.match(html, /mobileSummaryPreviewSnapshotComparisonCard/);
    assert.match(html, /mobileSummaryPreviewChange/);
    assert.match(preview, /createPriceSnapshotComparison\(records\)/);
    assert.match(view, /createMultiTimeframeState/);
    assert.doesNotMatch(view, /indexedDB|localStorage|\bfetch\s*\(|setInterval|setTimeout/);
    assert.doesNotMatch(view, /schemaVersion|persist|save|put|add\(/i);
    assert.doesNotMatch(view, /3h|6h|翌朝/);
});
