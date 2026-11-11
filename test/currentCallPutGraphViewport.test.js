"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Presentation = require("../js/strikeBarChartPresentation.js");

const ROOT = path.join(__dirname, "..");
const style = fs.readFileSync(path.join(ROOT, "style.css"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const currentRenderer = fs.readFileSync(path.join(ROOT, "js/script.js"), "utf8");
const historyRenderer = fs.readFileSync(path.join(ROOT, "js/qriTimeTravelView.js"), "utf8");
const viewportRule = style.match(/\.historical-qri-chart-container,\s*\n\.combined-chart-container\s*\{([^}]*)\}/)?.[1] || "";

test("UI1-1 Current graph uses the new bounded viewport height", () => {
    assert.match(viewportRule, /height:\s*min\(532px,\s*70vh\)/);
    assert.match(html, /id="combinedPriceChartContainer"[\s\S]*?class="[^"]*combined-chart-container/);
});

test("UI1-2 Historical OI uses the same viewport target", () => {
    assert.match(viewportRule, /height:\s*min\(532px,\s*70vh\)/);
    assert.match(html, /id="historicalQriChartContainer"[\s\S]*?historicalQriOpenInterestChart/);
});

test("UI1-3 Historical Volume reuses the Historical OI viewport", () => {
    assert.match(html, /id="historyOpenInterestButton"[\s\S]*id="historyVolumeButton"/);
    assert.equal((html.match(/id="historicalQriChartContainer"/g) || []).length, 1);
    assert.match(historyRenderer, /selectVolume/);
});

test("UI1-4 narrow viewports retain the exact 70vh cap", () => {
    assert.match(viewportRule, /min\(532px,\s*70vh\)/);
    assert.doesNotMatch(style, /historical-qri-chart-container\s*\{[^}]*min-height:\s*360px/s);
});

test("UI1-5 Current and Historical containers retain vertical scrolling", () => {
    assert.match(style, /\.combined-chart-container\s*\{[^}]*overflow-y:\s*auto/s);
    assert.match(style, /\.historical-qri-chart-container\.strike-bar-chart-scroll\s*\{[^}]*overflow-y:\s*auto/s);
});

test("UI1-6 mirrored graph row density remains 24px per Strike", () => {
    assert.equal(Presentation.ROW_HEIGHT, 24);
    assert.deepEqual(Presentation.prepareMirroredPlot({
        container: { clientWidth: 640 }, plot: { style: {} }, strikeCount: 20
    }), { width: 720, height: 536 });
});

test("UI1-7 Current auto-centering uses the taller viewport midpoint", () => {
    const container = { clientHeight: 532, scrollTop: 0 };
    const plot = { scrollHeight: 2456, style: { minHeight: "2456px" } };
    const chart = { scales: { y: { getPixelForValue: index => index * 24 + 28 } } };
    assert.equal(Presentation.centerVerticalIndex({ container, plot, chart, index: 50 }), true);
    assert.equal(container.scrollTop, 962);
});

test("UI1-8 Current OI and Volume switch does not resize the container", () => {
    const switcher = currentRenderer.slice(currentRenderer.indexOf("function switchChartMode"),
        currentRenderer.indexOf("function updateOpenInterestDataStatus"));
    assert.doesNotMatch(switcher, /style\.(?:height|minHeight|maxHeight)/);
    assert.equal((html.match(/id="combinedPriceChartContainer"/g) || []).length, 1);
});

test("UI1-9 History revision and metric switches do not resize the container", () => {
    assert.doesNotMatch(historyRenderer, /style\.(?:height|minHeight|maxHeight)/);
    assert.match(historyRenderer, /selectRevision/);
    assert.match(historyRenderer, /selectVolume/);
});

test("UI1-10 Current and Historical layouts share one height declaration", () => {
    assert.match(style, /\.historical-qri-chart-container,\s*\n\.combined-chart-container\s*\{\s*height:\s*min\(532px,\s*70vh\);\s*\}/);
    assert.equal((style.match(/height:\s*min\(532px,\s*70vh\)/g) || []).length, 1);
});
