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
  "acquireParticipants",
  "acquireQriPage",
  "acquireWeekly",
  "checkCalendarSources",
  "evaluateMorningV5Formal",
  "evaluateOverallV2Trace",
  "finalizeQriPage",
  "getRuntimeMetadata",
  "readMorningV5Formal",
  "readOverallV2Trace",
  "requestCalendarSource",
  "saveCalendarExportJson",
  "saveFullExportJson"
];
const mapping = {
  saveCalendarExportJson: "save-calendar-export-json",
  saveFullExportJson: "save-full-export-json"
};

function mainWindowBlock() {
  const start = mainSource.indexOf("function createWindow()");
  const end = mainSource.indexOf("app.whenReady()", start);
  assert.ok(start >= 0 && end > start);
  return mainSource.slice(start, end);
}

function hiddenWindowBlocks() {
  const jpxStart = mainSource.indexOf('ipcMain.handle("fetch-daytrading-page"');
  const excelStart = mainSource.indexOf('ipcMain.handle("download-daytrading-excel"');
  return [mainSource.slice(jpxStart, excelStart)];
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
      on() {},
      send() {},
      invoke(channel, url) {
        calls.push([channel, url]);
        return invokeImplementation(channel, url);
      }
    }
  };
  const context = vm.createContext({
    require(id) {
      if (id === "electron") return electron;
      if (id.endsWith("participantFormalBridgeContract.js")) return {
        COMMAND_CHANNEL: "optionmap:participants-formal:commit",
        RESULT_CHANNEL: "optionmap:participants-formal:result"
      };
      if (id.endsWith("participantFormalProductionWriter.js")) return {
        createParticipantFormalProductionWriter() { return { commit: async () => ({}) }; }
      };
      if (id.endsWith("participantFormalArchiveSchema.js")) return {
        DATABASE_NAME: "optionMapFormalArchive"
      };
      throw new Error(`unexpected preload require: ${id}`);
    },
    Promise,
    Object
  });
  vm.runInContext(preloadSource, context, { filename: "preload.js" });
  assert.ok(publication);
  return { ...publication, calls };
}

function loadRendererBridgeVerifier() {
  const match = html.match(/function hasExactOptionMapBridge\(bridge, expectedKeys\) \{[\s\S]*?\n\}/);
  assert.ok(match, "renderer bridge verifier must remain a standalone pure function");
  return vm.runInNewContext(`(${match[0]})`, { Object, Array, Set, JSON });
}

test("main window enables context isolation with Node OFF and an absolute root preload", () => {
  const main = mainWindowBlock();
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /preload:\s*path\.join\(__dirname, "preload\.bundle\.js"\)/);
  assert.doesNotMatch(main, /contextIsolation:\s*false|nodeIntegration:\s*true/);
  assert.equal(packageJson.build.files.includes("preload.bundle.js"), true);
});

test("preload publishes only the exact thirteen-method narrow bridge", () => {
  const { key, api } = loadPreload();
  assert.equal(key, "optionMapBridge");
  assert.deepEqual(Object.keys(api).sort(), expectedKeys);
  assert.equal(Object.values(api).every(value => typeof value === "function"), true);
  assert.equal(Object.isFrozen(api), true);
  assert.doesNotMatch(preloadSource, /exposeInMainWorld\([^)]*(ipcRenderer|process|require)/s);
  assert.doesNotMatch(preloadSource, /generic|invoke:\s|channel\s*=>/);
});

test("renderer URL acquisition methods are removed from the preload surface", () => {
  const { api } = loadPreload();
  for (const method of ["fetchJpxPage", "fetchOpenInterestListing", "downloadJpxExcel"])
    assert.equal(Object.hasOwn(api, method), false);
});

