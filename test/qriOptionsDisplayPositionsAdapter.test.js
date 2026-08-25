const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Adapter = require("../js/qriOptionsDisplayPositionsAdapter.js");

const formalPositions = [
    { contract: "2026-09", optionType: "call", strike: 65000, published: true, value: 101 },
    { contract: "2026-09", optionType: "put", strike: 65000, published: false, value: null },
    { contract: "2026-09", optionType: "call", strike: 64500, published: false, value: null },
    { contract: "2026-09", optionType: "put", strike: 64500, published: true, value: 202 }
];
const metadata = { contract: "2026-09", tradingDate: "2026-08-25",
    pageUpdatedAt: "2026-08-25T05:50:00+09:00",
    fetchedAt: "2026-08-25T06:10:00Z", origin: "cache" };
function source(sourceKind, state, positions = formalPositions, extra = {}) {
    return { available: true, sourceKind, state, contract: "2026-09", positions,
        metadata, analysisPolicy: { allowFormalAnalysis: sourceKind === "live",
            allowLegacyAnalysis: sourceKind === "legacy",
            calculationSourcePolicy: sourceKind === "saved" ? "none" : `existing_${sourceKind}_policy`,
            reason: sourceKind === "saved" ? "saved_display_only" : null },
        diagnostics: { analysisSuppressed: sourceKind === "saved" }, ...extra };
}
function build(displaySourceState) {
    return Adapter.buildQriOptionsDisplayPositions({ displaySourceState });
}

test("live canonical positions become display-only chart and table facts", () => {
    const result = build(source("live", "live_available"));
    assert.deepEqual([result.available, result.sourceKind, result.state, result.contract,
        result.displayOnly], [true, "live", "live_available", "2026-09", true]);
    assert.deepEqual(result.labels, ["65,000", "64,500"]);
});

test("saved retains source identity and display-only analysis policy", () => {
    const result = build(source("saved", "saved_pending"));
    assert.deepEqual([result.sourceKind, result.displayOnly], ["saved", true]);
    assert.deepEqual(result.analysisPolicy, { allowFormalAnalysis: false,
        allowLegacyAnalysis: false, calculationSourcePolicy: "none",
        reason: "saved_display_only" });
});

test("legacy positions map without executing legacy analysis", () => {
    const positions = [{ strike: 66000, callOpenInterest: 12, putOpenInterest: 34 },
        { strike: 65500, callOpenInterest: 56, putOpenInterest: 78 }];
    const result = build(source("legacy", "legacy_fallback", positions));
    assert.deepEqual(result.rows, [
        { strike: 66000, callOpenInterest: 12, putOpenInterest: 34,
            callPublished: true, putPublished: true },
        { strike: 65500, callOpenInterest: 56, putOpenInterest: 78,
            callPublished: true, putPublished: true }
    ]);
    assert.equal(result.diagnostics.analysisSuppressed, true);
});

test("unavailable always returns safe empty arrays", () => {
    const result = build(source("unavailable", "specific_unavailable", formalPositions,
        { available: false }));
    assert.deepEqual([result.available, result.rows, result.labels,
        result.callValues, result.putValues], [false, [], [], [], []]);
});

test("row mapping preserves strike OI and publication facts", () => {
    const result = build(source("saved", "saved_fallback"));
    assert.deepEqual(result.rows, [
        { strike: 65000, callOpenInterest: 101, putOpenInterest: null,
            callPublished: true, putPublished: false },
        { strike: 64500, callOpenInterest: null, putOpenInterest: 202,
            callPublished: false, putPublished: true }
    ]);
});

test("chart arrays derive from rows and zero-fill only unpublished display slots", () => {
    const result = build(source("saved", "saved_fallback"));
    assert.deepEqual(result.callValues, [101, 0]);
    assert.deepEqual(result.putValues, [0, 202]);
    assert.equal(result.rows[0].putOpenInterest, null);
    assert.equal(result.rows[1].callOpenInterest, null);
});

test("source ordering is preserved without sorting", () => {
    const result = build(source("live", "specific_live"));
    assert.deepEqual(result.rows.map(row => row.strike), [65000, 64500]);
    assert.equal(result.diagnostics.orderingPreserved, true);
});

test("duplicate legacy strikes are not merged or aggregated", () => {
    const positions = [{ strike: 65000, callOpenInterest: 1, putOpenInterest: 2 },
        { strike: 65000, callOpenInterest: 3, putOpenInterest: 4 }];
    const result = build(source("legacy", "legacy_fallback", positions));
    assert.equal(result.rows.length, 2);
    assert.deepEqual(result.callValues, [1, 3]);
});

test("duplicate canonical side is not smoothed merged or weighted", () => {
    const positions = [{ optionType: "call", strike: 65000, published: true, value: 5 },
        { optionType: "call", strike: 65000, published: true, value: 7 }];
    const result = build(source("live", "live_available", positions));
    assert.equal(result.rows.length, 2);
    assert.deepEqual(result.callValues, [5, 7]);
});

test("metadata is copied without reparsing", () => {
    const result = build(source("saved", "saved_pending"));
    assert.deepEqual(result.metadata, { sourceKind: "saved", state: "saved_pending",
        contract: "2026-09", tradingDate: "2026-08-25",
        pageUpdatedAt: "2026-08-25T05:50:00+09:00",
        fetchedAt: "2026-08-25T06:10:00Z", origin: "cache" });
});

test("available source with no positions preserves source availability", () => {
    const result = build(source("live", "live_available", []));
    assert.deepEqual([result.available, result.rows, result.diagnostics.inputRowCount,
        result.diagnostics.outputRowCount], [true, [], 0, 0]);
});

test("adapter does not mutate formal-global-shaped caller state", () => {
    const globals = { allJpxOpenInterestLabels: ["old"], allJpxCallValues: [10],
        allJpxPutValues: [20], wallCandidates: [{ strike: 1 }],
        optionJudgment: { direction: "neutral" }, overallV2: { score: 3 } };
    const before = JSON.stringify(globals);
    build(source("saved", "saved_pending", formalPositions, { callerState: globals }));
    assert.equal(JSON.stringify(globals), before);
});

test("input is unchanged and output graph is deeply frozen and detached", () => {
    const input = source("saved", "saved_pending");
    const before = JSON.stringify(input); const result = build(input);
    assert.equal(JSON.stringify(input), before);
    assert.notStrictEqual(result.rows, input.positions);
    for (const value of [result, result.rows, result.rows[0], result.labels,
        result.callValues, result.putValues, result.metadata, result.analysisPolicy,
        result.diagnostics]) assert.equal(Object.isFrozen(value), true);
});

test("diagnostics contain technical transformation facts only", () => {
    const result = build(source("saved", "saved_pending"));
    assert.deepEqual(result.diagnostics, { sourceKind: "saved",
        sourceState: "saved_pending", inputRowCount: 4, outputRowCount: 2,
        displayOnly: true, analysisSuppressed: true, sourceAnalysisSuppressed: true,
        orderingPreserved: true, transformationVersion: 1 });
});

test("module is pure and disconnected from UI analysis storage and network", () => {
    const code = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsDisplayPositionsAdapter.js"), "utf8");
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|\bfetch\s*\(/);
    assert.doesNotMatch(code, /document\.|querySelector|\bChart\b|drawJpxPriceChart/);
    assert.doesNotMatch(code, /allJpx|wallCandidates|optionJudgment|OverallV2/);
    assert.doesNotMatch(code, /setTimeout|setInterval|migration|backfill/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal(html.includes("qriOptionsDisplayPositionsAdapter.js"), false);
});
