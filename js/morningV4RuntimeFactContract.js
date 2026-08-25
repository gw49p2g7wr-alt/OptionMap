(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMorningV4RuntimeFactContract = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const CONTRACT_VERSION = 1;
    const SOURCE_CLASSES = Object.freeze(["formal_live", "formal_history", "saved",
        "reference", "legacy", "manual", "restored"]);
    const REASON_ORDER = Object.freeze(["refresh_in_progress", "source_generation_changed",
        "session_unverified", "overall_identity_missing", "overall_input_mismatch",
        "current_price_identity_missing", "qri_revision_identity_missing", "qri_not_formal",
        "weekly_identity_missing", "weekly_component_mismatch", "data_quality_missing",
        "nearest_levels_invalid", "mixed_acquisition", "contract_mismatch",
        "trading_date_mismatch", "fallback_present"]);
    const FACT_CLASSES = Object.freeze({ required: Object.freeze(["marketSession", "overallV2",
        "currentPrice", "qri", "weekly", "dataQuality"]),
    optional: Object.freeze(["nearestLevels"]) });
    const INVARIANTS = deepFreeze({ formalTradingDateMatched: true, contractMatched: true,
        currentRequestRequired: true, fallbackForbidden: true, savedReferenceManualRestoredForbidden: true,
        overallInputBindingRequired: true, qriPriceAcquisitionBindingRequired: true,
        weeklyComponentBindingRequired: true, collectionGenerationStable: true,
        refreshInProgressForbidden: true });

    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const finite = value => typeof value === "number" && Number.isFinite(value);
    const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function canonicalize(value) {
        if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
        if (object(value)) return `{${Object.keys(value).sort().map(key =>
            `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
        return JSON.stringify(value);
    }

    async function sha256(value) {
        const serialized = typeof value === "string" ? value : canonicalize(value);
        if (typeof module === "object" && module.exports) {
            return require("node:crypto").createHash("sha256").update(serialized).digest("hex");
        }
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    }

    function generation(value, source) {
        return object(value) && value.source === source && Number.isSafeInteger(value.sequence) &&
            value.sequence >= 0 && text(value.fingerprint) && value.current === true;
    }

    function validMarket(value) {
        return object(value) && date(value.formalTradingDate) && date(value.captureCalendarDate) &&
            text(value.sessionScopeId) && value.sessionMappingStatus === "verified" &&
            value.mappingVerified === true && text(value.source) &&
            value.source !== "jst_calendar_day" && generation(value.generation, "marketSession");
    }

    function validOverall(value) {
        return object(value) && value.sourceClass === "formal_live" && value.formalApplied === true &&
            value.referenceOnly === false && object(value.result) &&
            ["complete", "partial"].includes(value.result.status) && finite(value.result.direction) &&
            text(value.logicVersion) && timestamp(value.evaluatedAt) && text(value.requestId) &&
            text(value.inputFingerprint) && object(value.optionSourceIdentity) &&
            text(value.optionSourceIdentity.canonicalVersionKey) &&
            text(value.optionSourceIdentity.sourceFingerprint) && object(value.weeklySourceIdentity) &&
            text(value.weeklySourceIdentity.currentVersionKey) &&
            text(value.weeklySourceIdentity.sourceFingerprint) && generation(value.generation, "overallV2");
    }

    function validPrice(value) {
        const mapping = value?.qriTradingDateMapping;
        return object(value) && value.available === true && value.sourceKind === "live" &&
            value.origin === "live" && value.mode === "automatic" && finite(value.value) && value.value > 0 &&
            text(value.contract) && date(value.quoteDate) && timestamp(value.quotedAtNormalized) &&
            text(value.quoteSignature) && text(value.versionKey) && text(value.requestId) &&
            timestamp(value.fetchedAt) && object(value.acquisitionIdentity) &&
            value.identityVerified === true && value.acquisitionVerified === true &&
            value.currentRequestVerified === true && mapping?.mappingVerified === true &&
            mapping?.mappingSource === "same_date_explicit" && date(mapping.qriTradingDate) &&
            generation(value.generation, "currentPrice");
    }

    function validQri(value) {
        return object(value) && value.sourceClass === "formal_live" && value.origin === "live" &&
            value.usingFallback === false && value.referenceOnly === false && value.superseded === false &&
            text(value.contract) && date(value.tradingDate) && timestamp(value.pageUpdatedAt) &&
            text(value.canonicalSignature) && text(value.canonicalVersionKey) &&
            text(value.historyEntryIdentity) && text(value.historyRevisionIdentity) &&
            ["saved", "unchanged"].includes(value.persistenceStatus) && text(value.requestId) &&
            timestamp(value.fetchedAt) && generation(value.generation, "qri");
    }

    function validWeekly(value) {
        return object(value) && value.sourceClass === "formal_history" &&
            text(value.previousVersionKey) && text(value.currentVersionKey) &&
            text(value.currentSignature) && value.activeVersionMatched === true &&
            [value.normalizedDirection, value.qualityFactor, value.evidenceFactor,
                value.effectiveWeight, value.weightedContribution].every(finite) &&
            object(value.componentMetadata) && text(value.sourceFingerprint) &&
            object(value.requestContext) && text(value.requestContext.requestId) &&
            generation(value.generation, "weekly");
    }

    function validQuality(value) {
        const identities = value?.sourceIdentities;
        return object(value) && ["complete", "partial"].includes(value.status) &&
            Array.isArray(value.warnings) && object(value.sourceAvailability) &&
            object(value.componentAvailability) && object(value.fallbackFlags) &&
            Object.values(value.fallbackFlags).every(flag => flag === false) &&
            object(identities) && text(identities.qriVersionKey) &&
            text(identities.priceVersionKey) && text(identities.weeklyVersionKey) &&
            text(identities.logicVersion) && text(value.sourceFingerprint) &&
            generation(value.generation, "dataQuality");
    }

    function validLevels(value) {
        const level = item => object(item) && typeof item.available === "boolean" &&
            (!item.available || finite(item.price) && finite(item.distance));
        return object(value) && level(value.upper) && level(value.lower) && text(value.contract) &&
            text(value.sourceVersionKey) && value.generatedFromFormalOnly === true &&
            generation(value.generation, "nearestLevels");
    }

    async function expectedOverallInputFingerprint(facts) {
        return sha256({ logicVersion: facts.overallV2.logicVersion,
            qriCanonicalVersionKey: facts.qri.canonicalVersionKey,
            qriSourceFingerprint: facts.overallV2.optionSourceIdentity.sourceFingerprint,
            weeklyCurrentVersionKey: facts.weekly.currentVersionKey,
            weeklySourceFingerprint: facts.weekly.sourceFingerprint });
    }

    async function createFormalSnapshotInputFingerprint(facts) {
        return sha256({ sessionScopeId: facts.marketSession.sessionScopeId,
            formalTradingDate: facts.marketSession.formalTradingDate,
            overallInputFingerprint: facts.overallV2.inputFingerprint,
            currentPriceVersionKey: facts.currentPrice.versionKey,
            currentPriceRequestId: facts.currentPrice.requestId,
            qriCanonicalVersionKey: facts.qri.canonicalVersionKey,
            qriHistoryRevisionIdentity: facts.qri.historyRevisionIdentity,
            weeklyCurrentVersionKey: facts.weekly.currentVersionKey,
            weeklySourceFingerprint: facts.weekly.sourceFingerprint,
            dataQualitySourceFingerprint: facts.dataQuality.sourceFingerprint });
    }

    async function evaluateMorningV4RuntimeFactReadiness(input = {}) {
        const facts = object(input.facts) ? clone(input.facts) : {};
        const context = object(input.collectionContext) ? clone(input.collectionContext) : {};
        const reasons = [];
        const add = reason => { if (!reasons.includes(reason)) reasons.push(reason); };
        if (context.refreshInProgress === true) add("refresh_in_progress");
        if (!text(context.startGenerationFingerprint) || !text(context.endGenerationFingerprint) ||
            context.startGenerationFingerprint !== context.endGenerationFingerprint ||
            context.sourceGenerationChanged === true) add("source_generation_changed");
        if (!validMarket(facts.marketSession)) add("session_unverified");
        if (!validOverall(facts.overallV2)) add("overall_identity_missing");
        if (!validPrice(facts.currentPrice)) add("current_price_identity_missing");
        if (!object(facts.qri) || !text(facts.qri.historyEntryIdentity) ||
            !text(facts.qri.historyRevisionIdentity)) add("qri_revision_identity_missing");
        if (!validQri(facts.qri)) add("qri_not_formal");
        if (!validWeekly(facts.weekly)) add("weekly_identity_missing");
        if (!validQuality(facts.dataQuality)) add("data_quality_missing");
        if (facts.nearestLevels !== undefined && facts.nearestLevels !== null &&
            !validLevels(facts.nearestLevels)) add("nearest_levels_invalid");
        if (facts.qri?.usingFallback === true || object(facts.dataQuality?.fallbackFlags) &&
            Object.values(facts.dataQuality.fallbackFlags).some(Boolean)) add("fallback_present");

        const coreValid = validMarket(facts.marketSession) && validOverall(facts.overallV2) &&
            validPrice(facts.currentPrice) && validQri(facts.qri) && validWeekly(facts.weekly) &&
            validQuality(facts.dataQuality);
        if (coreValid) {
            const expectedInput = await expectedOverallInputFingerprint(facts);
            if (facts.overallV2.inputFingerprint !== expectedInput) add("overall_input_mismatch");
            if (facts.overallV2.optionSourceIdentity.canonicalVersionKey !==
                facts.qri.canonicalVersionKey) add("overall_input_mismatch");
            if (facts.overallV2.weeklySourceIdentity.currentVersionKey !==
                    facts.weekly.currentVersionKey ||
                facts.overallV2.weeklySourceIdentity.sourceFingerprint !==
                    facts.weekly.sourceFingerprint) add("weekly_component_mismatch");
            const qualityIdentities = facts.dataQuality.sourceIdentities;
            if (qualityIdentities.qriVersionKey !== facts.qri.canonicalVersionKey ||
                qualityIdentities.priceVersionKey !== facts.currentPrice.versionKey ||
                qualityIdentities.weeklyVersionKey !== facts.weekly.currentVersionKey ||
                qualityIdentities.logicVersion !== facts.overallV2.logicVersion)
                add("data_quality_missing");
            if (facts.qri.requestId !== facts.currentPrice.requestId ||
                facts.overallV2.requestId !== facts.qri.requestId ||
                context.marketRefreshRequestId !== facts.qri.requestId ||
                facts.weekly.requestContext.marketRefreshRequestId !==
                    context.marketRefreshRequestId) add("mixed_acquisition");
            if (facts.qri.contract !== facts.currentPrice.contract ||
                facts.nearestLevels && facts.nearestLevels.contract !== facts.qri.contract)
                add("contract_mismatch");
            if (facts.qri.tradingDate !== facts.marketSession.formalTradingDate ||
                facts.currentPrice.qriTradingDateMapping.qriTradingDate !==
                    facts.marketSession.formalTradingDate) add("trading_date_mismatch");
        }
        reasons.sort((left, right) => REASON_ORDER.indexOf(left) - REASON_ORDER.indexOf(right));
        const ready = reasons.length === 0;
        const fingerprint = ready ? await createFormalSnapshotInputFingerprint(facts) : null;
        return deepFreeze({ contractVersion: CONTRACT_VERSION, ready,
            status: ready ? "ready" : "not_ready", reasons,
            facts: { marketSession: facts.marketSession || null,
                overallV2: facts.overallV2 || null, currentPrice: facts.currentPrice || null,
                qri: facts.qri || null, weekly: facts.weekly || null,
                dataQuality: facts.dataQuality || null,
                nearestLevels: facts.nearestLevels || null },
            invariants: clone(INVARIANTS), diagnostics: {
                formalSnapshotInputFingerprint: fingerprint,
                collectionStartFingerprint: context.startGenerationFingerprint || null,
                collectionEndFingerprint: context.endGenerationFingerprint || null,
                marketRefreshRequestId: context.marketRefreshRequestId || null,
                nearestLevelsRequired: false } });
    }

    return Object.freeze({ CONTRACT_VERSION, SOURCE_CLASSES, REASON_ORDER, FACT_CLASSES,
        INVARIANTS, canonicalize, expectedOverallInputFingerprint,
        createFormalSnapshotInputFingerprint, evaluateMorningV4RuntimeFactReadiness });
});
