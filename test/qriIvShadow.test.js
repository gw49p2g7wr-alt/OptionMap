const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const shadow = require("../js/qriIvShadow.js");

function cellRow({ strike = "40,000", callSingle = "33.12%",
    callQuotes = "35.35%<br>32.49%", putSingle = "25.50%",
    putQuotes = "27.00%<br>24.00%" } = {}) {
    const cells = Array(17).fill("-");
    cells[3] = callQuotes; cells[5] = callSingle; cells[8] = strike;
    cells[11] = putSingle; cells[13] = putQuotes;
    return `<tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
}

function page(rows) {
    return `<dl><dt>取引日</dt><dd>2026/07/23</dd></dl>
        <a href="?gengetsu=202609&amp;lang=ja">CSV</a><table>${rows}</table>`;
}

test("percent parser distinguishes percent, decimal, missing, zero and malformed", () => {
    assert.deepEqual(shadow.parsePercent("33.12%"),
        { value: 33.12, status: "available", sourceFormat: "percent_sign" });
    assert.deepEqual(shadow.parsePercent("33.12"),
        { value: 33.12, status: "available", sourceFormat: "plain_number" });
    assert.deepEqual(shadow.parsePercent(".3312"),
        { value: 0.3312, status: "available", sourceFormat: "plain_number" });
    assert.deepEqual(shadow.parsePercent("-"),
        { value: null, status: "missing", sourceFormat: null });
    assert.deepEqual(shadow.parsePercent("  "),
        { value: null, status: "missing", sourceFormat: null });
    assert.deepEqual(shadow.parsePercent("0%"),
        { value: 0, status: "available", sourceFormat: "percent_sign" });
    assert.deepEqual(shadow.parsePercent("0"),
        { value: 0, status: "available", sourceFormat: "plain_number" });
    for (const value of ["abc", "12%%", "-1%", "NaN"])
        assert.deepEqual(shadow.parsePercent(value),
            { value: null, status: "invalid", sourceFormat: null });
});

test("CALL and PUT keep single, ask and bid IV separate in QRI header order", () => {
    const parsed = shadow.parseHtml(page(cellRow()));
    assert.equal(parsed.valueUnit, "percent_points");
    assert.equal(parsed.contract, "2026-09");
    assert.equal(parsed.tradingDate, "2026-07-23");
    assert.deepEqual(parsed.rows[0], {
        strike: 40000,
        call: {
            singleIv: { value: 33.12, status: "available", sourceFormat: "percent_sign" },
            askIv: { value: 35.35, status: "available", sourceFormat: "percent_sign" },
            bidIv: { value: 32.49, status: "available", sourceFormat: "percent_sign" }
        },
        put: {
            singleIv: { value: 25.5, status: "available", sourceFormat: "percent_sign" },
            askIv: { value: 27, status: "available", sourceFormat: "percent_sign" },
            bidIv: { value: 24, status: "available", sourceFormat: "percent_sign" }
        }
    });
    assert.equal("representativeIv" in parsed.rows[0].call, false);
});

test("missing remains null without interpolation or representative IV generation", () => {
    const parsed = shadow.parseHtml(page(cellRow({ callSingle: "-",
        callQuotes: "35%<br>-", putSingle: "", putQuotes: "-<br>-" })));
    assert.equal(parsed.rows[0].call.singleIv.value, null);
    assert.equal(parsed.rows[0].call.bidIv.value, null);
    assert.equal(parsed.rows[0].put.singleIv.value, null);
    assert.equal(parsed.rows[0].put.askIv.value, null);
    assert.equal(parsed.rows[0].call.singleIv.status, "missing");
    assert.equal("representativeIv" in parsed.rows[0].call, false);
});

test("500-yen filter keeps only real strikes and never creates interpolated rows", () => {
    const parsed = shadow.parseHtml(page([
        cellRow({ strike: "39,875" }), cellRow({ strike: "40,000" }),
        cellRow({ strike: "40,250" }), cellRow({ strike: "40,500" })
    ].join("")));
    const filtered = shadow.filterFiveHundred(parsed.rows);
    assert.deepEqual(filtered.map(row => row.strike), [40000, 40500]);
    assert.equal(filtered.every(row => parsed.rows.includes(row)), true);
});

test("continuity counts internal gaps separately from leading and trailing missing", () => {
    const values = ["-", "20%", "21%", "-", "-", "22%", "-", "23%", "-"];
    const parsed = shadow.parseHtml(page(values.map((value, index) => cellRow({
        strike: String(40000 + index * 500), callSingle: value
    })).join("")));
    assert.deepEqual(shadow.continuity(parsed.rows, "call", "singleIv"), {
        availablePoints: 4, missingPoints: 5, longestAvailableRun: 2,
        gapCount: 2, maximumGapPoints: 2, maximumGapWidth: 1500
    });
});

test("saved QRI fixture parses every strike and preserves observed density", () => {
    const fixture = fs.readFileSync(path.join(__dirname,
        "../data/sample2026_07_23-2.html"), "utf8");
    const parsed = shadow.parseHtml(fixture);
    const result = shadow.analyze(parsed, 66510);
    assert.equal(parsed.rows.length, 248);
    assert.equal(parsed.contract, "2026-09");
    assert.equal(parsed.tradingDate, "2026-07-23");
    assert.ok(fixture.indexOf("売気配IV") < fixture.indexOf("買気配IV"));
    assert.deepEqual(shadow.density(parsed.rows, "call"), {
        strikeCount: 248, singleIv: 24, askIv: 116, bidIv: 116,
        askAndBid: 116, allMissing: 132, invalidCells: 0
    });
    assert.deepEqual(shadow.density(parsed.rows, "put"), {
        strikeCount: 248, singleIv: 13, askIv: 171, bidIv: 171,
        askAndBid: 171, allMissing: 76, invalidCells: 0
    });
    assert.equal(result.full.strikeCount > 0, true);
    assert.equal(result.ranges[2000].strikeCount, 8);
    assert.equal(result.ranges[3000].strikeCount, 12);
    assert.equal(result.ranges[5000].strikeCount, 20);
    assert.equal(result.full.call.singleIv, 23);
    assert.equal(result.full.put.singleIv, 11);
    assert.equal(result.full.call.askAndBid > result.full.call.singleIv, true);
    assert.equal(result.full.put.askAndBid > result.full.put.singleIv, true);
});
