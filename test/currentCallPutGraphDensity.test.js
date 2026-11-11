"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Presentation = require("../js/strikeBarChartPresentation.js");
const Mirror = require("../js/currentCallPutGraphPresentation.js");

const ROOT = path.join(__dirname, "..");
const style = fs.readFileSync(path.join(ROOT, "style.css"), "utf8");
const currentRenderer = fs.readFileSync(path.join(ROOT, "js/script.js"), "utf8");
const historyRenderer = fs.readFileSync(path.join(ROOT, "js/qriTimeTravelView.js"), "utf8");
const viewportHeight = 532;
const baselineRowHeight = 24;

function contentHeight(strikeCount, rowHeight = Presentation.ROW_HEIGHT) {
    return strikeCount * rowHeight + Presentation.MIRRORED_AXIS_ALLOWANCE;
}

function visibleRows(rowHeight = Presentation.ROW_HEIGHT) {
    return Math.floor((viewportHeight - Presentation.MIRRORED_AXIS_ALLOWANCE) / rowHeight);
}

test("UI2-1 compact row-height authority remains shared after later tuning", () => {
    assert.equal(Presentation.ROW_HEIGHT, 18);
});

test("UI2-2 viewport remains bounded at 532px and 70vh", () => {
    assert.equal((style.match(/height:\s*min\(532px,\s*70vh\)/g) || []).length, 1);
});

test("UI2-3 Current graph still exposes more rows than the 24px baseline", () => {
    assert.deepEqual({ current: visibleRows(), baseline: visibleRows(baselineRowHeight) },
        { current: 26, baseline: 19 });
});

test("UI2-4 Historical graph still uses the same increased visible range", () => {
    assert.match(historyRenderer, /prepareMirroredPlot/);
    assert.equal(visibleRows(), 26);
});

test("UI2-5 vertical scrolling remains enabled for Current and Historical", () => {
    assert.match(style, /\.strike-bar-chart-scroll-region\s*\{[^}]*overflow-y:\s*auto/s);
    assert.match(currentRenderer, /combinedPriceChartScroll/);
    assert.match(historyRenderer, /historicalQriChartScroll/);
});

test("UI2-6 total scroll extent is reduced from the 24px baseline", () => {
    assert.deepEqual({ current: contentHeight(100), baseline: contentHeight(100, baselineRowHeight) },
        { current: 1856, baseline: 2456 });
    assert.ok(contentHeight(100) > viewportHeight);
});

test("UI2-7 16px Strike labels retain a visible gap in the active rows", () => {
    const plugin = Mirror.createCenterStrikeLabelsPlugin().afterDatasetsDraw.toString();
    assert.match(plugin, /y - 8/);
    assert.match(plugin, /width, 16/);
    assert.ok(Presentation.ROW_HEIGHT - 16 >= 2);
});

test("UI2-8 CALL and PUT bars remain separated from adjacent rows", () => {
    assert.equal(Presentation.DATASET_OPTIONS.maxBarThickness, 10);
    assert.ok(Presentation.DATASET_OPTIONS.maxBarThickness < Presentation.ROW_HEIGHT);
});

test("UI2-9 Current auto-centering follows the active chart scale", () => {
    const container = { clientHeight: viewportHeight, scrollTop: 0 };
    const plot = { scrollHeight: contentHeight(100),
        style: { minHeight: `${contentHeight(100)}px` } };
    const chart = { scales: { y: { getPixelForValue: index =>
        index * Presentation.ROW_HEIGHT + Presentation.MIRRORED_AXIS_ALLOWANCE / 2 } } };
    assert.equal(Presentation.centerVerticalIndex({ container, plot, chart, index: 50 }), true);
    assert.equal(container.scrollTop, 662);
});

test("UI2-10 TOP3 badges fit inside one row without collision", () => {
    const plugin = currentRenderer.match(/const combinedWallRankPlugin = \{[\s\S]*?\n\};/)?.[0] || "";
    const radius = Number(plugin.match(/ctx\.arc\(x, y, (\d+)/)?.[1]);
    assert.equal(radius, 8);
    assert.ok(radius * 2 < Presentation.ROW_HEIGHT);
    assert.match(plugin, /bold 10px sans-serif/);
});

test("UI2-11 Wall and local-spike highlight semantics remain unchanged", () => {
    const model = Mirror.createModel({ strikes: [68000, 68500, 69000, 69500, 70000],
        callValues: [10, 20, 100, 20, 30], putValues: [50, 40, 30, 20, 10] });
    const row = strike => model.rows.find(item => item.strike === strike);
    assert.equal(row(69000).callHighlight, "strong");
    assert.equal(row(68000).putHighlight, "strong");
});

test("UI2-12 Current OI and Volume switch cannot change row density", () => {
    const switcher = currentRenderer.slice(currentRenderer.indexOf("function switchChartMode"),
        currentRenderer.indexOf("function updateOpenInterestDataStatus"));
    assert.doesNotMatch(switcher, /ROW_HEIGHT|prepareMirroredPlot|style\.(?:height|minHeight|maxHeight)/);
});

test("UI2-13 Current and Historical use one shared density authority", () => {
    assert.match(currentRenderer, /presentation\?\.prepareMirroredPlot/);
    assert.match(historyRenderer, /presentation\?\.prepareMirroredPlot/);
    assert.equal((currentRenderer.match(/const ROW_HEIGHT/g) || []).length, 0);
    assert.equal((historyRenderer.match(/const ROW_HEIGHT/g) || []).length, 0);
});
