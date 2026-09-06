const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Diagnostics = require("../js/qriOptionOpenInterestComparisonDiagnostics.js");

const current = () => ({
    labels: [38000, "38,500", 39000],
    callOpenInterest: [100, 200, 300],
    putOpenInterest: [400, 500, 600]
});
const comparison = () => structuredClone(current());
const assess = (left = current(), right = comparison()) =>
    Diagnostics.assess({ current: left, comparison: right });

test("identical complete CALL and PUT sets receive the no-change reason", () => {
    const result = assess();
    assert.equal(result.status, "valid");
    assert.equal(result.reason, "option_open_interest_no_change");
    assert.deepEqual(result.diagnostics, {
        strikeSetsMatched: true,
        comparedStrikeCount: 3,
        callNonZeroDiffCount: 0,
        putNonZeroDiffCount: 0,
        maxCallAbsDiff: 0,
        maxPutAbsDiff: 0
    });
    assert.equal(Diagnostics.formatReason(result.reason), "建玉差分なし（比較対象と同一）");
});

for (const [name, mutate] of [
    ["one CALL difference", value => { value.callOpenInterest[0] += 1; }],
    ["one PUT difference", value => { value.putOpenInterest[1] += 1; }],
    ["CALL and PUT differences", value => {
        value.callOpenInterest[0] += 2; value.putOpenInterest[2] -= 3;
    }],
    ["a difference outside the UI focus range", value => { value.callOpenInterest[2] += 1; }]
]) test(`${name} is not classified as no change`, () => {
    const right = comparison(); mutate(right);
    const result = assess(current(), right);
    assert.equal(result.status, "valid");
    assert.equal(result.reason, null);
});

for (const [name, mutate] of [
    ["current-only strike", (left) => {
        left.labels.push(40000); left.callOpenInterest.push(1); left.putOpenInterest.push(1);
    }],
    ["comparison-only strike", (_left, right) => {
        right.labels.push(40000); right.callOpenInterest.push(1); right.putOpenInterest.push(1);
    }],
    ["duplicate strike", (_left, right) => { right.labels[2] = right.labels[1]; }],
    ["null value", (_left, right) => { right.callOpenInterest[0] = null; }],
    ["NaN value", (_left, right) => { right.putOpenInterest[0] = NaN; }],
    ["invalid numeric value", (_left, right) => { right.callOpenInterest[0] = "bad"; }],
    ["missing value", (_left, right) => { right.putOpenInterest.pop(); }],
    ["empty comparison set", (_left, right) => {
        right.labels = []; right.callOpenInterest = []; right.putOpenInterest = [];
    }]
]) test(`${name} fails closed without the no-change reason`, () => {
    const left = current(); const right = comparison(); mutate(left, right);
    const result = assess(left, right);
    assert.equal(result.status, "invalid");
    assert.equal(result.reason, null);
});

test("diagnostic output is deeply frozen and input is not mutated", () => {
    const left = current(); const right = comparison();
    const before = structuredClone({ left, right });
    const result = assess(left, right);
    assert.deepEqual({ left, right }, before);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.diagnostics), true);
});

test("helper is pure and loaded before script.js", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionOpenInterestComparisonDiagnostics.js"), "utf8");
    for (const token of ["localStorage", "indexedDB", "fetch(", "setTimeout", "setInterval"])
        assert.doesNotMatch(source, new RegExp(token.replace("(", "\\(")));
    assert.doesNotMatch(source, /(^|[^.\w])document\./);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.ok(html.indexOf("qriOptionOpenInterestComparisonDiagnostics.js") <
        html.indexOf("js/script.js"));
});

test("runtime wires reason lifecycle and OverallV2 mapping without changing scoped modules", () => {
    const script = fs.readFileSync(path.join(__dirname, "../js/script.js"), "utf8");
    assert.match(script, /reason:\s*optionMarketJudgment\.available === true\s*\? null\s*:\s*formalQriIdentity\s*\? comparisonAssessment\?\.reason \|\| null\s*:\s*null/);
    assert.match(script, /reason:\s*null,\s*metadata:\s*null/);
    assert.match(script, /formatReason\(source\?\.reason\)/);
    assert.match(script, /unavailableReason \|\| "オプション市場データが利用できません"/);
});
