(function (root, factory) {
    const storageApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("../morningBaselineV4Storage.js") : root?.OptionMapMorningBaselineV4StorageFoundation;
    const api = factory(storageApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMorningBaselineV4ReadOnlyStore = api;
})(typeof window !== "undefined" ? window : globalThis, function (storageApi) {
    "use strict";
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    const failure = (reason, status = "unavailable") => freeze({ status, reason, container: null });
    function createReadOnlyStore(storage) {
        async function read() {
            if (!storage || typeof storage.getItem !== "function") return failure("storage_unavailable");
            let serialized;
            try { serialized = storage.getItem(storageApi.STORAGE_KEY); }
            catch (_error) { return failure("storage_read_failed"); }
            const restored = await storageApi.restoreMorningBaselineV4Storage(serialized);
            if (!restored.success) return failure(restored.reason, restored.status);
            return freeze({ status: "ready", reason: null, container: freeze(clone(restored.container)) });
        }
        return Object.freeze({ read });
    }
    return Object.freeze({ STORAGE_KEY: storageApi.STORAGE_KEY, createReadOnlyStore });
});
