(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarReadOnlyProductionInventory = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const transactionDone = transaction => new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || new Error("readonly_transaction_aborted"));
        transaction.onerror = () => undefined; });
    const requestResult = request => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("readonly_request_failed")); });
    async function inspect(configuration = {}) {
        const indexedDB = configuration.indexedDB, databaseName = configuration.databaseName,
            expectedStores = Object.freeze([...(configuration.expectedStores || [])]);
        if (!indexedDB || typeof indexedDB.databases !== "function" || typeof indexedDB.open !== "function" ||
            typeof databaseName !== "string" || !databaseName)
            return Object.freeze({ status: "unsupported", reason: "safe_inventory_api_unavailable",
                databaseExists: null, opened: false });
        let databases;
        try { databases = await indexedDB.databases(); }
        catch (error) { return Object.freeze({ status: "unavailable", reason: "database_inventory_failed",
            databaseExists: null, opened: false, error: error?.message || String(error) }); }
        const descriptor = databases.find(item => item.name === databaseName);
        if (!descriptor) return Object.freeze({ status: "absent", databaseExists: false, opened: false,
            databaseName });
        let upgradeAttempted = false, database;
        try { database = await new Promise((resolve, reject) => { const request = indexedDB.open(databaseName);
            request.onupgradeneeded = () => { upgradeAttempted = true;
                try { request.transaction.abort(); } catch (_error) {} };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("readonly_open_failed"));
            request.onblocked = () => reject(new Error("readonly_open_blocked")); }); }
        catch (error) { return Object.freeze({ status: upgradeAttempted ? "absent_race" : "unavailable",
            reason: upgradeAttempted ? "creation_prevented" : "readonly_open_failed",
            databaseExists: upgradeAttempted ? false : true, opened: false,
            error: error?.message || String(error) }); }
        try {
            const actualStores = [...database.objectStoreNames].sort(), counts = {};
            if (actualStores.length) { const transaction = database.transaction(actualStores, "readonly"),
                done = transactionDone(transaction);
                await Promise.all(actualStores.map(async name => { counts[name] = await requestResult(
                    transaction.objectStore(name).count()); })); await done; }
            const missingStores = expectedStores.filter(name => !actualStores.includes(name)),
                extraStores = actualStores.filter(name => !expectedStores.includes(name));
            return Object.freeze({ status: missingStores.length ? "incompatible" : "compatible",
                databaseExists: true, opened: true, databaseName, version: database.version,
                stores: Object.freeze(actualStores), counts: Object.freeze(clone(counts)),
                missingStores: Object.freeze(missingStores), extraStores: Object.freeze(extraStores) });
        } catch (error) { return Object.freeze({ status: "unavailable", reason: "readonly_inventory_failed",
            databaseExists: true, opened: true, error: error?.message || String(error) }); }
        finally { database.close(); }
    }
    return Object.freeze({ inspect });
});
