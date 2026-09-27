"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { IDBFactory } = require("fake-indexeddb");
const Store = require("../js/storage/marketCalendarRuntimeStateStore.js");
const Integration = require("../js/marketCalendarRuntime/calendarRuntimeStateIntegration.js");
const B1 = require("../js/marketCalendarRuntime/updatePolicy.js");
const Registry = require("../js/marketCalendar/sourceRegistry.js");
const FormalSchema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Controller = require("../js/marketCalendarRuntime/calendarUpdateUiController.js");
const Presentation = require("../js/marketCalendarRuntime/calendarUpdatePresentation.js");
const Service = require("../js/marketCalendarRuntime/calendarManualCheckService.js");
const fs = require("node:fs"), path = require("node:path");
const ID = "jp-boj-calendar", AT = "2026-09-25T00:00:00.000Z", ids = Object.keys(Registry.SOURCES);
const stores = [], audit = { reopenCycles: 0, formalMutationDuringRuntimeOperations: 0 };
function instance(indexedDB = new IDBFactory()) {
  const store = Store.createRuntimeStateStore({ indexedDB, targetEnvironment: "isolated_test" });
  stores.push(store); return store;
}
function state(overrides = {}) { return { sourceId: ID, lastAttemptAt: AT, lastSuccessAt: AT,
  lastOutcome: "success", retryAfter: null, lastHttpStatus: 200,
  lastDiagnosticClass: null, coordinatorVersion: 1, ...overrides }; }
function result(failures = 0, at = AT) { return { state: failures ? "partial" : "success",
  checkedAt: at, sources: ids.map((sourceId, i) => ({ sourceId,
    status: i < failures ? "failed" : "success", reasonClass: i < failures ? "request_timeout" : null,
    lastHttpStatus: i < failures ? null : 200 })) }; }
function integration(store, service) { return Integration.createRuntimeStateIntegration({ store,
  service, targetEnvironment: "isolated_test" }); }
async function seed(factory, name, version, setup) {
  return new Promise((resolve, reject) => { const request = factory.open(name, version);
    request.onupgradeneeded = () => setup(request.result, request.transaction);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { request.result.close(); resolve(); }; });
}
test.after(() => {
  const totals = stores.reduce((out, store) => {
    for (const [key, value] of Object.entries(store.diagnostics())) out[key] = (out[key] || 0) + value;
    return out;
  }, {});
  assert.equal(totals.openHandles, 0);
  console.log("D2a isolated audit", JSON.stringify({ ...totals, ...audit }));
});

test("absent reads create nothing; first write creates only fixed runtime DB and reopen restores state", async () => {
  const factory = new IDBFactory(), store = instance(factory);
  assert.equal((await store.readAll()).status, "absent"); assert.deepEqual(await factory.databases(), []);
  assert.equal((await store.write(ID, state())).status, "ok");
  assert.equal(store.diagnostics().openHandles, 0);
  const reloaded = instance(factory); audit.reopenCycles += 1;
  assert.deepEqual((await reloaded.read(ID)).value, state());
  assert.deepEqual(await factory.databases(), [{ name: Store.DATABASE_NAME, version: 1 }]);
});

test("success then failure preserves lastSuccessAt and uses B1 retryAfter", async () => {
  const store = instance(); let next = result();
  const bridge = integration(store, { check: async () => next });
  await bridge.check(); next = result(2, "2026-09-25T01:00:00.000Z");
  await bridge.check(); const saved = (await store.readAll()).value;
  assert.equal(saved.filter(x => x.lastOutcome === "success").length, 10);
  assert.equal(saved.filter(x => x.lastOutcome === "failure").length, 2);
  const failure = saved.find(x => x.sourceId === ids[0]);
  assert.equal(failure.lastSuccessAt, AT); assert.equal(failure.retryAfter, "2026-09-25T02:00:00.000Z");
  assert.equal(failure.lastDiagnosticClass, "timeout");
  const restored = await bridge.restore(); assert.equal(restored.state, "partial");
  assert.equal(restored.successfulSourceCount, 10); assert.equal(restored.failedSourceIds.length, 2);
});

test("persisted states retain B1 JST skip/update and cooldown/retry decisions", async () => {
  const store = instance(); await store.write(ID, state());
  const evaluate = (runtimeState, requestedAt) => B1.evaluateSourceUpdate({ sourceId: ID,
    trigger: "startup", requestedAt, runtimeState, sessionState: { attemptCount: 0 }, formalState: {
      databaseStatus: "absent", schemaStatus: "compatible", sourceCursorStatus: "absent",
      lastAcceptedAt: null, securityStatus: "clear" } }).decision;
  const saved = (await store.read(ID)).value;
  assert.equal(evaluate(saved, "2026-09-25T23:59:59.000+09:00"), "skip");
  assert.equal(evaluate(saved, "2026-09-26T00:00:00.000+09:00"), "update");
  await store.write(ID, state({ lastAttemptAt: "2026-09-25T01:00:00.000Z",
    lastOutcome: "failure", lastDiagnosticClass: "timeout", retryAfter: "2026-09-25T02:00:00.000Z" }));
  const failed = (await store.read(ID)).value;
  assert.equal(evaluate(failed, "2026-09-25T01:59:59.000Z"), "cooldown");
  assert.equal(evaluate(failed, "2026-09-25T02:00:00.000Z"), "retry");
});

