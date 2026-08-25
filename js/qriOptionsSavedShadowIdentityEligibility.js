(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapQriOptionsSavedShadowIdentityEligibility = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const ELIGIBILITY_VERSION = 1;
    const SAVED_STATES = new Set(["saved_pending", "saved_fallback"]);
    const PRICE_SOURCE = "qri-nikkei225-futures";
    const PRICE_DATE_RESOLUTION = "nearest_not_after_page_updated_at";

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

    function identity(value = {}, generationRequired = false) {
        const result = { contract: text(value.contract), tradingDate: date(value.tradingDate),
            pageUpdatedAt: timestamp(value.pageUpdatedAt), fetchedAt: timestamp(value.fetchedAt),
            canonicalSignature: text(value.canonicalSignature),
            canonicalVersionKey: text(value.canonicalVersionKey),
            generation: Number.isSafeInteger(value.generation) ? value.generation : null };
        result.complete = Boolean(result.contract && result.tradingDate &&
            result.pageUpdatedAt && result.fetchedAt && result.canonicalSignature &&
            result.canonicalVersionKey && (!generationRequired || result.generation !== null));
        return result;
    }

    function sameCurrentIdentity(left, right) {
        return left.contract === right.contract && left.tradingDate === right.tradingDate &&
            left.pageUpdatedAt === right.pageUpdatedAt && left.fetchedAt === right.fetchedAt &&
            left.canonicalSignature === right.canonicalSignature &&
            left.canonicalVersionKey === right.canonicalVersionKey &&
            left.generation === right.generation;
    }

    function evaluateSavedCurrent(context, reference) {
        const currentIdentity = identity(context, true);
        const referenceIdentity = identity(reference?.identity || {}, true);
        const superseded = context?.state === "superseded" ||
            context?.reason === "replaced_by_live" || reference?.superseded === true;
        const currentCoverage = { callPublishedCount:
            Number.isSafeInteger(context?.coverage?.callPublishedCount)
                ? context.coverage.callPublishedCount : 0,
        putPublishedCount: Number.isSafeInteger(context?.coverage?.putPublishedCount)
            ? context.coverage.putPublishedCount : 0 };
        const coverageAvailable = currentCoverage.callPublishedCount > 0 &&
            currentCoverage.putPublishedCount > 0;
        const eligible = !superseded && context?.sourceKind === "saved" &&
            SAVED_STATES.has(context?.state) && context?.available === true &&
            context?.canonicalPresent === true && context?.canonicalValid === true &&
            context?.integrityVerified === true && context?.signatureValid === true &&
            context?.versionKeyValid === true && currentIdentity.complete &&
            coverageAvailable && reference?.available === true &&
            reference?.identityVerified === true && referenceIdentity.complete &&
            sameCurrentIdentity(currentIdentity, referenceIdentity) &&
            reference?.currentSourceGeneration === currentIdentity.generation;
        return { eligible, reason: superseded ? "saved_current_superseded" : eligible
            ? null : "saved_current_invalid", superseded,
        identity: currentIdentity, coverage: currentCoverage };
    }

    function coverageFacts(context) {
        return { callPublishedCount: Number.isSafeInteger(context?.callPublishedCount)
            ? context.callPublishedCount : 0,
        putPublishedCount: Number.isSafeInteger(context?.putPublishedCount)
            ? context.putPublishedCount : 0,
        commonPublishedStrikeCount:
            Number.isSafeInteger(context?.commonPublishedStrikeCount)
                ? context.commonPublishedStrikeCount : 0,
        comparisonCoverageVerified: context?.comparisonCoverageVerified === true,
        missingStrikeZeroFilled: context?.missingStrikeZeroFilled === true };
    }

    function sameDateRevisionProof(context, current, previous) {
        const revision = context?.revisionIdentity || {};
        const entryKey = text(revision.entryKey);
        const previousRevisionKey = text(revision.previousRevisionKey);
        const currentRevisionKey = text(revision.currentRevisionKey);
        return context?.explicitRevisionComparison === true &&
            revision.orderVerified === true && Boolean(entryKey) &&
            previousRevisionKey === `${entryKey}|${previous.canonicalVersionKey}` &&
            currentRevisionKey === `${entryKey}|${current.canonicalVersionKey}` &&
            text(revision.activeVersionKey) === current.canonicalVersionKey &&
            timestamp(revision.previousReplacedAt) !== null &&
            text(revision.previousVersionKey) === previous.canonicalVersionKey &&
            text(revision.currentVersionKey) === current.canonicalVersionKey;
    }

    function evaluateComparison(context, current) {
        if (!context || context.available !== true ||
            context.canonicalPresent !== true) {
            return { eligible: false, reason: "comparison_missing", identity: identity(),
                sameAcquisition: false, dateRelation: "unknown",
                coverage: coverageFacts(), sameDateRevisionProven: false };
        }
        const previous = identity(context.identity || {});
        const coverage = coverageFacts(context.coverage);
        const structurallyValid = context.origin === "formal_history" &&
            context.canonicalValid === true && context.signatureValid === true &&
            context.versionKeyValid === true && context.openInterestStatus === "available" &&
            previous.complete;
        if (!structurallyValid) return { eligible: false,
            reason: "comparison_invalid", identity: previous, sameAcquisition: false,
            dateRelation: "unknown", coverage, sameDateRevisionProven: false };
        if (previous.contract !== current.contract) return { eligible: false,
            reason: "comparison_contract_mismatch", identity: previous,
            sameAcquisition: false, dateRelation: "unknown", coverage,
            sameDateRevisionProven: false };
        const sameAcquisition = previous.canonicalVersionKey === current.canonicalVersionKey ||
            previous.canonicalSignature === current.canonicalSignature;
        if (sameAcquisition) return { eligible: false,
            reason: "comparison_same_acquisition", identity: previous,
            sameAcquisition: true, dateRelation: "same_acquisition", coverage,
            sameDateRevisionProven: false };
        const relation = previous.tradingDate < current.tradingDate ? "previous" :
            previous.tradingDate === current.tradingDate ? "same_date" : "future";
        if (relation === "future") return { eligible: false,
            reason: "comparison_date_invalid", identity: previous,
            sameAcquisition: false, dateRelation: relation, coverage,
            sameDateRevisionProven: false };
        const revisionProven = relation === "same_date" &&
            sameDateRevisionProof(context, current, previous);
        if (relation === "same_date" && !revisionProven) return { eligible: false,
            reason: "comparison_same_date_unqualified", identity: previous,
            sameAcquisition: false, dateRelation: relation, coverage,
            sameDateRevisionProven: false };
        const coverageComparable = coverage.callPublishedCount > 0 &&
            coverage.putPublishedCount > 0 && coverage.commonPublishedStrikeCount > 0 &&
            coverage.comparisonCoverageVerified && !coverage.missingStrikeZeroFilled;
        if (!coverageComparable) return { eligible: false,
            reason: "comparison_coverage_insufficient", identity: previous,
            sameAcquisition: false, dateRelation: relation, coverage,
            sameDateRevisionProven: revisionProven };
        return { eligible: true, reason: null, identity: previous,
            sameAcquisition: false, dateRelation: relation, coverage,
            sameDateRevisionProven: revisionProven };
    }

    function priceIdentity(context = {}) {
        return { source: text(context.source), mode: text(context.mode),
            origin: text(context.origin), contract: text(context.contract),
            value: Number.isFinite(context.value) ? context.value : null,
            quotedAtRaw: text(context.quotedAtRaw), quoteDate: date(context.quoteDate),
            quotedAtNormalized: timestamp(context.quotedAtNormalized),
            fetchedAt: timestamp(context.fetchedAt), identity: text(context.identity),
            versionKey: text(context.versionKey) };
    }

    function evaluatePrice(context, current) {
        const price = priceIdentity(context || {});
        if (!context || context.available !== true) return { eligible: false,
            reason: "price_missing", identity: price, dateRelation: "unknown" };
        if (context.mode === "manual") return { eligible: false,
            reason: "price_manual", identity: price, dateRelation: "unknown" };
        if (context.restored === true || context.origin === "cache" ||
            context.origin === "saved") return { eligible: false,
            reason: "price_restored", identity: price, dateRelation: "unknown" };
        const validValue = Number.isFinite(context.value) && context.value > 0;
        const validShape = context.source === PRICE_SOURCE && context.mode === "automatic" &&
            context.origin === "live" && validValue && price.contract &&
            price.quotedAtRaw && price.quoteDate && price.quotedAtNormalized &&
            price.fetchedAt;
        if (!validShape) return { eligible: false, reason: "price_invalid",
            identity: price, dateRelation: "unknown" };
        if (price.contract !== current.contract) return { eligible: false,
            reason: "price_contract_mismatch", identity: price,
            dateRelation: "unknown" };
        if (context.identityVerified !== true || !price.identity || !price.versionKey) {
            return { eligible: false, reason: "price_identity_invalid",
                identity: price, dateRelation: "unknown" };
        }
        const dateContext = context.dateContext || {};
        const relation = text(dateContext.relation) || "unknown";
        const resolved = context.quoteDateResolution === PRICE_DATE_RESOLUTION &&
            context.quoteDateResolutionSource === "pageUpdatedAt" &&
            dateContext.resolved === true &&
            date(dateContext.quoteDate) === price.quoteDate &&
            date(dateContext.qriTradingDate) === current.tradingDate &&
            date(dateContext.mappedTradingDate) === current.tradingDate &&
            dateContext.tradingDateContextVerified === true &&
            context.freshnessContextVerified === true;
        const sameDate = relation === "same_date" && price.quoteDate === current.tradingDate;
        const overnight = relation === "overnight_previous_date" &&
            price.quoteDate < current.tradingDate && dateContext.sessionContextVerified === true;
        if (!resolved || !sameDate && !overnight) return { eligible: false,
            reason: "price_date_context_unresolved", identity: price,
            dateRelation: relation };
        return { eligible: true, reason: null, identity: price, dateRelation: relation };
    }

    function reason(saved, comparison, price, reference) {
        if (!saved.eligible) return saved.reason;
        if (!comparison.eligible) return comparison.reason;
        if (!price.eligible) return price.reason;
        if (reference?.combinedIdentityVerified !== true ||
            reference?.combinedContractVerified !== true ||
            reference?.combinedDateContextVerified !== true) {
            return "combined_identity_mismatch";
        }
        return null;
    }

    function buildQriOptionsSavedShadowIdentityEligibility(input = {}) {
        const saved = evaluateSavedCurrent(input.savedCurrentContext,
            input.referenceContext);
        const comparison = evaluateComparison(input.previousComparisonContext,
            saved.identity);
        const price = evaluatePrice(input.currentPriceContext, saved.identity);
        const failure = reason(saved, comparison, price, input.referenceContext);
        const eligible = failure === null;
        const combinedIdentity = { contract: saved.identity.contract,
            currentTradingDate: saved.identity.tradingDate,
            previousTradingDate: comparison.identity.tradingDate,
            priceQuoteDate: price.identity.quoteDate,
            currentVersionKey: saved.identity.canonicalVersionKey,
            previousVersionKey: comparison.identity.canonicalVersionKey };
        return deepFreeze({ eligibilityVersion: ELIGIBILITY_VERSION, eligible,
            status: saved.superseded ? "superseded" : eligible
                ? "eligible" : "unavailable", reason: failure,
            referenceOnly: true, formalApplied: false,
            tradeDecisionEligible: false, savedCurrent: clone(saved),
            comparison: clone(comparison), currentPrice: clone(price),
            combinedIdentity, diagnostics: {
                savedCurrentEligible: saved.eligible,
                comparisonEligible: comparison.eligible, priceEligible: price.eligible,
                contractMatched: saved.eligible && comparison.identity.contract ===
                    saved.identity.contract && price.identity.contract === saved.identity.contract,
                comparisonDateRelation: comparison.dateRelation,
                priceDateRelation: price.dateRelation,
                sameAcquisitionRejected: comparison.sameAcquisition,
                sameDateRevisionRejected: comparison.dateRelation === "same_date" &&
                    !comparison.sameDateRevisionProven,
                coverageComparable: comparison.eligible || comparison.reason !==
                    "comparison_coverage_insufficient" &&
                    comparison.coverage.comparisonCoverageVerified === true,
                dateContextResolved: price.eligible,
                formalApplied: false, tradeDecisionEligible: false,
                storageAccessed: false, databaseAccessed: false,
                historyAccessed: false, fetchTriggered: false,
                runtimeAccessed: false, domAccessed: false } });
    }

    return Object.freeze({ ELIGIBILITY_VERSION,
        buildQriOptionsSavedShadowIdentityEligibility });
});
