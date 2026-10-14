"use strict";

const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"),
  path = require("node:path"), vm = require("node:vm"), { IDBFactory } = require("fake-indexeddb");
const Startup = require("../js/marketCalendarRuntime/calendarStartupRuntime.js");
const Service = require("../js/marketCalendarRuntime/calendarManualCheckService.js");
const Store = require("../js/storage/marketCalendarRuntimeStateStore.js");
const Controller = require("../js/marketCalendarRuntime/calendarUpdateUiController.js");
const Flights = require("../js/marketCalendarRuntime/sourceSingleFlight.js");
const Pool = require("../js/marketCalendarRuntime/boundedTaskPool.js");
const MarketBootstrap = require("../js/startupBootstrap.js");
const Contracts = require("../js/marketCalendarRuntime/normalAcquisitionContract.js");
const ids = Contracts.NORMAL13.sourceIds, AT = "2026-09-25T00:00:00.000Z", runtimes = [];
const builder = { buildCalendarCandidate: async ({ sourceId }) => ({ sourceId,
  formalEligible: true, candidateStatus: "available", recordCount: 1 }) };
const simulator = { simulateCalendarTransition: async () => ({ simulationStatus: "new",
  commitOutcome: "writer_disabled" }) };
function setup({ indexedDB = new IDBFactory(), at = AT, fail = [], gate, bridgeGate } = {}) {
  const calls = [], decisions = [], service = Service.createCalendarManualCheckService({ builder, acquisitionContract: Contracts.NORMAL13,
    simulator, now: () => at, acquire: async ({ sourceId }) => {
      calls.push(sourceId); if (gate) await gate;
      return fail.includes(sourceId) ? { success: false, reason: "request_timeout", diagnostics: [] } :
        { success: true, sourceId, documents: [{ httpStatus: 200 }], diagnostics: [] };
    } });
  const runtime = Startup.create({ indexedDB, bridge: { checkCalendarSources: async request => {
    decisions.push(request); if (bridgeGate) await bridgeGate; return service.check(request);
  } } }); runtimes.push(runtime); return { runtime, calls, decisions, indexedDB };
}
function ui(runtime, enabled = true) {
  const nodes = new Map(); const document = { getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, { dataset: { calendarUpdateUiEnabled: String(enabled) },
      textContent: "", listeners: {}, sentinel: id, addEventListener(k, f) { this.listeners[k] = f; } });
    return nodes.get(id);
  } };
  return { nodes, controller: Controller.mount({ document, bridge: { checkCalendarSources() {
    throw Error("bypass"); } }, runtime, autoStartup: true }) };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; });
  return { promise, resolve }; };
async function until(predicate) { for (let i = 0; i < 100 && !predicate(); i++)
  await new Promise(resolve => setImmediate(resolve)); assert.ok(predicate()); }
test.afterEach(() => {
  assert.equal(Flights.getFlightDiagnostics().activeFlightCount, 0);
  assert.deepEqual(Pool.getTaskPoolDiagnostics(), { activePoolCount: 0, activeTaskCount: 0,
    queuedTaskCount: 0, unresolvedTaskCount: 0 });
  assert.ok(runtimes.every(x => x.diagnostics().openHandles === 0));
});
test.after(() => console.log("D2b isolated runtime audit", JSON.stringify(runtimes.reduce((sum, runtime) => {
  for (const [key, value] of Object.entries(runtime.diagnostics())) sum[key] = (sum[key] || 0) + value;
  return sum;
}, {}))));

