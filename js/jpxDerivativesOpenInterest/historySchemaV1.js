(function (root, factory) { const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapJpxDerivativesOpenInterestHistorySchemaV1 = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";
    const DATABASE_NAME = "optionMapJpxDerivativesOpenInterestHistory", VERSION = 1;
    const STORES = Object.freeze({
        jpxDerivativeOpenInterestSourceRuns: Object.freeze({ keyPath: "runId", indexes: [["byAcceptedAt", "acceptedAt", true]] }),
        jpxDerivativeOpenInterestSourceDays: Object.freeze({ keyPath: "logicalKey", indexes: [["bySourceDate", "sourceDate", true], ["byActiveRevisionKey", "activeRevisionKey", true]] }),
        jpxDerivativeOpenInterestCanonicalRevisions: Object.freeze({ keyPath: "revisionKey", indexes: [["bySourceDate", "sourceDate", false], ["bySemanticIdentity", "semanticIdentity", false]] }),
        jpxDerivativeOpenInterestEvidence: Object.freeze({ keyPath: "evidenceKey", indexes: [["byRunId", "runId", false], ["byRevisionKey", "revisionKey", false]] }),
        jpxDerivativeOpenInterestObservations: Object.freeze({ keyPath: "observationKey", indexes: [["byRunId", "runId", false], ["byRevisionKey", "revisionKey", false]] }),
        jpxDerivativeOpenInterestSourceCursors: Object.freeze({ keyPath: "sourceId", indexes: [["byRunId", "runId", true], ["bySourceDate", "sourceDate", false]] })
    });
    const definition = () => ({ databaseName: DATABASE_NAME, version: VERSION, stores: STORES });
    function createInUpgrade(db) { for (const [name, spec] of Object.entries(STORES)) {
        const store = db.createObjectStore(name, { keyPath: spec.keyPath });
        for (const [index, keyPath, unique] of spec.indexes) store.createIndex(index, keyPath, { unique }); } }
    function inspect(db) { const stores = {}; for (const [name, spec] of Object.entries(STORES)) {
        const tx = db.transaction(name, "readonly"), store = tx.objectStore(name);
        stores[name] = { keyPath: store.keyPath, indexes: spec.indexes.map(([index]) => { const value = store.index(index);
            return [value.name, value.keyPath, value.unique]; }) }; }
        return { databaseName: db.name, version: db.version, stores }; }
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    function matches(db) { try { const actual = inspect(db), expected = definition();
        return db.version === VERSION && same(actual.stores, expected.stores); } catch (_error) { return false; } }
    return Object.freeze({ DATABASE_NAME, VERSION, STORES, definition, createInUpgrade, inspect, matches });
});
