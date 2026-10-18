"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { IDBFactory } = require("fake-indexeddb");
const Registry = require("../js/marketCalendar/sourceRegistry.js"), Contracts = require("../js/marketCalendarRuntime/normalAcquisitionContract.js");
const Runtime = require("../js/marketCalendarRuntime/normalCalendarAcquisitionRuntime.js"), Startup = require("../js/marketCalendarRuntime/calendarStartupRuntime.js");
const Store = require("../js/storage/marketCalendarRuntimeStateStore.js"), F = require("./fixtures/marketCalendar/mofNormalFixture.js");
const A = require("../js/marketCalendarHistory/formalWriterAuthorityV2.js"), E = require("../js/marketCalendarHistory/writerSafetyVersionedEnvelope.js");
const SetE = require("../js/marketCalendarHistory/writerSafetySourceSetEnvelope.js");
const SetF = require("./fixtures/marketCalendar/safetySourceSetFixture.js");
const root = path.resolve(__dirname, ".."), MOF = F.MOF;
const expected = [...Registry.HISTORICAL_SOURCE_ORDER, MOF], row = r => r.sources.find(s => s.sourceId === MOF);

// Execute the actual main bootstrap in a closed VM. Electron, filesystem audit,
// other app services and network are stubs; no native app/profile is opened.
async function bootstrap({ readFailure = false } = {}) {
  const indexedDB = new IDBFactory(), store = Store.createRuntimeStateStore({ indexedDB, targetEnvironment: "isolated_test" });
  let options;
  const f = await F.setup({ store, readFormal: readFailure ? async () => ({ status: "unavailable", reason: "readonly_failed" }) : undefined,
    compose: config => { options = config; return Runtime.create(config); } });
  const handlers = new Map(), windows = [], audit = { productionAccess: 0, network: 0, factory: 0 };
  class Window {
    constructor() { this.webContents = { on() {}, setWindowOpenHandler() {} }; windows.push(this); }
    on() {} loadFile() {}
    static fromWebContents(wc) { return windows.find(w => w.webContents === wc) || null; }
  }
  let instance;
  const modules = {
    electron: { app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then: f => f() }),
      getPath() { audit.productionAccess++; throw Error("production_path_forbidden"); } }, BrowserWindow: Window, ipcMain: { handle: (k, v) => handlers.set(k, v) },
      net: { fetch() { audit.network++; throw Error("external_network_forbidden"); } } },
    "./js/marketCalendarHistory/readOnlyAuditCoordinator.js": { classifyArguments: () => "normal", configureDevelopmentProfile() {} },
    "./js/marketCalendarRuntime/calendarAcquisitionService.js": { createCalendarAcquisitionService: () => ({ acquire() { throw Error("legacy_transport_stub"); } }) },
    "./js/marketCalendarRuntime/normalCalendarAcquisitionRuntime.js": { create: config => {
      audit.factory++; assert.equal(config.runtimeStateOwner, "renderer"); assert.equal(config.webContents, windows[0].webContents);
      instance = Runtime.create({ ...options, ...config, stores: options.stores, readFormal: options.readFormal,
        fetchImpl: options.fetchImpl, acquire: options.acquire }); return instance;
    } },
    "./js/marketCalendarRuntime/calendarFormalBootstrapRuntime.js": {
      createProductionRuntime: () => ({ close() {} }), wrapNormalRuntime: normal => normal },
    "./js/security/networkUrlPolicy.js": {}, "./js/fullExportFileSave.js": { createSaveService: () => ({}) },
    "./js/morningV5FormalStore.js": { createProductionStore() {
      throw Error("morning_v5_store_must_remain_dormant"); } },
    "./js/morningV5FormalWriter.js": { createMainOwnedWriter: () => ({ close() {} }) },
    "./js/morningV5MainAuthorityBinding.js": { createMainAuthorityBinding: () => ({
      evaluate: async () => ({ writeCandidate: false }), currentAuthorityBinding: async () => null }) },
    "./js/security/weeklyListingAcquisitionDiagnostics.js": { createWeeklyListingAcquisitionDiagnostics: () => ({}) },
    dotenv: { config() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "main.js"), "utf8"), {
    __dirname: root, process: { argv: [], env: {}, platform: "darwin" }, console: { log() {}, error() {} },
    require: id => { if (Object.hasOwn(modules, id)) return modules[id];
      if (["node:path", "node:crypto", "node:url"].includes(id)) return require(id);
      if (id === "node:fs/promises") return {}; throw Error("unexpected_main_dependency:" + id); }
  });
  let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(root, "preload.js"), "utf8"), { require: id => {
    assert.equal(id, "electron"); return { contextBridge: { exposeInMainWorld: (_, api) => { bridge = api; } },
      ipcRenderer: { invoke: (channel, request) => handlers.get(channel)({ sender: windows[0].webContents }, request) } };
  } });
  const browser = vm.createContext({ document: {}, indexedDB, console, structuredClone, setTimeout, clearTimeout, URL }); browser.window = browser;
  for (const p of ["marketCalendar/sourceRegistry.js", "marketCalendarRuntime/sourceUpdateState.js", "storage/marketCalendarRuntimeStateStore.js",
    "marketCalendarRuntime/calendarRuntimeStateIntegration.js", "marketCalendarRuntime/calendarStartupRuntime.js"])
    vm.runInContext(fs.readFileSync(path.join(root, "js", p), "utf8"), browser);
  const startup = browser.OptionMapCalendarStartupRuntime.create({ bridge, indexedDB });
  return { ...f, store, indexedDB, startup, handlers, bridge, audit, instance: () => instance, windows };
}
test.afterEach(() => {
  assert.equal(require("../js/marketCalendarRuntime/formalShadowCycle.js").activeCount(), 0);
  assert.equal(require("../js/marketCalendarRuntime/sourceSingleFlight.js").getFlightDiagnostics().activeFlightCount, 0);
  assert.equal(require("../js/marketCalendarRuntime/boundedTaskPool.js").getTaskPoolDiagnostics().activeTaskCount, 0);
});
test("P1/P2 normal selection exact13, only added MOF; historical diagnostics exact12", () => {
  assert.deepEqual(Registry.getNormalAcquisitionEnabledSourceIds(), expected);
  assert.deepEqual(Contracts.resolve(Contracts.NORMAL13), expected);
  assert.deepEqual(Registry.getAcquisitionEnabledSourceIds(), Registry.HISTORICAL_SOURCE_ORDER);
  assert.deepEqual(require("../js/marketCalendarRuntime/calendarManualCheckService.js").ACTIVE_SOURCE_IDS, Registry.HISTORICAL_SOURCE_ORDER);
});
test("P3 code activation true; fixed metadata contains no authority mutation capability", () => {
  assert.equal(Registry.getSource(MOF).acquisitionEnabled, true); assert.equal(Registry.getSource(MOF).writerAllowed, false);
  assert.equal(Registry.isAcquisitionEnabled(MOF), false); // historical fixed transport must not acquire MOF
  assert(Object.isFrozen(Registry.NORMAL_ACQUISITION_ENABLED_SOURCE_IDS));
});
test("P4/P5 source-set permission stays not_approved with automatic/manual disabled", () => {
  const historical = SetF.historical(), state = SetE.migrateSourceSet(historical,
    SetE.requestFor(historical, A.hash("G1.6b-0-permission")));
  assert(SetE.validate(state).valid);
  const permission = require("../js/marketCalendarHistory/writerSafetySourceSetPermission.js"), p = permission.PERMISSIONS;
  assert.equal(p.entries.find(s => s.sourceId === MOF).permission, "not_approved");
  assert.equal(Registry.getSource(MOF).writerAllowed, false);
  for (const operation of ["startup", "manual"]) assert.equal(permission.evaluate({ record: state, sourceId: MOF, operation }).writeAllowed, false);
});
test("P6 real main + preload + browser startup selects thirteen, MOF four exact documents", async () => {
  const f = await bootstrap(), r = await f.startup.startup();
  assert.equal(r.state, "success"); assert.deepEqual(Array.from(r.sources, s => s.sourceId), expected);
  assert.equal(row(r).recordCount, 16); assert.equal(f.requests.length, 4); assert.equal(r.peakSourceConcurrency, 3);
  assert.equal(f.legacyCalls.length, 12); assert.deepEqual(f.requests.map(x => x.url).sort(), Object.keys(f.documents).sort());
  assert.equal(f.audit.factory, 1); assert.equal(f.audit.network, 0); assert.equal(f.audit.productionAccess, 0);
});
test("P7 outer renderer is the only legacy persistence owner: first create1, later update1", async () => {
  const f = await bootstrap(); assert.equal((await f.store.read(MOF)).value, null);
  await f.startup.check({ sourceIds: [MOF] });
  assert.equal(f.startup.diagnostics().successfulWrites, 1); assert.equal(f.store.diagnostics().successfulWrites, 0);
  f.setClock("2026-10-14T00:00:00.000Z"); await f.startup.check({ sourceIds: [MOF] });
  assert.equal(f.startup.diagnostics().successfulWrites, 2); assert.equal((await f.store.readAll()).value.length, 1);
});
test("same-day fresh browser startup skips MOF without network/write/Formal read", async () => {
  const f = await bootstrap(); await f.startup.startup();
  const second = Startup.create({ indexedDB: f.indexedDB, bridge: f.bridge });
  const before = f.requests.length, reads = f.reads(); const r = await second.startup();
  assert.equal(row(r).reasonClass, "already_succeeded_today"); assert.equal(f.requests.length, before);
  assert.equal(f.reads(), reads); assert.equal(second.diagnostics().successfulWrites, 0);
});
test("P8 Formal16 unchanged and zero mutation via activated route", async () => {
  const f = await bootstrap(), before = structuredClone(f.snapshot); await f.startup.check({ sourceIds: [MOF] });
  const d = f.instance().diagnostics().comparison, s = d.comparison.summaries.find(s => s.sourceId === MOF);
  assert.equal(s.unchanged, 16); for (const k of ["new", "changed", "evidenceOnly", "ambiguity"]) assert.equal(s[k], 0);
  assert.deepEqual(f.snapshot, before); assert.equal(d.formalAudit.readwrite, 0); assert.equal(d.writeAllowed, false);
});
test("P9/P10 normal graph cannot invoke authorization, grant, token or safety lifecycle", async () => {
  const visited = new Set(); function visit(file) { if (visited.has(file)) return; visited.add(file);
    assert.doesNotMatch(file, /mofControlled|mofHidden|formalControlledWriterCore|writerSafety.*Store|machineryStartupCanary/);
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/require\(["'](\.[^"']+)["']\)/g)) visit(path.resolve(path.dirname(file), m[1]));
  }
  visit(require.resolve("../js/marketCalendarRuntime/normalCalendarAcquisitionRuntime.js"));
  const f = await bootstrap(); await f.startup.check({ sourceIds: [MOF] });
  assert.equal(f.instance().diagnostics().writerExecution, 0); assert.equal(f.instance().diagnostics().safetyWrites, 0);
});
test("P11 existing twelve routes/managed Runtime State behave identically", async () => {
  const f = await bootstrap(); await f.startup.startup();
  assert.deepEqual([...f.legacyCalls].sort(), [...Registry.HISTORICAL_SOURCE_IDS]);
  assert.equal(f.startup.diagnostics().successfulWrites, 10); // MOF + nine legacy; three main-managed
  for (const id of Registry.HISTORICAL_SOURCE_ORDER) assert.equal((f.states.get(id) || (await f.store.read(id)).value).lastOutcome, "success");
});
test("P12 Machinery historical ceiling/canary composition cannot inherit normal13", () => {
  assert.deepEqual(E.policyFor(3).global.permittedSources, [E.SOURCE]);
  assert.equal(E.policyFor(3).global.identity, "62d49ff8d78e01daae2bd42a556cca11e6b6a4de38e58a64355fa385bf8ea758");
  assert.deepEqual(require("../js/marketCalendarRuntime/formalExactComparison.js").SOURCE_IDS, Registry.HISTORICAL_SOURCE_IDS);
  assert.doesNotMatch(fs.readFileSync(require.resolve("../js/marketCalendarRuntime/machineryStartupCanary.js"), "utf8"), /NORMAL13|normalCalendarAcquisitionRuntime/);
});
test("P13 BOJ remains writer-ineligible without coverage or identity expansion", () => {
  assert.equal(E.policyFor(3).permissions.entries.find(p => p.sourceId === "jp-boj-calendar").permission, "writer_ineligible");
  assert.equal(Registry.getSource("jp-boj-calendar").parserVersion, 1);
});
test("narrow preload APIs stay fixed; exact13 input supported, override/14/source spoof rejected", async () => {
  const f = await bootstrap(); assert.equal(Object.keys(f.bridge).length, 11);
  const r = await f.bridge.checkCalendarSources({ sourceIds: expected }); assert.equal(r.successfulSourceCount, 13);
  for (const input of [{ sourceIds: [...expected, "unknown-source"] }, { sourceIds: [MOF], runtimeStateOwner: "main" },
    { sourceIds: [MOF], acquisitionEnabled: true }]) assert.equal((await f.bridge.checkCalendarSources(input)).errorCode, "invalid_argument");
  assert.equal((await f.bridge.checkCalendarSources({ sourceIds: ["unknown-source"] })).reasonClass, "invalid_argument");
  const denied = await f.handlers.get("check-market-calendar-sources")({ sender: {} }, {}); assert.equal(denied.reasonClass, "invalid_sender");
  assert.equal(f.audit.factory, 1);
});
test("read failures do not rewrite acquisition success; raw bodies absent from IPC", async () => {
  const f = await bootstrap({ readFailure: true }), r = await f.startup.check({ sourceIds: [MOF] });
  assert.equal(row(r).status, "success"); assert.equal((await f.store.read(MOF)).value.lastOutcome, "success");
  assert.equal(f.instance().diagnostics().comparison.reason, "readonly_failed");
  assert.doesNotMatch(JSON.stringify(r), /<tbody|parserInput|canonicalRecords|planIdentity/);
  assert.equal(f.startup.diagnostics().openHandles, 0); assert.equal(f.instance().diagnostics().transport.activeTasks, 0);
});
