(function (root, factory) {
    const cacheApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("../qriOptionIvLastValidCache.js")
        : root?.OptionMapQriOptionIvLastValidCache;
    const api = factory(cacheApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapQriOptionIvLastValidStore = api;
})(typeof window !== "undefined" ? window : globalThis, function (cacheApi) {
    "use strict";

    const STORE_VERSION = 1;
    const STORAGE_KEY = "optionMapQriOptionIvLastValidV1";

    function result(success, saved, reason, cache = null, serialized = null) {
        return Object.freeze({ success, saved, reason, cache, serialized });
    }

    function current(context) {
        return context.isCurrent !== false &&
            !(typeof context.isCurrent === "function" && !context.isCurrent());
    }

    async function buildAndSaveQriOptionIvLastValid(storage, input = {}, context = {}) {
        if (!storage || typeof storage.setItem !== "function") {
            return result(false, false, "storage_unavailable");
        }
        if (context.channel !== "active" || context.requestMode !== "auto" ||
            context.acquisitionOrigin !== "live") {
            return result(false, false, "request_context_ineligible");
        }
        if (!["available", "success"].includes(context.responseStatus) || !current(context)) {
            return result(false, false, "stale_or_unsuccessful_response");
        }
        if (input.restored === true || context.restored === true) {
            return result(false, false, "restored_cache_ineligible");
        }
        const candidate = input.candidate;
        if (!candidate?.available || candidate.sourceStatus !== "acquired" ||
            !candidate.canonical || candidate.reason !== null) {
            return result(false, false, "runtime_candidate_ineligible");
        }
        if (!input.activeContract || input.activeContract !== candidate.contract ||
            input.responseContract !== candidate.contract) {
            return result(false, false, "contract_mismatch");
        }
        if (!cacheApi?.buildQriOptionIvLastValidCache ||
            !cacheApi?.validateQriOptionIvLastValidCache) {
            return result(false, false, "dependency_unavailable");
        }

        let built;
        try {
            built = await cacheApi.buildQriOptionIvLastValidCache({
                channel: "active",
                available: candidate.available,
                sourceStatus: candidate.sourceStatus,
                status: context.responseStatus,
                canonical: candidate.canonical,
                canonicalSignature: candidate.signature,
                canonicalVersionKey: candidate.versionKey,
                fetchedAt: candidate.fetchedAt,
                activeContract: input.activeContract,
                acquisitionOrigin: "live",
                requestContext: { mode: "auto",
                    requestId: candidate.requestContext?.requestId }
            });
        } catch (_error) {
            return result(false, false, "cache_builder_error");
        }
        if (!built?.success || !built.cache) {
            return result(false, false, built?.reason || "cache_builder_failed");
        }
        let valid = false;
        try {
            valid = await cacheApi.validateQriOptionIvLastValidCache(built.cache);
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
        buildAndSaveQriOptionIvLastValid });
});
