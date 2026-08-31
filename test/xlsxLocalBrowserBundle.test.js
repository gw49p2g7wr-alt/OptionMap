const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const NodeXlsx = require("xlsx");
const weeklyFutures = require("../js/weeklyFutures.js");
const weeklyOptions = require("../js/weeklyOptions.js");
const participant = require("../js/participantData.js");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const installedAssetPath = path.join(root, "node_modules/xlsx/dist/xlsx.full.min.js");
const installedLicensePath = path.join(root, "node_modules/xlsx/LICENSE");
const localAssetPath = path.join(root, "js/vendor/xlsx.full.min.js");
const localLicensePath = path.join(root, "js/vendor/xlsx.LICENSE");
const localSource = fs.readFileSync(localAssetPath, "utf8");
const adapterPath = path.join(root, "js/vendor/xlsx.browser-global.js");
const adapterSource = fs.readFileSync(adapterPath, "utf8");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function loadBrowserXlsx({ hybrid = false } = {}) {
    const browser = { console, setTimeout, clearTimeout };
    browser.window = browser;
    browser.self = browser;
    browser.globalThis = browser;
    if (hybrid) {
        browser.module = { exports: {} };
        browser.exports = browser.module.exports;
        browser.require = require;
    }
    vm.createContext(browser);
    vm.runInContext(localSource, browser, { filename: "xlsx.full.min.js" });
    vm.runInContext(adapterSource, browser, { filename: "xlsx.browser-global.js" });
    return { api: browser.XLSX, browser };
}

function browserInput(browser, values, kind) {
    const bytes = ArrayBuffer.isView(values)
        ? new Uint8Array(values.buffer, values.byteOffset, values.byteLength)
        : new Uint8Array(values);
    browser.fixtureValues = Array.from(bytes);
    if (kind === "array") return vm.runInContext("Array.from(fixtureValues)", browser);
    if (kind === "uint8") return vm.runInContext("new Uint8Array(fixtureValues)", browser);
    return vm.runInContext("new Uint8Array(fixtureValues).buffer", browser);
}

function weeklyOptionsRows() {
    const rows = Array.from({ length: 84 }, () => Array(18).fill(null));
    rows[0][0] = weeklyOptions.SOURCE_TITLE;
    rows[1][0] = "（ 2026年08月07日現在 ）";
    rows[2][0] = "2026年08月10日";
    rows[6][1] = "プット（2026年08月限月）";
    rows[6][11] = "コール（2026年08月限月）";
    [10, 25, 40, 55, 70].forEach((start, block) => {
        const strike = 65375 + block * 125;
        rows[start - 1][1] = strike;
        rows[start - 1][11] = strike;
        for (let rank = 0; rank < 15; rank += 1) {
            rows[start - 1 + rank][0] = rank + 1;
            rows[start - 1 + rank][10] = rank + 1;
        }
    });
    rows[24][2] = "12479";
    rows[24][3] = "ＡＢＮクリアリン証券";
    rows[24][4] = 392;
    rows[24][5] = "12800";
    rows[24][6] = "モルガンＭＵＦＧ証券";
    rows[24][7] = 794;
    rows[24][12] = "12800";
    rows[24][13] = "モルガンＭＵＦＧ証券";
    rows[24][14] = 278;
    rows[24][15] = "11746";
    rows[24][16] = "ＵＢＳ証券";
    rows[24][17] = 250;
    return rows;
}

const futuresRows = [
    ["＜日経225先物＞"],
    ["1", "2026年09月限月", "12724", "ＨＳＢＣ証券", 33597,
        "12400", "野村証券", 33492]
];
const participantRows = [
    ["手口上位一覧"],
    [null, "取引日 Trading Date :", "20260814"],
    ["NK225F", "161090018", "NK225F CONTRACT", 1, "00123",
        "テスト証券", "Test Securities", 456]
];

function buildFixtureBytes() {
    const workbook = NodeXlsx.utils.book_new();
    const generic = NodeXlsx.utils.aoa_to_sheet([
        ["heading", "文字列", "空セル", "日付", "数値", "式"],
        ["A2 marker", "日本語", null, new Date("2026-08-14T00:00:00Z"), 42, null],
        ["A3 marker"]
    ], { cellDates: true });
    generic.F2 = { t: "n", f: "SUM(E2:E2)", v: 42 };
    generic["!ref"] = "A1:F3";
    NodeXlsx.utils.book_append_sheet(workbook, generic, "Generic");
    NodeXlsx.utils.book_append_sheet(workbook,
        NodeXlsx.utils.aoa_to_sheet(futuresRows), "WeeklyFutures");
    NodeXlsx.utils.book_append_sheet(workbook,
        NodeXlsx.utils.aoa_to_sheet(weeklyOptionsRows()), "WeeklyOptions");
    NodeXlsx.utils.book_append_sheet(workbook,
        NodeXlsx.utils.aoa_to_sheet(participantRows), "Participant");
    return NodeXlsx.write(workbook, { type: "array", bookType: "xlsx", cellDates: true });
}

