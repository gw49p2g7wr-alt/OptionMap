(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMorningV4FormalSessionScope = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const SCOPE_VERSION = 1;
    const SOURCE = "formal_identity_binding";
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
    const unwrap = (value, key) => object(value?.[key]) ? value[key] : value;
    function captureCalendarDate(capturedAt) {
        if (!timestamp(capturedAt)) return null;
        const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric",
            month: "2-digit", day: "2-digit" }).formatToParts(new Date(capturedAt));
        const part = type => parts.find(item => item.type === type)?.value;
        return `${part("year")}-${part("month")}-${part("day")}`;
    }
    function verifiedGeneration(value) {
        return object(value) && value.current === true && Number.isSafeInteger(value.sequence) &&
            value.sequence >= 0 && text(value.fingerprint);
    }
    function makeScopeId(contract, formalTradingDate) {
        return `morning-v4-scope|${contract}|${formalTradingDate}|same_date_explicit`;
    }
    function evaluateFormalSessionScope(input = {}) {
        const qri = unwrap(input.qriFormalIdentity, "fact");
        const price = unwrap(input.currentPriceLiveIdentity, "fact");
        const overall = unwrap(input.overallV2Envelope, "envelope");
        const weekly = unwrap(input.weeklyFormalIdentity, "fact");
        const refresh = object(input.marketRefreshContext) ? input.marketRefreshContext : {};
        const capturedAt = text(input.capturedAt);
        const calendarDate = captureCalendarDate(capturedAt);
        const qriVerified = object(qri) && qri.sourceClass === "formal_live" &&
            qri.origin === "live" && qri.usingFallback === false && qri.referenceOnly === false &&
            qri.superseded !== true && qri.identityVerified === true && qri.acquisitionVerified === true &&
            date(qri.tradingDate) && text(qri.contract) && text(qri.canonicalVersionKey) &&
            text(qri.canonicalSignature) && verifiedGeneration(qri.generation);
        const mapping = price?.qriTradingDateMapping;
        const priceIdentityVerified = object(price) && price.available === true &&
            price.sourceKind === "live" && price.origin === "live" && price.mode === "automatic" &&
            price.identityVerified === true && price.acquisitionVerified === true &&
            price.currentRequestVerified === true && text(price.contract) && text(price.requestId);
        const contractMatched = qriVerified && priceIdentityVerified && qri.contract === price.contract;
        const priceMappingVerified = priceIdentityVerified && mapping?.mappingVerified === true &&
            mapping?.mappingSource === "same_date_explicit" && mapping?.qriTradingDate === qri?.tradingDate &&
            price.quoteDate === qri?.tradingDate;
        const weeklyIdentityVerified = object(weekly) && weekly.sourceClass === "formal_history" &&
            weekly.activeVersionMatched === true && text(weekly.currentVersionKey) &&
            text(weekly.currentSignature) && text(weekly.sourceFingerprint) &&
            verifiedGeneration(weekly.generation);
        const optionIdentity = overall?.optionSourceIdentity;
        const weeklyIdentity = overall?.weeklySourceIdentity;
        const overallIdentityVerified = object(overall) && overall.formalApplied === true &&
            overall.referenceOnly === false && overall.identityVerified === true &&
            text(overall.inputFingerprint) && text(overall.logicVersion);
        const overallBindingVerified = overallIdentityVerified && qriVerified &&
            optionIdentity?.canonicalVersionKey === qri.canonicalVersionKey &&
            optionIdentity?.canonicalSignature === qri.canonicalSignature;
        const weeklyBindingVerified = overallIdentityVerified && weeklyIdentityVerified &&
            weeklyIdentity?.currentVersionKey === weekly.currentVersionKey &&
            weeklyIdentity?.sourceFingerprint === weekly.sourceFingerprint;
        const requestMatched = text(refresh.requestId) && qri?.requestId === refresh.requestId &&
            price?.requestId === refresh.requestId && overall?.requestId === refresh.requestId &&
            (!weekly?.requestId || weekly.requestId === refresh.requestId);
        const generationStable = refresh.sourceGenerationChanged === false &&
            text(refresh.startGenerationFingerprint) &&
            refresh.startGenerationFingerprint === refresh.endGenerationFingerprint;

        let status = "unresolved";
        let reason = "identity_unverified";
        let sessionClass = "identity_unverified";
        if (!qriVerified || !priceIdentityVerified || !weeklyIdentityVerified ||
            !overallIdentityVerified || !requestMatched || !generationStable) {
            reason = "identity_unverified";
        } else if (!contractMatched) {
            status = "mismatch"; reason = "contract_mismatch"; sessionClass = "contract_roll";
        } else if (!overallBindingVerified || !weeklyBindingVerified) {
            status = "mismatch"; reason = "source_binding_mismatch";
            sessionClass = "source_binding_mismatch";
        } else if (!priceMappingVerified) {
            reason = "price_mapping_unresolved"; sessionClass = "cross_date_unresolved";
        } else {
            status = "verified"; reason = null; sessionClass = "same_date_verified";
        }
        const mappingVerified = status === "verified";
        const scopeId = mappingVerified ? makeScopeId(qri.contract, qri.tradingDate) : null;
        const checks = { qriVerified, priceIdentityVerified, priceMappingVerified,
            contractMatched, overallBindingVerified, weeklyBindingVerified,
            requestMatched: Boolean(requestMatched), generationStable: Boolean(generationStable) };
        const sourceIdentities = { qriCanonicalVersionKey: qri?.canonicalVersionKey || null,
            currentPriceVersionKey: price?.versionKey || null,
            overallInputFingerprint: overall?.inputFingerprint || null,
            weeklyCurrentVersionKey: weekly?.currentVersionKey || null,
            weeklySourceFingerprint: weekly?.sourceFingerprint || null };
        return deepFreeze({ scopeVersion: SCOPE_VERSION, available: mappingVerified, status, reason,
            scopeId, sessionScopeId: scopeId, sessionIdentity: scopeId,
            formalTradingDate: qriVerified ? qri.tradingDate : null,
            contract: qriVerified ? qri.contract : null, captureCalendarDate: calendarDate,
            sessionClass, mappingStatus: status, sessionMappingStatus: status,
            mappingVerified, comparisonEligible: mappingVerified, source: SOURCE,
            generation: { source: "marketSession", sequence: 0,
                fingerprint: scopeId || "formal-session-unresolved", current: mappingVerified },
            sourceIdentities: deepFreeze(clone(sourceIdentities)), checks: deepFreeze(clone(checks)),
            diagnostics: deepFreeze({ formalTradingDate: qriVerified ? qri.tradingDate : null,
                contract: qriVerified ? qri.contract : null, qriVerified,
                priceMappingStatus: mapping?.status || "unavailable", priceMappingVerified,
                overallBindingVerified, weeklyBindingVerified, scopeId, mappingVerified,
                capturedAt: capturedAt || null, calendarAccessed: false,
                systemClockInference: false, overnightInferred: false,
                previousTradingDayInferred: false }) });
    }
    function compareFormalSessionScopes(baseline, current) {
        if (baseline?.contract && current?.contract && baseline.contract !== current.contract)
            return deepFreeze({ comparisonEligible: false, reason: "contract_roll" });
        if (baseline?.formalTradingDate && current?.formalTradingDate &&
            baseline.formalTradingDate !== current.formalTradingDate)
            return deepFreeze({ comparisonEligible: false, reason: "trading_date_changed" });
        const eligible = baseline?.mappingVerified === true && current?.mappingVerified === true &&
            text(baseline.scopeId) && baseline.scopeId === current.scopeId;
        return deepFreeze({ comparisonEligible: Boolean(eligible),
            reason: eligible ? null : "session_unverified", scopeId: eligible ? current.scopeId : null });
    }
    return Object.freeze({ SCOPE_VERSION, SOURCE, makeScopeId,
        evaluateFormalSessionScope, compareFormalSessionScopes });
});
