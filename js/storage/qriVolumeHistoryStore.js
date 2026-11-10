(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const historyApi = commonJs ? require("../qriVolumeHistory.js") : root?.OptionMapQriVolumeHistory;
    const api = factory(historyApi, root);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriVolumeHistoryStore = api;
})(typeof window !== "undefined" ? window : globalThis, function (historyApi, root) {
    "use strict";
    const DATABASE_NAME = "optionMapQriVolumeHistory";
    const DB_VERSION = 1;
    const META_STORE = "qriVolumeHistoryMeta";
    const ENTRY_STORE = "qriVolumeEntries";
    const OBSERVATION_STORE = "qriVolumeObservations";
    const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const requestResult = request => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("indexeddb_request_failed"));
    });
    const transactionDone = transaction => new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || new Error("indexeddb_transaction_aborted"));
        transaction.onerror = () => undefined;
    });

    function createQriVolumeHistoryStore(configuration = {}) {
        const indexedDb = configuration.indexedDB || root?.indexedDB;
        const databaseName = configuration.databaseName || DATABASE_NAME;
        let database = null, opening = null;
        async function openHistoryStore() {
            if (database) return database;
            if (opening) return opening;
            if (!indexedDb?.open) throw new Error("indexeddb_unavailable");
            opening = new Promise((resolve, reject) => {
                const request = indexedDb.open(databaseName, DB_VERSION);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE,
                        { keyPath: "id" });
                    if (!db.objectStoreNames.contains(ENTRY_STORE)) db.createObjectStore(ENTRY_STORE,
                        { keyPath: "entryKey" });
                    if (!db.objectStoreNames.contains(OBSERVATION_STORE)) {
                        const store = db.createObjectStore(OBSERVATION_STORE,
                            { keyPath: "observationId" });
                        store.createIndex("byEntryKey", "entryKey", { unique: false });
                    }
                };
                request.onsuccess = () => { database = request.result;
                    database.onversionchange = () => { database.close(); database = null; };
                    resolve(database); };
                request.onerror = () => reject(request.error || new Error("indexeddb_open_failed"));
                request.onblocked = () => reject(new Error("indexeddb_open_blocked"));
            }).finally(() => { opening = null; });
            return opening;
        }
        function closeHistoryStore() { if (database) database.close(); database = null; }
        async function readRecords() {
            const db = await openHistoryStore();
            const tx = db.transaction([META_STORE, ENTRY_STORE, OBSERVATION_STORE], "readonly");
            const done = transactionDone(tx);
            const [meta, entries, observations] = await Promise.all([
                requestResult(tx.objectStore(META_STORE).get("history")),
                requestResult(tx.objectStore(ENTRY_STORE).getAll()),
                requestResult(tx.objectStore(OBSERVATION_STORE).getAll())]);
            await done; return { meta, entries, observations };
        }
        function assemble(records) {
            if (!records.meta) return historyApi.createEmptyHistory();
            const grouped = new Map();
            for (const stored of records.observations) {
                const observation = clone(stored), entryKey = observation.entryKey;
                delete observation.entryKey;
                const list = grouped.get(entryKey) || []; list.push(observation); grouped.set(entryKey, list);
            }
            for (const list of grouped.values()) list.sort((a, b) =>
                a.confirmedAt.localeCompare(b.confirmedAt) || a.observationId.localeCompare(b.observationId));
            const { id: _id, ...meta } = records.meta;
            return { ...clone(meta), entries: records.entries.map(entry => ({ ...clone(entry),
                observations: grouped.get(entry.entryKey) || [] }))
                .sort((a, b) => a.tradingDate.localeCompare(b.tradingDate) ||
                    a.contract.localeCompare(b.contract)) };
        }
        async function loadHistory() {
            const records = await readRecords();
            const empty = !records.meta && !records.entries.length && !records.observations.length;
            const history = empty ? historyApi.createEmptyHistory() : assemble(records);
            const validation = await historyApi.validateHistory(history);
            const keys = new Set(records.entries.map(entry => entry.entryKey));
            const orphan = records.observations.filter(item => !keys.has(item.entryKey));
            return { status: empty ? "empty" : validation.valid && !orphan.length ? "ready" : "corrupted",
                history, validation, orphanObservations: clone(orphan) };
        }
        async function commitHistory(history) {
            const validation = await historyApi.validateHistory(history);
            if (!validation.valid) return { saved: false, outcome: "invalid_history",
                errors: validation.errors };
            const db = await openHistoryStore();
            const tx = db.transaction([META_STORE, ENTRY_STORE, OBSERVATION_STORE], "readwrite");
            const done = transactionDone(tx);
            const metaStore = tx.objectStore(META_STORE), entryStore = tx.objectStore(ENTRY_STORE),
                observationStore = tx.objectStore(OBSERVATION_STORE);
            metaStore.clear(); entryStore.clear(); observationStore.clear();
            const { entries, ...meta } = clone(history); metaStore.put({ id: "history", ...meta });
            for (const entry of entries) {
                const { observations, ...storedEntry } = entry; entryStore.put(storedEntry);
                for (const observation of observations) observationStore.put({
                    ...clone(observation), entryKey: entry.entryKey });
            }
            try { await done; return { saved: true, outcome: "committed" }; }
            catch (error) { return { saved: false, outcome: "transaction_failed",
                error: error?.message || String(error) }; }
        }
        async function persistCandidate(candidate, options = {}) {
            const loaded = await loadHistory();
            if (!["empty", "ready"].includes(loaded.status)) {
                return { saved: false, outcome: "corrupted_existing_history" };
            }
            const merged = await historyApi.mergeCandidate(loaded.history, candidate, options);
            if (!merged.changed) return { saved: false, outcome: merged.outcome };
            const committed = await commitHistory(merged.history);
            return committed.saved ? { saved: true, outcome: merged.outcome } : committed;
        }
        async function loadEntry(contract, tradingDate) {
            const loaded = await loadHistory();
            if (loaded.status === "corrupted") return { status: "corrupted", reason: "invalid_history", entry: null };
            return historyApi.getAvailability(loaded.history, contract, tradingDate);
        }
        return Object.freeze({ openHistoryStore, closeHistoryStore, loadHistory,
            commitHistory, persistCandidate, loadEntry });
    }
    let defaultStore;
    const getDefaultStore = () => defaultStore || (defaultStore = createQriVolumeHistoryStore());
    return Object.freeze({ DATABASE_NAME, DB_VERSION, META_STORE, ENTRY_STORE, OBSERVATION_STORE,
        createQriVolumeHistoryStore,
        openHistoryStore: (...args) => getDefaultStore().openHistoryStore(...args),
        closeHistoryStore: (...args) => getDefaultStore().closeHistoryStore(...args),
        loadHistory: (...args) => getDefaultStore().loadHistory(...args),
        persistCandidate: (...args) => getDefaultStore().persistCandidate(...args),
        loadEntry: (...args) => getDefaultStore().loadEntry(...args) });
});
