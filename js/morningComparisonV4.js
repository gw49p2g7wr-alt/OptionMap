(function (root, factory) {
    const baselineApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./morningBaselineV4.js") : root?.OptionMapMorningBaselineV4;
    const api = factory(baselineApi);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMorningComparisonV4 = api;
})(typeof window !== "undefined" ? window : globalThis, function (baselineApi) {
    "use strict";

    const COMPARISON_VERSION = 1;
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const finite = value => typeof value === "number" && Number.isFinite(value);

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function identity(snapshot) {
        return { baselineVersion: snapshot.baselineVersion, schemaVersion: snapshot.schemaVersion,
            baselineId: snapshot.baselineId, versionKey: snapshot.versionKey,
            contentSignature: snapshot.contentSignature, signature: snapshot.signature,
            capturedAt: snapshot.capturedAt };
    }

    function checks(overrides = {}) {
        return { logicVersionMatched: false, contractMatched: false,
            tradingDateMatched: false, sessionVerified: false,
            currentPriceMatched: false, qriMatched: false, weeklyMatched: false,
            ...overrides };
    }

    function unavailable(reason, baseline = null, current = null, checkOverrides = {}) {
        const comparisonChecks = checks(checkOverrides);
        return deepFreeze({ comparisonVersion: COMPARISON_VERSION, available: false,
            status: "unavailable", reason,
            baselineIdentity: baseline ? identity(baseline) : null,
            currentIdentity: current ? identity(current) : null,
            comparability: { comparable: false, class: "unavailable", reasons: [reason],
                checks: comparisonChecks }, overallV2: null, optionComponent: null,
            weeklyComponent: null, price: null, dataQuality: null,
            divergence: { available: false, supplyDemandDelta: null,
                priceDelta: null, relation: "unavailable" }, diagnostics: {
                baselineVersionKey: baseline?.versionKey || null,
                currentVersionKey: current?.versionKey || null,
                baselineCapturedAt: baseline?.capturedAt || null,
                currentEvaluatedAt: current?.overallV2?.evaluatedAt || null,
                logicVersion: baseline?.overallV2?.logicVersion || null,
                qriIdentities: baseline && current ? { baseline: clone(baseline.qri),
                    current: clone(current.qri) } : null,
                priceIdentities: baseline && current ? { baseline: clone(baseline.currentPrice),
                    current: clone(current.currentPrice) } : null,
                weeklyIdentities: baseline && current ? { baseline: clone(baseline.weekly),
                    current: clone(current.weekly) } : null } });
    }

    function compareComponent(baseline, current) {
        if (!object(baseline) || !object(current)) return { available: false,
            status: "unavailable", reason: "component_unavailable",
            baselineAvailable: baseline?.available === true,
            currentAvailable: current?.available === true,
            baselineDirection: null, currentDirection: null, normalizedDirectionDelta: null,
            directionDelta: null, qualityFactorDelta: null, evidenceFactorDelta: null,
            effectiveWeightDelta: null, weightedContributionDelta: null };
        if (baseline.available !== true || current.available !== true) return {
            available: false, status: "availability_changed",
            reason: "component_availability_changed", baselineAvailable: baseline.available === true,
            currentAvailable: current.available === true,
            baselineDirection: finite(baseline.directionScore) ? baseline.directionScore : null,
            currentDirection: finite(current.directionScore) ? current.directionScore : null,
            normalizedDirectionDelta: null, directionDelta: null, qualityFactorDelta: null,
            evidenceFactorDelta: null, effectiveWeightDelta: null, weightedContributionDelta: null };
        const required = [baseline.normalizedDirection, current.normalizedDirection,
            baseline.directionScore, current.directionScore, baseline.qualityFactor,
            current.qualityFactor, baseline.evidenceFactor, current.evidenceFactor,
            baseline.effectiveWeight, current.effectiveWeight, baseline.weightedContribution,
            current.weightedContribution];
        if (required.some(value => !finite(value))) return compareComponent(null, null);
        return { available: true, status: "comparable", reason: null,
            baselineAvailable: true, currentAvailable: true,
            baselineDirection: baseline.directionScore, currentDirection: current.directionScore,
            normalizedDirectionDelta: current.normalizedDirection - baseline.normalizedDirection,
            directionDelta: current.directionScore - baseline.directionScore,
            qualityFactorDelta: current.qualityFactor - baseline.qualityFactor,
            evidenceFactorDelta: current.evidenceFactor - baseline.evidenceFactor,
            effectiveWeightDelta: current.effectiveWeight - baseline.effectiveWeight,
            weightedContributionDelta: current.weightedContribution - baseline.weightedContribution };
    }

    function compareQuality(baseline, current) {
        if (!object(baseline) || !object(current) ||
            !["complete", "partial"].includes(baseline.status) ||
            !["complete", "partial"].includes(current.status)) return null;
        const before = [...new Set(baseline.warnings || [])].sort();
        const after = [...new Set(current.warnings || [])].sort();
        const sameFallbackFlags = object(baseline.fallbackFlags) && object(current.fallbackFlags) &&
            Object.keys(baseline.fallbackFlags).sort().join("\0") ===
                Object.keys(current.fallbackFlags).sort().join("\0") &&
            Object.keys(baseline.fallbackFlags).every(key =>
                baseline.fallbackFlags[key] === current.fallbackFlags[key]);
        const changed = baseline.status !== current.status || before.join("\0") !== after.join("\0") ||
            JSON.stringify(baseline.componentAvailability) !== JSON.stringify(current.componentAvailability) ||
            !sameFallbackFlags;
        const transition = baseline.status === current.status ? changed ? "changed_unclassified" : "unchanged" :
            baseline.status === "partial" && current.status === "complete" ? "improved" :
                baseline.status === "complete" && current.status === "partial" ? "degraded" :
                    "changed_unclassified";
        return { baselineStatus: baseline.status, currentStatus: current.status, changed, transition,
            baselineWarnings: before, currentWarnings: after,
            addedWarnings: after.filter(item => !before.includes(item)),
            resolvedWarnings: before.filter(item => !after.includes(item)),
            componentAvailabilityChanged: JSON.stringify(baseline.componentAvailability) !==
                JSON.stringify(current.componentAvailability),
            fallbackFlagsChanged: !sameFallbackFlags };
    }

    function relation(supplyDemandDelta, priceDelta) {
        if (!finite(supplyDemandDelta) || !finite(priceDelta)) return "unavailable";
        if (supplyDemandDelta === 0 || priceDelta === 0) return "zero_involved";
        return Math.sign(supplyDemandDelta) === Math.sign(priceDelta)
            ? "same_direction" : "opposite_direction";
    }

    function priceComparable(snapshot) {
        const price = snapshot.currentPrice;
        const mapping = price?.dateMapping;
        return object(price) && finite(price.value) && price.value > 0 &&
            price.contract === snapshot.qri.contract && price.quoteDate === snapshot.marketContext.formalTradingDate &&
            mapping?.mappingVerified === true && mapping?.qriTradingDate === snapshot.marketContext.formalTradingDate &&
            mapping?.mappingSource === "same_date_explicit";
    }

    async function buildMorningComparisonV4(input = {}) {
        const baseline = input.baseline;
        const current = input.currentSnapshot;
        if (!await baselineApi?.validateMorningBaselineV4?.(baseline)) return unavailable("baseline_invalid");
        if (!await baselineApi?.validateMorningBaselineV4?.(current)) return unavailable("current_invalid", baseline);
        const logicMatched = baseline.overallV2.logicVersion === current.overallV2.logicVersion;
        if (!logicMatched) return unavailable("logic_version_mismatch", baseline, current);
        const baselineContract = baseline.qri.contract;
        const currentContract = current.qri.contract;
        const contractMatched = baselineContract === currentContract &&
            baseline.currentPrice.contract === current.currentPrice.contract;
        if (!contractMatched) return unavailable("contract_roll", baseline, current,
            { logicVersionMatched: true });
        const dateMatched = baseline.marketContext.formalTradingDate ===
            current.marketContext.formalTradingDate;
        if (!dateMatched) return unavailable("trading_date_mismatch", baseline, current,
            { logicVersionMatched: true, contractMatched: true });
        const sessionVerified = baseline.comparability.sessionVerified === true &&
            current.comparability.sessionVerified === true &&
            baseline.marketContext.sessionMappingStatus === "verified" &&
            current.marketContext.sessionMappingStatus === "verified" &&
            baseline.marketContext.sessionIdentity === current.marketContext.sessionIdentity;
        if (!sessionVerified) return unavailable("session_unverified", baseline, current,
            { logicVersionMatched: true, contractMatched: true, tradingDateMatched: true });
        const qriMatched = baseline.qri.historyEntryId === current.qri.historyEntryId &&
            baseline.qri.contract === current.qri.contract &&
            baseline.qri.tradingDate === current.qri.tradingDate;
        if (!qriMatched) return unavailable("qri_identity_mismatch", baseline, current,
            { logicVersionMatched: true, contractMatched: true, tradingDateMatched: true,
                sessionVerified: true });
        const priceMatched = priceComparable(baseline) && priceComparable(current);
        if (!priceMatched) return unavailable("price_identity_mismatch", baseline, current,
            { logicVersionMatched: true, contractMatched: true, tradingDateMatched: true,
                sessionVerified: true, qriMatched: true });
        const baselineWeeklyIdentity = baseline.overallV2.components.weekly.sourceIdentity;
        const currentWeeklyIdentity = current.overallV2.components.weekly.sourceIdentity;
        const weeklyMatched = baselineWeeklyIdentity.source === currentWeeklyIdentity.source &&
            baselineWeeklyIdentity.versionKey === baseline.weekly.versionKey &&
            currentWeeklyIdentity.versionKey === current.weekly.versionKey;
        if (!weeklyMatched) return unavailable("weekly_identity_mismatch", baseline, current,
            { logicVersionMatched: true, contractMatched: true, tradingDateMatched: true,
                sessionVerified: true, qriMatched: true, currentPriceMatched: true });

        const overallV2 = { baselineScore: baseline.overallV2.directionScore,
            currentScore: current.overallV2.directionScore,
            delta: current.overallV2.directionScore - baseline.overallV2.directionScore,
            baselineDirection: baseline.overallV2.direction,
            currentDirection: current.overallV2.direction,
            baselineLabel: baseline.overallV2.directionLabel,
            currentLabel: current.overallV2.directionLabel,
            sideChanged: Math.sign(baseline.overallV2.direction) !== Math.sign(current.overallV2.direction),
            labelChanged: baseline.overallV2.directionLabel !== current.overallV2.directionLabel,
            confidenceDelta: current.overallV2.confidence - baseline.overallV2.confidence,
            coverageDelta: current.overallV2.coverage - baseline.overallV2.coverage,
            agreementDelta: current.overallV2.agreement - baseline.overallV2.agreement };
        const optionComponent = compareComponent(baseline.overallV2.components.option,
            current.overallV2.components.option);
        const weeklyComponent = compareComponent(baseline.overallV2.components.weekly,
            current.overallV2.components.weekly);
        const delta = current.currentPrice.value - baseline.currentPrice.value;
        const price = { available: true, baselineValue: baseline.currentPrice.value,
            currentValue: current.currentPrice.value, delta,
            percentDelta: delta / baseline.currentPrice.value * 100 };
        const dataQuality = compareQuality(baseline.dataQuality, current.dataQuality);
        if (!dataQuality) return unavailable("data_quality_incomparable", baseline, current);
        const divergence = { available: true, supplyDemandDelta: overallV2.delta,
            priceDelta: price.delta, relation: relation(overallV2.delta, price.delta) };
        const comparisonChecks = checks({ logicVersionMatched: true, contractMatched: true,
            tradingDateMatched: true, sessionVerified: true, currentPriceMatched: true,
            qriMatched: true, weeklyMatched: true });
        return deepFreeze({ comparisonVersion: COMPARISON_VERSION, available: true,
            status: "comparable", reason: null, baselineIdentity: identity(baseline),
            currentIdentity: identity(current), comparability: { comparable: true,
                class: "same_formal_session", reasons: [], checks: comparisonChecks },
            overallV2, optionComponent, weeklyComponent, price, dataQuality, divergence,
            diagnostics: { baselineVersionKey: baseline.versionKey,
                currentVersionKey: current.versionKey, baselineCapturedAt: baseline.capturedAt,
                currentEvaluatedAt: current.overallV2.evaluatedAt,
                logicVersion: baseline.overallV2.logicVersion,
                qriIdentities: { baseline: clone(baseline.qri), current: clone(current.qri) },
                priceIdentities: { baseline: clone(baseline.currentPrice),
                    current: clone(current.currentPrice) },
                weeklyIdentities: { baseline: clone(baseline.weekly),
                    current: clone(current.weekly) } } });
    }

    return Object.freeze({ COMPARISON_VERSION, buildMorningComparisonV4,
        compareComponent, compareQuality, relation });
});
