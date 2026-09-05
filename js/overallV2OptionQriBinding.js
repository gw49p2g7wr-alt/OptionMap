(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapOverallV2OptionQriBinding = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const text = value => typeof value === "string" && value.trim()
        ? value.trim() : null;
    const clone = value => value == null ? value
        : typeof structuredClone === "function"
            ? structuredClone(value)
            : JSON.parse(JSON.stringify(value));

    function sameTimestamp(left, right) {
        const leftTime = Date.parse(text(left) || "");
        const rightTime = Date.parse(text(right) || "");
        return Number.isFinite(leftTime) && Number.isFinite(rightTime) &&
            leftTime === rightTime;
    }

    function getEligibleFact(state) {
        const fact = state?.fact;
        const generation = fact?.generation;
        if (state?.status !== "available" || !fact ||
            fact.sourceClass !== "formal_live" ||
            fact.sourceKind !== "formal_live" || fact.origin !== "live" ||
            fact.usingFallback !== false || fact.referenceOnly !== false ||
            fact.superseded !== false || fact.identityVerified !== true ||
            fact.acquisitionVerified !== true ||
            state.requestId !== fact.requestId ||
            generation?.source !== "qri" || generation.current !== true ||
            !Number.isSafeInteger(generation.sequence) ||
            generation.sequence !== state.publicationGeneration ||
            !text(generation.fingerprint) || !text(fact.requestId) ||
            !text(fact.canonicalVersionKey) ||
            !text(fact.canonicalSignature) || !text(fact.contract) ||
            !text(fact.tradingDate) || !text(fact.pageUpdatedAt)) {
            return null;
        }
        return fact;
    }

    function createBinding(state, sourceDate) {
        const fact = getEligibleFact(state);
        if (!fact || !sameTimestamp(sourceDate, fact.pageUpdatedAt)) return null;
        return {
            requestId: fact.requestId,
            publicationGeneration: state.publicationGeneration,
            generation: clone(fact.generation),
            canonicalVersionKey: fact.canonicalVersionKey,
            canonicalSignature: fact.canonicalSignature,
            contract: fact.contract,
            tradingDate: fact.tradingDate,
            pageUpdatedAt: fact.pageUpdatedAt,
            sourceDate
        };
    }

    function matchesCurrent(binding, state, sourceDate) {
        const current = createBinding(state, sourceDate);
        if (!binding || !current) return false;
        return binding.requestId === current.requestId &&
            binding.publicationGeneration === current.publicationGeneration &&
            binding.generation?.source === current.generation.source &&
            binding.generation?.sequence === current.generation.sequence &&
            binding.generation?.fingerprint === current.generation.fingerprint &&
            binding.generation?.current === true &&
            binding.canonicalVersionKey === current.canonicalVersionKey &&
            binding.canonicalSignature === current.canonicalSignature &&
            binding.contract === current.contract &&
            binding.tradingDate === current.tradingDate &&
            sameTimestamp(binding.pageUpdatedAt, current.pageUpdatedAt) &&
            sameTimestamp(binding.sourceDate, current.sourceDate);
    }

    function shouldReapplySelectedSnapshot({ sameSourceDate, snapshotValid,
        judgmentState, qriState, sourceDate } = {}) {
        if (sameSourceDate !== true || snapshotValid !== true) return false;
        return judgmentState?.available !== true ||
            !matchesCurrent(
                judgmentState?.metadata?.formalQriIdentity,
                qriState,
                sourceDate
            );
    }

    return Object.freeze({
        getEligibleFact,
        createBinding,
        matchesCurrent,
        shouldReapplySelectedSnapshot
    });
});
