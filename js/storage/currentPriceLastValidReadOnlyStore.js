(function (root, factory) {
    const restoreApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("../currentPriceLastValidRestore.js") : root?.OptionMapCurrentPriceLastValidRestore;
    const api = factory(restoreApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapCurrentPriceLastValidReadOnlyStore = api;
})(typeof window !== "undefined" ? window : globalThis, function (restoreApi) {
    "use strict";

    const STORE_VERSION = 1;
    const STORAGE_KEY = "optionMapCurrentPriceLastValidV1";

    function result(status, serialized, reason = null) {
        return Object.freeze({ storeVersion: STORE_VERSION, status, reason,
            storageKey: STORAGE_KEY, serialized });
    }

    function readCurrentPriceLastValidSerialized(storage) {
        if (!storage || typeof storage.getItem !== "function") {
            return result("unavailable", null, "storage_unavailable");
        }
        try {
            const serialized = storage.getItem(STORAGE_KEY);
            if (serialized === null || serialized === undefined) {
                return result("missing", null, null);
            }
            return result("available", serialized, null);
        } catch (_) {
            return result("unavailable", null, "storage_read_error");
        }
    }

    async function readAndRestoreCurrentPriceLastValid(storage, context = {}) {
        const read = readCurrentPriceLastValidSerialized(storage);
        if (read.status !== "available") {
            return Object.freeze({ status: read.status, reason: read.reason,
                read, restore: null, freshness: null, cache: null });
        }
        if (!restoreApi?.restoreCurrentPriceLastValidWithFreshness) {
            return Object.freeze({ status: "unavailable", reason: "restore_unavailable",
                read, restore: null, freshness: null, cache: null });
        }
        const restore = await restoreApi.restoreCurrentPriceLastValidWithFreshness(
            read.serialized, context);
        if (!restore.success) {
            return Object.freeze({ status: "invalid", reason: restore.reason,
                read, restore, freshness: null, cache: null });
        }
        return Object.freeze({ status: "restored", reason: null, read, restore,
            freshness: restore.freshness, cache: restore.cache });
    }

    return Object.freeze({ STORE_VERSION, STORAGE_KEY,
        readCurrentPriceLastValidSerialized, readAndRestoreCurrentPriceLastValid });
});
