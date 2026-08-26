(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMorningBaselineV4 = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const BASELINE_VERSION = 4;
    const SCHEMA_VERSION = 1;
    const SIGNATURE_ALGORITHM = "sha256";
    const TOP_LEVEL_FIELDS = Object.freeze(["baselineVersion", "schemaVersion", "baselineId",
        "capturedAt", "marketContext", "overallV2", "currentPrice", "qri", "weekly",
        "nearestLevels", "dataQuality", "comparability", "signatureAlgorithm",
        "contentSignature", "signature", "versionKey"]);
    const LEVEL_CONTEXT_FIELDS = Object.freeze(["generatedFromFormalOnly", "referenceOnly",
        "usingFallback", "contract", "sourceVersionKey", "upper", "lower"]);
    const LEVELS_FIELDS = Object.freeze(["upper", "lower", "contract", "sourceVersionKey",
        "generatedFromFormalOnly"]);
    const LEVEL_FIELDS = Object.freeze(["available", "price", "distance", "optionType"]);

    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const finite = value => typeof value === "number" && Number.isFinite(value);
    const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
    const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
        fields.every(field => Object.hasOwn(value, field));

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

    function jstDate(value) {
        return timestamp(value) ? new Date(Date.parse(value) + 32400000).toISOString().slice(0, 10) : null;
    }

    function failure(reason) {
        return deepFreeze({ success: false, reason, baseline: null });
    }

    function componentSnapshot(component, sourceIdentity) {
        return { name: text(component.name), available: component.available === true,
            invalid: component.invalid === true,
            normalizedDirection: finite(component.normalizedDirection) ? component.normalizedDirection : null,
            directionScore: finite(component.directionScore) ? component.directionScore : null,
            baseWeight: finite(component.baseWeight) ? component.baseWeight : null,
            qualityFactor: finite(component.qualityFactor) ? component.qualityFactor : null,
            effectiveWeight: finite(component.effectiveWeight) ? component.effectiveWeight : null,
            weightedContribution: finite(component.weightedContribution)
                ? component.weightedContribution : null,
            evidenceFactor: finite(component.evidenceFactor) ? component.evidenceFactor : null,
            notes: Array.isArray(component.notes) ? component.notes.filter(item => typeof item === "string") : [],
            metadata: object(component.metadata) ? clone(component.metadata) : null,
            sourceIdentity: clone(sourceIdentity) };
    }

    function validIdentity(identity) {
        return object(identity) && text(identity.source) && text(identity.versionKey) &&
            (identity.signature === null || text(identity.signature)) && identity.verified === true;
    }

    function buildOverall(context) {
        const result = context?.result;
        const logicVersion = text(context?.logicVersion);
        if (!logicVersion) return { error: "logic_version_missing" };
        if (context?.origin !== "formal_live" || context?.formalApplied !== true ||
            context?.superseded === true || !object(result) ||
            !["complete", "partial"].includes(result.status) || !finite(result.direction)) {
            return { error: "overall_unavailable" };
        }
        const identities = context.componentIdentities;
        if (!validIdentity(context.inputIdentity) || !validIdentity(identities?.option) ||
            !validIdentity(identities?.weekly) || !timestamp(context.evaluatedAt)) {
            return { error: "overall_identity_invalid" };
        }
        const option = result.components?.option;
        const weekly = result.components?.weekly;
        if (!object(option) || !object(weekly) || option.available !== true || weekly.available !== true ||
            option.invalid === true || weekly.invalid === true) return { error: "overall_unavailable" };
        const values = [result.confidence, result.metadata?.coverage,
            result.confidenceFactors?.agreement];
        if (values.some(value => !finite(value))) return { error: "overall_unavailable" };
        return { value: { logicVersion, evaluatedAt: context.evaluatedAt, available: true,
            status: result.status, directionScore: result.direction, direction: result.direction,
            directionLabel: text(result.directionLabel), confidence: result.confidence,
            coverage: result.metadata.coverage, agreement: result.confidenceFactors.agreement,
            warnings: Array.isArray(result.metadata.warnings)
                ? result.metadata.warnings.filter(item => typeof item === "string") : [],
            inputIdentity: clone(context.inputIdentity), components: {
                option: componentSnapshot(option, identities.option),
                weekly: componentSnapshot(weekly, identities.weekly) } } };
    }

    function buildPrice(context) {
        if (!context || context.available !== true) return { error: "current_price_unavailable" };
        if (context.sourceKind !== "live" || context.origin !== "live" ||
            context.mode !== "automatic") return { error: "current_price_not_live" };
        if (context.identityVerified !== true || context.acquisitionVerified !== true ||
            context.currentRequestVerified !== true || !finite(context.value) || context.value <= 0 ||
            !text(context.contract) || !date(context.quoteDate) ||
            !timestamp(context.quotedAtNormalized) || !text(context.quoteSignature) ||
            !text(context.versionKey) || !text(context.wrapperSignature) ||
            !text(context.requestId) || !timestamp(context.fetchedAt) ||
            !object(context.qriTradingDateMapping)) return { error: "current_price_identity_invalid" };
        return { value: { value: context.value, contract: context.contract,
            quoteDate: context.quoteDate, quotedAtNormalized: context.quotedAtNormalized,
            quoteSignature: context.quoteSignature, versionKey: context.versionKey,
            acquisitionIdentity: clone(context.acquisitionIdentity), requestId: context.requestId,
            fetchedAt: context.fetchedAt, dateMapping: clone(context.qriTradingDateMapping) } };
    }

    function buildQri(context) {
        if (!context || context.available !== true) return { error: "qri_unavailable" };
        if (context.origin !== "formal_live" || context.sourceKind !== "live" ||
            context.formalRevisionAvailable !== true || context.referenceOnly === true ||
            context.usingFallback === true || context.restored === true || context.superseded === true) {
            return { error: "qri_not_formal" };
        }
        const identity = context.identity;
        if (!object(identity) || identity.verified !== true || !text(identity.contract) ||
            !date(identity.tradingDate) || !timestamp(identity.pageUpdatedAt) ||
            !text(identity.canonicalSignature) || !text(identity.canonicalVersionKey) ||
            !text(identity.historyEntryId) || !text(identity.historyRevisionId) ||
            !["available", "partial"].includes(context.openInterestStatus)) {
            return { error: "qri_identity_invalid" };
        }
        return { value: { contract: identity.contract, tradingDate: identity.tradingDate,
            pageUpdatedAt: identity.pageUpdatedAt, canonicalSignature: identity.canonicalSignature,
            canonicalVersionKey: identity.canonicalVersionKey,
            historyEntryId: identity.historyEntryId, historyRevisionId: identity.historyRevisionId,
            openInterestStatus: context.openInterestStatus } };
    }

    function buildWeekly(context) {
        if (!context || context.available !== true) return { error: "weekly_unavailable" };
        if (context.origin !== "formal_history" || context.formalApplied !== true ||
            context.usingFallback === true || context.superseded === true ||
            !date(context.sourceDate) || !text(context.versionKey) ||
            context.signature !== null && !text(context.signature) ||
            context.identityVerified !== true) return { error: "weekly_identity_invalid" };
        return { value: { available: true, sourceDate: context.sourceDate,
            versionKey: context.versionKey, signature: context.signature,
            normalizedDirection: context.normalizedDirection,
            qualityFactor: context.qualityFactor, effectiveWeight: context.effectiveWeight,
            weightedContribution: context.weightedContribution,
            metadata: object(context.metadata) ? clone(context.metadata) : null } };
    }

    function buildLevels(context, contract, qriVersionKey) {
        if (context === null) return { value: null };
        if (!exact(context, LEVEL_CONTEXT_FIELDS) || context.generatedFromFormalOnly !== true ||
            context.referenceOnly === true || context.usingFallback === true ||
            context.contract !== contract || context.sourceVersionKey !== qriVersionKey)
            return { error: "qri_identity_invalid" };
        const level = (value, optionType) => exact(value, LEVEL_FIELDS) &&
            typeof value.available === "boolean" && (value.available === true ?
                finite(value.price) && value.price > 0 && finite(value.distance) &&
                    value.distance >= 0 && value.optionType === optionType :
                value.price === null && value.distance === null && value.optionType === null)
            ? clone(value) : null;
        const upper = level(context.upper, "CALL"); const lower = level(context.lower, "PUT");
        return upper && lower ? { value: { upper, lower, contract, sourceVersionKey: qriVersionKey,
            generatedFromFormalOnly: true } } : { error: "qri_identity_invalid" };
    }

    function buildQuality(context) {
        if (!object(context) || !["complete", "partial"].includes(context.status) ||
            !Array.isArray(context.warnings) || !object(context.sourceAvailability) ||
            !object(context.componentAvailability) || !object(context.fallbackFlags) ||
            Object.values(context.fallbackFlags).some(value => value !== false)) return null;
        return { status: context.status, warnings: [...context.warnings],
            sourceAvailability: clone(context.sourceAvailability),
            fallbackFlags: clone(context.fallbackFlags),
            componentAvailability: clone(context.componentAvailability) };
    }

    function contentOf(baseline) {
        return { baselineVersion: baseline.baselineVersion, schemaVersion: baseline.schemaVersion,
            marketContext: baseline.marketContext, overallV2: baseline.overallV2,
            currentPrice: baseline.currentPrice, qri: baseline.qri, weekly: baseline.weekly,
            nearestLevels: baseline.nearestLevels, dataQuality: baseline.dataQuality,
            comparability: baseline.comparability };
    }

    function eventOf(baseline) {
        return { contentSignature: baseline.contentSignature, capturedAt: baseline.capturedAt };
    }

    function validComponentSnapshot(value, expectedName) {
        return object(value) && value.name === expectedName && value.available === true &&
            value.invalid === false && [value.normalizedDirection, value.directionScore,
                value.baseWeight, value.qualityFactor, value.effectiveWeight,
                value.weightedContribution, value.evidenceFactor].every(finite) &&
            value.normalizedDirection >= -1 && value.normalizedDirection <= 1 &&
            value.qualityFactor >= 0 && value.qualityFactor <= 1 &&
            value.evidenceFactor >= 0 && value.evidenceFactor <= 1 &&
            value.baseWeight > 0 && value.effectiveWeight > 0 && Array.isArray(value.notes) &&
            value.notes.every(item => typeof item === "string") && validIdentity(value.sourceIdentity);
    }

    function validSnapshotShape(baseline) {
        const market = baseline.marketContext;
        const overall = baseline.overallV2;
        const price = baseline.currentPrice;
        const qri = baseline.qri;
        const weekly = baseline.weekly;
        const levels = baseline.nearestLevels;
        const quality = baseline.dataQuality;
        const comparable = baseline.comparability;
        const marketValid = object(market) && date(market.captureCalendarDate) &&
            market.captureCalendarDate === jstDate(baseline.capturedAt) &&
            date(market.formalTradingDate) && ["verified", "unresolved"].includes(market.sessionMappingStatus) &&
            (market.sessionMappingStatus === "verified" ? Boolean(text(market.sessionIdentity)) :
                market.sessionIdentity === null);
        const overallValid = object(overall) && text(overall.logicVersion) &&
            timestamp(overall.evaluatedAt) && overall.available === true &&
            ["complete", "partial"].includes(overall.status) && finite(overall.directionScore) &&
            overall.directionScore === overall.direction && finite(overall.confidence) &&
            finite(overall.coverage) && finite(overall.agreement) && Array.isArray(overall.warnings) &&
            validIdentity(overall.inputIdentity) &&
            validComponentSnapshot(overall.components?.option, "option") &&
            validComponentSnapshot(overall.components?.weekly, "weekly");
        const acquisition = price?.acquisitionIdentity;
        const mapping = price?.dateMapping;
        const priceValid = object(price) && finite(price.value) && price.value > 0 &&
            text(price.contract) && date(price.quoteDate) && timestamp(price.quotedAtNormalized) &&
            text(price.quoteSignature) && text(price.versionKey) && text(price.requestId) &&
            timestamp(price.fetchedAt) && object(acquisition) &&
            acquisition.requestId === price.requestId && acquisition.fetchedAt === price.fetchedAt &&
            text(acquisition.sourceUrl) && text(acquisition.wrapperSignature) && object(mapping) &&
            typeof mapping.mappingVerified === "boolean";
        const qriValid = object(qri) && text(qri.contract) && date(qri.tradingDate) &&
            timestamp(qri.pageUpdatedAt) && text(qri.canonicalSignature) &&
            text(qri.canonicalVersionKey) && text(qri.historyEntryId) &&
            text(qri.historyRevisionId) && ["available", "partial"].includes(qri.openInterestStatus);
        const weeklyValid = object(weekly) && weekly.available === true && date(weekly.sourceDate) &&
            text(weekly.versionKey) && (weekly.signature === null || text(weekly.signature)) &&
            [weekly.normalizedDirection, weekly.qualityFactor, weekly.effectiveWeight,
                weekly.weightedContribution].every(finite);
        const levelValid = (value, optionType) => exact(value, LEVEL_FIELDS) &&
            typeof value.available === "boolean" && (value.available === true ?
                finite(value.price) && value.price > 0 && finite(value.distance) &&
                    value.distance >= 0 && value.optionType === optionType :
                value.price === null && value.distance === null && value.optionType === null);
        const levelsValid = levels === null || exact(levels, LEVELS_FIELDS) &&
            levelValid(levels.upper, "CALL") && levelValid(levels.lower, "PUT") &&
            levels.contract === qri?.contract && levels.sourceVersionKey === qri?.canonicalVersionKey &&
            levels.generatedFromFormalOnly === true;
        const qualityValid = object(quality) && ["complete", "partial"].includes(quality.status) &&
            Array.isArray(quality.warnings) && object(quality.sourceAvailability) &&
            object(quality.fallbackFlags) && Object.values(quality.fallbackFlags).every(value => value === false) &&
            object(quality.componentAvailability);
        const sessionVerified = market?.sessionMappingStatus === "verified";
        const comparabilityValid = object(comparable) && comparable.formalLive === true &&
            comparable.sessionVerified === sessionVerified && comparable.currentPriceVerified === true &&
            comparable.qriVerified === true && comparable.weeklyVerified === true &&
            comparable.logicVersion === overall?.logicVersion && comparable.comparisonClass ===
                (sessionVerified ? "formal_live_verified_session" : "formal_live_session_unresolved");
        return marketValid && overallValid && priceValid && qriValid && weeklyValid && levelsValid &&
            qualityValid && comparabilityValid && price.contract === qri.contract &&
            qri.tradingDate === market.formalTradingDate;
    }

    async function validateMorningBaselineV4(baseline) {
        if (!exact(baseline, TOP_LEVEL_FIELDS) || baseline.baselineVersion !== BASELINE_VERSION ||
            baseline.schemaVersion !== SCHEMA_VERSION || baseline.signatureAlgorithm !== SIGNATURE_ALGORITHM ||
            !/^mb4-[a-f0-9]{24}$/.test(baseline.baselineId || "") || !timestamp(baseline.capturedAt) ||
            !/^[a-f0-9]{64}$/.test(baseline.contentSignature || "") ||
            !/^[a-f0-9]{64}$/.test(baseline.signature || "") || !text(baseline.versionKey) ||
            !validSnapshotShape(baseline)) return false;
        const contentSignature = await sha256(contentOf(baseline));
        const signature = await sha256(eventOf(baseline));
        return baseline.contentSignature === contentSignature && baseline.signature === signature &&
            baseline.versionKey === `morning-baseline-v4|sha256:${contentSignature}` &&
            baseline.baselineId === `mb4-${signature.slice(0, 24)}`;
    }

    async function buildMorningBaselineV4(input = {}) {
        const capturedAt = text(input.capturedAt);
        const market = input.marketContext;
        if (!timestamp(capturedAt) || !object(market) || !date(market.captureCalendarDate) ||
            market.captureCalendarDate !== jstDate(capturedAt) || !date(market.formalTradingDate) ||
            !["verified", "unresolved"].includes(market.sessionMappingStatus) ||
            market.sessionMappingStatus === "verified" && !text(market.sessionIdentity)) {
            return failure("session_context_unresolved");
        }
        const overall = buildOverall(input.overallV2Context);
        if (overall.error) return failure(overall.error);
        const price = buildPrice(input.currentPriceContext);
        if (price.error) return failure(price.error);
        const qri = buildQri(input.qriContext);
        if (qri.error) return failure(qri.error);
        const weekly = buildWeekly(input.weeklyContext);
        if (weekly.error) return failure(weekly.error);
        if (price.value.contract !== qri.value.contract ||
            qri.value.tradingDate !== market.formalTradingDate) return failure("contract_mismatch");
        const levels = buildLevels(input.nearestLevelsContext, qri.value.contract,
            qri.value.canonicalVersionKey);
        if (levels.error) return failure(levels.error);
        const quality = buildQuality(input.dataQualityContext);
        if (!quality) return failure("data_quality_invalid");
        const sessionVerified = market.sessionMappingStatus === "verified";
        const baseline = { baselineVersion: BASELINE_VERSION, schemaVersion: SCHEMA_VERSION,
            baselineId: "", capturedAt, marketContext: { captureCalendarDate: market.captureCalendarDate,
                formalTradingDate: market.formalTradingDate,
                sessionIdentity: text(market.sessionIdentity),
                sessionMappingStatus: market.sessionMappingStatus },
            overallV2: overall.value, currentPrice: price.value, qri: qri.value,
            weekly: weekly.value, nearestLevels: levels.value, dataQuality: quality,
            comparability: { formalLive: true, sessionVerified, currentPriceVerified: true,
                qriVerified: true, weeklyVerified: true,
                logicVersion: overall.value.logicVersion,
                comparisonClass: sessionVerified ? "formal_live_verified_session" :
                    "formal_live_session_unresolved" },
            signatureAlgorithm: SIGNATURE_ALGORITHM, contentSignature: "", signature: "", versionKey: "" };
        baseline.contentSignature = await sha256(contentOf(baseline));
        baseline.signature = await sha256(eventOf(baseline));
        baseline.versionKey = `morning-baseline-v4|sha256:${baseline.contentSignature}`;
        baseline.baselineId = `mb4-${baseline.signature.slice(0, 24)}`;
        if (!await validateMorningBaselineV4(baseline)) return failure("overall_identity_invalid");
        return deepFreeze({ success: true, reason: sessionVerified ? null : "session_context_unresolved",
            baseline: deepFreeze(clone(baseline)) });
    }

    return Object.freeze({ BASELINE_VERSION, SCHEMA_VERSION, SIGNATURE_ALGORITHM,
        TOP_LEVEL_FIELDS, canonicalize, buildMorningBaselineV4, validateMorningBaselineV4 });
});
