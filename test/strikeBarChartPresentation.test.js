"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Presentation = require("../js/strikeBarChartPresentation.js");

test("12px/strikeと軸余白から不足時だけminimum plot幅を設定する", () => {
    const container = { clientWidth: 800 };
    const plot = { style: {} };
    assert.equal(Presentation.preparePlot({ container, plot, strikeCount: 100 }), 1280);
    assert.deepEqual(plot.style, { width: "100%", minWidth: "1280px" });

    assert.equal(Presentation.preparePlot({ container, plot, strikeCount: 20 }), 800);
    assert.deepEqual(plot.style, { width: "100%", minWidth: "320px" });
});

test("dataset設定はgroupedを変えず固定barThicknessを持たない", () => {
    assert.deepEqual(Presentation.DATASET_OPTIONS, {
        categoryPercentage: 0.82,
        barPercentage: 0.90,
        maxBarThickness: 10
    });
    assert.equal(Object.hasOwn(Presentation.DATASET_OPTIONS, "barThickness"), false);
    assert.equal(Object.hasOwn(Presentation.DATASET_OPTIONS, "grouped"), false);
});

test("現在値indexをviewport中央へ寄せ両端では安全にclampする", () => {
    const container = { clientWidth: 400, scrollLeft: 0 };
    const plot = { scrollWidth: 1280, style: { minWidth: "1280px" } };
    const chart = { scales: { x: { getPixelForValue: index => index * 120 } } };
    assert.equal(Presentation.centerIndex({ container, plot, chart, index: 5 }), true);
    assert.equal(container.scrollLeft, 400);
    Presentation.centerIndex({ container, plot, chart, index: 20 });
    assert.equal(container.scrollLeft, 880);
});

test("mirror chartは24px/Strikeの縦plotと720px minimum幅を設定する", () => {
    const container = { clientWidth: 640 };
    const plot = { style: {} };
    assert.deepEqual(Presentation.prepareMirroredPlot({ container, plot,
        strikeCount: 100 }), { width: 720, height: 2456 });
    assert.deepEqual(plot.style, { width: "100%", minWidth: "720px",
        height: "2456px", minHeight: "2456px" });
});

test("mirror chartの現在値indexを縦viewport中央へ安全にclampする", () => {
    const container = { clientHeight: 400, scrollTop: 0 };
    const plot = { scrollHeight: 2456, style: { minHeight: "2456px" } };
    const chart = { scales: { y: { getPixelForValue: index => index * 24 + 28 } } };
    assert.equal(Presentation.centerVerticalIndex({ container, plot, chart, index: 50 }), true);
    assert.equal(container.scrollTop, 1028);
    Presentation.centerVerticalIndex({ container, plot, chart, index: 100 });
    assert.equal(container.scrollTop, 2056);
});

test("HTML legendはdatasetのlabelと色から生成し空なら隠す", () => {
    const createElement = () => ({ className: "", textContent: "", style: {}, children: [],
        replaceChildren(...children) { this.children = children; } });
    const legend = { hidden: true, children: [],
        replaceChildren(...children) { this.children = children; } };
    const datasets = [
        { label: "CALL建玉残", backgroundColor: ["#call-soft", "#call-strong"],
            borderColor: "#call-border" },
        { label: "PUT建玉残", backgroundColor: "#put", borderColor: "#put-border" }
    ];
    assert.equal(Presentation.renderLegend({ documentRef: { createElement }, legend,
        datasets }), true);
    assert.equal(legend.hidden, false);
    assert.deepEqual(legend.children.map(item => item.children[1].textContent),
        ["CALL建玉残", "PUT建玉残"]);
    assert.deepEqual(legend.children.map(item => item.children[0].style), [
        { backgroundColor: "#call-soft", borderColor: "#call-border" },
        { backgroundColor: "#put", borderColor: "#put-border" }
    ]);
    assert.equal(Presentation.renderLegend({ documentRef: { createElement }, legend,
        datasets: [] }), false);
    assert.equal(legend.hidden, true);
    assert.equal(legend.children.length, 0);
});

test("対象4 chartはscroll外HTML legendを使い内蔵legendを非表示にする", () => {
    const root = path.join(__dirname, "..");
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const script = fs.readFileSync(path.join(root, "js/script.js"), "utf8");
    for (const [legendId, containerId] of [
        ["historicalQriChartLegend", "historicalQriChartContainer"],
        ["historicalQriAggregationChartLegend", "historicalQriAggregationChartContainer"],
        ["combinedPriceChartLegend", "combinedPriceChartContainer"]
    ]) {
        assert.ok(html.indexOf(`id="${legendId}"`) < html.indexOf(`id="${containerId}"`));
    }
    assert.equal((script.match(/renderCombinedStrikeChartLegend\(combinedPriceChart\)/g) || []).length, 1);
    assert.match(script, /legend:\s*\{\s*display: false\s*\}/);
});
