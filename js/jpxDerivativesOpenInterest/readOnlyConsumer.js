(function (root, factory) {
    const common = typeof module === "object" && module.exports && !(root && root.document);
    const schema = common ? require("./historySchemaV1.js") : root?.OptionMapJpxDerivativesOpenInterestHistorySchemaV1;
    const history = common ? require("./historyContract.js") : root?.OptionMapJpxDerivativesOpenInterestHistoryContract;
    const api = factory(schema, history); if (common) module.exports = api;
    if (root) root.OptionMapJpxDerivativesOpenInterestReadOnlyConsumer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (schema, history) {
    "use strict";
    const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result);
        value.onerror = () => reject(value.error || new Error("indexeddb_request_failed")); });
    const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error || new Error("transaction_aborted")); tx.onerror = () => undefined; });
    function create(configuration = {}) {
        const indexedDB = configuration.indexedDB || root?.indexedDB;
        const databaseName = configuration.databaseName || schema.DATABASE_NAME;
        async function catalog() { if (typeof indexedDB?.databases !== "function") throw new Error("catalog_unavailable");
            return indexedDB.databases(); }
        async function openExisting() { const entries = await catalog();
            if (!entries.some(item => item.name === databaseName)) throw new Error("database_absent");
            return new Promise((resolve, reject) => { const value = indexedDB.open(databaseName); let upgraded = false;
                value.onupgradeneeded = () => { upgraded = true; try { value.transaction.abort(); } catch (_error) {} };
                value.onsuccess = () => upgraded ? (value.result.close(), reject(new Error("upgrade_forbidden"))) : resolve(value.result);
                value.onerror = () => reject(value.error || new Error("open_failed")); value.onblocked = () => reject(new Error("open_blocked")); }); }
        async function readSnapshot() { let db; try { db = await openExisting();
                if (!schema.matches(db)) throw new Error("schema_mismatch");
                const names = Object.values(history.stores), tx = db.transaction(names, "readonly"), completed = done(tx), snapshot = {};
                await Promise.all(Object.entries(history.stores).map(async ([field, name]) => {
                    snapshot[field] = await request(tx.objectStore(name).getAll()); })); await completed;
                const errors = history.validateSnapshot(snapshot); if (errors.length) throw new Error(errors[0]);
                return { status: snapshot.days.length ? "ready" : "empty", snapshot };
            } finally { db?.close(); } }
        async function readActive() { const loaded = await readSnapshot(); const cursor = loaded.snapshot.cursors[0] || null;
            if (!cursor) return { status: "unavailable", cursor: null, revision: null, evidence: null };
            const revision = loaded.snapshot.revisions.find(item => item.revisionKey === cursor.activeRevisionKey) || null;
            const evidence = loaded.snapshot.evidence.filter(item => item.revisionKey === cursor.activeRevisionKey)
                .sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt)).at(-1) || null;
            return { status: revision && evidence ? "available" : "integrity_error", cursor, revision, evidence };
        }
        return Object.freeze({ catalog, openExisting, readSnapshot, readActive,
            diagnostics: Object.freeze({ readOnly: true, createsDatabase: false, upgradesDatabase: false }) });
    }
    return Object.freeze({ create });
});
