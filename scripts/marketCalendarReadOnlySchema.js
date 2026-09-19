(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarProductionSchemaV1 = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const DATABASE_NAME = "optionMapMarketCalendarHistory";
    const specs = Object.freeze({
        marketCalendarSourceRuns: ["bySourceRunId", "bySourceAcceptedAt", "byAcceptedAt",
            "bySourceSemanticSetHash"],
        marketCalendarEventEntries: ["bySourceId", "byActiveRevisionKey", "bySourceLastObservedAt"],
        marketCalendarSemanticRevisions: ["byEventValidFrom", "byEventValidTo", "bySourceValidFrom",
            "byCalendarStart", "byCalendarEnd", "byRevisionOrigin"],
        marketCalendarAcquisitionEvidence: ["byRevisionAcceptedAt", "bySourceRun",
            "byAcquisitionEvidenceKey", "byAcceptedAt"],
        marketCalendarEventObservations: ["byEventAcceptedAt", "bySourceRun",
            "bySourceAcceptedAt", "byState"],
        marketCalendarSourceCursors: ["byAcceptedAt", "byLastRunKey"]
    });
    const keyPath = value => Array.isArray(value) ? [...value] : value;
    function inspect(database) { const stores = {};
        for (const [name, indexNames] of Object.entries(specs)) {
            const transaction = database.transaction(name, "readonly"), store =
                transaction.objectStore(name), indexes = indexNames.map(indexName => {
                    const index = store.index(indexName);
                    return [index.name, keyPath(index.keyPath), index.unique]; });
            stores[name] = { keyPath: keyPath(store.keyPath), indexes };
        }
        return { databaseName: database.name, version: database.version, stores };
    }
    async function fingerprint(value) { const bytes = new TextEncoder().encode(JSON.stringify(value)),
        digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""); }
    return Object.freeze({ DATABASE_NAME, inspect, fingerprint });
});
