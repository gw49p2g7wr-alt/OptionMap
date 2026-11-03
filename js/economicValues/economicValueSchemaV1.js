"use strict";

const Canonical = require("./economicValueCanonical.js");

const DATABASE_NAME = "optionMapEconomicValueHistory";
const VERSION = 1;
const STORES = Object.freeze({
  economicSourceRuns: Object.freeze({ keyPath: "runKey", indexes: Object.freeze([
    Object.freeze(["bySourceAcceptedAt", Object.freeze(["sourceId", "acceptedAt"]), true]),
    Object.freeze(["byReleaseOccurrence", "releaseOccurrenceKey", false])]) }),
  economicReleaseOccurrences: Object.freeze({ keyPath: "releaseOccurrenceKey", indexes: Object.freeze([
    Object.freeze(["byAuthorityPublishedAt", Object.freeze(["authority", "publishedAt"]), true]),
    Object.freeze(["byReferencePeriod", "referencePeriod", false]),
    Object.freeze(["byCalendarEventKey", "calendarEventKey", false])]) }),
  economicSeriesDefinitions: Object.freeze({ keyPath: "seriesDefinitionKey", indexes: Object.freeze([
    Object.freeze(["byIndicator", "indicator", false]),
    Object.freeze(["byMeasure", "measure", false])]) }),
  economicValueEntries: Object.freeze({ keyPath: "valueKey", indexes: Object.freeze([
    Object.freeze(["bySeriesReferencePeriod", Object.freeze(["seriesDefinitionKey", "referencePeriod"]), true]),
    Object.freeze(["byActiveRevisionKey", "activeRevisionKey", true])]) }),
  economicValueRevisions: Object.freeze({ keyPath: "revisionKey", indexes: Object.freeze([
    Object.freeze(["byValueValidFrom", Object.freeze(["valueKey", "validFrom"]), true]),
    Object.freeze(["byValueValidTo", Object.freeze(["valueKey", "validTo"]), false]),
    Object.freeze(["byReleaseOccurrence", "releaseOccurrenceKey", false])]) }),
  economicReleaseValueLinks: Object.freeze({ keyPath: "linkKey", indexes: Object.freeze([
    Object.freeze(["byReleaseOccurrence", "releaseOccurrenceKey", false]),
    Object.freeze(["byRevisionKey", "revisionKey", false])]) }),
  economicSourceDocuments: Object.freeze({ keyPath: "sourceDocumentKey", indexes: Object.freeze([
    Object.freeze(["byReleaseOccurrence", "releaseOccurrenceKey", false]),
    Object.freeze(["byRawContentHash", "rawContentHash", false])]) }),
  economicAcquisitionEvidence: Object.freeze({ keyPath: "evidenceKey", indexes: Object.freeze([
    Object.freeze(["byRevisionAcceptedAt", Object.freeze(["revisionKey", "acceptedAt"]), true]),
    Object.freeze(["bySourceRun", Object.freeze(["sourceId", "runId"]), false]),
    Object.freeze(["bySourceDocument", "sourceDocumentKey", false])]) }),
  economicSourceCursors: Object.freeze({ keyPath: "sourceId", indexes: Object.freeze([
    Object.freeze(["byAcceptedAt", "acceptedAt", false]),
    Object.freeze(["byRunKey", "runKey", true])]) })
});
const STORE_NAMES = Object.freeze(Object.keys(STORES));
const EXPECTED_FINGERPRINT = "59a2af13487d0473159f5dcce65e60e0adde7de3f380c67bf7471ff19e7f2efa";
const definition = () => ({ databaseName: DATABASE_NAME, version: VERSION, stores: STORES });
const fingerprint = () => Canonical.sha256(definition());
function createInUpgrade(database) {
  for (const [name, value] of Object.entries(STORES)) {
    const store = database.createObjectStore(name, { keyPath: value.keyPath });
    for (const [indexName, keyPath, unique] of value.indexes)
      store.createIndex(indexName, keyPath, { unique });
  }
}
function matches(database, transaction) {
  if (database.name !== DATABASE_NAME || database.version !== VERSION ||
      JSON.stringify([...database.objectStoreNames].sort()) !== JSON.stringify([...STORE_NAMES].sort())) return false;
  for (const [name, expected] of Object.entries(STORES)) {
    const store = transaction.objectStore(name);
    if (JSON.stringify(store.keyPath) !== JSON.stringify(expected.keyPath) ||
        JSON.stringify([...store.indexNames].sort()) !== JSON.stringify(expected.indexes.map(item => item[0]).sort())) return false;
    for (const [indexName, keyPath, unique] of expected.indexes) {
      const index = store.index(indexName);
      if (JSON.stringify(index.keyPath) !== JSON.stringify(keyPath) || index.unique !== unique) return false;
    }
  }
  return true;
}

module.exports = Canonical.freeze({ DATABASE_NAME, VERSION, STORES, STORE_NAMES,
  EXPECTED_FINGERPRINT, definition, fingerprint, createInUpgrade, matches });
