const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "../js/mobileSummaryPreview.js"), "utf8");

test("Mobile v3, Formal v4 and automatic acquisition have separate visible labels", () => {
    assert.match(html, /id="mobileMorningBaselineTitle">スマホ版朝基準</);
    assert.match(html, /id="morningComparisonV4Title">Formal Morning v4</);
    assert.match(html, /id="morningBaselineV4AutomaticWindowStatus"/);
    assert.match(source, /スマホ版朝基準：[^`"\n]*品質：/);
});
test("manual button is explicitly Mobile v3 only", () => {
    assert.match(html, /id="saveMorningBaselineButton"[\s\S]{0,160}スマホ版朝基準を手動保存/);
    const handler = source.slice(source.indexOf("async function saveMorningBaseline"),
        source.indexOf("document.addEventListener", source.indexOf("async function saveMorningBaseline")));
    assert.match(handler, /OptionMapMorningBaselineStorage[\s\S]*\.save\(saved\.baseline\)/);
    assert.doesNotMatch(handler, /captureManual|MorningBaselineV4CaptureRuntime|morningV4/);
});
test("normal user UI has no Formal v4 manual capture path and automatic authority is the scheduler", () => {
    assert.doesNotMatch(source, /captureManual/);
    assert.doesNotMatch(html, /runAutomaticFirstSuccessCapture/);
    assert.equal((html.match(/\.captureAutomatic\s*\(/g) || []).length, 1);
    assert.match(html, /formalBaselineRetryScheduler\s*=\s*window\.OptionMapMorningBaselineV4Scheduler/);
});
test("existing v3 and v4 storage identities remain separate", () => {
    const legacy = fs.readFileSync(path.join(__dirname, "../js/morningBaselineStorage.js"), "utf8");
    const formal = fs.readFileSync(path.join(__dirname, "../js/morningBaselineV4Storage.js"), "utf8");
    assert.match(legacy, /optionMapMobileMorningBaselinesV1/);
    assert.match(formal, /optionMapMorningBaselinesV4/);
});