test("malformed, unknown source, identity mismatch, timestamps and raw fields reject before DB creation", async () => {
  const factory = new IDBFactory(), store = instance(factory);
  for (const value of [null, {}, state({ sourceId: ids[1] }), state({ lastAttemptAt: "yesterday" }),
    state({ lastHttpStatus: 999 }), state({ rawHtml: "secret" }), state({ lastDiagnosticClass: "secret/path" })])
    assert.equal((await store.write(ID, value)).status, "unavailable");
  assert.equal((await store.write("unknown", state({ sourceId: "unknown" }))).status, "unavailable");
  assert.deepEqual(await factory.databases(), []);
});

test("unexpected version, store, keyPath and indexes fail closed without upgrade/reset", async () => {
  for (const variant of ["version", "store", "key", "index"]) {
    const factory = new IDBFactory();
    await seed(factory, Store.DATABASE_NAME, variant === "version" ? 2 : 1, db => {
      const s = db.createObjectStore(variant === "store" ? "other" : Store.STORE_NAME,
        { keyPath: variant === "key" ? "other" : "sourceId" });
      if (variant === "index") s.createIndex("unexpected", "sourceId");
    });
    const store = instance(factory);
    assert.equal((await store.readAll()).reason, "schema_mismatch");
    assert.equal((await store.write(ID, state())).reason, "schema_mismatch");
    assert.equal(store.diagnostics().successfulWrites, 0);
    assert.equal(store.diagnostics().databaseCreateAttempts, 0);
  }
});

test("corrupt stored record and stale candidate cannot overwrite accepted runtime state", async () => {
  const factory = new IDBFactory(); await seed(factory, Store.DATABASE_NAME, 1, db =>
    db.createObjectStore(Store.STORE_NAME, { keyPath: "sourceId" }).put({ sourceId: ID, rawBody: "bad" }));
  const corrupt = instance(factory);
  assert.equal((await corrupt.readAll()).status, "ok");
  assert.deepEqual((await corrupt.readAll()).invalidSources, [{ sourceId: ID, reason: "runtime_state_invalid" }]);
  assert.equal((await corrupt.read(ID)).reason, "runtime_state_invalid");
  assert.equal((await corrupt.write(ID, state())).status, "unavailable");
  const store = instance(); await store.write(ID, state());
  assert.equal((await store.write(ID, state({ lastAttemptAt: "2026-09-24T00:00:00.000Z",
    lastSuccessAt: "2026-09-24T00:00:00.000Z" }))).status, "unavailable");
  assert.deepEqual((await store.read(ID)).value, state());
});

test("read failure and actual transaction failure are sanitized; handles close", async () => {
  const broken = instance({ databases: async () => { throw new Error("secret filesystem path"); }, open() {} });
  assert.equal((await broken.readAll()).reason, "runtime_state_access_failed");
  const factory = new IDBFactory(); const store = instance(factory); await store.write(ID, state());
  const wrapped = { databases: () => factory.databases(), open: (...args) => {
    const request = factory.open(...args);
    request.addEventListener("success", () => { const db = request.result, original = db.transaction.bind(db);
      db.transaction = (...params) => { const tx = original(...params);
        if (params[1] === "readwrite") tx.abort(); return tx; }; }); return request;
  } };
  const failing = instance(wrapped);
  assert.equal((await failing.write(ID, state())).status, "unavailable");
  assert.equal(failing.diagnostics().openHandles, 0);
  assert.deepEqual((await store.read(ID)).value, state());
});

test("persistence rejection/throw preserves official check result and exposes sanitized diagnostic", async () => {
  for (const write of [async () => ({ status: "unavailable" }), async () => { throw Error("secret"); }]) {
    const output = await integration({ readAll: async () => ({ status: "absent", value: [] }), write },
      { check: async () => result() }).check();
    assert.equal(output.state, "success"); assert.equal(output.sources.length, 12);
    assert.deepEqual(output.runtimeStateDiagnostics, ["runtime_state_persist_failed"]);
    assert.match(Presentation.build(output).detailsText, /runtime_state_persist_failed/);
  }
  const store = instance({ databases: async () => { throw Error("secret"); }, open() {} });
  const output = await integration(store, { check: async () => result() }).check();
  assert.equal(output.state, "success");
  assert.equal((await integration(store, { check() {} }).restore()).state, "unavailable");
});

