(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarReadOnlyProbe = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    function createGuard(indexedDB, databaseName, log) {
        let catalogSeen = false, exists = false, openConnections = 0, activeTransactions = 0,
            openAttempts = 0;
        const connections = new Set(), wrappedDatabases = new WeakMap(), pending = new Set();
        const store = value => Object.freeze({ count: () => value.count(), getAll: () => value.getAll(),
            index: name => value.index(name), get name() { return value.name; },
            get keyPath() { return value.keyPath; } });
        const transaction = (value, names) => { activeTransactions += 1;
            log("readonly_transaction_started", { stores: Array.isArray(names) ? names : [names] });
            let finished = false, settle; const completion = new Promise(resolve => { settle = resolve; });
            pending.add(completion);
            const finish = stage => { if (finished) return; finished = true; activeTransactions -= 1;
                pending.delete(completion); settle(); log(stage); };
            value.addEventListener("complete", () => finish("readonly_transaction_complete"));
            value.addEventListener("abort", () => finish("readonly_transaction_abort"));
            value.addEventListener("error", () => log("readonly_transaction_error"));
            return { objectStore: name => store(value.objectStore(name)),
                get oncomplete() { return value.oncomplete; }, set oncomplete(handler) {
                    value.oncomplete = handler; }, get onabort() { return value.onabort; },
                set onabort(handler) { value.onabort = handler; }, get onerror() { return value.onerror; },
                set onerror(handler) { value.onerror = handler; }, get error() { return value.error; } }; };
        const database = value => { if (wrappedDatabases.has(value)) return wrappedDatabases.get(value);
            openConnections += 1; let closed = false;
            const wrapped = Object.freeze({ get name() { return value.name; },
                get version() { return value.version; }, get objectStoreNames() {
                    return value.objectStoreNames; },
                close() { if (closed) return; closed = true;
                    value.close(); openConnections -= 1; connections.delete(wrapped);
                    log("connection_close"); },
                transaction(names, mode, ...rest) {
                    if (mode !== "readonly") throw new Error("readwrite_transaction_forbidden");
                    return transaction(value.transaction(names, mode, ...rest), names); } });
            wrappedDatabases.set(value, wrapped); connections.add(wrapped); return wrapped; };
        const guard = Object.freeze({ async databases() { const values = await indexedDB.databases();
            catalogSeen = true; exists = values.some(value => value.name === databaseName);
            log("db_catalog_confirmed", { databaseCount: values.length });
            log("target_db_checked", { exists }); return values; },
        open(name, ...rest) { if (name !== databaseName || rest.length || !catalogSeen || !exists)
            throw new Error("unverified_database_open_forbidden");
            openAttempts += 1;
            if (openAttempts === 2) log("schema_inventory_passed");
            log("indexeddb_open_started"); const request = indexedDB.open(name);
            request.addEventListener("success", () => log("indexeddb_open_success"));
            request.addEventListener("error", () => log("indexeddb_open_failure"));
            request.addEventListener("upgradeneeded", () => log("version_upgrade_forbidden"));
            return { get result() { return database(request.result); },
                get error() { return request.error; },
                get onsuccess() { return request.onsuccess; }, set onsuccess(handler) {
                    request.onsuccess = handler; }, get onerror() { return request.onerror; },
                set onerror(handler) { request.onerror = handler; },
                get onblocked() { return request.onblocked; }, set onblocked(handler) {
                    request.onblocked = handler; }, get onupgradeneeded() {
                    return request.onupgradeneeded; }, set onupgradeneeded(handler) {
                    request.onupgradeneeded = handler; }, get transaction() { return request.transaction; } }; } });
        return { guard, state: () => ({ catalogSeen, exists, openConnections, activeTransactions }),
            closeAll: () => { for (const connection of [...connections]) connection.close(); },
            settle: async () => { if (!pending.size) return;
                await Promise.race([Promise.all([...pending]), new Promise(resolve =>
                    setTimeout(resolve, 1000))]); } };
    }
    async function run({ indexedDB, gateTools, sourceId, databaseName, origin, session,
        emit = () => {} } = {}) {
        const stages = [], log = (stage, detail = {}) => { const value = Object.freeze({ stage,
            at: new Date().toISOString(), ...clone(detail) }); stages.push(value); emit(value); },
            wrapped = createGuard(indexedDB, databaseName, log);
        log("probe_started"); log("origin_session_confirmed", { origin, session });
        let result = null, error = null;
        try { if (!gateTools || typeof gateTools.preflight !== "function")
            throw new Error("gate_tools_unavailable");
            result = await gateTools.preflight({ indexedDB: wrapped.guard, databaseName, sourceId });
            if (result.ok) { log("schema_inventory_confirmed", { status: result.inventory?.status });
                log("snapshot_counts_fingerprint_acquired", { counts: result.counts,
                    fingerprint: result.productionSnapshotFingerprint });
                log("source_cursor_acquired", { present: Boolean(result.sourceCursor) });
                log("source_excluded_fingerprint_acquired", { fingerprint:
                    result.externalHistoryFingerprint }); }
            else if (result.inventory) log("schema_inventory_checked", { status: result.inventory.status });
        } catch (caught) { error = caught?.message || String(caught); log("probe_error", { error }); }
        finally { wrapped.closeAll(); await wrapped.settle(); }
        const state = wrapped.state();
        if (state.openConnections || state.activeTransactions) log("resource_leak_detected", state);
        const ok = !error && result?.ok === true && state.openConnections === 0 &&
            state.activeTransactions === 0;
        log("probe_finished", { ok, outcome: result?.outcome || null });
        return Object.freeze({ ok, error, outcome: result?.outcome || null, stages: clone(stages),
            result: clone(result), resources: state });
    }
    return Object.freeze({ createGuard, run });
});
