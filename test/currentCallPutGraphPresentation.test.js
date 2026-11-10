"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Presentation = require("../js/currentCallPutGraphPresentation.js");

test("CALLは左、PUTは右へ表示しsource値を変更しない", () => {
    const calls = [100, 300], puts = [250, 50];
    const before = JSON.stringify({ calls, puts });
    const model = Presentation.createModel({ strikes: [65000, 65125],
        callValues: calls, putValues: puts });
    assert.deepEqual(model.rows.map(row => row.strike), [65125, 65000]);
    assert.deepEqual(model.rows.map(row => row.callDisplay), [-300, -100]);
    assert.deepEqual(model.rows.map(row => row.putDisplay), [50, 250]);
    assert.equal(JSON.stringify({ calls, puts }), before);
});

test("CALL/PUTは大きい側に合わせた共通対称scaleを使う", () => {
    const callLarge = Presentation.createModel({ strikes: [65000],
        callValues: [900], putValues: [300] });
    assert.equal(callLarge.sharedMaximum, 900);
    assert.equal(callLarge.displayMaximum, 900);
    const putLarge = Presentation.createModel({ strikes: [65000],
        callValues: [200], putValues: [1200] });
    assert.equal(putLarge.sharedMaximum, 1200);
    assert.equal(putLarge.displayMaximum, 1200);
});

test("全値0は市場値を捏造せず安全な表示rangeだけを返す", () => {
    const model = Presentation.createModel({ strikes: [65000],
        callValues: [0], putValues: [0], metric: "volume" });
    assert.equal(model.sharedMaximum, 0);
    assert.equal(model.displayMaximum, Presentation.SAFE_ZERO_RANGE);
    assert.deepEqual(model.rows.map(row => [row.callOriginal, row.putOriginal]), [[0, 0]]);
});

test("missing値はnullのまま保持し実測0へ変換しない", () => {
    const model = Presentation.createModel({ strikes: [65000, 65125],
        callValues: [null, 0], putValues: [undefined, 5] });
    assert.equal(model.rows[1].callOriginal, null);
    assert.equal(model.rows[1].callDisplay, null);
    assert.equal(model.rows[1].putOriginal, null);
    assert.equal(model.rows[0].callOriginal, 0);
});

test("top3とlocal spikeは元のStrike/valueに結び付いたまま", () => {
    const model = Presentation.createModel({
        strikes: [65000, 65125, 65250, 65375, 65500],
        callValues: [10, 20, 100, 20, 30], putValues: [50, 40, 30, 20, 10]
    });
    const strike65250 = model.rows.find(row => row.strike === 65250);
    assert.equal(strike65250.callHighlight, "strong");
    const strongPut = model.rows.filter(row => row.putHighlight === "strong")
        .map(row => row.strike).sort();
    assert.deepEqual(strongPut, [65000, 65125, 65250]);
    const spike = Presentation.createModel({
        strikes: [65000, 65125, 65250, 65375, 65500, 65625, 65750],
        callValues: [1000, 900, 800, 10, 30, 10, 700], putValues: Array(7).fill(0)
    }).rows.find(row => row.strike === 65500);
    assert.equal(spike.callHighlight, "spike");
});

test("現在値と同じ最寄りStrike identityを降順表示でも選ぶ", () => {
    const model = Presentation.createModel({ strikes: [65000, 65125, 65250],
        callValues: [1, 2, 3], putValues: [3, 2, 1] });
    const index = Presentation.nearestStrikeIndex(model.rows, 65110);
    assert.equal(model.rows[index].strike, 65125);
    const midpointIndex = Presentation.nearestStrikeIndex(model.rows, 65062.5);
    assert.equal(model.rows[midpointIndex].strike, 65000);
});

test("axisとtooltip用formatterは負号を見せない", () => {
    assert.equal(Presentation.formatAbsolute(-5000), "5,000");
    assert.equal(Presentation.formatAbsolute(5000), "5,000");
    assert.equal(Presentation.formatAbsolute(null), "—");
});

test("CALL/PUT tooltipは限月・Strike・metric・正の原値を表示する", () => {
    const row = Presentation.createModel({ strikes: [65000],
        callValues: [5000], putValues: [7500], metric: "volume" }).rows[0];
    assert.deepEqual(Presentation.createTooltip({ row, side: "call", metric: "volume",
        contract: "2026-11" }), {
        title: "限月 2026-11 / Strike 65,000円", label: "CALL取引高：5,000枚"
    });
    assert.equal(Presentation.createTooltip({ row, side: "put", metric: "volume" }).label,
        "PUT取引高：7,500枚");
});

test("OI/Volumeは同じadapterを使いmetricだけを明示する", () => {
    const input = { strikes: [65000], callValues: [12], putValues: [34] };
    assert.equal(Presentation.createModel({ ...input, metric: "openInterest" }).metric,
        "openInterest");
    assert.equal(Presentation.createModel({ ...input, metric: "volume" }).metric, "volume");
    assert.equal(Presentation.createModel({ ...input, metric: "other" }).status, "invalid");
});

test("current graph wiringは水平mirror、中央Strike、vertical scrollを明示する", () => {
    const root = path.join(__dirname, "..");
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const script = fs.readFileSync(path.join(root, "js/script.js"), "utf8");
    const style = fs.readFileSync(path.join(root, "style.css"), "utf8");
    assert.match(html, /currentCallPutGraphPresentation\.js/);
    assert.match(script, /indexAxis:\s*"y"/);
    assert.match(script, /centerStrikeLabelsPlugin/);
    assert.match(script, /min:\s*-model\.displayMaximum/);
    assert.match(script, /max:\s*model\.displayMaximum/);
    assert.equal((script.match(/grouped:\s*false/g) || []).length, 2);
    assert.match(script, /formatAbsolute/);
    const marker = script.match(/const currentPriceLinePlugin = \{[\s\S]*?\n\};/)?.[0] || "";
    assert.match(marker, /getPixelForValue\(priceIndex\)/);
    assert.match(marker, /moveTo\(chart\.chartArea\.left, y\)/);
    assert.match(marker, /lineTo\(chart\.chartArea\.right, y\)/);
    assert.match(style, /\.combined-chart-container[\s\S]*overflow-y:\s*auto/);
});

test("current rendererはrefresh時に旧Chartを破棄しmetric切替でauthorityを変更しない", () => {
    const script = fs.readFileSync(path.join(__dirname, "../js/script.js"), "utf8");
    const renderer = script.slice(script.indexOf("function renderCurrentCallPutMirror"),
        script.indexOf("function renderQriContractDisplayChart"));
    assert.match(renderer, /combinedPriceChart\.destroy\(\)[\s\S]*clearQriChartRendererIdentity/);
    assert.doesNotMatch(renderer, /fetch\(|indexedDB|localStorage|setItem|removeItem/);
    const switcher = script.slice(script.indexOf("function switchChartMode"),
        script.indexOf("function updateOpenInterestDataStatus"));
    assert.match(switcher, /currentChartMode = mode/);
    assert.doesNotMatch(switcher, /qriContractSelectionState\s*=|qriFormalChartContract\s*=/);
});

test("pure adapterはDOM・network・storage・QRI persistenceを持たない", () => {
    const code = fs.readFileSync(path.join(__dirname,
        "../js/currentCallPutGraphPresentation.js"), "utf8");
    assert.doesNotMatch(code, /document\.|querySelector|\bChart\b|fetch\(|indexedDB|localStorage/);
    assert.doesNotMatch(code, /qriOptionsHistory|Evidence|persist|write|setItem/);
});