test("first normal startup checks 13 sources, bounded at three, creates only Runtime State DB", async () => {
  const f = setup(), output = await f.runtime.startup();
  assert.equal(output.state, "success"); assert.equal(f.calls.length, 13);
  assert.equal(f.decisions[0].trigger, "startup"); assert.ok(output.peakSourceConcurrency <= 3);
  assert.deepEqual(await f.indexedDB.databases(), [{ name: Store.DATABASE_NAME, version: 1 }]);
  assert.equal(f.runtime.diagnostics().successfulWrites, 13);
});
test("same JST day second launch skips every source without write; next JST day updates", async () => {
  const first = setup(); await first.runtime.startup();
  const second = setup({ indexedDB: first.indexedDB, at: "2026-09-25T23:59:59.000+09:00" });
  const skipped = await second.runtime.startup();
  assert.equal(second.calls.length, 0); assert.equal(second.runtime.diagnostics().successfulWrites, 0);
  assert.equal(skipped.runtimePhase, "skipped"); assert.equal(skipped.checkedAt, AT);
  const third = setup({ indexedDB: first.indexedDB, at: "2026-09-26T00:00:00.000+09:00" });
  await third.runtime.startup(); assert.equal(third.calls.length, 13);
});
test("partial startup retains 11 successes; cooldown skips all; retry selects only failed pair", async () => {
  const first = setup({ fail: ids.slice(-2) });
  assert.equal((await first.runtime.startup()).state, "partial");
  const cooldown = setup({ indexedDB: first.indexedDB, at: "2026-09-25T00:59:59.000Z" });
  assert.equal((await cooldown.runtime.startup()).runtimePhase, "cooldown");
  assert.equal(cooldown.calls.length, 0); assert.equal(cooldown.runtime.diagnostics().successfulWrites, 0);
  const retry = setup({ indexedDB: first.indexedDB, at: "2026-09-25T01:00:00.000Z" });
  assert.equal((await retry.runtime.startup()).state, "success");
  assert.deepEqual(retry.calls, ids.slice(-2)); assert.equal(retry.runtime.diagnostics().successfulWrites, 2);
});
test("all failure returns UI failed, preserves grid and permits manual retry after B1 cooldown", async () => {
  const f = setup({ fail: ids }), mounted = ui(f.runtime);
  await mounted.controller.ready;
  assert.equal(mounted.controller.getState().state, "failed");
  assert.equal(mounted.nodes.get("marketCalendarUpdateButton").disabled, false);
  const retry = setup({ indexedDB: f.indexedDB, at: "2026-09-25T01:00:00.000Z" });
  await retry.runtime.check(); assert.equal(retry.calls.length, 13);
});
test("startup is idempotent and concurrent manual joins existing source flights", async () => {
  const gate = deferred(), f = setup({ gate: gate.promise });
  const a = f.runtime.startup(); assert.equal(a, f.runtime.startup());
  await until(() => f.calls.length === 3);
  assert.equal(Flights.getFlightDiagnostics().activeFlightCount, 3);
  const b = f.runtime.check(); assert.equal(a, b);
  gate.resolve(); await Promise.all([a, b]); assert.equal(f.calls.length, 13);
  assert.equal(f.runtime.diagnostics().successfulWrites, 13);
});
test("manual during runtime read joins startup decision; no duplicate acquisition", async () => {
  const gate = deferred(), factory = new IDBFactory();
  const f = setup({ indexedDB: { open: factory.open.bind(factory),
    databases: async () => { await gate.promise; return factory.databases(); } } });
  const a = f.runtime.startup(), b = f.runtime.check(); assert.equal(a, b);
  assert.equal(f.calls.length, 0); gate.resolve(); await a; assert.equal(f.calls.length, 13);
});
test("manual during decision bridge joins startup, with exactly one B1 request", async () => {
  const gate = deferred(), f = setup({ bridgeGate: gate.promise }), a = f.runtime.startup();
  await until(() => f.decisions.length === 1); const b = f.runtime.check(); assert.equal(a, b);
  gate.resolve(); await b; assert.equal(f.decisions.length, 1); assert.equal(f.calls.length, 13);
});
test("UI manual during restore wins over stale restore and prevents redundant startup", async () => {
  const gate = deferred(); let automatic = 0, manual = 0;
  const mounted = ui({ restore: () => gate.promise,
    startup: async () => { automatic++; }, check: async () => { manual++; return { state: "success" }; } });
  await mounted.controller.check(); gate.resolve({ state: "failed" }); await mounted.controller.ready;
  assert.equal(manual, 1); assert.equal(automatic, 0); assert.equal(mounted.controller.getState().state, "success");
});
test("feature OFF hides new UI and does not restore/write/acquire", async () => {
  let calls = 0; const mounted = ui({ restore() { calls++; }, startup() { calls++; } }, false);
  assert.equal(mounted.controller.enabled, false);
  assert.equal(mounted.nodes.get("marketCalendarUpdateRegion").hidden, true); assert.equal(calls, 0);
});
test("schema/read failure and B1 security state block startup network without repair", async () => {
  const f = setup({ indexedDB: { databases: async () => { throw Error("broken"); }, open() {} } });
  assert.equal((await f.runtime.startup()).state, "unavailable"); assert.equal(f.calls.length, 0);
  const factory = new IDBFactory(), store = Store.createRuntimeStateStore({ indexedDB: factory,
    targetEnvironment: "isolated_test" });
  for (const sourceId of ids) await store.write(sourceId, { sourceId, lastAttemptAt: AT, lastSuccessAt: null,
    lastOutcome: "failure", retryAfter: null, lastHttpStatus: null,
    lastDiagnosticClass: "security_violation", coordinatorVersion: 1 });
  const blocked = setup({ indexedDB: factory }); await blocked.runtime.startup();
  assert.equal(blocked.calls.length, 0); assert.equal(blocked.runtime.diagnostics().successfulWrites, 0);
});
test("Calendar pending never blocks market bootstrap; pending market never blocks Calendar", async () => {
  const gate = deferred(), f = setup({ gate: gate.promise }), calendar = ui(f.runtime);
  let refreshes = 0;
  const market = MarketBootstrap.createCoordinator({ initializers: [], refresh: async () => { refreshes++; } });
  await market.start(); assert.equal(refreshes, 1);
  gate.resolve(); await calendar.controller.ready;
  const marketGate = deferred(), slowMarket = MarketBootstrap.createCoordinator({ initializers: [
    { name: "pending history", run: () => marketGate.promise }], refresh: async () => {} });
  const pendingMarket = slowMarket.start(), independent = setup();
  await independent.runtime.startup(); assert.equal(slowMarket.getState().phase, "initializing");
  marketGate.resolve(); await pendingMarket;
  const source = fs.readFileSync(path.join(__dirname, "../js/startupBootstrap.js"), "utf8");
  assert.doesNotMatch(source, /calendarStartupRuntime|calendarRuntimeStateIntegration/);
});
test("browser Node-off modules compose without Node globals; 9 API input contract remains narrow", async () => {
  const context = vm.createContext({ console, document: {}, indexedDB: new IDBFactory(),
    structuredClone, setTimeout, clearTimeout, URL }); context.window = context;
  for (const file of ["marketCalendar/sourceRegistry.js", "marketCalendarRuntime/sourceUpdateState.js",
    "storage/marketCalendarRuntimeStateStore.js", "marketCalendarRuntime/calendarRuntimeStateIntegration.js",
    "marketCalendarRuntime/calendarStartupRuntime.js"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../js", file), "utf8"), context);
  const instance = context.OptionMapCalendarStartupRuntime.create({ indexedDB: context.indexedDB,
    bridge: { checkCalendarSources() { throw Error("restore must not acquire"); } } });
  assert.equal((await instance.restore()).state, "idle"); assert.equal(instance.diagnostics().successfulCreates, 0);
  let api, calls = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../preload.js"), "utf8"), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_, value) => { api = value; } },
      ipcRenderer: { invoke: async () => { calls++; return {}; } } }) });
  assert.equal(Object.keys(api).length, 9);
  for (const request of [{ trigger: "scheduler" }, { databaseName: "other" }, { runtimeStates: [] },
    { sessionStates: null }, { trigger: "startup", url: "https://bad.invalid" }])
    assert.equal((await api.checkCalendarSources(request)).errorCode, "invalid_argument");
  assert.equal(calls, 0);
  await api.checkCalendarSources({ trigger: "startup", runtimeStates: {}, sessionStates: {} });
  assert.equal(calls, 1);
});
