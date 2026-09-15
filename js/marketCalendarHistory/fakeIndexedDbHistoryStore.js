(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const memory = commonJs ? require("./inMemoryHistory.js") : root?.OptionMapMarketCalendarInMemoryHistory;
    const api = factory(memory);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMarketCalendarFakeHistoryStore = api;
})(typeof window !== "undefined" ? window : globalThis, function (memory) {
    "use strict";
    const DB_VERSION = 1, TEST_PREFIX = "optionMapMarketCalendarHistoryTest-";
    const STORES = Object.freeze({ entries: "entries", revisions: "revisions", evidence: "evidence",
        observations: "observations", runs: "runs", cursors: "cursors" });
    const KEY_PATHS = Object.freeze({ entries: "eventKey", revisions: "revisionKey",
        evidence: "evidenceLinkKey", observations: "observationKey", runs: "runKey", cursors: "sourceId" });
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result);
        value.onerror = () => reject(value.error || new Error("indexeddb_request_failed")); });
    const done = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error || new Error("indexeddb_transaction_aborted"));
        tx.onerror = () => undefined; });
    function createFakeIndexedDbHistoryStore(configuration = {}) {
        if (configuration.targetEnvironment !== "test" || !configuration.indexedDB?.open ||
            typeof configuration.databaseName !== "string" ||
            !configuration.databaseName.startsWith(TEST_PREFIX)) throw new Error("test_store_configuration_required");
        const indexedDB = configuration.indexedDB, databaseName = configuration.databaseName;
        let db = null, queue = Promise.resolve();
        async function open() { if (db) return db; db = await new Promise((resolve, reject) => {
            const value = indexedDB.open(databaseName, DB_VERSION);
            value.onupgradeneeded = () => { for (const name of Object.values(STORES))
                if (!value.result.objectStoreNames.contains(name)) value.result.createObjectStore(name,
                    { keyPath: KEY_PATHS[name] }); };
            value.onsuccess = () => resolve(value.result);
            value.onerror = () => reject(value.error || new Error("indexeddb_open_failed"));
        }); return db; }
        async function load() { const database = await open(), names = Object.values(STORES),
            tx = database.transaction(names, "readonly"), completed = done(tx), values = {};
            await Promise.all(Object.entries(STORES).map(async ([field, name]) => {
                values[field] = await request(tx.objectStore(name).getAll()); }));
            await completed; return memory.normalize(values); }
        async function replaceSnapshot(snapshot, options = {}) { const database = await open(),
            names = Object.values(STORES), tx = database.transaction(names, "readwrite"), completed = done(tx);
            try { for (const [field, name] of Object.entries(STORES)) {
                const store = tx.objectStore(name); store.clear();
                for (const raw of snapshot[field]) { const item = clone(raw);
                    if (field === "observations") item.observationKey = `${item.eventKey}|${item.acceptedAt}|${item.runId}`;
                    if (field === "runs") item.runKey = `${item.sourceId}|${item.runId}`;
                    store.add(item); }
                if (options.failAfter === field) throw new Error(`injected_failure_after_${field}`); }
            } catch (error) { try { tx.abort(); } catch (_error) {} try { await completed; } catch (_error) {}
                return { committed: false, outcome: "rolled_back", error: error.message }; }
            try { await completed; return { committed: true, outcome: "committed" }; }
            catch (error) { return { committed: false, outcome: "rolled_back", error: error.message }; }
        }
        async function acceptNow(input, options) { const before = await load(), reduced = await memory.accept(before,
            input, options?.memory);
            if (!reduced.committed) return reduced;
            const stored = await replaceSnapshot(reduced.snapshot, options?.storage);
            return stored.committed ? { ...stored, snapshot: reduced.snapshot } : { ...stored, snapshot: before };
        }
        function accept(input, options = {}) { const operation = queue.then(() => acceptNow(input, options));
            queue = operation.catch(() => undefined); return operation; }
        function close() { db?.close(); db = null; }
        return Object.freeze({ open, load, accept, close });
    }
    return Object.freeze({ DB_VERSION, TEST_PREFIX, STORES, createFakeIndexedDbHistoryStore });
});
