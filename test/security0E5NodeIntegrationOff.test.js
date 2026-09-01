"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const mainSource = read("main.js");
const preloadSource = read("preload.js");
const html = read("index.html");
const packageJson = JSON.parse(read("package.json"));
const scriptSources = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(match => match[1]);
const productionSources = ["index.html", ...scriptSources
    .filter(file => file.startsWith("js/") && !file.startsWith("js/vendor/"))];

function mainWindowBlock() {
    const start = mainSource.indexOf("function createWindow()");
    const end = mainSource.indexOf("app.whenReady()", start);
    assert.ok(start >= 0 && end > start);
    return mainSource.slice(start, end);
}

function hiddenWindowBlocks() {
    const qri = mainSource.indexOf('ipcMain.handle("fetch-option-page"');
    const jpx = mainSource.indexOf('ipcMain.handle("fetch-daytrading-page"');
    const excel = mainSource.indexOf('ipcMain.handle("download-daytrading-excel"');
    return [mainSource.slice(qri, jpx), mainSource.slice(jpx, excel)];
}

function browserModule(file, dependencies = {}) {
    const browser = {
        crypto: crypto.webcrypto,
        TextEncoder,
        TextDecoder,
        console,
        ...dependencies
    };
    browser.window = browser;
    browser.globalThis = browser;
    vm.createContext(browser);
    vm.runInContext(read(file), browser, { filename: file });
    return browser;
}

test("main renderer is Node OFF with isolation and the packaged narrow preload", () => {
    const block = mainWindowBlock();
    assert.match(block, /nodeIntegration:\s*false/);
    assert.match(block, /contextIsolation:\s*true/);
    assert.match(block, /preload:\s*path\.join\(__dirname, "preload\.js"\)/);
    assert.doesNotMatch(block, /nodeIntegration:\s*true|contextIsolation:\s*false/);
    assert.equal(packageJson.build.files.includes("preload.js"), true);
});

