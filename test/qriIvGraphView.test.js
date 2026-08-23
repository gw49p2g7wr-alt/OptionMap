const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const View = require("../js/qriIvGraphView.js");

function side(optionType, state, values, message = null) {
    return { optionType, state, values, availablePoints: values.filter(Number.isFinite).length,
        strikeCount: values.length, message };
}

function model(call, put, extra = {}) {
    return { available: true, chartAvailable: true, message: null,
        metadata: { contract: "2026-09", tradingDate: "2026-08-24",
            pageUpdatedAt: "2026-08-24T04:52:00+09:00", rangeLabel: "±3,000円" },
        series: { call, put }, ...extra };
}

test("CALL and PUT line datasets preserve null and disable gap spanning", () => {
    const result = View.presentation(model(
        side("call", "line_and_point", [20, null, 22], "公表点のみ表示"),
        side("put", "line_and_point", [null, 24, 25], "公表点のみ表示")
    ));
    assert.deepEqual(result.datasets.map(item => item.label), ["CALL IV", "PUT IV"]);
    assert.deepEqual(result.datasets[0].data, [20, null, 22]);
    assert.equal(result.datasets.every(item => item.spanGaps === false), true);
    assert.equal(result.datasets.every(item => item.tension === 0), true);
});

test("empty side is omitted while the other side remains drawable", () => {
    const result = View.presentation(model(
        side("call", "line_and_point", [20, 21]), side("put", "empty", [null, null])
    ));
    assert.deepEqual(result.datasets.map(item => item.label), ["CALL IV"]);
    assert.deepEqual(result.sideMessages, ["PUT IV：公表データなし"]);
});

test("point_only renders a point without inventing a line", () => {
    const result = View.presentation(model(
        side("call", "point_only", [null, 20], "IVデータ1点のみ"),
        side("put", "empty", [null, null])
    ));
    assert.equal(result.datasets[0].showLine, false);
    assert.match(result.sideMessages[0], /1点のみ/);
});

test("line_and_point uses line plus visible points", () => {
    const result = View.dataset(side("call", "line_and_point", [20, 21]));
    assert.equal(result.showLine, true);
    assert.equal(result.pointRadius > 0, true);
});

test("both empty uses publication empty state instead of system failure", () => {
    const result = View.presentation(model(side("call", "empty", [null]),
        side("put", "empty", [null]), { chartAvailable: false,
            message: "この範囲にはIV公表データがありません" }));
    assert.equal(result.emptyMessage, "この範囲にはIV公表データがありません");
    assert.equal(result.systemMessage, null);
    assert.deepEqual(result.datasets, []);
});

test("acquisition failure remains distinct from publication empty state", () => {
    const result = View.presentation({ available: false, reason: "canonical_invalid" });
    assert.equal(result.systemMessage, "IVデータを表示できません");
    assert.equal(result.emptyMessage, null);
    assert.equal(result.reason, "canonical_invalid");
});

test("coverage and canonical metadata use view-model facts", () => {
    const result = View.presentation(model(side("call", "line_and_point", [20, null]),
        side("put", "point_only", [null, 25])));
    assert.deepEqual(result.coverage, ["CALL 1 / 2点", "PUT 1 / 2点"]);
    assert.deepEqual(result.metadata, ["2026年9月限", "取引日 2026/08/24",
        "QRI更新 04:52", "表示範囲 ±3,000円"]);
});

test("active and specific contract channels never cross", () => {
    const runtime = { active: { available: true, contract: "2026-09" },
        selected: { available: true, contract: "2026-10" } };
    assert.equal(View.resolveChannel({ mode: "auto" }, runtime).channel, "active");
    assert.equal(View.resolveChannel({ mode: "specific", contract: "2026-10" }, runtime).channel,
        "selected");
    assert.equal(View.resolveChannel({ mode: "specific", contract: "2026-11" }, runtime).available,
        false);
    assert.equal(View.resolveChannel({ mode: "unresolved" }, runtime).available, false);
});

test("renderer wiring has panel, all ranges and no fetch, storage, history or OverallV2 use", () => {
    const index = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const source = fs.readFileSync(path.join(__dirname, "../js/qriIvGraphView.js"), "utf8");
    assert.match(index, /id="qriIvCurvePanel"/);
    assert.match(index, /data-range-mode="plus_minus_3000"[^>]*class="iv-range-button active"/);
    for (const mode of View.RANGE_MODES) assert.match(index, new RegExp(`data-range-mode="${mode}"`));
    assert.match(index, /buildCurrentQriIvGraphViewModel/);
    assert.doesNotMatch(source, /fetch\s*\(|ipcRenderer|localStorage|indexedDB|History|OverallV2/);
    const ivWiring = index.slice(index.indexOf("function renderQriIvGraph"),
        index.indexOf("function setQriContractSelectionNote"));
    assert.doesNotMatch(ivWiring, /fetch-option-page|localStorage|indexedDB|persist/);
    assert.doesNotMatch(ivWiring, /currentPriceLinePlugin/);
});
