(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const cacheApi = commonJs
        ? require("./qriOptionIvLastValidCache.js")
        : root?.OptionMapQriOptionIvLastValidCache;
    const freshnessApi = commonJs
        ? require("./dataFreshness.js") : root?.OptionMapDataFreshness;
    const api = factory(cacheApi, freshnessApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriOptionIvLastValidRestore = api;
})(typeof window !== "undefined" ? window : globalThis, function (cacheApi, freshnessApi) {
    "use strict";

    const RESTORE_VERSION = 1;

    function object(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function clone(value) {
        return typeof structuredClone === "function"
            ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    }

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function diagnostics(inputType, values = {}) {
        return deepFreeze({ restoreVersion: RESTORE_VERSION, inputType,
            parsed: values.parsed === true, validated: values.validated === true,
            integrityVerified: values.integrityVerified === true,
            canonicalDetached: values.canonicalDetached === true,
            detail: values.detail || null });
    }

    function failure(reason, inputType, values = {}) {
        return deepFreeze({ success: false, reason, cache: null, canonical: null,
            diagnostics: diagnostics(inputType, values) });
    }

    function parseQriOptionIvLastValidCache(serialized) {
        if (serialized === null) return failure("input_null", "serialized");
        if (serialized === undefined) return failure("input_undefined", "serialized");
        if (typeof serialized !== "string") {
            return failure("serialized_type_invalid", typeof serialized);
        }
        if (!serialized.trim()) return failure("input_blank", "serialized");
        try {
            const parsed = JSON.parse(serialized);
            if (!object(parsed)) return failure("parsed_type_invalid", "serialized");
            return deepFreeze({ success: true, reason: null, cache: parsed, canonical: null,
                diagnostics: diagnostics("serialized", { parsed: true }) });
        } catch (_error) {
            return failure("parse_error", "serialized");
        }
    }

    async function restoreQriOptionIvLastValidCache(input) {
        let candidate; let inputType; let parsed = false;
        if (typeof input === "string" || input === null || input === undefined) {
            const result = parseQriOptionIvLastValidCache(input);
            if (!result.success) return result;
            candidate = result.cache; inputType = "serialized"; parsed = true;
        } else if (object(input)) {
            candidate = input; inputType = "object";
        } else {
            return failure("input_type_invalid", typeof input);
        }
        let isolated;
        try {
            isolated = clone(candidate);
        } catch (_error) {
            return failure("clone_error", inputType, { parsed });
        }
        if (!cacheApi?.validateQriOptionIvLastValidCache) {
            return failure("validator_unavailable", inputType, { parsed });
        }
        let valid = false;
        try {
            valid = await cacheApi.validateQriOptionIvLastValidCache(isolated);
        } catch (_error) {
            return failure("validation_error", inputType, { parsed });
        }
        if (!valid) return failure("cache_invalid", inputType, { parsed });
        const frozenCache = deepFreeze(isolated);
        return deepFreeze({ success: true, reason: null, cache: frozenCache,
            canonical: frozenCache.canonical,
            diagnostics: diagnostics(inputType, { parsed, validated: true,
                integrityVerified: true, canonicalDetached: true }) });
    }

    async function restoreQriOptionIvLastValidWithFreshness(input, context = {}) {
        const restored = await restoreQriOptionIvLastValidCache(input);
        if (!restored.success) {
            return deepFreeze({ ...restored, freshnessInput: null, freshness: null });
        }
        if (!cacheApi?.createFreshnessInput) {
            return deepFreeze({ success: false, reason: "freshness_adapter_unavailable",
                cache: null, canonical: null, freshnessInput: null, freshness: null,
                diagnostics: restored.diagnostics });
        }
        const adapted = await cacheApi.createFreshnessInput(restored.cache);
        if (!adapted.success) {
            return deepFreeze({ success: false, reason: adapted.reason,
                cache: null, canonical: null, freshnessInput: null, freshness: null,
                diagnostics: restored.diagnostics });
        }
        const freshnessInput = deepFreeze({ ...clone(adapted.input),
            expectedTradingDate: context.expectedTradingDate || null,
            currentReferenceDate: context.currentReferenceDate || null,
            contractMatches: typeof context.contractMatches === "boolean"
                ? context.contractMatches : null,
            lastAttemptStatus: context.lastAttemptStatus || "not_attempted",
            lastAttemptedAt: context.lastAttemptedAt || null });
        const freshness = freshnessApi?.evaluateDailyFreshness
            ? freshnessApi.evaluateDailyFreshness(freshnessInput) : null;
        return deepFreeze({ ...restored, freshnessInput, freshness });
    }

    return Object.freeze({ RESTORE_VERSION, parseQriOptionIvLastValidCache,
        restoreQriOptionIvLastValidCache, restoreQriOptionIvLastValidWithFreshness,
        deepFreeze });
});
