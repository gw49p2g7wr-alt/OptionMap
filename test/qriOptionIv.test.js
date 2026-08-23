const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Iv = require("../js/qriOptionIv.js");
const QriV2 = require("../js/qriOptions.js");

const URL = "https://svc.qri.jp/jpx/nkopm/";

function row(strike, callIv, putIv, callQuotes = "99%<br>98%",
    putQuotes = "97%<br>96%") {
    const cells = Array(17).fill("-");
    cells[3] = callQuotes; cells[5] = callIv; cells[8] = strike;
    cells[11] = putIv; cells[13] = putQuotes;
    return `<tr class="row-num">${cells.map(value => `<td>${value}</td>`).join("")}</tr>`;
}

function page(rows = row("40,000", "33.12%", "25.50%")) {
    return `<!doctype html><html><body>
        <div><dt>最終更新時刻</dt><dd>2026/08/23 06:00</dd></div>
        <dl><dt>取引日</dt><dd>2026/08/24</dd></dl>
        <dl><dt>取引最終日</dt><dd>2026/09/10</dd></dl>
        <a href="?gengetsu=202609&amp;lang=ja">CSV</a>
        <table>${rows}</table></body></html>`;
}

test("formal percent parser separates available, missing and invalid", () => {
    const cases = [
        ["33.12%", { status: "available", value: 33.12, sourceFormat: "percent_sign" }],
        ["33.12", { status: "available", value: 33.12, sourceFormat: "plain_number" }],
        ["0%", { status: "available", value: 0, sourceFormat: "percent_sign" }],
        ["0", { status: "available", value: 0, sourceFormat: "plain_number" }],
        ["-", { status: "missing", value: null, sourceFormat: "dash" }],
        ["－", { status: "missing", value: null, sourceFormat: "dash" }],
        ["  ", { status: "missing", value: null, sourceFormat: "blank" }],
        ["broken", { status: "invalid", value: null, sourceFormat: "malformed" }],
        ["-1%", { status: "invalid", value: null, sourceFormat: "malformed" }],
        ["NaN", { status: "invalid", value: null, sourceFormat: "malformed" }],
        ["Infinity", { status: "invalid", value: null, sourceFormat: "malformed" }]
    ];
    for (const [input, expected] of cases) assert.deepEqual(Iv.parsePercent(input), expected);
});

test("CALL cell 5 and PUT cell 11 only become independent records", () => {
    const parsed = Iv.parseQriOptionIvPage(page(row(
        "40,000", "31.25%", "29.75%", "88%<br>87%", "86%<br>85%"
    )), URL);
    assert.deepEqual(parsed.records, [
        { optionType: "call", strike: 40000,
            iv: { status: "available", value: 31.25, sourceFormat: "percent_sign" } },
        { optionType: "put", strike: 40000,
            iv: { status: "available", value: 29.75, sourceFormat: "percent_sign" } }
    ]);
    assert.equal(JSON.stringify(parsed).includes("88"), false);
    assert.equal(JSON.stringify(parsed).includes("85"), false);
    assert.equal("available" in parsed.records[0], false);
});

test("missing and malformed cells remain distinct canonical facts", () => {
    const parsed = Iv.parseQriOptionIvPage(page(
        row("40,000", "-", "broken") + row("40,500", "", "0%")
    ), URL);
    assert.deepEqual(parsed.records.map(record => record.iv), [
        { status: "missing", value: null, sourceFormat: "dash" },
        { status: "invalid", value: null, sourceFormat: "malformed" },
        { status: "missing", value: null, sourceFormat: "blank" },
        { status: "available", value: 0, sourceFormat: "percent_sign" }
    ]);
    assert.equal(Iv.validateCanonical(parsed), true);
});

test("canonical v1 retains exact metadata and excludes fetchedAt", () => {
    const parsed = Iv.parseQriOptionIvPage(page(), `${URL}?ignored=1#fragment`);
    assert.deepEqual({ parserVersion: parsed.parserVersion, schemaVersion: parsed.schemaVersion,
        source: parsed.source, sourceUrl: parsed.sourceUrl, valueUnit: parsed.valueUnit,
        contract: parsed.contract, tradingDate: parsed.tradingDate,
        pageUpdatedAt: parsed.pageUpdatedAt, lastTradingDate: parsed.lastTradingDate }, {
        parserVersion: 1, schemaVersion: 1, source: "qri-nikkei225-option-iv",
        sourceUrl: URL, valueUnit: "percent_points", contract: "2026-09",
        tradingDate: "2026-08-24", pageUpdatedAt: "2026-08-23T06:00:00+09:00",
        lastTradingDate: "2026-09-10"
    });
    assert.equal("fetchedAt" in parsed, false);
});

test("validator rejects structure corruption, duplicates and inconsistent IV state", () => {
    const canonical = Iv.parseQriOptionIvPage(page(), URL);
    const invalid = [];
    for (const [key, value] of [["parserVersion", 2], ["schemaVersion", 2],
        ["source", "other"], ["sourceUrl", "https://example.com/"],
        ["valueUnit", "ratio"], ["contract", "2026-13"],
        ["tradingDate", "bad"], ["pageUpdatedAt", "bad"]]) {
        const changed = structuredClone(canonical); changed[key] = value; invalid.push(changed);
    }
    const duplicate = structuredClone(canonical); duplicate.records.push(duplicate.records[0]);
    invalid.push(duplicate);
    for (const value of [NaN, Infinity, -1]) {
        const changed = structuredClone(canonical); changed.records[0].iv.value = value;
        invalid.push(changed);
    }
    const missingWithValue = structuredClone(canonical);
    missingWithValue.records[0].iv = { status: "missing", value: 1, sourceFormat: "dash" };
    invalid.push(missingWithValue);
    const mismatchedStrikes = structuredClone(canonical);
    mismatchedStrikes.records[1].strike = 40500; invalid.push(mismatchedStrikes);
    for (const changed of invalid) assert.equal(Iv.validateCanonical(changed), false);
});

