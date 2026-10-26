"use strict";

const { IDBFactory } = require("fake-indexeddb");
const Schema = require("../../../js/marketCalendarHistory/productionSchemaV1.js");
const BootstrapSchema = require("../../../js/marketCalendarHistory/bootstrapSchemaV1.js");
const WriterCore = require("../../../js/marketCalendarHistory/formalControlledWriterCore.js");
const Preparation = require("../../../js/marketCalendarHistory/calendarPartialSourcePreparation.js");
const Authority = require("../../../js/marketCalendarHistory/calendarPartialSourceExecutionAuthority.js");
const Executor = require("../../../js/marketCalendarHistory/calendarPartialSourceAtomicExecutor.js");
const SourceFixture = require("./partialSourcePreparationFixture.js");

const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result);
  value.onerror = () => reject(value.error || new Error("request_failed"));
});
const done = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onabort = () => reject(transaction.error || new Error("transaction_aborted"));
  transaction.onerror = () => undefined;
});
async function seed(indexedDB, descriptor) {
  const opening = indexedDB.open(Schema.DATABASE_NAME, Schema.VERSION);
  await new Promise((resolve, reject) => {
    opening.onupgradeneeded = () => BootstrapSchema.createAndPopulate(opening.result,
      opening.transaction, Object.fromEntries(Preparation.SNAPSHOT_FIELDS.map(field =>
        [field, structuredClone(descriptor[field])])));
    opening.onsuccess = resolve;
    opening.onerror = () => reject(opening.error);
  });
  opening.result.close();
}
async function read(indexedDB) {
  const catalog = await indexedDB.databases(), descriptor = catalog.find(value =>
    value.name === Schema.DATABASE_NAME);
  if (!descriptor) return null;
  const database = await request(indexedDB.open(Schema.DATABASE_NAME)), transaction =
    database.transaction(Object.keys(Schema.STORES), "readonly"), completed = done(transaction),
    snapshot = {};
  for (const [field, storeName] of BootstrapSchema.STORE_ORDER)
    snapshot[field] = await request(transaction.objectStore(storeName).getAll());
  await completed; database.close();
  return WriterCore.sorted(snapshot);
}
function harness(indexedDB = new IDBFactory(), testHooks = null, clock = null) {
  const authority = Authority.createCalendarPartialExecutionAuthority(
    clock ? { clock } : {}), configuration = { targetEnvironment: "isolated_test", indexedDB,
      executionAuthority: authority };
  if (testHooks) configuration.testHooks = testHooks;
  return { indexedDB, authority, executor:
    Executor.createCalendarPartialSourceAtomicExecutor(configuration) };
}
async function prepareFirst(sourceId) {
  return Preparation.prepareCalendarFormalSourceMutation(await SourceFixture.input(sourceId));
}
async function prepareExisting(sourceId, descriptor, acquisition = null) {
  return Preparation.prepareCalendarFormalSourceMutation(await SourceFixture.input(sourceId,
    descriptor, acquisition));
}
async function grant(authority, plan) {
  const issued = await authority.issueGrant(plan);
  if (!issued.valid) throw new Error(issued.reason);
  return issued.grant;
}

module.exports = Object.freeze({ IDBFactory, seed, read, harness, prepareFirst, prepareExisting,
  grant, SourceFixture });
