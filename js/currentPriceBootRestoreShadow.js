(function (root, factory) {
    const readOnlyStoreApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./storage/currentPriceLastValidReadOnlyStore.js")
        : root?.OptionMapCurrentPriceLastValidReadOnlyStore;
    const api = factory(readOnlyStoreApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapCurrentPriceBootRestoreShadow = api;
})(typeof window !== "undefined" ? window : globalThis, function (readOnlyStoreApi) {
    "use strict";

    const SHADOW_VERSION = 1;

    function text(value) {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    function timestamp(value) {
        const candidate = text(value);
        return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : null;
    }

    function clone(value) {
        return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        for (const nested of Object.values(value)) deepFreeze(nested);
        return Object.freeze(value);
    }

    function diagnostics(context, readResult, extra = {}) {
        const activeContract = text(context?.activeContract);
        const expectedTradingDate = text(context?.expectedTradingDate);
        return {
            shadowVersion: SHADOW_VERSION,
            readStatus: readResult?.status ?? null,
            restoreStatus: readResult?.restore?.success === true ? "verified"
                : readResult?.restore?.success === false ? "rejected" : "not_executed",
            integrityVerified: readResult?.restore?.diagnostics?.integrityVerified === true,
            activeContractContext: activeContract ? "available" : "unknown",
            activeContract,
            expectedTradingDateContext: expectedTradingDate ? "available" : "unknown",
            expectedTradingDate,
            bootGeneration: context?.bootGeneration ?? null,
            requestId: text(context?.requestId),
            candidateIdentity: readResult?.cache?.versionKey ?? null,
            currentPriceApplied: false,
            liveOverwriteAllowed: false,
            storageMutation: false,
            ...extra
        };
    }

    function state(status, reason, context, readResult, values = {}) {
        return deepFreeze({
            status,
            reason,
            cache: values.cache ?? null,
            freshness: values.freshness ?? null,
            candidate: values.candidate ?? null,
            displayEligible: values.displayEligible === true,
            calculationEligible: values.calculationEligible ?? "undetermined",
            restoredAt: timestamp(context?.restoredAt),
            diagnostics: diagnostics(context, readResult, values.diagnostics)
        });
    }

    function candidate(cache) {
        return {
            origin: "cache",
            value: cache.value,
            source: cache.source,
            mode: cache.mode,
            contract: cache.contract,
            quoteDate: cache.quoteDate,
            quotedAt: cache.quotedAtNormalized,
            quotedAtRaw: cache.quotedAtRaw,
            quotedAtNormalized: cache.quotedAtNormalized,
            fetchedAt: cache.fetchedAt,
            pageTradingDate: cache.pageTradingDate,
            pageUpdatedAt: cache.pageUpdatedAt
        };
    }

    async function buildCurrentPriceBootRestoreShadow({ storage, context = {} } = {}) {
        if (!readOnlyStoreApi?.readAndRestoreCurrentPriceLastValid) {
            return state("unavailable", "read_only_store_unavailable", context, null);
        }

        let restored;
        try {
            restored = await readOnlyStoreApi.readAndRestoreCurrentPriceLastValid(storage, {
                expectedTradingDate: context?.expectedTradingDate,
                currentReferenceDate: context?.currentReferenceDate,
                selectedContract: context?.activeContract,
                lastAttemptedAt: context?.lastAttemptedAt,
                lastAttemptStatus: context?.lastAttemptStatus
            });
        } catch (_) {
            return state("unavailable", "restore_read_error", context, null,
                { diagnostics: { exceptionContained: true } });
        }

        if (restored.status === "missing") {
            return state("missing", null, context, restored);
        }
        if (restored.status === "unavailable") {
            return state("unavailable", restored.reason, context, restored);
        }
        if (restored.status !== "restored" || !restored.cache || !restored.freshness) {
            return state("invalid", restored.reason || "restore_invalid", context, restored);
        }

        const isolatedCache = clone(restored.cache);
        const isolatedFreshness = clone(restored.freshness);
        return state("candidate", null, context, restored, {
            cache: isolatedCache,
            freshness: isolatedFreshness,
            candidate: candidate(isolatedCache),
            displayEligible: isolatedFreshness.displayEligible,
            calculationEligible: isolatedFreshness.calculationEligible,
            diagnostics: {
                freshnessEvaluated: true,
                candidateOrigin: "cache",
                contractEvaluationDeferred: !text(context?.activeContract),
                referenceDateEvaluationDeferred:
                    !text(context?.expectedTradingDate) && !text(context?.currentReferenceDate)
            }
        });
    }

    return Object.freeze({ SHADOW_VERSION, buildCurrentPriceBootRestoreShadow });
});