function parseWorkbook(api, input) {
    return api.read(input, { type: "array" });
}

function rows(api, workbook, name) {
    return api.utils.sheet_to_json(workbook.Sheets[name], { header: 1 });
}

test("XLSX 0.20.3 browser assetとApache licenseをinstalled packageからexact固定", () => {
    assert.equal(packageJson.dependencies.xlsx,
        "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz");
    assert.equal(packageLock.packages["node_modules/xlsx"].version, "0.20.3");
    assert.equal(fs.statSync(localAssetPath).isFile(), true);
    assert.equal(fs.statSync(localLicensePath).isFile(), true);
    assert.equal(hash(fs.readFileSync(localAssetPath)),
        hash(fs.readFileSync(installedAssetPath)));
    assert.equal(hash(fs.readFileSync(localLicensePath)),
        hash(fs.readFileSync(installedLicensePath)));
    assert.match(fs.readFileSync(localLicensePath, "utf8"), /Apache License/);
});

test("local bundleはwindow.XLSX 0.20.3と必要APIを公開", () => {
    const { api: xlsx } = loadBrowserXlsx();
    assert.equal(xlsx.version, "0.20.3");
    assert.equal(typeof xlsx.read, "function");
    assert.equal(typeof xlsx.utils.sheet_to_json, "function");
});

test("pure-browser・Electron hybrid・将来Node OFFで同じwindow.XLSX authorityが成立", () => {
    for (const condition of [
        { name: "pure-browser", hybrid: false },
        { name: "electron-hybrid", hybrid: true },
        { name: "future-node-off", hybrid: false }
    ]) {
        const { api, browser } = loadBrowserXlsx({ hybrid: condition.hybrid });
        assert.equal(browser.window.XLSX, api, condition.name);
        assert.equal(api?.version, "0.20.3", condition.name);
        assert.equal(typeof api?.read, "function", condition.name);
        assert.equal(typeof api?.utils?.sheet_to_json, "function", condition.name);
        if (condition.hybrid) assert.equal(browser.module.exports, api, condition.name);
        else {
            assert.equal("module" in browser, false, condition.name);
            assert.equal("require" in browser, false, condition.name);
        }
    }
});

test("Node版とbrowser版でworkbook・cells・formula cached valueが一致", () => {
    const { api: browserXlsx, browser } = loadBrowserXlsx();
    const bytes = buildFixtureBytes();
    const nodeBook = parseWorkbook(NodeXlsx, bytes);
    const browserBook = parseWorkbook(browserXlsx, browserInput(browser, bytes, "array"));
    assert.deepEqual(Array.from(browserBook.SheetNames), nodeBook.SheetNames);
    assert.deepEqual(Object.keys(browserBook.Sheets), Object.keys(nodeBook.Sheets));
    const nodeSheet = nodeBook.Sheets.Generic;
    const browserSheet = browserBook.Sheets.Generic;
    for (const address of ["A2", "A3", "B2", "C2", "D2", "E2", "F2"]) {
        assert.deepEqual(plain(browserSheet[address]), plain(nodeSheet[address]), address);
    }
    assert.equal(nodeSheet.A2.v, "A2 marker");
    assert.equal(nodeSheet.A3.v, "A3 marker");
    assert.equal(nodeSheet.B2.v, "日本語");
    assert.equal(nodeSheet.C2, undefined);
    assert.equal(typeof nodeSheet.D2.v, "number");
    assert.equal(nodeSheet.E2.v, 42);
    assert.equal(nodeSheet.F2.f, "SUM(E2:E2)");
    assert.equal(nodeSheet.F2.v, 42);
    assert.deepEqual(plain(rows(browserXlsx, browserBook, "Generic")),
        plain(rows(NodeXlsx, nodeBook, "Generic")));
});