test("main world production has no raw Electron, XLSX require, or historical direct require", () => {
    for (const file of productionSources) {
        const source = read(file);
        assert.doesNotMatch(source, /require\(["']electron["']\)|\bipcRenderer\b/, file);
        assert.doesNotMatch(source, /require\(["']xlsx["']\)/, file);
        assert.doesNotMatch(source,
            /require\(["'][^"']*qriOptionsHistorical(?:ViewModel|Aggregation)\.js["']\)/,
            file);
    }
});

test("preload keeps Electron authority and the exact immutable five-method surface", () => {
    let exposed;
    const calls = [];
    const sandbox = {
        require(id) {
            assert.equal(id, "electron");
            return {
                contextBridge: { exposeInMainWorld: (key, api) => { exposed = { key, api }; } },
                ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(args); } }
            };
        },
        Promise,
        Object
    };
    vm.runInNewContext(preloadSource, sandbox, { filename: "preload.js" });
    assert.equal(exposed.key, "optionMapBridge");
    assert.deepEqual(Object.keys(exposed.api).sort(), [
        "downloadJpxExcel", "fetchJpxPage", "fetchOpenInterestListing",
        "fetchParticipantListing", "fetchQriOptionPage"
    ]);
    assert.equal(Object.isFrozen(exposed.api), true);
    assert.equal(calls.length, 0);
});

test("browser main world exposes Web Crypto while Node globals remain absent", () => {
    const browser = browserModule("js/weeklyOptions.js");
    for (const name of ["require", "module", "exports", "process", "Buffer", "__dirname"]) {
        assert.equal(name in browser, false, name);
    }
    assert.equal(typeof browser.crypto, "object");
    assert.equal(typeof browser.crypto.subtle.digest, "function");
    assert.equal(typeof browser.TextEncoder, "function");
    assert.equal(typeof browser.OptionMapWeeklyOptions.createSignature, "function");
});

test("browser UMD branches load core QRI, Weekly, Participant, Morning and Formal modules", () => {
    const definitions = [
        ["js/qriOptions.js", "OptionMapQriOptions"],
        ["js/weeklyOptions.js", "OptionMapWeeklyOptions"],
        ["js/participantData.js", "OptionMapParticipantData"],
        ["js/morningBaselineV4.js", "OptionMapMorningBaselineV4"],
        ["js/formalOptionAvailabilityEvidence.js", "OptionMapFormalOptionAvailabilityEvidence"],
        ["js/overallJudgmentV2.js", "OptionMapOverallJudgmentV2"],
        ["js/qriFormalIdentityRuntime.js", "OptionMapQriFormalIdentityRuntime"],
        ["js/weeklyFormalIdentityRuntime.js", "OptionMapWeeklyFormalIdentityRuntime"],
        ["js/overallV2FormalEnvelopeRuntime.js", "OptionMapOverallV2FormalEnvelopeRuntime"],
        ["js/currentPriceLastValidCache.js", "OptionMapCurrentPriceLastValidCache"],
        ["js/qriOptionsHistoricalViewModel.js", "OptionMapQriOptionsHistoricalViewModel"],
        ["js/qriOptionsHistoricalAggregation.js", "OptionMapQriOptionsHistoricalAggregation"]
    ];
    for (const [file, namespace] of definitions) {
        const browser = browserModule(file);
        assert.equal(typeof browser[namespace], "object", `${file}: ${namespace}`);
        assert.equal(Object.isFrozen(browser[namespace]), true, file);
        assert.equal("module" in browser, false, file);
        assert.equal("require" in browser, false, file);
    }
    const broker = browserModule("js/weeklyBrokerConfig.js");
    const weekly = browserModule("js/weeklyFutures.js", {
        OptionMapWeeklyBrokerConfig: broker.OptionMapWeeklyBrokerConfig
    });
    assert.equal(typeof weekly.OptionMapWeeklyFutures.createSignature, "function");
    const qri = browserModule("js/qriOptions.js");
    const qriLastValid = browserModule("js/qriOptionsLastValidCache.js", {
        OptionMapQriOptions: qri.OptionMapQriOptions
    });
    assert.equal(typeof qriLastValid.OptionMapQriOptionsLastValidCache, "object");
});

test("Web Crypto SHA-256 is byte-identical to Node for canonical edge fixtures", async () => {
    const fixtures = [
        "ASCII",
        "日本語",
        null,
        ["日本語", null, 3],
        { z: [1, null], a: { nested: "値" } },
        { a: 1, b: 2 }
    ];
    for (const value of fixtures) {
        const serialized = typeof value === "string" ? value : JSON.stringify(value);
        const expected = crypto.createHash("sha256").update(serialized).digest("hex");
        const digest = await crypto.webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
        const actual = Buffer.from(digest).toString("hex");
        assert.equal(actual, expected, serialized);
    }
    const ordered = JSON.stringify({ a: 1, b: 2 });
    assert.notEqual(ordered, JSON.stringify({ b: 2, a: 1 }));
});

test("XLSX and Chart remain local browser globals at pinned versions; adapter is valid-global no-op", () => {
    const xlsx = browserModule("js/vendor/xlsx.full.min.js", {
        setTimeout, clearTimeout
    });
    const before = xlsx.XLSX;
    vm.runInContext(read("js/vendor/xlsx.browser-global.js"), xlsx,
        { filename: "js/vendor/xlsx.browser-global.js" });
    assert.equal(xlsx.XLSX, before);
    assert.equal(xlsx.XLSX.version, "0.20.3");
    assert.equal(typeof xlsx.XLSX.read, "function");
    assert.match(read("js/vendor/chart.umd.js"), /v4\.5\.1/);
    assert.match(html, /src="js\/vendor\/chart\.umd\.js"/);
    assert.match(html, /src="js\/vendor\/xlsx\.full\.min\.js"/);
});

test("storage identity, bootstrap ordering, offline assets and scheduling remain unchanged", () => {
    const main = mainWindowBlock();
    assert.match(main, /mainWindow\.loadFile\("index\.html"\)/);
    assert.doesNotMatch(main, /partition:|session:|setPath\(|userData/);
    assert.equal(scriptSources.every(source => !/^https?:\/\//.test(source)), true);
    assert.equal((html.match(/<script[^>]+src=["']https?:\/\//g) || []).length, 0);
    const bridge = html.indexOf("const optionMapBridge = window.optionMapBridge");
    const xlsx = html.indexOf("const XLSX = window.XLSX", bridge);
    const history = html.indexOf("const qriHistoricalViewModelApi =", xlsx);
    const schedule = html.indexOf("refreshAllMarketData()", history);
    assert.ok(bridge >= 0 && xlsx > bridge && history > xlsx && schedule > history);
    assert.match(html, /localStorage/);
    assert.match(html, /indexedDB|OptionMap/);
});

test("hidden windows and Security 0C/0D remain isolated and fail-closed", () => {
    for (const block of hiddenWindowBlocks()) {
        assert.match(block, /nodeIntegration:\s*false/);
        assert.match(block, /contextIsolation:\s*true/);
        assert.doesNotMatch(block, /preload:/);
    }
    assert.equal((mainSource.match(/requestSingleInstanceLock\(\)/g) || []).length, 1);
    assert.match(mainSource, /second-instance/);
    assert.match(mainSource, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
    assert.match(mainSource, /redirect:\s*"error"/);
    assert.match(mainSource, /requireAllowedUrl/);
    assert.doesNotMatch(preloadSource, /\bfetch\s*\(|localStorage|sessionStorage|indexedDB/);
});

test("contract suite itself performs no fetch or storage mutation", () => {
    const source = read("test/security0E5NodeIntegrationOff.test.js");
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /(?:localStorage|sessionStorage)\.setItem\s*\(/);
    assert.doesNotMatch(source, /indexedDB\.(?:open|deleteDatabase)\s*\(/);
});
