(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const restoreApi = commonJs
        ? require("../qriOptionsLastValidRestore.js")
        : root?.OptionMapQriOptionsLastValidRestore;
    const api = factory(restoreApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriOptionsLastValidReadOnlyStore = api;
})(typeof window !== "undefined" ? window : globalThis, function (restoreApi) {
    "use strict";

    const STORE_VERSION = 1;
    const STORAGE_KEY = "optionMapQriOptionsLastValidV1";

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function result(status, serialized, reason = null) {
        return deepFreeze({ storeVersion: STORE_VERSION, status, reason,
            storageKey: STORAGE_KEY, serialized });
    }

    function readQriOptionsLastValidSerialized(storage) {
        if (!storage || typeof storage.getItem !== "function") {
            return result("unavailable", null, "storage_unavailable");
        }
        try {
            const serialized = storage.getItem(STORAGE_KEY);
            if (serialized === null || serialized === undefined) {
                return result("missing", null, null);
            }
            return result("available", serialized, null);
        } catch (_error) {
            return result("unavailable", null, "storage_read_error");
        }
    }

    async function readAndRestoreQriOptionsLastValid(storage, context = {}) {
        const read = readQriOptionsLastValidSerialized(storage);
        if (read.status !== "available") {
            return deepFreeze({ status: read.status, reason: read.reason,
                read, restore: null, freshness: null, cache: null, canonical: null });
        }
        if (!restoreApi?.restoreQriOptionsLastValidWithFreshness) {
            return deepFreeze({ status: "unavailable", reason: "restore_unavailable",
                read, restore: null, freshness: null, cache: null, canonical: null });
        }
        const restore = await restoreApi.restoreQriOptionsLastValidWithFreshness(
            read.serialized, context);
        if (!restore.success) {
            return deepFreeze({ status: "invalid", reason: restore.reason,
                read, restore, freshness: null, cache: null, canonical: null });
        }
        return deepFreeze({ status: "restored", reason: null, read, restore,
            freshness: restore.freshness, cache: restore.cache,
            canonical: restore.canonical });
    }

    return Object.freeze({ STORE_VERSION, STORAGE_KEY,
        readQriOptionsLastValidSerialized, readAndRestoreQriOptionsLastValid });
});
