"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Presentation = require("../js/strikeBarChartPresentation.js");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const style = fs.readFileSync(path.join(ROOT, "style.css"), "utf8");
const currentRenderer = fs.readFileSync(path.join(ROOT, "js/script.js"), "utf8");
const historyRenderer = fs.readFileSync(path.join(ROOT, "js/qriTimeTravelView.js"), "utf8");

function element() {
    return {
        hidden: true, children: [], style: {}, scrollLeft: 0, scrollTop: 0,
        clientWidth: 500, scrollWidth: 720, listeners: {},
        replaceChildren(...children) { this.children = children; },
        addEventListener(type, listener) { this.listeners[type] = listener; },
        removeEventListener(type, listener) {
            if (this.listeners[type] === listener) delete this.listeners[type];
        },
        dispatch(type) { this.listeners[type]?.({ target: this }); }
    };
}

function chartFixture(values, positions) {
    const ticks = values.map(value => ({ value }));
    const scale = { ticks, getPixelForValue: value => positions[values.indexOf(value)] };
    return { scales: { x: scale }, options: { scales: { x: { ticks: {
        callback(value) { return Math.abs(value).toLocaleString("ja-JP"); }
    } } } } };
}

function render(values = [-5716, -4000, -2000, 0, 2000, 4000, 5716],
    positions = [24, 136, 248, 360, 472, 584, 696]) {
    const axis = element(), scroller = element();
    const plot = { scrollWidth: 720, style: { minWidth: "720px" } };
    const documentRef = { createElement: () => element() };
    const chart = chartFixture(values, positions);
    const result = Presentation.renderStickyAxis({ documentRef, axis, scroller, plot, chart });
    return { result, axis, scroller, plot, chart, track: axis.children[0] };
}

test("UI4-1 vertical scroll leaves the horizontal value axis visible", () => {
    const value = render();
    assert.equal(value.result, true);
    assert.equal(value.axis.hidden, false);
    value.scroller.scrollTop = 900;
    value.scroller.dispatch("scroll");
    assert.equal(value.axis.hidden, false);
    assert.equal(value.track.style.transform, "translateX(0px)");
});

test("UI4-2 sticky ticks use the exact Chart.js scale pixel positions", () => {
    const value = render([-100, 0, 100], [41, 360, 679]);
    assert.deepEqual(value.track.children.map(tick => tick.style.left),
        ["41px", "360px", "679px"]);
});

test("UI4-3 shared scale remains mirrored around zero", () => {
    const value = render();
    assert.deepEqual(value.track.children.map(tick => tick.textContent),
        ["5,716", "4,000", "2,000", "0", "2,000", "4,000", "5,716"]);
});

test("UI4-4 CALL-side labels remain absolute user-facing values", () => {
    const labels = render().track.children.map(tick => tick.textContent);
    assert.equal(labels.some(label => label.includes("-")), false);
});

test("UI4-5 OI rerender replaces the axis from the active chart scale", () => {
    const value = render([-100, 0, 100], [24, 360, 696]);
    const next = chartFixture([-240, 0, 240], [24, 360, 696]);
    assert.equal(Presentation.renderStickyAxis({ documentRef: { createElement: () => element() },
        axis: value.axis, scroller: value.scroller, plot: value.plot, chart: next }), true);
    assert.deepEqual(value.axis.children[0].children.map(tick => tick.textContent),
        ["240", "0", "240"]);
});

test("UI4-6 Volume switch cannot retain a stale OI scale", () => {
    assert.match(currentRenderer, /onResize:\s*chart\s*=>\s*syncStickyAxis\(chart\)/);
    assert.match(currentRenderer, /syncStickyAxis\(combinedPriceChart\)/);
    assert.match(currentRenderer, /currentChartMode === "volume"/);
});

test("UI4-7 Current mode owns one scroll region and one sticky axis", () => {
    assert.equal((html.match(/id="combinedPriceChartScroll"/g) || []).length, 1);
    assert.equal((html.match(/id="combinedPriceChartAxis"/g) || []).length, 1);
    assert.match(currentRenderer, /renderStickyAxis/);
});

test("UI4-8 Historical OI uses the same sticky-axis authority", () => {
    assert.equal((html.match(/id="historicalQriChartAxis"/g) || []).length, 1);
    assert.match(historyRenderer, /presentation\.renderStickyAxis/);
    assert.match(historyRenderer, /callback:\s*value\s*=>\s*mirror\.formatAbsolute\(value\)/);
});

test("UI4-9 Historical Volume updates or clears the shared axis", () => {
    const value = render([-100, 0, 100], [24, 360, 696]);
    assert.equal(Presentation.clearStickyAxis({ axis: value.axis,
        scroller: value.scroller }), true);
    assert.equal(value.axis.hidden, true);
    assert.equal(value.axis.children.length, 0);
    assert.equal(value.scroller.listeners.scroll, undefined);
    assert.match(historyRenderer, /selectVolume:\s*onVolumeMetric/);
    assert.match(historyRenderer, /clearStickyAxis/);
    assert.match(historyRenderer, /volumeMode[\s\S]*renderStickyAxis/);
});

test("UI4-10 narrow viewport scroll keeps ticks horizontally aligned", () => {
    const value = render([-100, 0, 100], [24, 360, 696]);
    value.scroller.scrollLeft = 175;
    value.scroller.dispatch("scroll");
    assert.equal(value.track.style.transform, "translateX(-175px)");
    assert.deepEqual(value.track.children.map(tick => tick.style.left),
        ["24px", "360px", "696px"]);
});

test("UI4-11 current auto-centering keeps the shared vertical math", () => {
    const container = { clientHeight: 502, scrollTop: 0 };
    const plot = { scrollHeight: 1856, style: { minHeight: "1856px" } };
    const chart = { scales: { y: { getPixelForValue: index => index * 18 + 28 } } };
    assert.equal(Presentation.centerVerticalIndex({ container, plot, chart, index: 50 }), true);
    assert.equal(container.scrollTop, 677);
    assert.doesNotMatch(Presentation.centerVerticalIndex.toString(), /axis|sticky/i);
});

test("UI4-12 dedicated grid row prevents the axis obscuring the lowest visible Strike", () => {
    const frame = style.match(/\.historical-qri-chart-container,\s*\n\.combined-chart-container\s*\{([^}]*)\}/)?.[1] || "";
    const axis = style.match(/\.strike-bar-chart-sticky-axis\s*\{([^}]*)\}/)?.[1] || "";
    assert.match(frame, /grid-template-rows:\s*minmax\(0, 1fr\) auto/);
    assert.match(axis, /height:\s*30px/);
    assert.doesNotMatch(axis, /position:\s*absolute/);
});

test("UI4-13 Current marker Top3 and Wall semantics remain outside axis rendering", () => {
    assert.match(currentRenderer, /plugins:\s*\[currentPriceLinePlugin, combinedWallRankPlugin, centerStrikeLabelsPlugin\]/);
    const axisCall = currentRenderer.match(/syncStickyAxis\(combinedPriceChart\)/)?.[0] || "";
    assert.doesNotMatch(axisCall, /currentPrice|Wall|Rank|Highlight/);
    assert.equal(Presentation.ROW_HEIGHT, 18);
});
