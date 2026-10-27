(function (root, factory) {
    const node = typeof module === "object" && module.exports && !(root && root.document);
    const api = factory(
        node ? require("./marketCalendarHistory/readOnlyCalendarConsumer.js") :
            root?.OptionMapMarketCalendarReadOnlyConsumer,
        node ? require("./storage/marketCalendarRuntimeStateStore.js") :
            root?.OptionMapCalendarRuntimeStateStore,
        node ? require("./calendarExportV1.js") : root?.OptionMapCalendarExportV1
    );
    if (node) module.exports = api;
    if (root) root.OptionMapCalendarExportRuntime = api;
})(typeof window !== "undefined" ? window : globalThis, function (Reader, RuntimeStore, ExportV1) {
    "use strict";
    function create({ indexedDB = globalThis.indexedDB } = {}) {
        async function exportCurrent({ appVersion, generatedAt } = {}) {
            let runtimeStates = [];
            try {
                const store = RuntimeStore.createRuntimeStateStore({ indexedDB,
                    targetEnvironment: "browser_runtime" }), runtime = await store.readAll();
                if (runtime.status === "ok" && Array.isArray(runtime.value)) runtimeStates = runtime.value;
            } catch (_error) {}
            const archiveResult = await Reader.readArchive({ indexedDB, runtimeStates });
            return ExportV1.create({ appVersion, generatedAt, selection: { mode: "current" },
                archiveResult, runtimeStates });
        }
        return Object.freeze({ exportCurrent });
    }
    return Object.freeze({ create });
});
