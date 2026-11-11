"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Presentation = require("../js/strikeBarChartPresentation.js");

const ROOT = path.join(__dirname, "..");
const style = fs.readFileSync(path.join(ROOT, "style.css"), "utf8");
const currentRenderer = fs.readFileSync(path.join(ROOT, "js/script.js"), "utf8");
const historyRenderer = fs.readFileSync(path.join(ROOT, "js/qriTimeTravelView.js"), "utf8");
const mirrorPresentation = fs.readFileSync(path.join(ROOT,
    "js/currentCallPutGraphPresentation.js"), "utf8");
const viewportHeight = 532;
const baselineRowHeight = 20;
const labelHeight = 16;
const currentMarkerFontHeight = 13;
const currentMarkerOffset = 3;

function contentHeight(strikeCount, rowHeight = Presentation.ROW_HEIGHT) {
    return strikeCount * rowHeight + Presentation.MIRRORED_AXIS_ALLOWANCE;
}

function visibleRows(rowHeight = Presentation.ROW_HEIGHT) {
    return Math.floor((viewportHeight - Presentation.MIRRORED_AXIS_ALLOWANCE) / rowHeight);
}

test("UI3-1 row height is exactly 18px", () => {
    assert.equal(Presentation.ROW_HEIGHT, 18);
});

test("UI3-2 viewport remains bounded at 532px and 70vh", () => {
    assert.equal((style.match(/height:\s*min\(532px,\s*70vh\)/g) || []).length, 1);
});

test("UI3-3 visible rows increase over the 20px baseline", () => {
    assert.deepEqual({ current: visibleRows(), baseline: visibleRows(baselineRowHeight) },
        { current: 26, baseline: 23 });
});

test("UI3-4 scroll extent is lower than the 20px baseline and still exceeds the viewport", () => {
    assert.deepEqual({ current: contentHeight(100), baseline: contentHeight(100, baselineRowHeight) },
        { current: 1856, baseline: 2056 });
    assert.ok(contentHeight(100) > viewportHeight);
});

test("UI3-5 Strike labels retain a non-overlapping vertical gap", () => {
    assert.equal(Presentation.ROW_HEIGHT - labelHeight, 2);
    assert.match(mirrorPresentation, /fillRect\(x - width \/ 2, y - 8, width, 16\)/);
});

test("UI3-6 bars retain separation between adjacent rows", () => {
    assert.equal(Presentation.DATASET_OPTIONS.maxBarThickness, 10);
    assert.equal(Presentation.ROW_HEIGHT - Presentation.DATASET_OPTIONS.maxBarThickness, 8);
});

test("UI3-7 TOP3 badge has a gap and readable text inside an 18px row", () => {
    const plugin = currentRenderer.match(/const combinedWallRankPlugin = \{[\s\S]*?\n\};/)?.[0] || "";
    const radius = Number(plugin.match(/ctx\.arc\(x, y, (\d+)/)?.[1]);
    assert.equal(radius, 8);
    assert.equal(Presentation.ROW_HEIGHT - radius * 2, 2);
    assert.match(plugin, /bold 10px sans-serif/);
});

test("UI3-8 Current marker label fits between adjacent row centers", () => {
    const marker = currentRenderer.match(/const currentPriceLinePlugin = \{[\s\S]*?\n\};/)?.[0] || "";
    assert.match(marker, /font = "bold 13px sans-serif"/);
    assert.match(marker, /y - 3/);
    assert.ok(currentMarkerFontHeight + currentMarkerOffset < Presentation.ROW_HEIGHT);
});

test("UI3-9 auto-centering follows the 18px chart scale", () => {
    const container = { clientHeight: viewportHeight, scrollTop: 0 };
    const plot = { scrollHeight: contentHeight(100),
        style: { minHeight: `${contentHeight(100)}px` } };
    const chart = { scales: { y: { getPixelForValue: index =>
        index * Presentation.ROW_HEIGHT + Presentation.MIRRORED_AXIS_ALLOWANCE / 2 } } };
    assert.equal(Presentation.centerVerticalIndex({ container, plot, chart, index: 50 }), true);
    assert.equal(container.scrollTop, 662);
});

test("UI3-10 OI and Volume switching cannot change layout density", () => {
    const switcher = currentRenderer.slice(currentRenderer.indexOf("function switchChartMode"),
        currentRenderer.indexOf("function updateOpenInterestDataStatus"));
    assert.doesNotMatch(switcher, /ROW_HEIGHT|style\.(?:height|minHeight|maxHeight)/);
    assert.match(historyRenderer, /selectOpenInterest/);
    assert.match(historyRenderer, /selectVolume/);
});

test("UI3-11 Current and History share the same density function", () => {
    assert.match(currentRenderer, /presentation\?\.prepareMirroredPlot/);
    assert.match(historyRenderer, /presentation\?\.prepareMirroredPlot/);
    assert.equal((currentRenderer.match(/const ROW_HEIGHT/g) || []).length, 0);
    assert.equal((historyRenderer.match(/const ROW_HEIGHT/g) || []).length, 0);
});
