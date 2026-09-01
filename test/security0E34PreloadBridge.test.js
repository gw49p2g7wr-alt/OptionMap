const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const preloadSource = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const expectedKeys = [
  "downloadJpxExcel",
  "fetchJpxPage",
  "fetchOpenInterestListing",
  "fetchParticipantListing",
  "fetchQriOptionPage"
];
const mapping = {
  fetchQriOptionPage: "fetch-option-page",
  fetchJpxPage: "fetch-daytrading-page",
  fetchOpenInterestListing: "fetch-jpx-open-interest-json",
  fetchParticipantListing: "fetch-jpx-participant-json",
  downloadJpxExcel: "download-daytrading-excel"
};

function mainWindowBlock() {
  const start = mainSource.indexOf("function createWindow()");
  const end = mainSource.indexOf("app.whenReady()", start);
  assert.ok(start >= 0 && end > start);
  return mainSource.slice(start, end);
}

function hiddenWindowBlocks() {
  const qriStart = mainSource.indexOf('ipcMain.handle("fetch-option-page"');
  const jpxStart = mainSource.indexOf('ipcMain.handle("fetch-daytrading-page"');
  const excelStart = mainSource.indexOf('ipcMain.handle("download-daytrading-excel"');
  return [mainSource.slice(qriStart, jpxStart), mainSource.slice(jpxStart, excelStart)];
}

function loadPreload(invokeImplementation = async (channel, url) => ({ channel, url })) {
  let publication = null;
  const calls = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld(key, api) {
        publication = { key, api };
      }
    },
    ipcRenderer: {
      invoke(channel, url) {
        calls.push([channel, url]);
        return invokeImplementation(channel, url);
      }
    }
  };
  const context = vm.createContext({
    require(id) {
      assert.equal(id, "electron");
      return electron;
    },
    Promise,
    Object
  });
  vm.runInContext(preloadSource, context, { filename: "preload.js" });
  assert.ok(publication);
  return { ...publication, calls };
}

test("main window enables context isolation with Node OFF and an absolute root preload", () => {
  const main = mainWindowBlock();
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /preload:\s*path\.join\(__dirname, "preload\.js"\)/);
  assert.doesNotMatch(main, /contextIsolation:\s*false|nodeIntegration:\s*true/);
  assert.equal(packageJson.build.files.includes("preload.js"), true);
});

test("preload publishes only the exact five-method narrow bridge", () => {
  const { key, api } = loadPreload();
  assert.equal(key, "optionMapBridge");
  assert.deepEqual(Object.keys(api).sort(), expectedKeys);
  assert.equal(Object.values(api).every(value => typeof value === "function"), true);
  assert.equal(Object.isFrozen(api), true);
  assert.doesNotMatch(preloadSource, /exposeInMainWorld\([^)]*(ipcRenderer|process|require)/s);
  assert.doesNotMatch(preloadSource, /generic|invoke:\s|channel\s*=>/);
});

test("each public method maps one unchanged URL to its fixed IPC channel", async () => {
  const response = Object.freeze({ success: true, data: Object.freeze([1, 2, 3]) });
  const failure = Object.freeze({ success: false, error: "safe", errorCode: "invalid_url" });
  const { api, calls } = loadPreload(async channel =>
    channel === "download-daytrading-excel" ? response : failure);
  for (const method of expectedKeys) {
    const url = ` https://example.invalid/${method} `;
    const result = await api[method](url);
    assert.deepEqual(calls.at(-1), [mapping[method], url]);
    assert.equal(result, method === "downloadJpxExcel" ? response : failure);
  }
  assert.deepEqual(await api.downloadJpxExcel("https://example.invalid/file.xlsx"), response);
  assert.equal(Array.isArray(response.data), true);
});

test("all bridge methods reject invalid argument shape without invoking IPC", async () => {
  const { api, calls } = loadPreload();
  const invalidCalls = [[], ["one", "two"], [null], [42], [""], [" \n\t "], ["x".repeat(4097)]];
  for (const method of expectedKeys) {
    for (const args of invalidCalls) {
      const result = await api[method](...args);
      assert.deepEqual(JSON.parse(JSON.stringify(result)), {
        success: false,
        error: "リクエスト引数が不正です",
        errorCode: "invalid_argument"
      });
    }
  }
  assert.equal(calls.length, 0);
  await api.fetchQriOptionPage("x".repeat(4096));
  assert.equal(calls.length, 1);
});

test("renderer fail-fast validates exact bridge before XLSX and startup work", () => {
  const bridge = html.indexOf("const optionMapBridge = window.optionMapBridge");
  const failure = html.indexOf("OptionMap preload bridge unavailable");
  const xlsx = html.indexOf("const XLSX = window.XLSX", bridge);
  const cache = html.indexOf("initializeWeeklyCaches()", bridge);
  const refresh = html.indexOf("refreshAllMarketData()", bridge);
  assert.ok(bridge >= 0 && failure > bridge && xlsx > failure);
  assert.ok(cache > xlsx && refresh > xlsx);
  assert.match(html.slice(bridge, xlsx), /Object\.keys\(optionMapBridge\)\.sort\(\)/);
  assert.match(html.slice(bridge, xlsx), /typeof optionMapBridge\[key\] !== "function"/);
});

test("all 19 renderer callsites use the narrow bridge with no raw Electron access", () => {
  const calls = html.match(/optionMapBridge\.(?:fetchQriOptionPage|fetchJpxPage|fetchOpenInterestListing|fetchParticipantListing|downloadJpxExcel)\(/g) || [];
  assert.equal(calls.length, 19);
  assert.equal((html.match(/optionMapBridge\.fetchQriOptionPage\(/g) || []).length, 4);
  assert.equal((html.match(/optionMapBridge\.fetchJpxPage\(/g) || []).length, 2);
  assert.equal((html.match(/optionMapBridge\.fetchOpenInterestListing\(/g) || []).length, 3);
  assert.equal((html.match(/optionMapBridge\.fetchParticipantListing\(/g) || []).length, 1);
  assert.equal((html.match(/optionMapBridge\.downloadJpxExcel\(/g) || []).length, 9);
  assert.doesNotMatch(html, /require\(["']electron["']\)|ipcRenderer/);
});

test("UMD, XLSX, Web Crypto and storage identity contracts remain browser-visible", () => {
  assert.match(html, /src="js\/vendor\/xlsx\.full\.min\.js"/);
  assert.match(html, /src="js\/vendor\/xlsx\.browser-global\.js"/);
  assert.match(html, /XLSX\.read/);
  assert.match(html, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(html, /new TextEncoder\(\)/);
  assert.match(html, /window\.OptionMap/);
  const main = mainWindowBlock();
  assert.match(main, /mainWindow\.loadFile\("index\.html"\)/);
  assert.doesNotMatch(main, /partition:|session:|setPath\(|userData/);
});

test("hidden windows and Security 0C/0D remain independent of the main preload", () => {
  for (const block of hiddenWindowBlocks()) {
    assert.match(block, /nodeIntegration:\s*false/);
    assert.match(block, /contextIsolation:\s*true/);
    assert.doesNotMatch(block, /preload:/);
  }
  assert.equal((mainSource.match(/requestSingleInstanceLock\(\)/g) || []).length, 1);
  assert.match(mainSource, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(mainSource, /redirect:\s*"error"/);
  assert.match(mainSource, /requireAllowedUrl/);
  assert.doesNotMatch(preloadSource, /\bfetch\s*\(|localStorage|sessionStorage|indexedDB|validate[A-Z].*Url/);
});
