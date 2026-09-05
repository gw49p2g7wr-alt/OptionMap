(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const freshnessApi = commonJs ? require("./dataFreshness.js") : root?.OptionMapDataFreshness;
    const api = factory(freshnessApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapFullExportFreshness = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (freshnessApi) {
    "use strict";

    const ADAPTER_VERSION = 1;
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

    function unavailable(reason = "freshness_status_unavailable") {
        return { status: "unavailable", reason };
    }

    function attemptStatus(status) {
        if (status === "success" || status === "partial") return "success";
        if (status === "failed" || status === "unavailable") return "failed";
        if (status === "loading") return "pending";
        return "not_attempted";
    }

    function daily(input) {
        return freshnessApi?.evaluateDailyFreshness
            ? clone(freshnessApi.evaluateDailyFreshness(input))
            : unavailable("freshness_api_unavailable");
    }

    function weekly(input) {
        return freshnessApi?.evaluateWeeklyFreshness
            ? clone(freshnessApi.evaluateWeeklyFreshness(input))
            : unavailable("freshness_api_unavailable");
    }

    function nonCurrent(sourceType) {
        return freshnessApi?.evaluateFreshness
            ? clone(freshnessApi.evaluateFreshness({ sourceType }))
            : unavailable("freshness_api_unavailable");
    }

    function createFullExportFreshnessAdapter(configuration = {}) {
        function sessionDate() {
            const session = configuration.getMarketSession?.();
            return session?.formalTradingDate || session?.tradingDate || null;
        }

        function marketSnapshot() {
            const state = configuration.getCurrentPriceIdentity?.();
            const fact = state?.status === "available" ? state.fact : null;
            if (!object(fact) || fact.available !== true || fact.identityVerified !== true ||
                fact.acquisitionVerified !== true || fact.currentRequestVerified !== true ||
                !["live", "manual"].includes(fact.origin)) return unavailable();
            const mapping = fact.qriTradingDateMapping;
            const mappedDate = mapping?.mappingVerified === true
                ? mapping.mappedDate || mapping.qriTradingDate || null : null;
            const fetchState = configuration.getFetchState?.("qri") || {};
            return daily({ sourceType: "current_price", origin: fact.origin,
                hasData: true, dataTradingDate: mappedDate,
                sourceUpdatedAt: fact.quotedAt || null, quotedAt: fact.quotedAt || null,
                fetchedAt: fact.fetchedAt || fetchState.fetchedAt || null,
                expectedTradingDate: sessionDate(), lastAttemptedAt: fetchState.fetchedAt || null,
                lastAttemptStatus: attemptStatus(fetchState.status), mode: fact.mode,
                contract: fact.contract, validation: fact.identityVerified === true,
                signatureValid: fact.acquisitionVerified === true,
                calculationEligible: "eligible" });
        }

        function qriOptions() {
            const state = configuration.getQriFormalIdentity?.();
            const fact = state?.status === "available" ? state.fact : null;
            if (!object(fact) || fact.identityVerified !== true ||
                fact.acquisitionVerified !== true || fact.usingFallback === true ||
                fact.referenceOnly === true || fact.origin !== "live") return unavailable();
            const fetchState = configuration.getFetchState?.("qri") || {};
            return daily({ sourceType: "qri_options", origin: fact.origin, hasData: true,
                dataTradingDate: fact.tradingDate || null,
                sourceUpdatedAt: fact.pageUpdatedAt || null,
                fetchedAt: fact.fetchedAt || fetchState.fetchedAt || null,
                expectedTradingDate: sessionDate(), lastAttemptedAt: fetchState.fetchedAt || null,
                lastAttemptStatus: attemptStatus(fetchState.status), mode: "automatic",
                contract: fact.contract, validation: fact.identityVerified === true,
                signatureValid: Boolean(fact.canonicalSignature), calculationEligible: "eligible" });
        }

        function weeklySource(name) {
            const state = configuration.getWeeklyDataState?.(name);
            if (!object(state)) return unavailable();
            return weekly({ sourceType: name, origin: state.origin,
                hasData: Boolean(state.sourceDate), sourceDate: state.sourceDate || null,
                publishedAt: state.publishedAt || null,
                listingUpdatedAt: state.listingUpdatedAt || null,
                fetchedAt: state.fetchedAt || configuration.getFetchState?.(name)?.fetchedAt || null,
                validation: state.validation === true || state.status === "latest",
                signatureValid: state.signatureValid === true || Boolean(state.signature),
                remoteCheckStatus: state.remoteCheckStatus || null,
                calculationEligible: "eligible" });
        }

        function participants() {
            const state = configuration.getParticipantState?.();
            const fetchState = configuration.getFetchState?.("participant") || {};
            if (!object(state)) return unavailable();
            return daily({ sourceType: "participants", origin: state.origin,
                hasData: Boolean(state.sourceDate), dataTradingDate: state.sourceDate || null,
                fetchedAt: state.fetchedAt || fetchState.fetchedAt || null,
                currentReferenceDate: state.observedLatestDate || state.sourceDate || null,
                lastAttemptedAt: fetchState.fetchedAt || null,
                lastAttemptStatus: attemptStatus(fetchState.status), mode: "automatic",
                validation: state.validation !== false &&
                    ["latest", "partial", "waiting_update"].includes(state.dataStatus),
                signatureValid: state.signatureValid === true || Boolean(state.signature),
                calculationEligible: state.dataStatus === "partial" ? "undetermined" : "eligible" });
        }

        function projectedQri() {
            const result = qriOptions();
            return { ...result, projectionSource: "qriOptions" };
        }

        function overallV2() {
            const state = configuration.getOverallV2FormalEnvelope?.();
            const formal = state?.envelope;
            if (state?.status !== "available" || !object(formal) ||
                formal.formalApplied !== true || formal.identityVerified !== true ||
                !object(formal.result)) return unavailable();
            return nonCurrent("overall_v2_formal_envelope");
        }

        function getSectionFreshness(name) {
            if (name === "marketSnapshot") return marketSnapshot();
            if (name === "qriOptions") return qriOptions();
            if (name === "importantLevels") return projectedQri();
            if (name === "weeklyFutures" || name === "weeklyOptions") return weeklySource(name);
            if (name === "participants") return participants();
            if (name === "morning") return nonCurrent("morning_baseline");
            if (name === "qriHistoryComparison") return nonCurrent("observation_history");
            if (name === "intelligence") return nonCurrent("observation_history");
            if (name === "overallV2") return overallV2();
            return unavailable("freshness_section_unsupported");
        }

        return Object.freeze({ getSectionFreshness });
    }

    return Object.freeze({ ADAPTER_VERSION, createFullExportFreshnessAdapter });
});
