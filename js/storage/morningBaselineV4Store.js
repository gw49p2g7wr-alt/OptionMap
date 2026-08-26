(function (root, factory) {
    const storageApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("../morningBaselineV4Storage.js") : root?.OptionMapMorningBaselineV4StorageFoundation;
    const api = factory(storageApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMorningBaselineV4Store = api;
})(typeof window !== "undefined" ? window : globalThis, function (storageApi) {
    "use strict";
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    const result = overrides => freeze({ saved: false, status: "unavailable", reason: null,
        changed: false, duplicate: false, writeCount: 0, ...overrides });
    function createStore(storage, configuration = {}) {
        async function saveContainer(container) {
            if (!storage || typeof storage.setItem !== "function")
                return result({ reason: "storage_unavailable" });
            const serialized = await storageApi.serializeMorningBaselineV4Storage(container,
                { stringify: configuration.stringify });
            if (!serialized.success) return result({ reason: serialized.reason });
            try { storage.setItem(storageApi.STORAGE_KEY, serialized.serialized); }
            catch (error) { return result({ reason: error?.name === "QuotaExceededError"
                ? "quota_exceeded" : "storage_write_failed" }); }
            return result({ saved: true, status: "saved", reason: null, changed: true,
                writeCount: 1, serialized: serialized.serialized });
        }
        async function save(baseline) {
            if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function")
                return result({ reason: "storage_unavailable" });
            let existingSerialized;
            try { existingSerialized = storage.getItem(storageApi.STORAGE_KEY); }
            catch (_error) { return result({ reason: "storage_read_failed" }); }
            let existingContainer = null;
            if (existingSerialized !== null && existingSerialized !== undefined && existingSerialized !== "") {
                const restored = await storageApi.restoreMorningBaselineV4Storage(existingSerialized);
                if (!restored.success) return result({ reason: "existing_storage_invalid" });
                existingContainer = restored.container;
            }
            const built = await storageApi.buildMorningBaselineV4Storage({ baseline, existingContainer });
            if (!built.success) return result({ reason: built.reason });
            if (!built.changed) return result({ saved: false, status: "unchanged", reason: null,
                duplicate: true });
            return saveContainer(built.container);
        }
        return Object.freeze({ save, saveContainer });
    }
    return Object.freeze({ STORAGE_KEY: storageApi.STORAGE_KEY, createStore });
});
