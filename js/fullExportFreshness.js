(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const freshnessApi = commonJs ? require("./dataFreshness.js") : root?.OptionMapDataFreshness;
    const contextApi = commonJs ? require("./qriTradingDateContext.js") :
        root?.OptionMapQriTradingDateContext;
    const api = factory(freshnessApi, contextApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapFullExportFreshness = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (freshnessApi, contextApi) {
    "use strict";

    const ADAPTER_VERSION = 1;
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

    function classifyConsumerState({ status, reason, payloadValidation }) {
        if (status === "unavailable" || ["invalid", "unavailable"].includes(payloadValidation)) {
            return "invalid_or_unavailable";
        }
        if (reason === "saved_last_valid") return "valid_saved_fallback";
        if (reason === "date_unverifiable") return "valid_date_unverifiable";
        if (status === "fresh" && payloadValidation === "valid") return "valid_current";
        if (payloadValidation === "valid") return "valid_stale";
        return "unverified";
    }

    function provenance(values = {}) {
        const result = { ...values };
        result.expectedTradingDate = values.expectedTradingDate || null;
        result.expectedTradingDateSource = values.expectedTradingDateSource || null;
        result.payloadValidation = values.payloadValidation || "unavailable";
        result.dateRelation = values.dataTradingDate && values.expectedTradingDate
            ? values.dataTradingDate === values.expectedTradingDate ? "matched"
                : values.dataTradingDate < values.expectedTradingDate
                    ? "older_than_expected" : "newer_than_expected"
            : "unverifiable";
        result.consumerState = classifyConsumerState(result);
        if (!Object.hasOwn(result, "staleReason")) result.staleReason = null;
        return result;
    }

    function unavailable(reason = "freshness_status_unavailable", values = {}) {
        return provenance({ status: "unavailable", reason, origin: values.origin || null,
            dataTradingDate: values.dataTradingDate || null,
            expectedTradingDate: values.expectedTradingDate || null,
            expectedTradingDateSource: values.expectedTradingDateSource || null,
            payloadValidation: values.payloadValidation || "unavailable", staleReason: null,
            ...(values.tradingDateContext ? {
                tradingDateContext: values.tradingDateContext } : {}) });
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

    const sessionOf = value => {
        const session = contextApi?.sessionOf?.(value) || null;
        return session?.kind === "closed" ? null : session;
    };

    function classifyCurrentPriceSessionFreshness({ fact, observedAt, expectedTradingDate,
        expectedTradingDateSource, fetchState = {} } = {}) {
        const quotedAt = fact?.quotedAtNormalized;
        const quoteSession = sessionOf(quotedAt), observedSession = sessionOf(observedAt);
        const base = { origin: fact?.origin || null,
            dataTradingDate: fact?.qriTradingDateMapping?.qriTradingDate || null,
            expectedTradingDate: expectedTradingDate || null,
            expectedTradingDateSource: expectedTradingDateSource || null,
            payloadValidation: "valid",
            sourceUpdatedAt: quotedAt || null, fetchedAt: fact?.fetchedAt || fetchState.fetchedAt || null,
            lastAttemptedAt: fetchState.fetchedAt || null,
            lastAttemptStatus: attemptStatus(fetchState.status), displayEligible: true,
            staleSince: null, diagnostics: { policyType: "current_price_session",
                timeZone: "Asia/Tokyo", expectedTradingDate: expectedTradingDate || null,
                quoteSession, observedSession, sessionMatched: false } };
        if (!quoteSession) return provenance({ ...base, status: "unavailable",
            reason: "quote_timestamp_unavailable", displayEligible: false,
            calculationEligible: "ineligible", staleReason: null });
        if (!observedSession) return provenance({ ...base, status: "stale", reason: "stale_reference",
            calculationEligible: "ineligible", staleReason: "session_closed" });
        if (Date.parse(quotedAt) > Date.parse(observedAt)) return provenance({ ...base, status: "unavailable",
            reason: "quote_timestamp_invalid", displayEligible: false,
            calculationEligible: "ineligible", staleReason: null });
        const matched = quoteSession.kind === observedSession.kind && quoteSession.key === observedSession.key;
        base.diagnostics.sessionMatched = matched;
        return matched ? provenance({ ...base, status: "fresh", reason: "current_session",
            calculationEligible: "eligible", staleReason: null })
            : provenance({ ...base, status: "stale", reason: "stale_reference",
                calculationEligible: "ineligible", staleReason: "previous_session_quote" });
    }

    function createFullExportFreshnessAdapter(configuration = {}) {
        function sessionDate() {
            const session = configuration.getMarketSession?.();
            return session?.formalTradingDate || session?.tradingDate || null;
        }

        function sessionAuthority() {
            const session = configuration.getMarketSession?.();
            return session?.authority || session?.expectedTradingDateSource || null;
        }

        function qriDateContext(payloadTradingDate) {
            return configuration.resolveQriTradingDateContext?.(payloadTradingDate) || null;
        }

        function qriDaily(values) {
            const context = qriDateContext(values.dataTradingDate);
            const expectedTradingDate = context ? context.expectedTradingDate : sessionDate();
            const expectedTradingDateSource = context
                ? context.authoritySource : sessionAuthority();
            if (context?.relation === "date_mismatch") return unavailable("date_mismatch", {
                origin: values.origin, dataTradingDate: values.dataTradingDate,
                expectedTradingDate, expectedTradingDateSource, payloadValidation: "valid",
                tradingDateContext: context });
            const result = daily({ ...values, expectedTradingDate,
                expectedTradingDateSource });
            return context ? provenance({ ...result, tradingDateContext: context }) : result;
        }

        function marketSnapshot() {
            const state = configuration.getCurrentPriceIdentity?.();
            const fact = state?.status === "available" ? state.fact : null;
            if (!object(fact) || fact.available !== true || fact.identityVerified !== true ||
                fact.acquisitionVerified !== true || fact.currentRequestVerified !== true ||
                !["live", "manual"].includes(fact.origin)) return unavailable(
                    "freshness_status_unavailable", { expectedTradingDate: sessionDate(),
                        expectedTradingDateSource: sessionAuthority(),
                        payloadValidation: object(fact) ? "invalid" : "unavailable" });
            const mapping = fact.qriTradingDateMapping;
            const mappedDate = mapping?.mappingVerified === true
                ? mapping.mappedDate || mapping.qriTradingDate || null : null;
            const fetchState = configuration.getFetchState?.("qri") || {};
            return classifyCurrentPriceSessionFreshness({ fact: { ...fact,
                qriTradingDateMapping: { ...mapping, qriTradingDate: mappedDate } },
                observedAt: configuration.now?.() || null,
                expectedTradingDate: sessionDate(),
                expectedTradingDateSource: sessionAuthority(), fetchState });
        }

        function qriOptions() {
            const state = configuration.getQriFormalIdentity?.();
            const fact = state?.status === "available" ? state.fact : null;
            if (!object(fact) || fact.identityVerified !== true ||
                fact.acquisitionVerified !== true || fact.usingFallback === true ||
                fact.referenceOnly === true || fact.origin !== "live") return unavailable(
                    "freshness_status_unavailable", { expectedTradingDate: sessionDate(),
                        expectedTradingDateSource: sessionAuthority(),
                        payloadValidation: object(fact) ? "invalid" : "unavailable" });
            const fetchState = configuration.getFetchState?.("qri") || {};
            return qriDaily({ sourceType: "qri_options", origin: fact.origin, hasData: true,
                dataTradingDate: fact.tradingDate || null,
                sourceUpdatedAt: fact.pageUpdatedAt || null,
                fetchedAt: fact.fetchedAt || fetchState.fetchedAt || null,
                lastAttemptedAt: fetchState.fetchedAt || null,
                lastAttemptStatus: attemptStatus(fetchState.status), mode: "automatic",
                contract: fact.contract, validation: fact.identityVerified === true,
                signatureValid: Boolean(fact.canonicalSignature), calculationEligible: "eligible" });
        }

        function qriOptionsNextContract(context) {
            const acquisition = context?.acquisition;
            const revision = context?.revision;
            if (!object(acquisition) || !["saved", "unchanged"].includes(acquisition.status) ||
                !object(revision) || acquisition.targetContract !== revision.contract ||
                acquisition.referenceTradingDate !== revision.tradingDate ||
                acquisition.versionKey !== revision.versionKey || !revision.signature) {
                return unavailable("next_contract_acquisition_unavailable", {
                    dataTradingDate: revision?.tradingDate || null,
                    expectedTradingDate: sessionDate(),
                    expectedTradingDateSource: sessionAuthority(),
                    payloadValidation: object(acquisition) || object(revision)
                        ? "invalid" : "unavailable" });
            }
            return qriDaily({ sourceType: "qri_options", origin: "history", hasData: true,
                dataTradingDate: revision.tradingDate, sourceUpdatedAt: revision.pageUpdatedAt,
                fetchedAt: revision.fetchedAt,
                lastAttemptedAt: acquisition.completedAt || revision.confirmedAt || null,
                lastAttemptStatus: "success", mode: "automatic", contract: revision.contract,
                validation: true, signatureValid: true, calculationEligible: "eligible" });
        }

        function qriOptionsMajorSqNextContract(context) {
            const locator = context?.locator;
            const revision = context?.revision;
            if (!object(locator) || !["saved", "unchanged"].includes(locator.status) ||
                !object(revision) || locator.targetContract !== revision.contract ||
                locator.referenceTradingDate !== revision.tradingDate ||
                locator.targetUrl !== revision.sourceUrl ||
                locator.versionKey !== revision.versionKey || !revision.signature) {
                return unavailable("major_sq_locator_unavailable", {
                    dataTradingDate: revision?.tradingDate || null,
                    expectedTradingDate: sessionDate(),
                    expectedTradingDateSource: sessionAuthority(),
                    payloadValidation: object(locator) || object(revision)
                        ? "invalid" : "unavailable" });
            }
            return qriDaily({ sourceType: "qri_options", origin: "history", hasData: true,
                dataTradingDate: revision.tradingDate, sourceUpdatedAt: revision.pageUpdatedAt,
                fetchedAt: revision.fetchedAt,
                lastAttemptedAt: locator.completedAt || revision.confirmedAt || null,
                lastAttemptStatus: "success", mode: "automatic", contract: revision.contract,
                validation: true, signatureValid: true, calculationEligible: "eligible" });
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

        function getSectionFreshness(name, context = null) {
            if (name === "marketSnapshot") return marketSnapshot();
            if (name === "qriOptions") return qriOptions();
            if (name === "qriOptionsNextContract") return qriOptionsNextContract(context);
            if (name === "qriOptionsMajorSqNextContract") {
                return qriOptionsMajorSqNextContract(context);
            }
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

    return Object.freeze({ ADAPTER_VERSION, classifyCurrentPriceSessionFreshness,
        createFullExportFreshnessAdapter });
});
