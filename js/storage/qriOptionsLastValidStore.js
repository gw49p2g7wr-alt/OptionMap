(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const cacheApi = commonJs
        ? require("../qriOptionsLastValidCache.js")
        : root?.OptionMapQriOptionsLastValidCache;
    const api = factory(cacheApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriOptionsLastValidStore = api;
})(typeof window !== "undefined" ? window : globalThis, function (cacheApi) {
    "use strict";

    const STORE_VERSION = 1;
    const STORAGE_KEY = "optionMapQriOptionsLastValidV1";

    function result(success, saved, reason, cache = null, serialized = null) {
        return Object.freeze({ success, saved, reason, cache, serialized });
    }

    function current(context) {
        return context.isCurrent !== false &&
            !(typeof context.isCurrent === "function" && !context.isCurrent());
    }

    function publishedTypes(canonical) {
        const records = Array.isArray(canonical?.records) ? canonical.records : [];
        return new Set(records.filter(record => record.published === true)
            .map(record => record.optionType));
    }

    async function buildAndSaveQriOptionsLastValid(storage, input = {}, context = {}) {
        if (!storage || typeof storage.setItem !== "function") {
            return result(false, false, "storage_unavailable");
        }
        if (context.channel !== "active" || context.requestMode !== "auto" ||
            context.acquisitionOrigin !== "live") {
            return result(false, false, "request_context_ineligible");
        }
        if (!current(context)) return result(false, false, "stale_response");
        if (input.restored === true || context.restored === true) {
            return result(false, false, "restored_cache_ineligible");
        }
        const canonical = input.canonical;
        const types = publishedTypes(canonical);
        if (canonical?.openInterestStatus !== "available" ||
            !types.has("call") || !types.has("put")) {
            return result(false, false, "open_interest_not_fully_available");
        }
        if (context.sourceStatus !== "acquired" ||
            !["available", "success"].includes(context.responseStatus)) {
            return result(false, false, "source_not_acquired");
        }
        if (!input.activeContract || input.activeContract !== canonical.contract ||
            input.responseContract !== canonical.contract) {
            return result(false, false, "contract_mismatch");
        }
        if (!cacheApi?.buildQriOptionsLastValidCache ||
            !cacheApi?.validateQriOptionsLastValidCache) {
            return result(false, false, "dependency_unavailable");
        }

        let built;
        try {
            built = await cacheApi.buildQriOptionsLastValidCache({ channel: "active",
                mode: "auto", acquisitionOrigin: "live", isCurrent: true,
                available: true, sourceStatus: "acquired", status: "available",
                canonical, canonicalSignature: input.canonicalSignature,
                canonicalVersionKey: input.canonicalVersionKey,
                fetchedAt: input.fetchedAt, activeContract: input.activeContract,
                responseContract: input.responseContract,
                requestContext: { channel: "active", mode: "auto",
                    acquisitionOrigin: "live", requestId: input.requestId,
                    requestedContract: "auto", responseContract: input.responseContract } });
        } catch (_error) {
            return result(false, false, "cache_builder_error");
        }
        if (!built?.success || !built.cache) {
            return result(false, false, built?.reason || "cache_builder_failed");
        }
        let valid = false;
        try {
            valid = await cacheApi.validateQriOptionsLastValidCache(built.cache);
        } catch (_error) {
            return result(false, false, "cache_validation_error");
        }
        if (!valid) return result(false, false, "cache_validation_failed");
        if (!current(context)) return result(false, false, "stale_response");

        let serialized;
        try {
            serialized = JSON.stringify(built.cache);
        } catch (_error) {
            return result(false, false, "serialization_error");
        }
        try {
            storage.setItem(STORAGE_KEY, serialized);
        } catch (_error) {
            return result(false, false, "storage_write_error");
        }
        return result(true, true, null, built.cache, serialized);
    }

    return Object.freeze({ STORE_VERSION, STORAGE_KEY,
        buildAndSaveQriOptionsLastValid });
});
