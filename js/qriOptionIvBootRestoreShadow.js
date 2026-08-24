(function (root, factory) {
    const readOnlyStoreApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./storage/qriOptionIvLastValidReadOnlyStore.js")
        : root?.OptionMapQriOptionIvLastValidReadOnlyStore;
    const api = factory(readOnlyStoreApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapQriOptionIvBootRestoreShadow = api;
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
        return value == null ? value : typeof structuredClone === "function"
            ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    }

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function availableCounts(canonical) {
        const records = Array.isArray(canonical?.records) ? canonical.records : [];
        const count = optionType => records.filter(record =>
            record.optionType === optionType && record.iv?.status === "available").length;
        return { call: count("call"), put: count("put"), total: count("call") + count("put") };
    }

    function baseDiagnostics(context, readResult, extra = {}) {
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
            contractEvaluationDeferred: !activeContract,
            referenceDateEvaluationDeferred: !expectedTradingDate &&
                !text(context?.currentReferenceDate),
            bootGeneration: context?.bootGeneration ?? null,
            requestId: text(context?.requestId),
            candidateIdentity: readResult?.cache?.versionKey ?? null,
            candidateOrigin: readResult?.cache ? "cache" : null,
            currentIvActiveApplied: false,
            currentIvSelectedApplied: false,
            graphApplied: false,
            liveOverwriteAllowed: false,
            storageMutation: false,
            ...extra
        };
    }

    function state(status, reason, context = {}, readResult = null, values = {}) {
        return deepFreeze({
            status,
            reason,
            cache: values.cache ?? null,
            canonical: values.canonical ?? null,
            freshness: values.freshness ?? null,
            candidate: values.candidate ?? null,
            displayEligible: values.displayEligible === true,
            calculationEligible: values.calculationEligible ?? "undetermined",
            restoredAt: timestamp(context.restoredAt),
            generation: context.bootGeneration ?? 0,
            diagnostics: baseDiagnostics(context, readResult, values.diagnostics)
        });
    }

    function candidate(cache, canonical) {
        const counts = availableCounts(canonical);
        return {
            origin: "cache",
            contract: canonical.contract,
            tradingDate: canonical.tradingDate,
            pageUpdatedAt: canonical.pageUpdatedAt,
            fetchedAt: cache.fetchedAt,
            canonicalSignature: cache.canonicalSignature,
            canonicalVersionKey: cache.canonicalVersionKey,
            recordCount: canonical.records.length,
            availablePointCounts: counts,
            canonical: clone(canonical)
        };
    }

    async function buildQriOptionIvBootRestoreShadow({ storage, context = {} } = {}) {
        if (!readOnlyStoreApi?.readAndRestoreQriOptionIvLastValid) {
            return state("unavailable", "read_only_store_unavailable", context);
        }
        let restored;
        try {
            restored = await readOnlyStoreApi.readAndRestoreQriOptionIvLastValid(storage, {
                expectedTradingDate: context.expectedTradingDate,
                currentReferenceDate: context.currentReferenceDate,
                contractMatches: null,
                lastAttemptStatus: context.lastAttemptStatus,
                lastAttemptedAt: context.lastAttemptedAt
            });
        } catch (_error) {
            return state("unavailable", "restore_read_error", context, null,
                { diagnostics: { exceptionContained: true } });
        }
        if (restored.status === "missing") return state("missing", null, context, restored);
        if (restored.status === "unavailable") {
            return state("unavailable", restored.reason, context, restored);
        }
        if (restored.status !== "restored" || !restored.cache || !restored.canonical ||
            !restored.freshness) {
            return state("invalid", restored.reason || "restore_invalid", context, restored);
        }
        const isolatedCache = clone(restored.cache);
        const isolatedCanonical = clone(restored.canonical);
        const isolatedFreshness = clone(restored.freshness);
        const activeContract = text(context.activeContract);
        const contractMatches = activeContract
            ? activeContract === isolatedCanonical.contract : null;
        return state("candidate", null, context, restored, {
            cache: isolatedCache,
            canonical: isolatedCanonical,
            freshness: isolatedFreshness,
            candidate: candidate(isolatedCache, isolatedCanonical),
            displayEligible: isolatedFreshness.displayEligible,
            calculationEligible: "undetermined",
            diagnostics: { freshnessEvaluated: true,
                contractMatches, contractEvaluationDeferred: contractMatches === null,
                availablePointCounts: availableCounts(isolatedCanonical) }
        });
    }

    function runtimeState(status = "not_started", reason = null, generation = 0, values = {}) {
        return deepFreeze({ status, reason, cache: values.cache ?? null,
            canonical: values.canonical ?? null, freshness: values.freshness ?? null,
            candidate: values.candidate ?? null,
            displayEligible: values.displayEligible === true,
            calculationEligible: values.calculationEligible ?? "undetermined",
            restoredAt: values.restoredAt ?? null,
            generation, diagnostics: values.diagnostics ?? {} });
    }

    function createQriOptionIvBootRestoreShadowRuntime({ build =
        buildQriOptionIvBootRestoreShadow } = {}) {
        let generation = 0; let started = false; let pending = null;
        let current = runtimeState();
        function getState() { return deepFreeze(clone(current)); }
        function initialize({ storage, context = {} } = {}) {
            if (started) return pending || Promise.resolve(getState());
            started = true;
            const ownGeneration = ++generation;
            const requestId = text(context.requestId) || `iv-boot-shadow-${ownGeneration}`;
            current = runtimeState("pending", null, ownGeneration, {
                restoredAt: timestamp(context.restoredAt),
                diagnostics: { shadowVersion: SHADOW_VERSION, requestId,
                    bootGeneration: ownGeneration, currentIvActiveApplied: false,
                    currentIvSelectedApplied: false, graphApplied: false,
                    liveOverwriteAllowed: false }
            });
            pending = build({ storage, context: { ...context, requestId,
                bootGeneration: ownGeneration } }).then(result => {
                if (generation !== ownGeneration) return getState();
                current = runtimeState(result.status, result.reason, ownGeneration, result);
                return getState();
            }).catch(() => {
                if (generation === ownGeneration) {
                    current = runtimeState("unavailable", "boot_shadow_error", ownGeneration, {
                        restoredAt: timestamp(context.restoredAt),
                        diagnostics: { shadowVersion: SHADOW_VERSION, requestId,
                            bootGeneration: ownGeneration, exceptionContained: true,
                            currentIvActiveApplied: false, currentIvSelectedApplied: false,
                            graphApplied: false, liveOverwriteAllowed: false }
                    });
                }
                return getState();
            });
            return pending;
        }
        function markLiveAcquisitionSuperseded({ requestId = null,
            acquisitionIdentity = null, acquiredAt = null } = {}) {
            const ownGeneration = ++generation;
            current = runtimeState("superseded", "replaced_by_live", ownGeneration, {
                ...current, diagnostics: { ...current.diagnostics,
                    liveRequestId: text(requestId),
                    liveAcquisitionIdentity: text(acquisitionIdentity),
                    liveAcquiredAt: timestamp(acquiredAt), supersededGeneration: ownGeneration,
                    currentIvActiveApplied: false, currentIvSelectedApplied: false,
                    graphApplied: false, liveOverwriteAllowed: false }
            });
            return getState();
        }
        return Object.freeze({ initialize, getState, markLiveAcquisitionSuperseded });
    }

    const runtime = createQriOptionIvBootRestoreShadowRuntime();
    return Object.freeze({ SHADOW_VERSION, availableCounts,
        buildQriOptionIvBootRestoreShadow, createQriOptionIvBootRestoreShadowRuntime,
        initializeQriOptionIvBootRestoreShadow: runtime.initialize,
        getQriOptionIvBootRestoreShadowState: runtime.getState,
        markQriOptionIvBootRestoreShadowSuperseded: runtime.markLiveAcquisitionSuperseded });
});