test("saved fixtures retain every real strike and matching CALL/PUT sets", () => {
    for (const file of ["sample2026_07_23-2.html", "sample2026_07_21.html"]) {
        const html = fs.readFileSync(path.join(__dirname, "../data", file), "utf8");
        const parsed = Iv.parseQriOptionIvPage(html, URL);
        const calls = parsed.records.filter(record => record.optionType === "call");
        const puts = parsed.records.filter(record => record.optionType === "put");
        const expected = file.includes("07_23") ? 248 : 270;
        assert.equal(calls.length, expected); assert.equal(puts.length, expected);
        assert.deepEqual(calls.map(record => record.strike), puts.map(record => record.strike));
        assert.equal(new Set(calls.map(record => record.strike)).size, expected);
        assert.equal(calls.some(record => record.strike % 500 !== 0), true);
        assert.equal(parsed.records.some(record => record.iv.status === "invalid"), false);
    }
});

test("fixture known IV and missing values match QRI single columns", () => {
    const html = fs.readFileSync(path.join(__dirname,
        "../data/sample2026_07_23-2.html"), "utf8");
    const parsed = Iv.parseQriOptionIvPage(html, URL);
    const find = (optionType, strike) => parsed.records.find(record =>
        record.optionType === optionType && record.strike === strike).iv;
    assert.deepEqual(find("call", 100000),
        { status: "available", value: 33.12, sourceFormat: "percent_sign" });
    assert.deepEqual(find("put", 100000),
        { status: "missing", value: null, sourceFormat: "dash" });
    assert.deepEqual(find("put", 35000),
        { status: "available", value: 74.61, sourceFormat: "percent_sign" });
});

test("signature is order-independent and reacts to IV semantic changes only", async () => {
    const canonical = Iv.parseQriOptionIvPage(page(
        row("40,000", "30%", "31%") + row("40,500", "32%", "-")
    ), URL);
    const reordered = structuredClone(canonical); reordered.records.reverse();
    assert.equal(await Iv.createSignature(canonical), await Iv.createSignature(reordered));
    for (const mutate of [
        value => { value.records[0].iv.value = 30.1; },
        value => { value.records[3].iv = { status: "invalid", value: null,
            sourceFormat: "malformed" }; },
        value => { value.records[0].iv.sourceFormat = "plain_number"; }
    ]) {
        const changed = structuredClone(canonical); mutate(changed);
        assert.notEqual(await Iv.createSignature(canonical), await Iv.createSignature(changed));
    }
    const withFetchedAt = { ...structuredClone(canonical), fetchedAt: "2026-08-23T06:01:00Z" };
    assert.equal(await Iv.createSignature(canonical), await Iv.createSignature(withFetchedAt));
});

test("versionKey is stable and IV-only change produces a new key", async () => {
    const canonical = Iv.parseQriOptionIvPage(page(), URL);
    const key = await Iv.createVersionKey(canonical);
    assert.match(key, /^qri-option-iv-v1\|2026-09\|2026-08-23T06:00:00\+09:00\|sha256:[0-9a-f]{64}$/);
    assert.equal(key, await Iv.createVersionKey(structuredClone(canonical)));
    const changed = structuredClone(canonical); changed.records[0].iv.value += 0.01;
    assert.notEqual(key, await Iv.createVersionKey(changed));
});

test("existing QRI v2 canonical and signature remain unchanged by IV parsing", async () => {
    const html = fs.readFileSync(path.join(__dirname,
        "../data/sample2026_07_23-2.html"), "utf8");
    const fixtureUrl = "https://svc.qri.jp/jpx/nkopm/1";
    const v2 = QriV2.parseQriOptionsPage(html, fixtureUrl);
    const before = await QriV2.createSignature(v2);
    Iv.parseQriOptionIvPage(html, fixtureUrl);
    assert.equal(QriV2.PARSER_VERSION, 2);
    assert.equal(QriV2.SCHEMA_VERSION, 2);
    assert.equal(await QriV2.createSignature(v2), before);
    assert.equal(QriV2.validateCanonical(v2, { allowUnresolvedContracts: true }), true);
});

test("module stays pure and disconnected from storage, fetch, history, UI and OverallV2", () => {
    const moduleSource = fs.readFileSync(path.join(__dirname, "../js/qriOptionIv.js"), "utf8");
    const indexSource = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.doesNotMatch(moduleSource, /localStorage|indexedDB|fetch\s*\(|ipcRenderer|Chart\s*\(/);
    assert.doesNotMatch(moduleSource, /OverallV2|HistoryStore|commitHistory|persist/i);
    assert.equal(indexSource.includes('<script src="js/qriOptionIv.js"></script>'), true);
    assert.doesNotMatch(indexSource, /new\s+Chart\([^)]*qriIv|id=["']qriIv/i);
});
