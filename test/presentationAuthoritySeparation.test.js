const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const MorningView = require("../js/morningComparisonV4View.js");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("Desktop option-only diagnosis uses a distinct presentation label", () => {
    const source = read("js/script.js");
    assert.match(source, /オプション需給診断：\$\{optionDemandLevel\}/);
    assert.match(source, /"強気": "買い寄り"/);
    assert.match(source, /"弱気": "売り寄り"/);
    assert.match(source, /const optionDemandLevel = formatOptionDemandLevel\(marketLevel\)/);
});

test("Desktop presentation mapping does not alter option or OverallV2 calculation", () => {
    const source = read("js/script.js");
    const formatter = source.slice(source.indexOf("function formatOptionDemandLevel("),
        source.indexOf("function createDiagnosisSentence("));
    assert.doesNotMatch(formatter, /bullishScore|bearishScore|scoreDifference|normalizedDirection|weightedContribution/);
    assert.match(source, /const scoreDifference = bullishScore - bearishScore/);
    assert.match(source, /calculateOverallJudgmentV2\(\{/);
});

test("Mobile failed refresh marks the direction card as a previous generated value", () => {
    const source = read("js/mobileSummaryPreview.js");
    const failure = source.slice(source.indexOf("} catch (error) {", source.indexOf("async function update")),
        source.indexOf("async function renderMorningBaselineState"));
    assert.match(failure, /前回生成値：\$\{overall\.directionLabel\}/);
    assert.match(failure, /更新失敗・\$\{generatedAtJst\(latestSummary\.generatedAt\)\}/);
    assert.doesNotMatch(failure, /buildMobileSummary|createSignature|localStorage|indexedDB/);
});

test("Mobile presentation commits one verified OverallV2 generation atomically", () => {
    const source = read("js/mobileSummaryPreview.js");
    assert.match(source, /captureOverallAuthority\(\)/);
    assert.match(source, /assertOverallAuthority\(input, overallAuthority\)/);
    assert.match(source, /assertCurrentOverallAuthority\(input\.renderAuthority\)/);
    assert.match(source, /ownSequence !== updateSequence/);
    const commit = source.slice(source.indexOf("function commitPresentation("),
        source.indexOf("async function resolveFormalQriReference", source.indexOf("function commitPresentation(")));
    assert.match(commit, /render\(bundle\.summary\)/);
    assert.match(commit, /renderMorningBaselineState\(bundle\.summary\.marketDate, bundle\.baselineResolution\)/);
    assert.match(commit, /applyFormalComparisonV4\(bundle\.formalModel, bundle\.formalStatus\)/);
    assert.match(commit, /dataset\.summaryId = bundle\.summary\.summaryId/);
    assert.doesNotMatch(commit, /\bawait\b/);
});

test("Formal runtime callbacks cannot partially update a committed Mobile generation", () => {
    const source = read("js/mobileSummaryPreview.js");
    const formal = source.slice(source.indexOf("function renderFormalComparisonV4()"),
        source.indexOf("const elapsedLabel", source.indexOf("function renderFormalComparisonV4()")));
    assert.match(formal, /if \(latestPresentation\) return clone\(latestPresentation\.formalModel\)/);
    assert.doesNotMatch(formal, /applyFormalComparisonV4\(captureFormalComparisonV4\(\)\)[\s\S]*latestPresentation/);
    assert.match(read("index.html"), /入力データ取得時刻/);
});

test("Morning movement explicitly describes change since morning", () => {
    assert.equal(MorningView.scoreMovement(1), "朝から買い方向へ +1");
    assert.equal(MorningView.scoreMovement(-1), "朝から売り方向へ -1");
    assert.equal(MorningView.scoreMovement(0), "朝から変化なし");
});
