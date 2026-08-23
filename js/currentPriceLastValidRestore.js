(function (root, factory) {
    const cacheApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./currentPriceLastValidCache.js") : root?.OptionMapCurrentPriceLastValidCache;
    const shadowApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./currentPriceFreshnessShadow.js") : root?.OptionMapCurrentPriceFreshnessShadow;
    const api = factory(cacheApi, shadowApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapCurrentPriceLastValidRestore = api;
})(typeof window !== "undefined" ? window : globalThis, function (cacheApi, shadowApi) {
    "use strict";

    const RESTORE_VERSION = 1;

    function object(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function deepClone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        for (const nested of Object.values(value)) deepFreeze(nested);
        return Object.freeze(value);
    }

    function failure(reason, inputType, detail = null) {
        return Object.freeze({ success: false, reason, cache: null,
            diagnostics: Object.freeze({ restoreVersion: RESTORE_VERSION, inputType,
                parsed: false, validated: false, integrityVerified: false, detail }) });
    }

    function parseCurrentPriceLastValidCache(serialized) {
        if (serialized === null) return failure("input_null", "serialized");
        if (serialized === undefined) return failure("input_undefined", "serialized");
        if (typeof serialized !== "string") return failure("serialized_type_invalid", typeof serialized);
        if (!serialized.trim()) return failure("input_blank", "serialized");
        try {
            const parsed = JSON.parse(serialized);
            if (!object(parsed)) return failure("parsed_type_invalid", "serialized");
            return Object.freeze({ success: true, reason: null, cache: parsed,
                diagnostics: Object.freeze({ restoreVersion: RESTORE_VERSION,
                    inputType: "serialized", parsed: true, validated: false,
                    integrityVerified: false, detail: null }) });
        } catch (_) {
            return failure("parse_error", "serialized");
        }
    }

    async function restoreCurrentPriceLastValidCache(input) {
        let candidate; let inputType;
        if (typeof input === "string" || input === null || input === undefined) {
            const parsed = parseCurrentPriceLastValidCache(input);
            if (!parsed.success) return parsed;
            candidate = parsed.cache;
            inputType = "serialized";
        } else if (object(input)) {
            candidate = input;
            inputType = "object";
        } else {
            return failure("input_type_invalid", typeof input);
        }

        let isolated;
        try {
            isolated = deepClone(candidate);
        } catch (_) {
            return failure("clone_error", inputType);
        }
        if (isolated?.cacheVersion === 1 && isolated?.schemaVersion === 1) {
            return failure("schema_v1_unsupported", inputType);
        }
        if (!cacheApi?.validateCurrentPriceLastValidCacheV2) {
            return failure("validator_unavailable", inputType);
        }
        let valid = false;
        try {
            valid = await cacheApi.validateCurrentPriceLastValidCacheV2(isolated);
        } catch (_) {
            return failure("validation_error", inputType);
        }
        if (!valid) return failure("cache_invalid", inputType);
        const frozen = deepFreeze(isolated);
        return Object.freeze({ success: true, reason: null, cache: frozen,
            diagnostics: Object.freeze({ restoreVersion: RESTORE_VERSION, inputType,
                parsed: inputType === "serialized", validated: true,
                integrityVerified: true, detail: null }) });
    }

    async function restoreCurrentPriceLastValidWithFreshness(input, context = {}) {
        const restored = await restoreCurrentPriceLastValidCache(input);
        if (!restored.success) {
            return Object.freeze({ ...restored, freshness: null, shadow: null });
        }
        if (!shadowApi?.evaluateCurrentPriceFreshness) {
            return Object.freeze({ success: false, reason: "freshness_shadow_unavailable",
                cache: null, freshness: null, shadow: null, diagnostics: restored.diagnostics });
        }
        const cache = restored.cache;
        const shadow = shadowApi.evaluateCurrentPriceFreshness({
            value: cache.value, source: cache.source, mode: cache.mode,
            contract: cache.contract, quotedAt: cache.quotedAtNormalized,
            fetchedAt: cache.fetchedAt
        }, { ...context, restored: true, dataTradingDate: cache.quoteDate,
            signatureValid: true });
        return Object.freeze({ ...restored, freshness: shadow.freshness, shadow });
    }

    return Object.freeze({ RESTORE_VERSION, parseCurrentPriceLastValidCache,
        restoreCurrentPriceLastValidCache, restoreCurrentPriceLastValidWithFreshness,
        deepFreeze });
});
