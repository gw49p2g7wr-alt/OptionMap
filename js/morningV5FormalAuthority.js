(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const freshnessApi = commonJs ? require("./fullExportFreshness.js") :
        root?.OptionMapFullExportFreshness;
    const api = factory(freshnessApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMorningV5FormalAuthority = api;
})(typeof window !== "undefined" ? window : globalThis, function (freshnessApi) {
    "use strict";

    const AUTHORITY_VERSION = 1;
    const FRESHNESS_POLICY_VERSION = "current-price-session-v1";
    const RELATION_ADAPTER_VERSION = 1;
    const FUTURES_SOURCE = "qri-nikkei225-futures";
    const FUTURES_INSTRUMENT = "nikkei225_futures";
    const CALCULATION_VERSION = "formal-morning-v5-calculation-v1";
    const COMPARISON_POLICY_VERSION = "formal-morning-v5-comparison-v1";
    const RELATIONS = Object.freeze(["same_contract", "independent_cross_contract", "unsupported"]);
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const timestamp = value => !!text(value) && Number.isFinite(Date.parse(value));
    const date = value => { if (!/^20\d{2}-\d{2}-\d{2}$/.test(value || "")) return false;
        const parsed = new Date(`${value}T00:00:00Z`); return Number.isFinite(parsed.getTime()) &&
            parsed.toISOString().slice(0, 10) === value; };
    const month = value => /^20\d{2}-(0[1-9]|1[0-2])$/.test(value || "");
    const quarterly = value => /^20\d{2}-(03|06|09|12)$/.test(value || "");
    const finite = value => typeof value === "number" && Number.isFinite(value);
    const digest = value => /^sha256:[0-9a-f]{64}$/.test(value || "");
    const clone = value => value == null ? value : typeof structuredClone === "function" ?
        structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }

    function relationFor(qriContract, futuresContract) {
        if (!month(qriContract) || !month(futuresContract) || !quarterly(futuresContract))
            return "unsupported";
        return qriContract === futuresContract ? "same_contract" : "independent_cross_contract";
    }

    function adaptShadowRelation(mappingClass, qriContract, futuresContract) {
        const relation = relationFor(qriContract, futuresContract);
        if (relation === "unsupported") return relation;
        if (mappingClass === "same_contract_reference" && relation === "same_contract") return relation;
        if (mappingClass === "explicit_cross_contract_reference" &&
            relation === "independent_cross_contract") return relation;
        return "unsupported";
    }

    function failure(reason, relation = "unsupported", freshness = null) {
        return freeze({ authorityVersion: AUTHORITY_VERSION, eligible: false, status: "unavailable",
            reason, writeCandidate: false, relation, authority: null,
            freshness: clone(freshness) });
    }

    function validQri(value, tradingDate) {
        return object(value) && value.accepted === true && value.sourceClass === "formal_live" &&
            month(value.contract) && value.tradingDate === tradingDate && text(value.canonicalVersionKey) &&
            text(value.signature) && timestamp(value.confirmedAt);
    }

    function validWeekly(value) {
        return object(value) && value.accepted === true && value.sourceClass === "formal_history" &&
            date(value.sourceDate) && text(value.previousVersionKey) && text(value.previousSignature) &&
            text(value.currentVersionKey) && text(value.currentSignature) &&
            value.previousVersionKey !== value.currentVersionKey;
    }

    function validOverall(value, qri, weekly) {
        return object(value) && value.formalApplied === true && text(value.logicVersion) &&
            text(value.inputFingerprint) && value.qriVersionKey === qri.canonicalVersionKey &&
            value.weeklyVersionKey === weekly.currentVersionKey && finite(value.direction) &&
            value.direction >= -100 && value.direction <= 100 && finite(value.confidence) &&
            value.confidence >= 0 && value.confidence <= 100;
    }

    function validFutures(value) {
        return object(value) && value.available === true && value.source === FUTURES_SOURCE &&
            value.instrument === FUTURES_INSTRUMENT && month(value.contract) && finite(value.value) &&
            value.value > 0 && timestamp(value.quotedAtNormalized) && text(value.quoteSignature) &&
            text(value.versionKey);
    }

    function validCalendar(value, observedAt) {
        return object(value) && value.mode === "read_only" && timestamp(value.asKnownAt) &&
            Date.parse(value.asKnownAt) <= Date.parse(observedAt) && digest(value.digest);
    }

    function validCalculation(value) {
        return object(value) && value.calculationVersion === CALCULATION_VERSION &&
            value.comparisonPolicyVersion === COMPARISON_POLICY_VERSION;
    }

    async function acceptMorningV5FormalAuthority(input = {}) {
        if (!timestamp(input.observedAt) || !date(input.calendarDay) || !date(input.tradingDate))
            return failure("observation_identity_invalid");
        const jstCalendarDay = new Date(Date.parse(input.observedAt) + 9 * 60 * 60 * 1000)
            .toISOString().slice(0, 10);
        if (input.calendarDay !== jstCalendarDay) return failure("observation_identity_invalid");
        if (!validQri(input.qri, input.tradingDate)) return failure("qri_authority_invalid");
        if (Date.parse(input.qri.confirmedAt) > Date.parse(input.observedAt))
            return failure("qri_authority_invalid");
        if (!validWeekly(input.weekly)) return failure("weekly_authority_invalid");
        if (input.weekly.sourceDate > input.calendarDay) return failure("weekly_authority_invalid");
        if (!validOverall(input.overall, input.qri, input.weekly))
            return failure("overall_binding_invalid");
        if (!validFutures(input.futures)) return failure("futures_authority_invalid");
        const relation = adaptShadowRelation(input.shadowMappingClass,
            input.qri.contract, input.futures.contract);
        if (!RELATIONS.includes(relation) || relation === "unsupported")
            return failure("contract_relation_unsupported", relation);
        if (!validCalendar(input.calendar, input.observedAt))
            return failure("calendar_context_invalid", relation);
        if (!validCalculation(input.calculation))
            return failure("calculation_contract_invalid", relation);
        const freshness = freshnessApi?.classifyCurrentPriceSessionFreshness?.({
            fact: { origin: "live", quotedAtNormalized: input.futures.quotedAtNormalized,
                qriTradingDateMapping: { qriTradingDate: input.tradingDate } },
            observedAt: input.observedAt, expectedTradingDate: input.tradingDate,
            fetchState: { status: "success", fetchedAt: input.observedAt }
        }) || null;
        if (input.freshnessPolicyVersion !== FRESHNESS_POLICY_VERSION ||
            freshness?.status !== "fresh" || freshness.reason !== "current_session" ||
            freshness.calculationEligible !== "eligible") {
            return failure(freshness?.reason === "stale_reference" ? "futures_stale" :
                "futures_freshness_invalid", relation, freshness);
        }
        const sessionIdentity = clone(freshness.diagnostics?.observedSession || null);
        if (!object(sessionIdentity) || !["day", "night"].includes(sessionIdentity.kind) ||
            !date(sessionIdentity.key)) return failure("futures_freshness_invalid", relation, freshness);
        const authority = { authorityVersion: AUTHORITY_VERSION,
            observedAt: input.observedAt, calendarDay: input.calendarDay,
            tradingDate: input.tradingDate,
            sourceIdentities: { qri: { accepted: true, sourceClass: input.qri.sourceClass,
                contract: input.qri.contract, tradingDate: input.qri.tradingDate,
                canonicalVersionKey: input.qri.canonicalVersionKey, signature: input.qri.signature,
                confirmedAt: input.qri.confirmedAt }, weekly: { accepted: true,
                sourceClass: input.weekly.sourceClass, sourceDate: input.weekly.sourceDate,
                previousVersionKey: input.weekly.previousVersionKey,
                previousSignature: input.weekly.previousSignature,
                currentVersionKey: input.weekly.currentVersionKey,
                currentSignature: input.weekly.currentSignature }, overall: { formalApplied: true,
                logicVersion: input.overall.logicVersion,
                inputFingerprint: input.overall.inputFingerprint,
                qriVersionKey: input.overall.qriVersionKey,
                weeklyVersionKey: input.overall.weeklyVersionKey,
                direction: input.overall.direction, confidence: input.overall.confidence },
            futures: { available: true, source: input.futures.source,
                instrument: input.futures.instrument, contract: input.futures.contract,
                value: input.futures.value, quotedAtNormalized: input.futures.quotedAtNormalized,
                quoteSignature: input.futures.quoteSignature,
                versionKey: input.futures.versionKey }, calendar: { mode: "read_only",
                asKnownAt: input.calendar.asKnownAt, digest: input.calendar.digest } },
            contractContext: { qriContract: input.qri.contract,
                futuresContract: input.futures.contract, relation,
                relationAdapterVersion: RELATION_ADAPTER_VERSION },
            freshness: { policyVersion: FRESHNESS_POLICY_VERSION, status: "fresh",
                reason: "current_session", observedAt: input.observedAt,
                sessionIdentity, quoteTimestamp: input.futures.quotedAtNormalized },
            calculation: clone(input.calculation) };
        return freeze({ authorityVersion: AUTHORITY_VERSION, eligible: true, status: "available",
            reason: null, writeCandidate: true, relation, authority: freeze(authority),
            freshness: authority.freshness });
    }

    return freeze({ AUTHORITY_VERSION, FRESHNESS_POLICY_VERSION, RELATION_ADAPTER_VERSION,
        FUTURES_SOURCE, FUTURES_INSTRUMENT, CALCULATION_VERSION, COMPARISON_POLICY_VERSION,
        RELATIONS, relationFor, adaptShadowRelation, acceptMorningV5FormalAuthority });
});