test("all bridge methods reject invalid argument shape without invoking IPC", async () => {
  const { api, calls } = loadPreload();
  assert.equal(calls.length, 0);
  const exportRequest = { fileName: "OptionMap-Full-Export-2026-09-06T071500-JST.json",
    json: "{}" };
  await api.saveFullExportJson(exportRequest);
  assert.deepEqual(calls.at(-1), ["save-full-export-json", exportRequest]);
  assert.equal(calls.length, 1);
  const calendarRequest = { fileName: "OptionMap-Calendar-Export-v1-2026-10-28T071500-JST.json",
    json: "{}" };
  await api.saveCalendarExportJson(calendarRequest);
  assert.deepEqual(calls.at(-1), ["save-calendar-export-json", calendarRequest]);
  assert.equal(calls.length, 2);
  const activeQri = { requestKind: "active" };
  await api.acquireQriPage(activeQri);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["acquire-qri-page", activeQri]);
  assert.equal(calls.length, 3);
  const invalidQriCount = calls.length;
  for (const value of [null, {}, { requestKind: "active", sourceUrl: "https://example.invalid" },
    { requestKind: "listed_reference", role: "next" }])
    assert.equal((await api.acquireQriPage(value)).errorCode, "invalid_argument");
  assert.equal(calls.length, invalidQriCount);
  const finalization = { acquisitionId: `qri-acquisition-v1|sha256:${"a".repeat(64)}`,
    canonical: {}, cache: null, ivCanonical: null };
  await api.finalizeQriPage(finalization);
  assert.deepEqual(calls.at(-1), ["finalize-qri-page", finalization]);
  const invalidFinalizationCount = calls.length;
  assert.equal((await api.finalizeQriPage({ ...finalization, rawBytes: [] })).errorCode,
    "invalid_argument");
  assert.equal(calls.length, invalidFinalizationCount);
  await api.checkCalendarSources({ sourceIds: ["jp-boj-calendar", "jp-boj-calendar"] });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["check-market-calendar-sources",
    { sourceIds: ["jp-boj-calendar"] }]);
  const before = calls.length;
  for (const value of [null, [], { sourceIds: [] }, { sourceIds: ["bad id"] }, { extra: true }])
    assert.equal((await api.checkCalendarSources(value)).errorCode, "invalid_argument");
  assert.equal(calls.length, before);
  await api.readMorningV5Formal({ scope: "current" });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),
    ["read-formal-morning-v5", { scope: "current" }]);
  const readCount = calls.length;
  for (const value of [null, {}, { scope: "other" },
    { scope: "calendar_day", calendarDate: "2026-99-99" },
    { scope: "current", calendarDate: "2026-10-15" }])
    assert.equal((await api.readMorningV5Formal(value)).errorCode, "invalid_argument");
  assert.equal(calls.length, readCount);
  await api.readOverallV2Trace({ scope: "calendar_day", calendarDate: "2026-10-15" });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),
    ["read-formal-overall-trace", { scope: "calendar_day", calendarDate: "2026-10-15" }]);
  const traceReadCount = calls.length;
  for (const value of [null, {}, { scope: "other" },
    { scope: "calendar_day", calendarDate: "2026-99-99" },
    { scope: "current", calendarDate: "2026-10-15" }])
    assert.equal((await api.readOverallV2Trace(value)).errorCode, "invalid_argument");
  assert.equal(calls.length, traceReadCount);
  await api.evaluateMorningV5Formal();
  assert.deepEqual(calls.at(-1), ["evaluate-formal-morning-v5", undefined]);
  const evaluationCount = calls.length;
  assert.equal((await api.evaluateMorningV5Formal({ fake: true })).errorCode, "invalid_argument");
  assert.equal(calls.length, evaluationCount);
  await api.evaluateOverallV2Trace();
  assert.deepEqual(calls.at(-1), ["evaluate-formal-overall-trace", undefined]);
  const traceCount = calls.length;
  assert.equal((await api.evaluateOverallV2Trace({ fake: true })).errorCode, "invalid_argument");
  assert.equal(calls.length, traceCount);
  await api.getRuntimeMetadata();
  assert.deepEqual(calls.at(-1), ["get-runtime-metadata", undefined]);
  const metadataCount = calls.length;
  assert.equal((await api.getRuntimeMetadata({ fake: true })).errorCode, "invalid_argument");
  assert.equal(calls.length, metadataCount);
  const participant = { requestKind: "explicit_source_date", targetDate: "2026-11-10" };
  await api.acquireParticipants(participant);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),
    ["acquire-participants", participant]);
  const participantCount = calls.length;
  for (const value of [null, {}, { requestKind: "latest_available", sourceUrl: "https://evil" },
    { requestKind: "explicit_source_date", targetDate: "2026-99-99" }])
    assert.equal((await api.acquireParticipants(value)).errorCode, "invalid_argument");
  assert.equal(calls.length, participantCount);
  const weekly = { requestKind: "historical_backfill_range",
    startDate: "2026-10-01", endDate: "2026-11-13" };
  await api.acquireWeekly(weekly);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["acquire-weekly", weekly]);
  const weeklyCount = calls.length;
  for (const value of [null, {}, { requestKind: "latest_available", sourceUrl: "https://evil" },
    { requestKind: "historical_backfill_range", startDate: "2026-11-13",
      endDate: "2026-10-01" }])
    assert.equal((await api.acquireWeekly(value)).errorCode, "invalid_argument");
  assert.equal(calls.length, weeklyCount);
});

