(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapQriOptionsSavedReferenceAnalysis = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const ANALYSIS_STATE_VERSION = 1;
    const TOP_COUNT = 3;
    const SAVED_STATES = new Set(["saved_pending", "saved_fallback"]);

    function clone(value) {
        if (value == null) return value;
        return typeof structuredClone === "function" ? structuredClone(value) :
            JSON.parse(JSON.stringify(value));
    }

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function text(value) {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    function date(value) {
        const candidate = text(value);
        if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
        const parsed = new Date(`${candidate}T00:00:00Z`);
        return Number.isFinite(parsed.getTime()) &&
            parsed.toISOString().slice(0, 10) === candidate ? candidate : null;
    }

    function identity(state) {
        const metadata = state?.identity || state?.metadata || {};
        return {
            contract: text(state?.contract) || text(metadata.contract),
            tradingDate: date(metadata.tradingDate),
            pageUpdatedAt: text(metadata.pageUpdatedAt),
            fetchedAt: text(metadata.fetchedAt),
            canonicalSignature: text(state?.canonicalSignature) ||
                text(metadata.canonicalSignature),
            canonicalVersionKey: text(state?.canonicalVersionKey) ||
                text(metadata.canonicalVersionKey),
            displayGeneration: Number.isSafeInteger(state?.displayGeneration)
                ? state.displayGeneration : Number.isSafeInteger(metadata.displayGeneration)
                    ? metadata.displayGeneration : null
        };
    }

    function sameIdentity(left, right) {
        return left.contract === right.contract &&
            left.tradingDate === right.tradingDate &&
            left.pageUpdatedAt === right.pageUpdatedAt &&
            left.fetchedAt === right.fetchedAt &&
            left.canonicalSignature === right.canonicalSignature &&
            left.canonicalVersionKey === right.canonicalVersionKey &&
            left.displayGeneration === right.displayGeneration;
    }

    function freshness(source, sourceIdentity) {
        const fact = source?.freshness || {};
        const expected = date(fact.expectedTradingDate);
        const reference = date(fact.currentReferenceDate);
        const comparison = expected || reference;
        const tradingDate = sourceIdentity.tradingDate || date(fact.dataTradingDate);
        const calendarContextResolved = Boolean(comparison);
        let tier;
        if (!tradingDate) tier = "reference_date_unknown";
        else if (!comparison) tier = "calendar_context_unresolved";
        else if (tradingDate === comparison) tier = "same_trading_date_verified";
        else if (tradingDate < comparison) tier = "older_trading_date";
        else tier = "calendar_context_unresolved";
        return { tier, status: text(fact.status), reason: text(fact.reason),
            calendarContextResolved };
    }

    function policy() {
        return { allowReferenceAnalysis: true, allowFormalAnalysis: false,
            allowLegacyAnalysis: false, allowOverallV2: false,
            calculationEligible: false };
    }

    function diagnostics(values = {}) {
        return { inputSourceKind: values.inputSourceKind ?? null,
            inputSourceState: values.inputSourceState ?? null,
            displayGeneration: values.displayGeneration ?? null,
            sourceRowCount: values.sourceRowCount ?? 0,
            callPublishedCount: values.callPublishedCount ?? 0,
            putPublishedCount: values.putPublishedCount ?? 0,
            topCount: TOP_COUNT, identityMatched: values.identityMatched === true,
            referenceOnly: true, currentPriceAccessed: false,
            savedPriceAccessed: false, historyAccessed: false,
            storageAccessed: false, databaseAccessed: false,
            fetchTriggered: false, timerScheduled: false,
            domAccessed: false, chartAccessed: false,
            formalGlobalsAccessed: false, overallV2Accessed: false };
    }

    function rejected(reason, source = null, positions = null, values = {}) {
        const sourceIdentity = identity(source);
        return deepFreeze({ analysisStateVersion: ANALYSIS_STATE_VERSION,
            accepted: false, available: false, reason,
            sourceKind: text(source?.sourceKind), sourceState: text(source?.state),
            referenceOnly: true, calculationEligible: false, identity: null,
            freshness: null, call: { topOpenInterest: [], maximumOpenInterest: null },
            put: { topOpenInterest: [], maximumOpenInterest: null }, strikeRows: [],
            comparison: null, judgment: null, overallV2: null, currentPrice: null,
            analysisPolicy: policy(), diagnostics: diagnostics({
                inputSourceKind: text(source?.sourceKind),
                inputSourceState: text(source?.state),
                displayGeneration: sourceIdentity.displayGeneration,
                sourceRowCount: Array.isArray(positions?.rows) ? positions.rows.length : 0,
                ...values }) });
    }

    function ranking(rows, side) {
        const publishedField = `${side}Published`;
        const valueField = `${side}OpenInterest`;
        return rows.map((row, sourceIndex) => ({ row, sourceIndex }))
            .filter(item => item.row[publishedField] === true &&
                Number.isSafeInteger(item.row[valueField]) && item.row[valueField] >= 0)
            .map(item => ({ strike: item.row.strike,
                openInterest: item.row[valueField], sourceIndex: item.sourceIndex }))
            .sort((left, right) => right.openInterest - left.openInterest ||
                left.sourceIndex - right.sourceIndex);
    }

    function publicCandidate(candidate) {
        return candidate ? { strike: candidate.strike,
            openInterest: candidate.openInterest } : null;
    }

    function buildQriOptionsSavedReferenceAnalysis(input = {}) {
        const source = input?.displaySourceState;
        const positions = input?.displayPositionsState;
        if (!source || !positions) return rejected("input_missing", source, positions);
        if (source.sourceKind !== "saved") {
            return rejected(`${text(source.sourceKind) || "unknown"}_source_rejected`,
                source, positions);
        }
        if (!SAVED_STATES.has(source.state)) {
            return rejected(source.state === "superseded" ? "saved_superseded" :
                "saved_state_invalid", source, positions);
        }
        if (source.available !== true || source.displayEligible !== true) {
            return rejected("saved_display_ineligible", source, positions);
        }
        if (source.diagnostics?.savedIntegrityVerified !== true) {
            return rejected("integrity_invalid", source, positions);
        }
        if (positions.sourceKind !== "saved" || positions.available !== true ||
            positions.displayOnly !== true) {
            return rejected("positions_source_rejected", source, positions);
        }
        const sourceIdentity = identity(source);
        const positionsIdentity = identity(positions);
        if (!sourceIdentity.contract || sourceIdentity.contract !== positionsIdentity.contract) {
            return rejected("contract_mismatch", source, positions);
        }
        if (!sourceIdentity.canonicalSignature || !sourceIdentity.canonicalVersionKey ||
            sourceIdentity.displayGeneration === null || !sameIdentity(sourceIdentity,
                positionsIdentity)) {
            return rejected(sourceIdentity.displayGeneration !==
                positionsIdentity.displayGeneration ? "generation_mismatch" :
                "identity_mismatch", source, positions);
        }
        if (positions.state !== source.state) {
            return rejected("source_state_mismatch", source, positions);
        }
        if (!Array.isArray(positions.rows)) {
            return rejected("rows_invalid", source, positions);
        }

        const rows = clone(positions.rows);
        const callRanked = ranking(rows, "call");
        const putRanked = ranking(rows, "put");
        const callPublishedCount = callRanked.length;
        const putPublishedCount = putRanked.length;
        const result = { analysisStateVersion: ANALYSIS_STATE_VERSION,
            accepted: true, available: true, reason: null,
            sourceKind: "saved", sourceState: source.state,
            referenceOnly: true, calculationEligible: false,
            identity: sourceIdentity, freshness: freshness(source, sourceIdentity),
            call: { topOpenInterest: callRanked.slice(0, TOP_COUNT).map(publicCandidate),
                maximumOpenInterest: publicCandidate(callRanked[0]) },
            put: { topOpenInterest: putRanked.slice(0, TOP_COUNT).map(publicCandidate),
                maximumOpenInterest: publicCandidate(putRanked[0]) },
            strikeRows: rows, comparison: null, judgment: null,
            overallV2: null, currentPrice: null, analysisPolicy: policy(),
            diagnostics: diagnostics({ inputSourceKind: source.sourceKind,
                inputSourceState: source.state,
                displayGeneration: sourceIdentity.displayGeneration,
                sourceRowCount: rows.length, callPublishedCount,
                putPublishedCount, identityMatched: true }) };
        return deepFreeze(result);
    }

    return Object.freeze({ ANALYSIS_STATE_VERSION, TOP_COUNT,
        buildQriOptionsSavedReferenceAnalysis });
});
