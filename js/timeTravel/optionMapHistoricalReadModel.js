(function (root, factory) {
    const storageApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("../morningBaselineV4Storage.js") : root?.OptionMapMorningBaselineV4StorageFoundation;
    const api = factory(storageApi, root);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapHistoricalReadModel = api;
})(typeof window !== "undefined" ? window : globalThis, function (morningStorage, root) {
    "use strict";
    const DATABASES = Object.freeze({
        observations: Object.freeze({ name: "optionMapMarketObservations", version: 1,
            stores: Object.freeze(["observations"]) }),
        qri: Object.freeze({ name: "optionMapQriOptionsHistory", version: 1,
            stores: Object.freeze(["qriOptionsHistoryMeta", "qriOptionsEntries", "qriOptionsRevisions"]) })
    });
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
    const requestValue = request => new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const transactionDone = transaction => new Promise((resolve, reject) => {
        transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => undefined; });
    async function catalog(indexedDB) {
        if (typeof indexedDB?.databases !== "function") throw new Error("database_catalog_unavailable");
        return indexedDB.databases();
    }
    async function readDatabase(indexedDB, descriptor, reader) {
        const available = await catalog(indexedDB), found = available.find(item => item.name === descriptor.name);
        if (!found) return { status: "absent", value: null };
        if (found.version !== descriptor.version) return { status: "schema_mismatch", value: null };
        let database = null;
        try {
            database = await new Promise((resolve, reject) => {
                const open = indexedDB.open(descriptor.name, descriptor.version);
                open.onupgradeneeded = () => { open.transaction?.abort();
                    reject(new Error("database_upgrade_forbidden")); };
                open.onsuccess = () => resolve(open.result);
                open.onerror = () => reject(open.error || new Error("database_open_failed"));
                open.onblocked = () => reject(new Error("database_open_blocked"));
            });
            if (descriptor.stores.some(name => !database.objectStoreNames.contains(name)))
                return { status: "schema_mismatch", value: null };
            return { status: "available", value: await reader(database) };
        } catch (_error) { return { status: "unavailable", value: null }; }
        finally { database?.close(); }
    }
    async function observationsFor(indexedDB, calendarDate) {
        return readDatabase(indexedDB, DATABASES.observations, async database => {
            const transaction = database.transaction("observations", "readonly"), done = transactionDone(transaction);
            const records = await requestValue(transaction.objectStore("observations")
                .index("byMarketDate").getAll(calendarDate));
            await done;
            return clone(records).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
        });
    }
    async function qriFor(indexedDB, calendarDate) {
        return readDatabase(indexedDB, DATABASES.qri, async database => {
            const transaction = database.transaction("qriOptionsEntries", "readonly"),
                done = transactionDone(transaction), entries = await requestValue(transaction
                    .objectStore("qriOptionsEntries").index("bySourceDate").getAll(calendarDate));
            await done;
            return clone(entries).sort((a, b) => a.contract.localeCompare(b.contract));
        });
    }
    async function morningFor(storage, calendarDate) {
        let raw = null;
        try { raw = storage?.getItem?.(morningStorage.STORAGE_KEY) ?? null; }
        catch (_error) { return { status: "unavailable", value: null }; }
        if (raw === null) return { status: "absent", value: null };
        const restored = await morningStorage.restoreMorningBaselineV4Storage(raw);
        if (!restored?.success) return { status: "schema_mismatch", value: null };
        const series = restored.container.series.filter(item => item.formalTradingDate === calendarDate);
        const values = series.map(item => ({ scopeId: item.scopeId, contract: item.contract,
            formalTradingDate: item.formalTradingDate, activeBaselineId: item.activeBaselineId,
            baseline: clone(item.revisions.find(revision =>
                revision.baselineId === item.activeBaselineId)?.snapshot || null) }))
            .filter(item => item.baseline);
        return { status: "available", value: values };
    }
    function statusOf(parts) {
        if (parts.some(item => item.status === "schema_mismatch")) return "schema_mismatch";
        if (parts.some(item => item.status === "unavailable")) return "unavailable";
        return "available";
    }
    async function read({ calendarDate, indexedDB = root?.indexedDB,
        localStorage = root?.localStorage } = {}) {
        if (!validDate(calendarDate)) return Object.freeze({ status: "invalid", calendarDate,
            available: false });
        const [observations, morning, qri] = await Promise.all([
            observationsFor(indexedDB, calendarDate), morningFor(localStorage, calendarDate),
            qriFor(indexedDB, calendarDate)
        ]);
        const observationList = observations.value || [], morningList = morning.value || [],
            qriEntries = qri.value || [], latestObservation = observationList.at(-1) || null,
            contracts = [...new Set(qriEntries.map(item => item.contract))].sort();
        return Object.freeze({ status: statusOf([observations, morning, qri]), calendarDate,
            available: Boolean(latestObservation || morningList.length || contracts.length),
            latestObservation: clone(latestObservation), observationCount: observationList.length,
            morningBaselines: clone(morningList), qri: Object.freeze({ available: contracts.length > 0,
                contracts, selectedContract: contracts[0] || null }),
            availability: Object.freeze({ observation: observations.status, morning: morning.status,
                qri: qri.status, weeklyOptions: "not_queried", weeklyFutures: "not_queried",
                participant: "not_queried", jpxSnapshot: "not_queried" }) });
    }
    return Object.freeze({ DATABASES, read, observationsFor, qriFor, morningFor });
});