test("renderer fail-fast validates exact bridge before XLSX and startup work", () => {
  const bridge = html.indexOf("const optionMapBridge = window.optionMapBridge");
  const failure = html.indexOf("OptionMap preload bridge unavailable");
  const xlsx = html.indexOf("const XLSX = window.XLSX", bridge);
  const cache = html.indexOf("initializeWeeklyCaches()", bridge);
  const refresh = html.indexOf("refreshAllMarketData()", bridge);
  assert.ok(bridge >= 0 && failure > bridge && xlsx > failure);
  assert.ok(cache > xlsx && refresh > xlsx);
  assert.match(html.slice(bridge, xlsx), /hasExactOptionMapBridge\(optionMapBridge, OPTION_MAP_BRIDGE_KEYS\)/);
  assert.match(html.slice(bridge, xlsx), /Object\.keys\(bridge\)/);
  assert.match(html.slice(bridge, xlsx), /typeof bridge\[key\] === "function"/);
  assert.match(html.slice(bridge, xlsx), /"requestCalendarSource"/);
  assert.match(html.slice(bridge, xlsx), /"checkCalendarSources"/);
});

test("renderer bridge verification normalizes order but rejects missing extra and duplicate keys", () => {
  const verify = loadRendererBridgeVerifier();
  const bridge = Object.fromEntries([...expectedKeys].reverse().map(key => [key, () => {}]));
  assert.equal(verify(bridge, expectedKeys), true);
  assert.equal(verify(bridge, [...expectedKeys].reverse()), true);
  assert.equal(verify(Object.fromEntries(Object.entries(bridge).slice(1)), expectedKeys), false);
  assert.equal(verify({ ...bridge, unexpectedMethod() {} }, expectedKeys), false);
  assert.equal(verify(bridge, [...expectedKeys.slice(0, -1), expectedKeys[0]]), false);
  assert.equal(verify({ ...bridge, readMorningV5Formal: null }, expectedKeys), false);
  assert.equal(verify({ ...bridge, readOverallV2Trace: null }, expectedKeys), false);
});

test("all renderer acquisition callsites use the narrow bridge with no raw Electron access", () => {
  const calls = html.match(/optionMapBridge\.(?:acquireParticipants|acquireQriPage|acquireWeekly|finalizeQriPage)\(/g) || [];
  assert.equal(calls.length, 11);
  assert.equal((html.match(/optionMapBridge\.acquireParticipants\(/g) || []).length, 5);
  assert.equal((html.match(/optionMapBridge\.acquireQriPage\(/g) || []).length, 2);
  assert.equal((html.match(/optionMapBridge\.acquireWeekly\(/g) || []).length, 3);
  assert.equal((html.match(/optionMapBridge\.finalizeQriPage\(/g) || []).length, 1);
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
  assert.doesNotMatch(mainSource, /ipcMain\.handle\("fetch-option-page"/);
  assert.doesNotMatch(preloadSource, /\bfetch\s*\(|localStorage|sessionStorage|validate[A-Z].*Url/);
  assert.match(preloadSource, /participantFormalProductionWriter/);
});
