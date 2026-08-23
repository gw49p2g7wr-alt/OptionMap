const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Iv = require("../js/qriOptionIv.js");
const View = require("../js/qriIvGraphViewModel.js");

const URL = "https://svc.qri.jp/jpx/nkopm/";

function row(strike, callIv = "-", putIv = "-") {
    const cells = Array(17).fill("-");
    cells[3] = "99%<br>98%"; cells[5] = callIv; cells[8] = String(strike);
    cells[11] = putIv; cells[13] = "97%<br>96%";
    return `<tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
}

function canonical(rows) {
    const html = `<dt>最終更新時刻</dt><dd>2026/08/24 06:00</dd>
        <dl><dt>取引日</dt><dd>2026/08/24</dd></dl>
        <dl><dt>取引最終日</dt><dd>2026/09/10</dd></dl>
        <a href="?gengetsu=202609&amp;lang=ja">CSV</a><table>${rows}</table>`;
    return Iv.parseQriOptionIvPage(html, URL);
}

function get(input, mode = "plus_minus_3000", currentPrice = 40000) {
    return View.build({ canonical: input, rangeMode: mode, currentPrice });
}

test("±3000 includes exact boundaries and filters 125/250-yen strikes", () => {
    const data = canonical([
        row(36999, "10%", "10%"), row(37000, "11%", "12%"),
        row(37250, "13%", "14%"), row(39750, "15%", "16%"),
        row(40000, "17%", "18%"), row(43000, "19%", "20%"),
        row(43001, "21%", "22%")
    ].join(""));
    const result = get(data);
    assert.deepEqual(result.labels, [37000, 40000, 43000]);
    assert.deepEqual(result.series.call.values, [11, 17, 19]);
    assert.deepEqual(result.series.put.values, [12, 18, 20]);
    assert.equal(result.series.call.strikeCount, 3);
});

test("±5000 and all use only real 500-yen strikes without creating rows", () => {
    const data = canonical([
        row(34000, "1%", "2%"), row(35000, "3%", "4%"),
        row(40000, "5%", "6%"), row(45000, "7%", "8%"),
        row(46000, "9%", "10%"), row(46250, "11%", "12%")
    ].join(""));
    assert.deepEqual(get(data, "plus_minus_5000").labels, [35000, 40000, 45000]);
    assert.deepEqual(get(data, "all", null).labels, [34000, 35000, 40000, 45000, 46000]);
    assert.equal(get(data, "all", null).currentPriceAvailable, false);
});

test("missing and invalid become null while diagnostics remain distinct", () => {
    const data = canonical(row(39500, "10%", "-") +
        row(40000, "broken", "20%") + row(40500, "", "21%"));
    const result = get(data);
    assert.deepEqual(result.series.call.values, [10, null, null]);
    assert.equal(result.series.call.availablePoints, 1);
    assert.equal(result.series.call.missingPoints, 1);
    assert.equal(result.series.call.invalidPoints, 1);
    assert.deepEqual(result.series.call.invalidStrikes, [40000]);
    assert.deepEqual(result.series.put.values, [null, 20, 21]);
});

test("0, 1 and 2 available points map to fixed side states and messages", () => {
    const empty = get(canonical(row(39500) + row(40000)));
    assert.deepEqual([empty.series.call.state, empty.series.call.message],
        ["empty", "IV公表データなし"]);
    const one = get(canonical(row(39500, "10%") + row(40000)));
    assert.deepEqual([one.series.call.state, one.series.call.message],
        ["point_only", "IVデータ1点のみ"]);
    const two = get(canonical(row(39500, "10%") + row(40000, "11%")));
    assert.deepEqual([two.series.call.state, two.series.call.message],
        ["line_and_point", null]);
    const partial = get(canonical(row(39500, "10%") + row(40000, "11%") + row(40500)));
    assert.deepEqual([partial.series.call.state, partial.series.call.message],
        ["line_and_point", "公表点のみ表示"]);
});

test("coverage denominator is the shared real strike universe", () => {
    const result = get(canonical(row(39500, "10%", "-") +
        row(40000, "11%", "20%") + row(40500, "-", "21%")));
    assert.equal(result.series.call.strikeCount, 3);
    assert.equal(result.series.put.strikeCount, 3);
    assert.equal(result.series.call.coverageRatio, 2 / 3);
    assert.equal(result.series.put.coverageRatio, 2 / 3);
});

test("one empty side is partial and both empty use aggregate empty state", () => {
    const callOnly = get(canonical(row(40000, "10%", "-") + row(40500, "11%", "-")));
    assert.deepEqual([callOnly.chartAvailable, callOnly.state], [true, "partial"]);
    assert.equal(callOnly.series.put.state, "empty");
    const putOnly = get(canonical(row(40000, "-", "20%") + row(40500, "-", "21%")));
    assert.deepEqual([putOnly.chartAvailable, putOnly.state], [true, "partial"]);
    assert.equal(putOnly.series.call.state, "empty");
    const neither = get(canonical(row(40000) + row(40500)));
    assert.deepEqual([neither.chartAvailable, neither.state, neither.message],
        [false, "empty", "この範囲にはIV公表データがありません"]);
});

test("acquisition failure, invalid canonical and invalid current price stay distinct", () => {
    assert.equal(get(null).reason, "data_unavailable");
    const invalid = canonical(row(40000)); invalid.schemaVersion = 99;
    assert.equal(get(invalid).reason, "canonical_invalid");
    const valid = canonical(row(40000));
    assert.equal(get(valid, "plus_minus_3000", NaN).reason, "current_price_invalid");
    assert.equal(get(valid, "unknown", 40000).reason, "range_mode_invalid");
});

test("metadata and current price facts are exposed without drawing decisions", () => {
    const result = get(canonical(row(40000, "10%", "20%")));
    assert.deepEqual(result.metadata, {
        contract: "2026-09", tradingDate: "2026-08-24",
        pageUpdatedAt: "2026-08-24T06:00:00+09:00",
        valueUnit: "percent_points", rangeMode: "plus_minus_3000",
        rangeLabel: "±3,000円"
    });
    assert.equal(result.currentPrice, 40000);
    assert.equal(result.currentPriceAvailable, true);
});

test("view generation does not mutate canonical or interpolate missing strikes", () => {
    const data = canonical(row(39000, "10%", "20%") + row(40000, "11%", "21%"));
    const before = JSON.stringify(data);
    const result = get(data);
    assert.equal(JSON.stringify(data), before);
    assert.deepEqual(result.labels, [39000, 40000]);
    assert.equal(result.labels.includes(39500), false);
});

function fixture(file, currentPrice) {
    const html = fs.readFileSync(path.join(__dirname, "../data", file), "utf8");
    return get(Iv.parseQriOptionIvPage(html, URL), "plus_minus_3000", currentPrice);
}

test("07-21 fixture produces relatively usable CALL and PUT curves", () => {
    const result = fixture("sample2026_07_21.html", 65220);
    assert.equal(result.series.call.strikeCount, 12);
    assert.equal(result.series.call.availablePoints, 10);
    assert.equal(result.series.put.availablePoints, 9);
    assert.equal(result.series.call.state, "line_and_point");
    assert.equal(result.series.put.state, "line_and_point");
    assert.equal(result.state, "available");
});

test("07-23 fixture remains point-centered without filling gaps", () => {
    const result = fixture("sample2026_07_23-2.html", 66510);
    assert.equal(result.series.call.strikeCount, 12);
    assert.equal(result.series.call.availablePoints, 1);
    assert.equal(result.series.put.availablePoints, 2);
    assert.equal(result.series.call.state, "point_only");
    assert.equal(result.series.put.state, "line_and_point");
    assert.equal(result.series.put.message, "公表点のみ表示");
});

test("module is pure and disconnected from Chart, DOM, storage, UI and OverallV2", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/qriIvGraphViewModel.js"), "utf8");
    const index = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.doesNotMatch(source, /new\s+Chart|canvas|querySelector|createElement/);
    assert.doesNotMatch(source, /localStorage|indexedDB|fetch\s*\(|ipcRenderer|OverallV2/i);
    assert.equal(index.includes("js/qriIvGraphViewModel.js"), false);
});
