(function (root, factory) {
    const node = typeof module === "object" && module.exports && !(root && root.document);
    const api = factory(
        node ? require("./marketCalendarHistory/readOnlyCalendarConsumer.js") :
            root?.OptionMapMarketCalendarReadOnlyConsumer,
        node ? require("./storage/marketCalendarRuntimeStateStore.js") :
            root?.OptionMapCalendarRuntimeStateStore,
        node ? require("./calendarExportV1.js") : root?.OptionMapCalendarExportV1,
        root
    );
    if (node) module.exports = api;
    if (root) root.OptionMapCalendarExportRuntime = api;
})(typeof window !== "undefined" ? window : globalThis, function (Reader, RuntimeStore, ExportV1, root) {
    "use strict";
    const unavailable = reason => Object.freeze({ status: "unavailable", reason,
        value: Object.freeze([]), invalidSources: Object.freeze([]) });
    async function readRuntimeStates(indexedDB) {
        const Store = RuntimeStore || root?.OptionMapCalendarRuntimeStateStore;
        if (!Store?.createRuntimeStateStore) return unavailable("runtime_state_store_unavailable");
        try {
            const result = await Store.createRuntimeStateStore({ indexedDB,
                targetEnvironment: "browser_runtime" }).readAll();
            if (result?.status === "ok" && Array.isArray(result.value)) return Object.freeze({
                status: "ok", reason: null, value: Object.freeze([...result.value]),
                invalidSources: Object.freeze([...(result.invalidSources || [])]) });
            if (result?.status === "absent") return Object.freeze({ status: "absent",
                reason: null, value: Object.freeze([]), invalidSources: Object.freeze([]) });
            return unavailable(result?.reason || "runtime_state_access_failed");
        } catch (_error) { return unavailable("runtime_state_access_failed"); }
    }
    function create({ indexedDB = globalThis.indexedDB } = {}) {
        async function exportCurrent({ appVersion, generatedAt } = {}) {
            const runtimeStateRead = await readRuntimeStates(indexedDB),
                runtimeStates = runtimeStateRead.status === "ok" ? runtimeStateRead.value : [];
            const archiveResult = await Reader.readArchive({ indexedDB, runtimeStates });
            return ExportV1.create({ appVersion, generatedAt, selection: { mode: "current" },
                archiveResult, runtimeStates, runtimeStateRead });
        }
        return Object.freeze({ exportCurrent });
    }
    return Object.freeze({ create });
});
