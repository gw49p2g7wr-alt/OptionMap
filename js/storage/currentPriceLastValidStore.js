(function (root, factory) {
    const cacheApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("../currentPriceLastValidCache.js") : root?.OptionMapCurrentPriceLastValidCache;
    const shadowApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("../currentPriceFreshnessShadow.js") : root?.OptionMapCurrentPriceFreshnessShadow;
    const api = factory(cacheApi, shadowApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapCurrentPriceLastValidStore = api;
})(typeof window !== "undefined" ? window : globalThis, function (cacheApi, shadowApi) {
    "use strict";

    const STORE_VERSION = 1;
    const STORAGE_KEY = "optionMapCurrentPriceLastValidV1";

    function failure(reason, cache = null) {
        return Object.freeze({ success: false, saved: false, reason, cache });
    }

    function contractsMatch(rawContract, canonicalContract) {
        if (typeof rawContract !== "string" || typeof canonicalContract !== "string" ||
            !/^20\d{2}-(0[1-9]|1[0-2])$/.test(canonicalContract)) return false;
        if (rawContract.trim() === canonicalContract) return true;
        const match = rawContract.trim().match(/^(\d{2}|20\d{2})年\s*(\d{1,2})月限$/);
        if (!match) return false;
        const canonicalYear = canonicalContract.slice(0, 4);
        const yearMatches = match[1].length === 4 ? match[1] === canonicalYear
            : match[1] === canonicalYear.slice(2);
        return yearMatches && Number(match[2]) === Number(canonicalContract.slice(5));
    }

    async function buildAndSaveCurrentPriceLastValid(storage, input = {}, context = {}) {
        if (!storage || typeof storage.setItem !== "function") return failure("storage_unavailable");
        if (context.requestMode !== "auto" || context.requestOrigin !== "live") {
            return failure("request_context_ineligible");
        }
        if (context.responseStatus === "stale_ignored" || context.responseStatus === "stale" ||
            context.isCurrent === false || typeof context.isCurrent === "function" && !context.isCurrent()) {
            return failure("stale_response");
        }
        const price = input.price || {};
        if (price.mode !== "automatic" || price.source !== cacheApi?.SOURCE) {
            return failure("price_source_ineligible");
        }
        if (input.restored === true || context.restored === true) return failure("restored_price_ineligible");
        if (!contractsMatch(price.contract, input.activeContract)) return failure("contract_mismatch");
        if (!cacheApi?.buildCurrentPriceLastValidCache || !shadowApi?.evaluateCurrentPriceFreshness) {
            return failure("dependency_unavailable");
        }

        let built;
        try {
            built = await cacheApi.buildCurrentPriceLastValidCache({
                source: price.source, mode: price.mode, value: price.value,
                contract: input.activeContract, tradingDate: input.tradingDate,
                quotedAtRaw: price.quotedAt, fetchedAt: price.fetchedAt,
                sourceUrl: input.sourceUrl
            });
        } catch (_) { return failure("cache_builder_error"); }
        if (!built?.success || !built.cache) return failure("cache_builder_failed");
        let valid = false;
        try { valid = await cacheApi.validateCurrentPriceLastValidCache(built.cache); }
        catch (_) { return failure("cache_validation_error"); }
        if (!valid) return failure("cache_validation_failed");

        const shadow = shadowApi.evaluateCurrentPriceFreshness({
            value: built.cache.value, source: built.cache.source, mode: built.cache.mode,
            contract: built.cache.contract, quotedAt: built.cache.quotedAtNormalized,
            fetchedAt: built.cache.fetchedAt
        }, { origin: "live", dataTradingDate: built.cache.tradingDate,
            expectedTradingDate: built.cache.tradingDate, selectedContract: input.activeContract,
            lastAttemptStatus: "success", signatureValid: true });
        if (shadow?.freshness?.status !== "fresh" || shadow.freshness.reason !== "current" ||
            shadow.freshness.origin !== "live") return failure("freshness_ineligible", built.cache);
        if (context.isCurrent === false || typeof context.isCurrent === "function" && !context.isCurrent()) {
            return failure("stale_response");
        }

        let serialized;
        try { serialized = JSON.stringify(built.cache); }
        catch (_) { return failure("serialization_error"); }
        try { storage.setItem(STORAGE_KEY, serialized); }
        catch (_) { return failure("storage_write_error"); }
        return Object.freeze({ success: true, saved: true, reason: null,
            cache: built.cache, serialized, freshness: shadow.freshness });
    }

    return Object.freeze({ STORE_VERSION, STORAGE_KEY, contractsMatch,
        buildAndSaveCurrentPriceLastValid });
});
