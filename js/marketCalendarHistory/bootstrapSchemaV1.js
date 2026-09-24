"use strict";

const Schema = require("./productionSchemaV1.js");

const STORE_ORDER = Object.freeze([
  ["entries", "marketCalendarEventEntries"],
  ["revisions", "marketCalendarSemanticRevisions"],
  ["evidence", "marketCalendarAcquisitionEvidence"],
  ["observations", "marketCalendarEventObservations"],
  ["runs", "marketCalendarSourceRuns"],
  ["cursors", "marketCalendarSourceCursors"]
]);
const FAILURE_POINTS = Object.freeze(["schema", ...STORE_ORDER.map(([field]) => field)]);

function createAndPopulate(database, transaction, snapshot, injectFailureAfter = null) {
  Schema.createInUpgrade(database);
  if (injectFailureAfter === "schema") throw new Error("injected_failure_after_schema");
  for (const [field, storeName] of STORE_ORDER) {
    const store = transaction.objectStore(storeName);
    for (const record of snapshot[field]) store.add(record);
    if (injectFailureAfter === field) throw new Error(`injected_failure_after_${field}`);
  }
}

function inspect(database, transaction) {
  const stores = {};
  for (const [name, expected] of Object.entries(Schema.STORES)) {
    const store = transaction.objectStore(name), indexes = expected.indexes.map(([indexName]) => {
      const index = store.index(indexName);
      return [index.name, Array.isArray(index.keyPath) ? [...index.keyPath] : index.keyPath,
        index.unique];
    });
    stores[name] = { keyPath: Array.isArray(store.keyPath) ? [...store.keyPath] : store.keyPath,
      indexes };
  }
  return { databaseName: database.name, version: database.version, stores };
}

module.exports = Object.freeze({ DATABASE_NAME: Schema.DATABASE_NAME,
  VERSION: Schema.VERSION, STORES: Schema.STORES, STORE_ORDER, FAILURE_POINTS,
  createAndPopulate, inspect });
