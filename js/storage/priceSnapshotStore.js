(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const snapshotApi = commonJs ? require("../priceSnapshot.js") : root?.OptionMapPriceSnapshot;
    const api = factory(snapshotApi, root);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapPriceSnapshotStore = api;
})(typeof window !== "undefined" ? window : globalThis, function (snapshotApi, root) {
    "use strict";

    const DATABASE_NAME = "optionMapPriceSnapshots";
    const DB_VERSION = 1;
    const SNAPSHOT_STORE = "snapshots";
    const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

    function requestResult(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("indexeddb_request_failed"));
        });
    }
    function transactionDone(transaction) {
        return new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(transaction.error || new Error("indexeddb_transaction_aborted"));
            transaction.onerror = () => undefined;
        });
    }

    function createPriceSnapshotStore(configuration = {}) {
        const indexedDb = configuration.indexedDB || root?.indexedDB;
        const databaseName = configuration.databaseName || DATABASE_NAME;
        let database = null;
        let opening = null;
        async function openStore() {
            if (database) return database;
            if (opening) return opening;
            if (!indexedDb?.open) throw new Error("indexeddb_unavailable");
            opening = new Promise((resolve, reject) => {
                const request = indexedDb.open(databaseName, DB_VERSION);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(SNAPSHOT_STORE)) {
                        const store = db.createObjectStore(SNAPSHOT_STORE, { keyPath: "snapshotId" });
                        store.createIndex("byObservedAt", "observedAt", { unique: false });
                        store.createIndex("byContract", "contract", { unique: false });
                        store.createIndex("byMarketDate", "marketDate", { unique: false });
                        store.createIndex("bySemanticSignature", "semanticSignature", { unique: false });
                    }
                };
                request.onsuccess = () => { database = request.result;
                    database.onversionchange = () => { database.close(); database = null; }; resolve(database); };
                request.onerror = () => reject(request.error || new Error("indexeddb_open_failed"));
                request.onblocked = () => reject(new Error("indexeddb_open_blocked"));
            }).finally(() => { opening = null; });
            return opening;
        }
        function closeStore() { if (database) database.close(); database = null; }

        async function append(snapshot) {
            const validation = await snapshotApi.verifySnapshot(snapshot);
            if (!validation.valid) return { saved: false, outcome: "invalid_snapshot", errors: validation.errors };
            const db = await openStore();
            const transaction = db.transaction(SNAPSHOT_STORE, "readwrite");
            const store = transaction.objectStore(SNAPSHOT_STORE);
            const matches = await requestResult(store.index("bySemanticSignature")
                .getAll(snapshot.semanticSignature));
            const duplicate = matches.some(item => Math.abs(Date.parse(snapshot.observedAt) -
                Date.parse(item.observedAt)) <= DEDUPE_WINDOW_MS);
            if (!duplicate) store.add(clone(snapshot));
            try { await transactionDone(transaction); }
            catch (error) { return { saved: false, outcome: "transaction_failed", error: error.message }; }
            return duplicate ? { saved: false, outcome: "duplicate" }
                : { saved: true, outcome: "appended", snapshotId: snapshot.snapshotId };
        }

        async function listAll() {
            const db = await openStore();
            const transaction = db.transaction(SNAPSHOT_STORE, "readonly");
            const records = await requestResult(transaction.objectStore(SNAPSHOT_STORE).getAll());
            await transactionDone(transaction);
            return clone(records).sort((left, right) => left.observedAt.localeCompare(right.observedAt));
        }
        async function listByContract(contract) {
            const db = await openStore();
            const transaction = db.transaction(SNAPSHOT_STORE, "readonly");
            const records = await requestResult(transaction.objectStore(SNAPSHOT_STORE)
                .index("byContract").getAll(contract));
            await transactionDone(transaction);
            return clone(records).sort((left, right) => left.observedAt.localeCompare(right.observedAt));
        }
        return Object.freeze({ openStore, closeStore, append, listAll, listByContract });
    }

    let defaultStore;
    const getDefaultStore = () => defaultStore || (defaultStore = createPriceSnapshotStore());
    return Object.freeze({ DATABASE_NAME, DB_VERSION, SNAPSHOT_STORE, DEDUPE_WINDOW_MS,
        createPriceSnapshotStore, openStore: (...args) => getDefaultStore().openStore(...args),
        closeStore: (...args) => getDefaultStore().closeStore(...args),
        append: (...args) => getDefaultStore().append(...args),
        listAll: (...args) => getDefaultStore().listAll(...args),
        listByContract: (...args) => getDefaultStore().listByContract(...args) });
});
