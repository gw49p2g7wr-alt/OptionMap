(function (root, factory) {
    const node = typeof module === "object" && module.exports && !(root && root.document),
        schema = node ? require("./productionSchemaV1.js") :
            root?.OptionMapMarketCalendarProductionSchemaV1,
        coverage = node ? require("./calendarPartialCoverage.js") :
            root?.OptionMapMarketCalendarPartialCoverage;
    const api = factory(schema, coverage);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarReadOnlyConsumer = api;
})(typeof window !== "undefined" ? window : globalThis, function (schema, coverage) {
    "use strict";
    const ENTRY = "marketCalendarEventEntries", REVISION = "marketCalendarSemanticRevisions",
        COVERAGE_STORES = Object.freeze({ runs: "marketCalendarSourceRuns",
            entries: ENTRY, revisions: REVISION,
            evidence: "marketCalendarAcquisitionEvidence",
            observations: "marketCalendarEventObservations",
            cursors: "marketCalendarSourceCursors" }),
        ALL_STORES = Object.freeze(Object.values(COVERAGE_STORES));
    const request = value => new Promise((resolve, reject) => {
        value.onsuccess = () => resolve(value.result);
        value.onerror = () => reject(value.error || new Error("readonly_request_failed"));
    });
    const complete = tx => new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error || new Error("readonly_transaction_aborted"));
        tx.onerror = () => undefined;
    });
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    function schemaMatches(db, tx, names = [ENTRY, REVISION]) {
        if (db.version !== schema.VERSION || !same([...db.objectStoreNames].sort(),
            Object.keys(schema.STORES).sort())) return false;
        for (const name of names) {
            const store = tx.objectStore(name), expected = schema.STORES[name];
            if (!same(store.keyPath, expected.keyPath) || !same([...store.indexNames].sort(),
                expected.indexes.map(item => item[0]).sort())) return false;
            for (const [indexName, keyPath, unique] of expected.indexes) {
                const index = store.index(indexName);
                if (!same(index.keyPath, keyPath) || index.unique !== unique) return false;
            }
        }
        return true;
    }
    async function query({ indexedDB, databaseName = schema.DATABASE_NAME, startDate, endDate,
        keyRange = globalThis.IDBKeyRange } = {}) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || "") ||
            !/^\d{4}-\d{2}-\d{2}$/.test(endDate || "") || endDate < startDate)
            return { status: "unavailable", reason: "date_range_invalid", events: [] };
        if (!indexedDB || typeof indexedDB.databases !== "function" || !keyRange)
            return { status: "unavailable", reason: "indexeddb_unavailable", events: [] };
        let catalog;
        try { catalog = await indexedDB.databases(); }
        catch (_error) { return { status: "unavailable", reason: "catalog_failed", events: [] }; }
        if (!catalog.some(item => item.name === databaseName))
            return { status: "absent", reason: "database_absent", events: [] };
        let db, tx, txDone;
        try {
            db = await new Promise((resolve, reject) => {
                const opening = indexedDB.open(databaseName); let settled = false, upgrade = false;
                opening.onupgradeneeded = () => { upgrade = true;
                    try { opening.transaction.abort(); } catch (_error) {} };
                opening.onsuccess = () => { if (settled || upgrade) { opening.result.close();
                    if (!settled) { settled = true; reject(new Error("upgrade_forbidden")); } return; }
                    settled = true; resolve(opening.result); };
                opening.onerror = () => { if (!settled) { settled = true;
                    reject(opening.error || new Error("readonly_open_failed")); } };
                opening.onblocked = () => { if (!settled) { settled = true;
                    reject(new Error("readonly_open_blocked")); } };
            });
            if (db.version !== schema.VERSION || !same([...db.objectStoreNames].sort(),
                Object.keys(schema.STORES).sort())) return { status: "schema_mismatch", events: [] };
            const range = keyRange.lowerBound(startDate);
            tx = db.transaction([ENTRY, REVISION], "readonly"); txDone = complete(tx);
            let validSchema = false;
            try { validSchema = schemaMatches(db, tx); } catch (_error) {}
            if (!validSchema) { try { tx.abort(); } catch (_error) {}
                await txDone.catch(() => undefined); return { status: "schema_mismatch", events: [] }; }
            const entriesRequest = request(tx.objectStore(ENTRY).getAll());
            const revisionsRequest = request(tx.objectStore(REVISION).index("byCalendarEnd")
                .getAll(range));
            const [entries, candidates] = await Promise.all([entriesRequest, revisionsRequest]);
            await txDone;
            const active = new Map(entries.map(entry => [entry.activeRevisionKey, entry]));
            const events = candidates.filter(revision => revision.calendarDateStart <= endDate &&
                revision.calendarDateEnd >= startDate && active.get(revision.revisionKey)?.eventKey ===
                revision.eventKey && active.get(revision.revisionKey)?.sourceId === revision.sourceId &&
                revision.validTo === null).sort((a, b) => a.calendarDateStart.localeCompare(b.calendarDateStart) ||
                (a.schedule?.canonicalStart || "").localeCompare(b.schedule?.canonicalStart || "") ||
                a.eventKey.localeCompare(b.eventKey));
            return { status: "available", events, activeEntryCount: entries.length };
        } catch (_error) { try { tx?.abort(); } catch (_abortError) {}
            await txDone?.catch(() => undefined);
            return { status: "unavailable", reason: "readonly_query_failed", events: [] }; }
        finally { db?.close(); }
    }
    async function readCoverage({ indexedDB, databaseName = schema.DATABASE_NAME,
        runtimeStates = [] } = {}) {
        if (!indexedDB || typeof indexedDB.databases !== "function")
            return { status: "unavailable", reason: "indexeddb_unavailable", coverage: null };
        let catalog;
        try { catalog = await indexedDB.databases(); }
        catch (_error) { return { status: "unavailable", reason: "catalog_failed", coverage: null }; }
        if (!catalog.some(item => item.name === databaseName))
            return { status: "absent", reason: "database_absent", coverage: null };
        let db, tx, txDone;
        try {
            db = await new Promise((resolve, reject) => {
                const opening = indexedDB.open(databaseName); let settled = false, upgrade = false;
                opening.onupgradeneeded = () => { upgrade = true;
                    try { opening.transaction.abort(); } catch (_error) {} };
                opening.onsuccess = () => { if (settled || upgrade) { opening.result.close();
                    if (!settled) { settled = true; reject(new Error("upgrade_forbidden")); } return; }
                    settled = true; resolve(opening.result); };
                opening.onerror = () => { if (!settled) { settled = true;
                    reject(opening.error || new Error("readonly_open_failed")); } };
                opening.onblocked = () => { if (!settled) { settled = true;
                    reject(new Error("readonly_open_blocked")); } };
            });
            if (db.version !== schema.VERSION || !same([...db.objectStoreNames].sort(),
                Object.keys(schema.STORES).sort()))
                return { status: "schema_mismatch", reason: "schema_version_mismatch", coverage: null };
            tx = db.transaction(ALL_STORES, "readonly"); txDone = complete(tx);
            let validSchema = false;
            try { validSchema = schemaMatches(db, tx, ALL_STORES); } catch (_error) {}
            if (!validSchema) { try { tx.abort(); } catch (_error) {}
                await txDone.catch(() => undefined);
                return { status: "schema_mismatch", reason: "schema_version_mismatch", coverage: null }; }
            const reads = Object.entries(COVERAGE_STORES).map(async ([field, storeName]) =>
                [field, await request(tx.objectStore(storeName).getAll())]), values = await Promise.all(reads);
            await txDone;
            const projected = coverage.projectPartialCoverage({ formalSnapshot: Object.fromEntries(values),
                runtimeStates: Array.isArray(runtimeStates) ? runtimeStates : [],
                schemaVersion: schema.VERSION });
            return projected.completeness === "invalid" ? { status: "invalid",
                reason: "formal_integrity_invalid", coverage: projected } :
                { status: "available", reason: null, coverage: projected };
        } catch (_error) { try { tx?.abort(); } catch (_abortError) {}
            await txDone?.catch(() => undefined);
            return { status: "unavailable", reason: "readonly_coverage_failed", coverage: null }; }
        finally { db?.close(); }
    }
    return Object.freeze({ query, readCoverage });
});
