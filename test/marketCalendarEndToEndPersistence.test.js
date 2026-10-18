"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
const Runtime = require("../js/marketCalendarRuntime/calendarFormalBootstrapRuntime.js");
const Schema = require("../js/marketCalendarHistory/productionSchemaV1.js");
const Bootstrap = require("../js/marketCalendarHistory/bootstrapSchemaV1.js");
const Consumer = require("../js/marketCalendarHistory/readOnlyCalendarConsumer.js");
const TimeTravel = require("../js/timeTravel/optionMapHistoricalReadModel.js");
const Mvp = require("../js/marketCalendarMvp.js");
const Presentation = require("../js/marketCalendarRuntime/calendarUpdatePresentation.js");
const Canonicalizer = require("../js/marketCalendar/marketEventCanonicalizer.js");
const Fixture = require("./fixtures/marketCalendar/calendar13Fixture.js");
const Native = require("../scripts/marketCalendarCea1Native.js");

function renderer(factory) {
  const context = vm.createContext({ indexedDB: factory, crypto: crypto.webcrypto, TextEncoder,
    structuredClone });
  return material => vm.runInContext(`(${Runtime.executeBootstrapInRenderer.toString()})(${
    JSON.stringify(material)},${JSON.stringify(Schema.definition())},${JSON.stringify(
      Bootstrap.STORE_ORDER)})`, context);
}
const absent = async () => ({ status: "unavailable", reason: "formal_database_absent" });
async function acceptedSources() {
  const fixture = await Fixture.fixture();
  for (const source of fixture.sources) source.candidateIdentity = await Canonicalizer.sha256({
    sourceId: source.sourceId, revisions: source.canonicalRecords.map(value => value.revisionKey).sort() });
  fixture.checkedAt = [...fixture.sources.flatMap(source => source.canonicalRecords.map(value =>
    value.acquisitionEvidence.fetchedAt)), Fixture.AT].sort((left, right) =>
      Date.parse(right) - Date.parse(left))[0];
  return fixture;
}

test("CEA1 empty archive + valid 13/13 creates one Formal database and read-backs exact events", async () => {
  const fixture = await acceptedSources(), factory = new IDBFactory(), prepared = await Runtime.prepare({
    sourceResults: fixture.sources, checkedAt: fixture.checkedAt });
  assert.equal(prepared.status, "prepared", prepared.reason);
  assert.equal(prepared.material.sourceIds.length, 13);
  assert.equal((await factory.databases()).length, 0);
  const receipt = await renderer(factory)(prepared.material);
  assert.equal(receipt.status, "committed");
  assert.equal(receipt.created, 1); assert.equal(receipt.transactions, 1);
  assert.equal(receipt.snapshotIdentity, prepared.material.snapshotIdentity);
  assert.equal(JSON.stringify(receipt.counts), JSON.stringify(prepared.material.counts));
  assert.equal((await factory.databases())[0].name, Schema.DATABASE_NAME);
  const future = receipt.snapshot.revisions.find(value =>
    value.calendarDateStart >= fixture.checkedAt.slice(0, 10));
  assert(future, "future Calendar fixture event required");
  const month = await Consumer.query({ indexedDB: factory, keyRange: IDBKeyRange,
    startDate: `${future.calendarDateStart.slice(0, 7)}-01`, endDate: future.calendarDateEnd });
  assert.equal(month.status, "available"); assert(month.events.length > 0);
  assert(Mvp.viewModel(month.events[0]).title);
  const selected = await Consumer.query({ indexedDB: factory, keyRange: IDBKeyRange,
    startDate: future.calendarDateStart, endDate: future.calendarDateStart });
  assert.equal(selected.status, "available");
  assert(selected.events.some(value => value.eventKey === future.eventKey));
  const historical = await TimeTravel.calendarFor(factory, future.calendarDateStart);
  assert.equal(historical.status, "available");
  assert(historical.value.some(value => value.revision.eventKey === future.eventKey));
  const fullHistorical = await TimeTravel.read({ calendarDate: future.calendarDateStart,
    indexedDB: factory, localStorage: { getItem: () => null }, readMorningV5: async () => ({
      status: "missing", records: [] }) });
  assert.equal(fullHistorical.sections.calendar.status, "saved");
  assert(fullHistorical.calendarEvents.some(value => value.revision.eventKey === future.eventKey));
});

