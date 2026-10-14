const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Overall = require("../js/overallJudgmentV2.js");
const Contributor = require("../js/overallV2ContributorView.js");

const component = (normalizedDirection, qualityFactor = 1) => ({
    available: true,
    normalizedDirection,
    qualityFactor,
    evidenceFactor: Math.abs(normalizedDirection)
});
const missing = { available: false };
const calculate = (option, weekly) =>
    Overall.calculateOverallJudgmentV2({ option, weekly }, "2026-10-15T00:00:00.000Z");

test("C1 Option effective contribution is dominant", () => {
    const view = Contributor.derive(calculate(component(0.8), component(0.2)));
    assert.equal(view.status, "option");
    assert.equal(view.optionContribution, 44);
    assert.equal(view.weeklyContribution, 9);
    assert.equal(Contributor.format(view), "主な寄与：Option");
});

test("C2 Weekly effective contribution is dominant", () => {
    const view = Contributor.derive(calculate(component(0.2), component(0.8)));
    assert.equal(view.status, "weekly");
    assert.equal(view.optionContribution, 11);
    assert.equal(view.weeklyContribution, 36);
    assert.equal(Contributor.format(view), "主な寄与：Weekly");
});

test("C3 exact effective contribution tie is balanced", () => {
    const view = Contributor.derive(calculate(
        component(9 / 55),
        component(0.2)
    ));
    assert.equal(view.status, "balanced");
    assert.equal(Contributor.format(view), "主な寄与：均衡");
});

test("C4 Weekly rollover-effective-zero is Option only", () => {
    const view = Contributor.derive(calculate(component(0.6), missing));
    assert.equal(view.status, "option_only");
    assert.equal(view.weeklyContribution, null);
    assert.equal(Contributor.format(view), "主な寄与：Optionのみ");
});

test("C5 opposing directions retain Weekly counter indication", () => {
    const view = Contributor.derive(calculate(component(0.8), component(-0.2)));
    assert.equal(view.status, "option");
    assert.equal(view.opposingComponent, "weekly");
    assert.equal(Contributor.format(view), "主な寄与：Option（Weeklyは逆方向）");
});

test("C6 opposing directions retain Option counter indication", () => {
    const view = Contributor.derive(calculate(component(-0.2), component(0.8)));
    assert.equal(view.status, "weekly");
    assert.equal(view.opposingComponent, "option");
    assert.equal(Contributor.format(view), "主な寄与：Weekly（Optionは逆方向）");
});

test("weekly-only is only reported when Option is non-contributing", () => {
    const view = Contributor.derive(calculate(missing, component(-0.7)));
    assert.equal(view.status, "weekly_only");
    assert.equal(Contributor.format(view), "主な寄与：Weeklyのみ");
});

test("C7 insufficient or malformed inputs are unavailable", () => {
    assert.equal(Contributor.derive(calculate(missing, missing)).status, "unavailable");
    assert.equal(Contributor.derive(null).status, "unavailable");
    assert.equal(Contributor.format(Contributor.derive(null)), "主な寄与：不明");
});

test("C8 contributor derivation does not change Overall judgment", () => {
    const result = calculate(component(0.7, 0.8), component(-0.3, 0.9));
    const before = structuredClone(result);
    Contributor.derive(result);
    assert.deepEqual(result, before);
});

test("UI loads one read-model and renders one compact contributor field", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const script = fs.readFileSync(path.join(__dirname, "../js/script.js"), "utf8");
    assert.match(html, /id="optionMapV2MainContributor"/);
    assert.match(html, /js\/overallV2ContributorView\.js/);
    assert.match(script, /OptionMapOverallV2ContributorView\?\.derive\(result\)/);
    assert.doesNotMatch(script, /weightedContribution\s*[*/+-]/);
});
