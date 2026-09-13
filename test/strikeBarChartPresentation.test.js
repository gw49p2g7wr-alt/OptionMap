"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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