test("blocked open settles without creating a DB and closes a late connection", async () => {
  let request, closed = 0;
  const store = instance({ databases: async () => [{ name: Store.DATABASE_NAME, version: 1 }],
    open: () => { request = {}; queueMicrotask(() => request.onblocked()); return request; } });
  assert.equal((await store.readAll()).status, "unavailable");
  request.result = { close: () => { closed++; } }; request.onsuccess();
  assert.equal(closed, 1); assert.equal(store.diagnostics().openHandles, 0);
  assert.equal(store.diagnostics().databaseCreateAttempts, 0);
});

test("restore distinguishes absent, all failure and incomplete source coverage", async () => {
  const store = instance(), adapter = integration(store, { check: async () => result(12) });
  assert.equal((await adapter.restore()).state, "idle");
  await adapter.check(); assert.equal((await adapter.restore()).state, "failed");
  const subset = instance(); await subset.write(ID, state());
  const restored = await integration(subset, { check() {} }).restore();
  assert.equal(restored.state, "partial"); assert.equal(restored.requestedSourceCount, 12);
  assert.equal(restored.successfulSourceCount, 1);
});

test("integrated manual service preserves HTTP evidence and repeated requests persist once", async () => {
  const service = Service.createCalendarManualCheckService({ now: () => AT,
    acquire: async ({ sourceId }) => ({ success: false, sourceId, reason: "http_5xx",
      documents: [], diagnostics: [{ httpStatus: 503, reason: "http_5xx" }] }) });
  const store = instance(), bridge = integration(store, service), first = bridge.check({ sourceIds: [ID] });
  assert.equal(first, bridge.check({ sourceIds: [ID] })); await first;
  const saved = (await store.read(ID)).value;
  assert.equal(saved.lastHttpStatus, 503); assert.equal(saved.lastDiagnosticClass, "http_5xx");
  assert.equal(store.diagnostics().successfulWrites, 1);
});

test("UI read-only restore renders status/date without network and late restore cannot replace manual result", async () => {
  const store = instance(); await integration(store, { check: async () => result() }).check();
  const restored = integration(store, { check() { throw Error("network must not start"); } });
  const nodes = new Map(), node = id => {
    if (!nodes.has(id)) nodes.set(id, { dataset: { calendarUpdateUiEnabled: "true" },
      addEventListener() {}, textContent: "" }); return nodes.get(id);
  };
  let calls = 0;
  const controller = Controller.mount({ document: { getElementById: node },
    bridge: { checkCalendarSources: async () => { calls++; return { state: "failed" }; } },
    restoreState: () => restored.restore() });
  await controller.ready; assert.equal(calls, 0); assert.equal(controller.getState().state, "success");
  assert.match(node("marketCalendarUpdateStatus").textContent, /2026\/09\/25/);
  assert.doesNotMatch(node("marketCalendarUpdateStatus").textContent, /本日/);
  let release;
  const late = Controller.mount({ document: { getElementById: node },
    bridge: { checkCalendarSources: async () => ({ state: "failed" }) },
    restoreState: () => new Promise(resolve => { release = resolve; }) });
  await Promise.resolve(); await late.check(); release({ state: "success" }); await late.ready;
  assert.equal(late.getState().state, "failed");
});

test("runtime DB disappearance leaves all six Formal stores byte-identical", async () => {
  const factory = new IDBFactory();
  await seed(factory, FormalSchema.DATABASE_NAME, 1, (db, tx) => {
    FormalSchema.createInUpgrade(db);
    for (const [name, definition] of Object.entries(FormalSchema.STORES))
      tx.objectStore(name).put({ [definition.keyPath]: "fixture", marker: name });
  });
  async function snapshot() {
    return new Promise((resolve, reject) => { const request = factory.open(FormalSchema.DATABASE_NAME);
      request.onerror = () => reject(request.error); request.onsuccess = () => {
        const db = request.result, names = Object.keys(FormalSchema.STORES), tx = db.transaction(names), out = {};
        for (const name of names) { const read = tx.objectStore(name).getAll();
          read.onsuccess = () => { out[name] = read.result; }; }
        tx.oncomplete = () => { db.close(); resolve(JSON.stringify(out)); };
      }; });
  }
  const before = await snapshot(), store = instance(factory); await store.write(ID, state());
  await new Promise((resolve, reject) => { const request = factory.deleteDatabase(Store.DATABASE_NAME);
    request.onsuccess = resolve; request.onerror = reject; });
  assert.equal((await store.readAll()).status, "absent"); assert.equal(await snapshot(), before);
});

test("explicit capability, fixed DB/store, and no main-world storage/export/writer dependencies", () => {
  assert.throws(() => Store.createRuntimeStateStore({ indexedDB: new IDBFactory() }), /isolated_test/);
  for (const file of ["main.js", "preload.js"])
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
      /marketCalendarRuntimeStateStore|calendarRuntimeStateIntegration|restoreState:/);
  for (const file of ["js/storage/marketCalendarRuntimeStateStore.js",
    "js/marketCalendarRuntime/calendarRuntimeStateIntegration.js"])
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
      /existingDbControlledWriter|bootstrapFirstSourceWriter|deleteDatabase|localStorage|fetch\(/);
});