test("Array<number>・Uint8Array・ArrayBuffer入力がbrowser版で同一", () => {
    const { api: browserXlsx, browser } = loadBrowserXlsx();
    const bytes = new Uint8Array(buildFixtureBytes());
    const inputs = [browserInput(browser, bytes, "array"),
        browserInput(browser, bytes, "uint8"), browserInput(browser, bytes, "arraybuffer")];
    const parsed = inputs.map(input => parseWorkbook(browserXlsx, input));
    for (const workbook of parsed) {
        assert.deepEqual(Array.from(workbook.SheetNames), Array.from(parsed[0].SheetNames));
        assert.deepEqual(plain(rows(browserXlsx, workbook, "Generic")),
            plain(rows(browserXlsx, parsed[0], "Generic")));
    }
});

test("Weekly Futures・Options・Participant canonical parser結果がNode版とbrowser版で一致", () => {
    const { api: browserXlsx, browser } = loadBrowserXlsx();
    const bytes = buildFixtureBytes();
    const nodeBook = parseWorkbook(NodeXlsx, bytes);
    const browserBook = parseWorkbook(browserXlsx, browserInput(browser, bytes, "array"));
    const pairs = [
        [weeklyFutures.parseWeeklyFuturesRows, "WeeklyFutures"],
        [weeklyOptions.parseWeeklyOptionsRows, "WeeklyOptions"],
        [value => participant.parseParticipantExcel(value, "2026-08-14"), "Participant"]
    ];
    for (const [parser, sheetName] of pairs) {
        assert.deepEqual(parser(rows(browserXlsx, browserBook, sheetName)),
            parser(rows(NodeXlsx, nodeBook, sheetName)), sheetName);
    }
});

test("rendererはChart直後にlocal XLSXを読みproduction requireとremote fallbackを持たない", () => {
    const sources = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
        .map(match => match[1]);
    const chartIndex = sources.indexOf("js/vendor/chart.umd.js");
    const xlsxIndex = sources.indexOf("js/vendor/xlsx.full.min.js");
    const adapterIndex = sources.indexOf("js/vendor/xlsx.browser-global.js");
    assert.equal(xlsxIndex, chartIndex + 1);
    assert.equal(adapterIndex, xlsxIndex + 1);
    assert.ok(html.indexOf('src="js/vendor/xlsx.full.min.js"') <
        html.indexOf('src="js/vendor/xlsx.browser-global.js"'));
    assert.ok(html.indexOf('src="js/vendor/xlsx.browser-global.js"') <
        html.indexOf("const XLSX = window.XLSX"));
    assert.match(html, /const XLSX = window\.XLSX;/);
    assert.match(html, /Local XLSX browser bundle is unavailable/);
    assert.doesNotMatch(html, /require\(["']xlsx["']\)/);
    assert.equal(sources.some(source => /^https?:\/\//i.test(source)), false);
    for (const source of sources) {
        assert.equal(fs.existsSync(path.join(root, source)), true,
            `offline script is missing: ${source}`);
    }
});

test("Electron hybrid bootstrapはXLSX guardを通過しstartup refresh schedulingへ到達可能", () => {
    const { api } = loadBrowserXlsx({ hybrid: true });
    assert.doesNotThrow(() => {
        const XLSX = api;
        if (!XLSX || typeof XLSX.read !== "function" ||
            typeof XLSX.utils?.sheet_to_json !== "function") {
            throw new Error("Local XLSX browser bundle is unavailable");
        }
    });
    const guardAt = html.indexOf("const XLSX = window.XLSX");
    const bootstrapAt = html.indexOf("Promise.all([", guardAt);
    const startupRefreshAt = html.indexOf(".finally(() => refreshAllMarketData());", bootstrapAt);
    assert.ok(guardAt >= 0);
    assert.ok(bootstrapAt > guardAt);
    assert.ok(startupRefreshAt > bootstrapAt);
});

test("XLSX read・sheet selection・sheet_to_json production semanticsを維持", () => {
    assert.equal((html.match(/XLSX\.read\([^\n]+\{ type: "array" \}\)/g) || []).length, 7);
    assert.equal((html.match(/workbook\.Sheets\[workbook\.SheetNames\[0\]\]/g) || []).length, 7);
    assert.equal((html.match(/XLSX\.utils\.sheet_to_json\(sheet, \{ header: 1 \}\)/g) || []).length, 7);
    assert.match(html, /sheet\?\.A2\?\.v/);
    assert.match(html, /sheet\?\.A3\?\.v/);
});

test("electron-builderのjs globがXLSX assetとlicenseをpackage対象に含む", () => {
    assert.ok(packageJson.build.files.includes("js/**/*"));
    assert.equal(path.relative(root, localAssetPath), "js/vendor/xlsx.full.min.js");
    assert.equal(path.relative(root, localLicensePath), "js/vendor/xlsx.LICENSE");
});