test("CEA1 production composition invokes bootstrap only for a complete fresh 13-source cycle", async () => {
  const fixture = await acceptedSources(), factory = new IDBFactory(); let notifications = 0, calls = 0;
  const runtime = Runtime.create({ readFormal: absent, execute: async material => {
    calls++; return renderer(factory)(material);
  }, notify: async () => { notifications++; } });
  const normal = { check: async () => ({ state: "success", checkedAt: fixture.checkedAt }),
    restore: async () => null, diagnostics: () => ({ comparison: { sourceResults: fixture.sources } }) };
  const wrapped = Runtime.wrapNormalRuntime(normal, runtime), result = await wrapped.check({ trigger: "startup" });
  assert.equal(result.formalPersistence.status, "committed");
  assert.equal(calls, 1); assert.equal(notifications, 1);
  assert.equal(runtime.diagnostics().writerExecution, 1);
  const secondRuntime = Runtime.create({ readFormal: async () => ({ status: "ok" }),
    execute: async () => { throw Error("writer_must_not_run"); } });
  const existing = await Runtime.wrapNormalRuntime(normal, secondRuntime).check({ trigger: "manual" });
  assert.deepEqual(existing.formalPersistence, { status: "skipped", reason: "database_exists" });
});

test("CEA1 incomplete/ambiguous input remains fail-closed with write0", async () => {
  const fixture = await acceptedSources();
  for (const sources of [fixture.sources.slice(1), fixture.sources.map((value, index) =>
    index ? value : { ...value, routeIdentity: "0".repeat(64) })]) {
    let writes = 0;
    const runtime = Runtime.create({ readFormal: absent, execute: async () => { writes++; } });
    const result = await runtime.bootstrap({ sourceResults: sources, checkedAt: fixture.checkedAt });
    assert.equal(result.status, "rejected"); assert.equal(writes, 0);
  }
});

test("CEA1 source verification label remains distinct from Formal persistence state", () => {
  const base = { state: "success", successfulSourceCount: 13, requestedSourceCount: 13,
    checkedAt: Fixture.AT, sources: [] };
  assert.match(Presentation.build(base).statusText, /13 \/ 13 source/);
  assert.match(Presentation.build(base).writerQualifier, /保存は行っていません/);
  assert.equal(Presentation.build({ ...base, formalPersistence: { status: "committed" } }).writerQualifier,
    "カレンダー予定を保存しました");
  assert.equal(Presentation.build({ ...base, formalPersistence: { status: "skipped",
    reason: "database_exists" } }).writerQualifier, "保存済みカレンダーを使用しています");
});

test("CEA1 fixed authority exposes no renderer record/path/store injection", () => {
  assert.deepEqual(Runtime.SOURCE_IDS.length, 13);
  assert.throws(() => Runtime.createProductionRuntime(null), /native_main_required/);
  const source = require("node:fs").readFileSync(require.resolve(
    "../js/marketCalendarRuntime/calendarFormalBootstrapRuntime.js"), "utf8");
  assert.doesNotMatch(source, /ipcMain\.handle|ipcRenderer|databaseName\s*=\s*configuration|input\.databaseName/);
});

test("CEA1 native Chromium persists and reads the fixed Calendar archive", async () => {
  const fixture = await acceptedSources(), prepared = await Runtime.prepare({
    sourceResults: fixture.sources, checkedAt: fixture.checkedAt });
  assert.equal(prepared.status, "prepared", prepared.reason);
  const result = await Native.run(prepared.material);
  assert.equal(result.status, "PASS"); assert.equal(result.realChromium, true);
  assert.equal(result.snapshotIdentity, prepared.material.snapshotIdentity);
  assert.deepEqual(result.counts, prepared.material.counts);
  assert(result.dayEvents > 0); assert.equal(result.networkAttempts, 0);
});
