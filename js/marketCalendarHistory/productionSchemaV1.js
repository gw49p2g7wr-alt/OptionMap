(function (root, factory) {
    const canonicalizer = typeof module === "object" && module.exports && !(root && root.document)
        ? require("../marketCalendar/marketEventCanonicalizer.js") : root?.OptionMapMarketEventCanonicalizer;
    const api = factory(canonicalizer);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarProductionSchemaV1 = api;
})(typeof window !== "undefined" ? window : globalThis, function (canonicalizer) {
    "use strict";
    const DATABASE_NAME = "optionMapMarketCalendarHistory", VERSION = 1;
    const EXPECTED_FINGERPRINT = "85248c8ec61ad4b554d77ee38e96088bc9b7fc0c3fc885e3af5332e7e02c2cbc";
    const STORES = Object.freeze({
        marketCalendarSourceRuns: Object.freeze({ keyPath: "runKey", indexes: Object.freeze([
            Object.freeze(["bySourceRunId", Object.freeze(["sourceId", "runId"]), true]),
            Object.freeze(["bySourceAcceptedAt", Object.freeze(["sourceId", "acceptedAt"]), true]),
            Object.freeze(["byAcceptedAt", "acceptedAt", false]),
            Object.freeze(["bySourceSemanticSetHash", Object.freeze(["sourceId", "semanticSetHash"]), false])]) }),
        marketCalendarEventEntries: Object.freeze({ keyPath: "eventKey", indexes: Object.freeze([
            Object.freeze(["bySourceId", "sourceId", false]),
            Object.freeze(["byActiveRevisionKey", "activeRevisionKey", true]),
            Object.freeze(["bySourceLastObservedAt", Object.freeze(["sourceId", "lastObservedAt"]), false])]) }),
        marketCalendarSemanticRevisions: Object.freeze({ keyPath: "revisionKey", indexes: Object.freeze([
            Object.freeze(["byEventValidFrom", Object.freeze(["eventKey", "validFrom"]), true]),
            Object.freeze(["byEventValidTo", Object.freeze(["eventKey", "validTo"]), false]),
            Object.freeze(["bySourceValidFrom", Object.freeze(["sourceId", "validFrom"]), false]),
            Object.freeze(["byCalendarStart", "calendarDateStart", false]),
            Object.freeze(["byCalendarEnd", "calendarDateEnd", false]),
            Object.freeze(["byRevisionOrigin", "revisionOrigin", false])]) }),
        marketCalendarAcquisitionEvidence: Object.freeze({ keyPath: "evidenceLinkKey", indexes: Object.freeze([
            Object.freeze(["byRevisionAcceptedAt", Object.freeze(["revisionKey", "acceptedAt"]), true]),
            Object.freeze(["bySourceRun", Object.freeze(["sourceId", "runId"]), false]),
            Object.freeze(["byAcquisitionEvidenceKey", "acquisitionEvidenceKey", false]),
            Object.freeze(["byAcceptedAt", "acceptedAt", false])]) }),
        marketCalendarEventObservations: Object.freeze({ keyPath: "observationKey", indexes: Object.freeze([
            Object.freeze(["byEventAcceptedAt", Object.freeze(["eventKey", "acceptedAt"]), true]),
            Object.freeze(["bySourceRun", Object.freeze(["sourceId", "runId"]), false]),
            Object.freeze(["bySourceAcceptedAt", Object.freeze(["sourceId", "acceptedAt"]), false]),
            Object.freeze(["byState", "state", false])]) }),
        marketCalendarSourceCursors: Object.freeze({ keyPath: "sourceId", indexes: Object.freeze([
            Object.freeze(["byAcceptedAt", "acceptedAt", false]),
            Object.freeze(["byLastRunKey", "runKey", true])]) })
    });
    const definition = () => ({ databaseName: DATABASE_NAME, version: VERSION, stores: STORES });
    const normalizeKeyPath = value => Array.isArray(value) ? [...value] : value;
    function inspect(database) { const stores = {};
        for (const [name, expected] of Object.entries(STORES)) { const tx = database.transaction(name, "readonly"),
            store = tx.objectStore(name), indexes = expected.indexes.map(([indexName]) => { const index =
                store.index(indexName); return [index.name, normalizeKeyPath(index.keyPath), index.unique]; });
            stores[name] = { keyPath: normalizeKeyPath(store.keyPath), indexes }; }
        return { databaseName: database.name, version: database.version, stores }; }
    async function fingerprint(value = definition()) { const bytes = new TextEncoder().encode(JSON.stringify(value));
        if (globalThis.crypto?.subtle) { const result = await globalThis.crypto.subtle.digest("SHA-256", bytes);
            return [...new Uint8Array(result)].map(value => value.toString(16).padStart(2, "0")).join(""); }
        return require("node:crypto").createHash("sha256").update(bytes).digest("hex"); }
    function createInUpgrade(database) { for (const [name, value] of Object.entries(STORES)) {
        const store = database.createObjectStore(name, { keyPath: value.keyPath });
        for (const [indexName, keyPath, unique] of value.indexes)
            store.createIndex(indexName, keyPath, { unique }); } }
    return Object.freeze({ DATABASE_NAME, VERSION, EXPECTED_FINGERPRINT, STORES, definition,
        inspect, fingerprint, createInUpgrade });
});
