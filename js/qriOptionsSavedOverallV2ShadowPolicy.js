(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapQriOptionsSavedOverallV2ShadowPolicy = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const POLICY_VERSION = 1;
    const SAVED_STATES = new Set(["saved_pending", "saved_fallback"]);
    const FRESHNESS_TIERS = new Set(["same_trading_date_verified",
        "older_trading_date", "calendar_context_unresolved",
        "reference_date_unknown", "contract_mismatch", "superseded"]);

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

    function timestamp(value) {
        const candidate = text(value);
        return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : null;
    }

    function identity(value = {}) {
        const metadata = value.identity || value.metadata || value;
        return { contract: text(value.contract) || text(metadata.contract),
            tradingDate: date(metadata.tradingDate),
            canonicalSignature: text(value.canonicalSignature) ||
                text(metadata.canonicalSignature),
            canonicalVersionKey: text(value.canonicalVersionKey) ||
                text(metadata.canonicalVersionKey),
            displayGeneration: Number.isSafeInteger(value.displayGeneration)
                ? value.displayGeneration : Number.isSafeInteger(metadata.displayGeneration)
                    ? metadata.displayGeneration : null };
    }

    function sameIdentity(left, right) {
        return left.contract === right.contract &&
            left.tradingDate === right.tradingDate &&
            left.canonicalSignature === right.canonicalSignature &&
            left.canonicalVersionKey === right.canonicalVersionKey &&
            left.displayGeneration === right.displayGeneration;
    }

    function validIdentity(value, requireGeneration = false) {
        return Boolean(value.contract && value.tradingDate && value.canonicalSignature &&
            value.canonicalVersionKey && (!requireGeneration ||
                value.displayGeneration !== null));
    }

    function guards() {
        return { allowFormalStateWrite: false, allowOverallV2Write: false,
            allowMobile: false, allowMorning: false, allowObservation: false,
            allowAlerts: false };
    }

    function evaluateSource(source, reference) {
        const sourceIdentity = identity(source);
        const referenceIdentity = identity(reference);
        const superseded = source?.state === "superseded" ||
            source?.reason === "saved_superseded" ||
            source?.reason === "replaced_by_live";
        const eligible = !superseded && source?.sourceKind === "saved" &&
            SAVED_STATES.has(source?.state) && source?.available === true &&
            source?.displayEligible === true &&
            source?.diagnostics?.savedIntegrityVerified === true &&
            reference?.accepted === true && reference?.available === true &&
            reference?.sourceKind === "saved" && reference?.referenceOnly === true &&
            reference?.calculationEligible === false && validIdentity(sourceIdentity, true) &&
            validIdentity(referenceIdentity, true) && sameIdentity(sourceIdentity,
                referenceIdentity);
        return { eligible, superseded, identity: sourceIdentity };
    }

    function evaluateComparison(context, sourceIdentity) {
        const previous = identity(context?.previousIdentity || {});
        const present = context?.available === true &&
            context?.previousCanonicalPresent === true;
        const currentVersionKey = text(context?.currentVersionKey);
        const currentSignature = text(context?.currentSignature);
        const currentIdentityMatched = currentVersionKey ===
            sourceIdentity.canonicalVersionKey && currentSignature ===
            sourceIdentity.canonicalSignature;
        const identityValid = context?.currentSignatureValid === true &&
            context?.previousSignatureValid === true &&
            context?.currentVersionKeyValid === true &&
            context?.previousVersionKeyValid === true && currentIdentityMatched &&
            validIdentity(previous);
        const contractMatched = Boolean(sourceIdentity.contract &&
            previous.contract === sourceIdentity.contract &&
            text(context?.currentContract) === sourceIdentity.contract);
        const sameVersionRejected = Boolean(currentVersionKey &&
            currentVersionKey === previous.canonicalVersionKey);
        const sameSignatureRejected = Boolean(currentSignature &&
            currentSignature === previous.canonicalSignature);
        const datesOrdered = context?.tradingDateOrderVerified === true &&
            date(context?.currentTradingDate) === sourceIdentity.tradingDate &&
            previous.tradingDate <= sourceIdentity.tradingDate;
        const sameDate = previous.tradingDate &&
            previous.tradingDate === sourceIdentity.tradingDate;
        const revisionQualified = !sameDate ||
            context?.explicitRevisionComparison === true;
        const coverage = context?.coverage?.callComparable === true &&
            context?.coverage?.putComparable === true;
        return { eligible: present && identityValid && contractMatched && datesOrdered &&
            revisionQualified && coverage && !sameVersionRejected &&
            !sameSignatureRejected, present, identityValid, contractMatched,
            currentIdentityMatched,
            tradingDateContextValid: Boolean(datesOrdered && revisionQualified),
            sameVersionRejected, sameSignatureRejected,
            sameDateRevisionRejected: Boolean(sameDate && !revisionQualified),
            coverageAvailable: coverage, previousIdentity: previous };
    }

    function evaluateCurrentPrice(context, sourceIdentity) {
        const value = Number(context?.value);
        const origin = text(context?.origin);
        const restored = context?.restored === true || origin === "cache" ||
            origin === "saved";
        const identityPresent = Boolean(text(context?.identity));
        const contractMatched = Boolean(sourceIdentity.contract &&
            text(context?.contract) === sourceIdentity.contract);
        const dateContextValid = Boolean(sourceIdentity.tradingDate &&
            date(context?.tradingDate) === sourceIdentity.tradingDate &&
            timestamp(context?.quotedAt));
        const eligible = context?.available === true &&
            context?.mode === "automatic" && Number.isFinite(value) && value > 0 &&
            origin === "live" && !restored && identityPresent && contractMatched &&
            dateContextValid && context?.identityVerified === true;
        return { eligible, identityClass: restored ? "saved" : origin === "live"
            ? "live_automatic" : "unknown", identityPresent, contractMatched,
            tradingDateContextValid: dateContextValid, restored };
    }

    function formalBaseline(context) {
        return { available: context?.available === true,
            identity: text(context?.identity), fingerprint: text(context?.fingerprint) };
    }

    function reasonFor(values) {
        if (values.source.superseded) return "saved_source_superseded";
        if (!values.source.eligible) return "saved_source_unavailable";
        if (!values.comparison.present) return "comparison_unavailable";
        if (values.comparison.sameVersionRejected ||
            values.comparison.sameSignatureRejected) return "same_acquisition_rejected";
        if (values.comparison.sameDateRevisionRejected) {
            return "same_date_revision_unqualified";
        }
        if (!values.comparison.coverageAvailable) return "comparison_coverage_unavailable";
        if (!values.comparison.eligible) return "comparison_identity_invalid";
        if (!values.price.eligible) return values.price.restored
            ? "saved_current_price_policy_undefined" : "current_price_unavailable";
        return null;
    }

    function buildQriOptionsSavedOverallV2ShadowPolicy(input = {}) {
        const source = evaluateSource(input.savedSourceState,
            input.savedReferenceAnalysisState);
        const comparison = evaluateComparison(input.comparisonContext, source.identity);
        const price = evaluateCurrentPrice(input.currentPriceContext, source.identity);
        const baseline = formalBaseline(input.formalOverallV2Context);
        const suppliedTier = text(input.savedReferenceAnalysisState?.freshness?.tier);
        const freshnessTier = source.superseded ? "superseded" :
            FRESHNESS_TIERS.has(suppliedTier) ? suppliedTier : "reference_date_unknown";
        const values = { source, comparison, price };
        const reason = reasonFor(values);
        const eligible = reason === null;
        return deepFreeze({ policyVersion: POLICY_VERSION, eligible,
            status: source.superseded ? "superseded" : eligible
                ? "eligible" : "shadow_unavailable", reason,
            referenceOnly: true, formalApplied: false,
            tradeDecisionEligible: false, sourceIdentity: clone(source.identity),
            comparisonEligibility: clone(comparison),
            currentPriceEligibility: clone(price), freshnessTier,
            formalBaseline: clone(baseline), guards: guards(),
            diagnostics: { sourceEligible: source.eligible,
                comparisonEligible: comparison.eligible,
                currentPriceEligible: price.eligible,
                contractMatched: source.eligible && comparison.contractMatched &&
                    price.contractMatched,
                tradingDateContextValid: comparison.tradingDateContextValid &&
                    price.tradingDateContextValid,
                freshnessTier, sameVersionRejected: comparison.sameVersionRejected,
                sameSignatureRejected: comparison.sameSignatureRejected,
                formalBaselineAvailable: baseline.available,
                formalApplied: false, tradeDecisionEligible: false,
                storageAccessed: false, historyWritten: false,
                fetchTriggered: false, runtimeAccessed: false, domAccessed: false } });
    }

    return Object.freeze({ POLICY_VERSION,
        buildQriOptionsSavedOverallV2ShadowPolicy });
});
