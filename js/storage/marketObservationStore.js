(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const observationApi = commonJs ? require("../marketObservation.js") : root?.OptionMapMarketObservation;
    const api = factory(observationApi, root);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMarketObservationStore = api;
})(typeof window !== "undefined" ? window : globalThis, function (observationApi, root) {
    "use strict";

    const DATABASE_NAME = "optionMapMarketObservations";
    const DB_VERSION = 1;
    const OBSERVATION_STORE = "observations";
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

    function createMarketObservationStore(configuration = {}) {
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
                    if (!db.objectStoreNames.contains(OBSERVATION_STORE)) {
                        const store = db.createObjectStore(OBSERVATION_STORE, { keyPath: "observationId" });
                        store.createIndex("byObservedAt", "observedAt", { unique: false });
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

        async function append(record) {
            const validation = await observationApi.verifyObservation(record);
            if (!validation.valid) return { saved: false, outcome: "invalid_observation", errors: validation.errors };
            const db = await openStore();
            const transaction = db.transaction(OBSERVATION_STORE, "readwrite");
            const store = transaction.objectStore(OBSERVATION_STORE);
            const matches = await requestResult(store
                .index("bySemanticSignature").getAll(record.semanticSignature));
            const duplicate = matches.some(item => Math.abs(Date.parse(record.observedAt) -
                Date.parse(item.observedAt)) <= DEDUPE_WINDOW_MS);
            if (!duplicate) store.add(clone(record));
            try { await transactionDone(transaction); }
            catch (error) { return { saved: false, outcome: "transaction_failed", error: error.message }; }
            if (duplicate) return { saved: false, outcome: "duplicate" };
            return { saved: true, outcome: "appended", observationId: record.observationId };
        }

        async function listAll() {
            const db = await openStore();
            const transaction = db.transaction(OBSERVATION_STORE, "readonly");
            const records = await requestResult(transaction.objectStore(OBSERVATION_STORE).getAll());
            await transactionDone(transaction);
            return clone(records).sort((left, right) => left.observedAt.localeCompare(right.observedAt));
        }
        async function listByMarketDate(marketDate) {
            const db = await openStore();
            const transaction = db.transaction(OBSERVATION_STORE, "readonly");
            const records = await requestResult(transaction.objectStore(OBSERVATION_STORE)
                .index("byMarketDate").getAll(marketDate));
            await transactionDone(transaction);
            return clone(records).sort((left, right) => left.observedAt.localeCompare(right.observedAt));
        }
        return Object.freeze({ openStore, closeStore, append, listAll, listByMarketDate });
    }

    let defaultStore;
    const getDefaultStore = () => defaultStore || (defaultStore = createMarketObservationStore());
    return Object.freeze({ DATABASE_NAME, DB_VERSION, OBSERVATION_STORE, DEDUPE_WINDOW_MS,
        createMarketObservationStore, openStore: (...args) => getDefaultStore().openStore(...args),
        closeStore: (...args) => getDefaultStore().closeStore(...args),
        append: (...args) => getDefaultStore().append(...args),
        listAll: (...args) => getDefaultStore().listAll(...args),
        listByMarketDate: (...args) => getDefaultStore().listByMarketDate(...args) });
});
