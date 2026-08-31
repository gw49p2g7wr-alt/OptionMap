"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const modules = [
    {
        file: "js/qriOptionsHistoricalViewModel.js",
        namespace: "OptionMapQriOptionsHistoricalViewModel",
        required: "buildQriHistoricalViewModel"
    },
    {
        file: "js/qriOptionsHistoricalAggregation.js",
        namespace: "OptionMapQriOptionsHistoricalAggregation",
        required: "buildQriHistoricalAggregation"
    }
];

function loadBrowser(definition, hybrid = false) {
    const sandbox = hybrid
        ? { document: {}, module: { exports: { untouched: true } } }
        : {};
    vm.runInNewContext(fs.readFileSync(path.join(root, definition.file), "utf8"), sandbox,
        { filename: definition.file });
    return sandbox;
}

function snapshot(contract, value) {
    const tradingDate = "2026-08-31";
    return {
        identity: {
            contract,
            tradingDate,
            entryKey: `${contract}|${tradingDate}`,
            activeVersionKey: `version-${contract}`
        },
        facts: [{
            strike: 65000,
            call: { published: true, value },
            put: { published: true, value: value + 1 }
        }]
    };
}

function historyFixture() {
    const contract = "2026-09";
    const tradingDate = "2026-08-31";
    const versionKey = `qri-options-v2|${contract}|fixture|sha256:${"a".repeat(64)}`;
    const canonical = {
        contract,
        tradingDate,
        parserVersion: 2,
        schemaVersion: 2,
        source: "qri-nikkei225-options",
        pageUpdatedAt: "2026-08-31T16:00:00+09:00",
        sourceUrl: "https://svc.qri.jp/jpx/nkopm/",
        openInterestStatus: "available",
        records: [
            { contract, optionType: "call", strike: 65000, published: true, value: 10 },
            { contract, optionType: "put", strike: 65000, published: false, value: null }
        ]
    };
    return {
        historyVersion: 1,
        parserVersion: 2,
        schemaVersion: 2,
        source: "qri-nikkei225-options",
        signatureAlgorithm: "sha256",
        entries: [{
            contract,
            sourceDateKey: tradingDate,
            entryKey: `${contract}|${tradingDate}`,
            activeVersionKey: versionKey,
            revisions: [{
                contract,
                tradingDate,
                versionKey,
                signature: "b".repeat(64),
                signatureAlgorithm: "sha256",
                fetchedAt: "2026-08-31T07:00:00.000Z",
                confirmedAt: "2026-08-31T07:01:00.000Z",
                replacedAt: null,
                pageUpdatedAt: canonical.pageUpdatedAt,
                sourceUrl: canonical.sourceUrl,
                openInterestStatus: canonical.openInterestStatus,
                openInterestAsOf: null,
                lastTradingDate: "2026-09-10",
                canonical
            }]
        }]
    };
}

test("CommonJS API shapeを両pure moduleで維持", () => {
    for (const definition of modules) {
        const api = require(path.join(root, definition.file));
        assert.deepEqual(Object.keys(api), [definition.required]);
        assert.equal(typeof api[definition.required], "function");
        assert.equal(Object.isFrozen(api), true);
    }
});

test("pure browserはNode globalsなしで正式namespaceを公開", () => {
    for (const definition of modules) {
        const browser = loadBrowser(definition);
        assert.equal(typeof browser[definition.namespace], "object");
        assert.equal(typeof browser[definition.namespace][definition.required], "function");
        assert.equal(Object.isFrozen(browser[definition.namespace]), true);
    }
});

test("Electron hybridはmodule.exportsを選ばずbrowser namespaceをauthorityにする", () => {
    for (const definition of modules) {
        const browser = loadBrowser(definition, true);
        assert.deepEqual(browser.module.exports, { untouched: true });
        assert.equal(typeof browser[definition.namespace][definition.required], "function");
    }
});

test("view modelのCommonJS/browser API・output・identity・freezeが一致", () => {
    const definition = modules[0];
    const commonJs = require(path.join(root, definition.file));
    const browser = loadBrowser(definition)[definition.namespace];
    assert.deepEqual(Object.keys(browser), Object.keys(commonJs));
    const input = { history: historyFixture() };
    const expected = commonJs[definition.required](input);
    const actual = browser[definition.required](input);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
    assert.deepEqual(JSON.parse(JSON.stringify(actual.selection)), expected.selection);
    assert.equal(actual.status, "available");
    assert.equal(actual.reason, null);
    assert.equal(Object.isFrozen(actual), true);
    assert.equal(Object.isFrozen(actual.snapshot.facts[0].call), true);
});

test("aggregationのCommonJS/browser API・output・identity・freezeが一致", () => {
    const definition = modules[1];
    const commonJs = require(path.join(root, definition.file));
    const browser = loadBrowser(definition)[definition.namespace];
    assert.deepEqual(Object.keys(browser), Object.keys(commonJs));
    const input = { snapshots: [snapshot("2026-09", 10), snapshot("2026-10", 20)] };
    const expected = commonJs[definition.required](input);
    const actual = browser[definition.required](input);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
    assert.equal(actual.status, "available");
    assert.equal(actual.reason, null);
    assert.equal(actual.aggregationIdentity, expected.aggregationIdentity);
    assert.equal(Object.isFrozen(actual), true);
    assert.equal(Object.isFrozen(actual.points[0].call.contributions[0]), true);
});

test("indexはpure modulesからcontrollers、inline bootstrapの順でlocal load", () => {
    const viewModel = html.indexOf('<script src="js/qriOptionsHistoricalViewModel.js"></script>');
    const aggregation = html.indexOf('<script src="js/qriOptionsHistoricalAggregation.js"></script>');
    const view = html.indexOf('<script src="js/qriOptionsHistoricalView.js"></script>');
    const aggregationView = html.indexOf(
        '<script src="js/qriOptionsHistoricalAggregationView.js"></script>');
    const bootstrap = html.indexOf("const qriHistoricalViewModelApi =");
    assert.ok(viewModel >= 0 && viewModel < aggregation);
    assert.ok(aggregation < view && view < aggregationView && aggregationView < bootstrap);
});

test("productionは両namespaceをfail-fast検証しdirect requireを持たない", () => {
    assert.match(html, /window\.OptionMapQriOptionsHistoricalViewModel/);
    assert.match(html, /window\.OptionMapQriOptionsHistoricalAggregation/);
    assert.match(html, /QRI historical view model browser module is unavailable/);
    assert.match(html, /QRI historical aggregation browser module is unavailable/);
    assert.doesNotMatch(html,
        /require\(["']\.\/js\/qriOptionsHistorical(?:ViewModel|Aggregation)\.js["']\)/);
    assert.doesNotMatch(html, /require\(["']xlsx["']\)/);
});

test("UMD移行はpure modulesをfetch・storage・current/formalへ接続しない", () => {
    for (const definition of modules) {
        const source = fs.readFileSync(path.join(root, definition.file), "utf8");
        assert.doesNotMatch(source,
            /fetch\s*\(|XMLHttpRequest|indexedDB|localStorage|sessionStorage|ipcRenderer/);
        assert.doesNotMatch(source,
            /OverallV2|Morning|Formal|setItem\s*\(|persist\s*\(|save\s*\(/);
    }
});
