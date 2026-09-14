(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const evaluationApi = commonJs ? require("./wallHistoryShadowEvaluation.js") :
        root?.OptionMapWallHistoryShadowEvaluation;
    const api = factory(evaluationApi, root);
    if (commonJs) module.exports = api;
    if (root) { root.OptionMapWallHistoryShadowRuntime = api;
        root.runWallHistoryShadowEvaluation = () => api.run({ indexedDB: root.indexedDB });
        root.getWallHistoryShadowDiagnostics = () => api.getDiagnostics(); }
})(typeof window !== "undefined" ? window : globalThis, function (evaluationApi, root) {
    "use strict";
    const RUNTIME_VERSION = 1;
    const DATABASES = Object.freeze([
        { name: "optionMapQriOptionsHistory", version: 1, meta: "qriOptionsHistoryMeta",
            entries: "qriOptionsEntries", revisions: "qriOptionsRevisions", dateField: "sourceDateKey" },
        { name: "optionMapQriOptionIvHistory", version: 1, meta: "qriOptionIvHistoryMeta",
            entries: "qriOptionIvEntries", revisions: "qriOptionIvRevisions", dateField: "tradingDate" },
        { name: "optionMapPriceSnapshots", version: 1, records: "snapshots" }
    ]);
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    let diagnostics = freeze({ runtimeVersion: RUNTIME_VERSION, status: "not_run", readOnly: true });
    const requestValue = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("indexeddb_request_failed")); });
    const transactionDone = transaction => new Promise((resolve, reject) => { transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || new Error("indexeddb_transaction_aborted"));
        transaction.onerror = () => undefined; });
    async function catalog(indexedDB) { return typeof indexedDB?.databases === "function"
        ? indexedDB.databases() : []; }
    async function readExisting(indexedDB, descriptor, available) {
        const found = available.find(item => item.name === descriptor.name);
        if (!found) return { status: "missing", stores: {} };
        if (found.version !== descriptor.version) return { status: "version_mismatch", stores: {} };
        const db = await new Promise((resolve, reject) => { const request = indexedDB.open(descriptor.name,
            descriptor.version); request.onupgradeneeded = () => { request.transaction.abort();
                reject(new Error("indexeddb_upgrade_forbidden")); }; request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("indexeddb_open_failed")); });
        try { const names = descriptor.records ? [descriptor.records] :
            [descriptor.meta, descriptor.entries, descriptor.revisions];
            if (!names.every(name => db.objectStoreNames.contains(name))) return { status: "store_mismatch", stores: {} };
            const transaction = db.transaction(names, "readonly"), done = transactionDone(transaction), stores = {};
            await Promise.all(names.map(async name => { stores[name] = clone(await requestValue(
                transaction.objectStore(name).getAll())); })); await done; return { status: "ready", stores };
        } finally { db.close(); }
    }
    function reconstruct(stores, descriptor) {
        const meta = clone(stores[descriptor.meta]?.[0] || {}); delete meta.id; const byEntry = new Map();
        for (const stored of stores[descriptor.revisions] || []) { const value = clone(stored), entryKey = value.entryKey;
            delete value.revisionKey; delete value.entryKey; const values = byEntry.get(entryKey) || [];
            values.push(value); byEntry.set(entryKey, values); }
        return { ...meta, entries: (stores[descriptor.entries] || []).map(stored => ({ ...clone(stored),
            revisions: byEntry.get(stored.entryKey) || [] })) };
    }
    async function run({ indexedDB } = {}) {
        try { const available = await catalog(indexedDB), values = {};
            for (const descriptor of DATABASES) values[descriptor.name] = await readExisting(
                indexedDB, descriptor, available);
            const oiDescriptor = DATABASES[0], ivDescriptor = DATABASES[1];
            if (values[oiDescriptor.name].status !== "ready") { diagnostics = freeze({ runtimeVersion: RUNTIME_VERSION,
                status: "unavailable", reason: "qri_options_history_unavailable", readOnly: true,
                databaseStatus: Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value.status])) });
                return diagnostics; }
            const evaluation = await evaluationApi.evaluate({ qriOptionsHistory: reconstruct(
                values[oiDescriptor.name].stores, oiDescriptor), qriOptionIvHistory:
                values[ivDescriptor.name].status === "ready" ? reconstruct(values[ivDescriptor.name].stores,
                    ivDescriptor) : null, priceSnapshots: values.optionMapPriceSnapshots.status === "ready"
                    ? values.optionMapPriceSnapshots.stores.snapshots : [] });
            diagnostics = freeze({ runtimeVersion: RUNTIME_VERSION, status: "ready", readOnly: true,
                indexedDbUpgradeAttempted: false, databaseStatus: Object.fromEntries(Object.entries(values)
                    .map(([name, value]) => [name, value.status])), evaluation }); return diagnostics;
        } catch (error) { diagnostics = freeze({ runtimeVersion: RUNTIME_VERSION, status: "error", readOnly: true,
            reason: error?.message || String(error) }); return diagnostics; }
    }
    function getDiagnostics() { return freeze(clone(diagnostics)); }
    return Object.freeze({ RUNTIME_VERSION, DATABASES, run, getDiagnostics });
});
