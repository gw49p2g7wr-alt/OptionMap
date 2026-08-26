(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const contractApi = commonJs ? require("./morningV4RuntimeFactContract.js") :
        root?.OptionMapMorningV4RuntimeFactContract;
    const sessionApi = commonJs ? require("./morningV4FormalSessionScope.js") :
        root?.OptionMapMorningV4FormalSessionScope;
    const api = factory(contractApi, sessionApi);
    if (commonJs) module.exports = api;
    if (root) {
        root.OptionMapMorningBaselineV4RuntimeCollector = api;
        const runtime = api.createRuntimeCollector({
            getCurrentPrice: () => root.getCurrentPriceLiveIdentityFact?.(),
            getQri: () => root.getQriFormalIdentityFact?.(),
            getWeekly: () => root.getWeeklyFormalIdentityFact?.(),
            getOverall: () => root.getOverallV2FormalEnvelope?.(),
            isRefreshInProgress: () => root.isMarketRefreshInProgress?.() === true
        });
        root.collectMorningBaselineV4ReadOnly = runtime.collect;
        root.getMorningBaselineV4RuntimeCollectorState = runtime.getState;
    }
})(typeof window !== "undefined" ? window : globalThis, function (contractApi, sessionApi) {
    "use strict";
    const COLLECTOR_VERSION = 1;
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
    const text = value => typeof value === "string" && value.trim() ? value.trim() : null;
    function canonical(value) { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
        if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
        return JSON.stringify(value); }
    async function hash(value) { const serialized = canonical(value);
        if (typeof module === "object" && module.exports) return require("node:crypto")
            .createHash("sha256").update(serialized).digest("hex");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized));
        return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join(""); }
    function snapshotSources(getters) {
        return { currentPrice: clone(getters.getCurrentPrice?.() || null),
            qri: clone(getters.getQri?.() || null), weekly: clone(getters.getWeekly?.() || null),
            overall: clone(getters.getOverall?.() || null) };
    }
    function currentPriceFormalFact(state) {
        const fact = clone(state?.fact || null);
        const sequence = state?.publicationGeneration;
        if (!object(fact)) return null;
        fact.generation = Number.isSafeInteger(sequence) && sequence >= 0 &&
            state?.status === "available" && text(fact.versionKey) ? {
                source: "currentPrice", sequence, fingerprint: fact.versionKey, current: true
            } : null;
        return fact;
    }
    function sourceIdentity(sources) {
        return { currentPriceGeneration: sources.currentPrice?.publicationGeneration ?? null,
            currentPriceVersionKey: sources.currentPrice?.fact?.versionKey || null,
            qriGeneration: sources.qri?.publicationGeneration ?? null,
            qriVersionKey: sources.qri?.fact?.canonicalVersionKey || null,
            weeklyGeneration: sources.weekly?.publicationGeneration ?? null,
            weeklyVersionKey: sources.weekly?.fact?.currentVersionKey || null,
            overallGeneration: sources.overall?.publicationGeneration ?? null,
            overallInputFingerprint: sources.overall?.envelope?.inputFingerprint || null,
            requestIds: [sources.currentPrice?.requestId, sources.qri?.requestId,
                sources.weekly?.requestId, sources.overall?.requestId].map(value => value || null) };
    }
    async function fingerprint(sources) { return hash(sourceIdentity(sources)); }
    function createRuntimeCollector(configuration = {}) {
        const getters = configuration;
        const now = configuration.now || (() => new Date().toISOString());
        let lastState = null;
        async function collect(options = {}) {
            const collectedAt = text(options.collectedAt) || now();
            const refreshAtStart = getters.isRefreshInProgress?.() === true;
            const start = snapshotSources(getters);
            const startFingerprint = await fingerprint(start);
            const priceState = start.currentPrice; const qriState = start.qri;
            const weeklyState = start.weekly; const overallState = start.overall;
            const price = currentPriceFormalFact(priceState); const qri = qriState?.fact;
            const weekly = weeklyState?.fact; const overall = overallState?.envelope;
            const requestId = qri?.requestId || null;
            const sessionScope = sessionApi?.evaluateFormalSessionScope?.({ capturedAt: collectedAt,
                qriFormalIdentity: qri, currentPriceLiveIdentity: price,
                overallV2Envelope: overall, weeklyFormalIdentity: weekly,
                marketRefreshContext: { requestId,
                    startGenerationFingerprint: startFingerprint,
                    endGenerationFingerprint: startFingerprint, sourceGenerationChanged: false } }) || null;
            const overallResult = overall?.result;
            const dataQuality = overall ? { status: overallResult?.status,
                warnings: clone(overall.diagnostics?.warnings || overallResult?.metadata?.warnings || []),
                sourceAvailability: { currentPrice: priceState?.status === "available",
                    qri: qriState?.status === "available", weekly: weeklyState?.status === "available",
                    overallV2: overallState?.status === "available" },
                componentAvailability: { option: overallResult?.components?.option?.available === true,
                    weekly: overallResult?.components?.weekly?.available === true },
                fallbackFlags: { currentPrice: false, qri: qri?.usingFallback === true,
                    weekly: false, overallV2: overall?.diagnostics?.fallbackUsed === true },
                sourceIdentities: { qriVersionKey: qri?.canonicalVersionKey || null,
                    priceVersionKey: price?.versionKey || null,
                    weeklyVersionKey: weekly?.currentVersionKey || null,
                    logicVersion: overall?.logicVersion || null }, sourceFingerprint: startFingerprint,
                generation: { source: "dataQuality", sequence: 0,
                    fingerprint: startFingerprint, current: true } } : null;
            const facts = { marketSession: sessionScope,
                overallV2: overall ? { sourceClass: "formal_live", formalApplied: overall.formalApplied,
                    referenceOnly: overall.referenceOnly, result: clone(overallResult),
                    logicVersion: overall.logicVersion, evaluatedAt: overall.evaluatedAt,
                    requestId: overall.requestId, inputFingerprint: null,
                    optionSourceIdentity: clone(overall.optionSourceIdentity),
                    weeklySourceIdentity: clone(overall.weeklySourceIdentity),
                    generation: { source: "overallV2", sequence: overallState.publicationGeneration,
                        fingerprint: overall.inputFingerprint, current: true } } : null,
                currentPrice: price || null, qri: qri || null, weekly: weekly || null,
                dataQuality, nearestLevels: null };
            if (facts.overallV2 && qri && weekly) facts.overallV2.inputFingerprint =
                await contractApi.expectedOverallInputFingerprint(facts);
            const contract = await contractApi.evaluateMorningV4RuntimeFactReadiness({ facts,
                collectionContext: { refreshInProgress: refreshAtStart,
                    startGenerationFingerprint: startFingerprint,
                    endGenerationFingerprint: startFingerprint, sourceGenerationChanged: false,
                    marketRefreshRequestId: requestId } });
            await options.beforeEndSnapshot?.();
            const end = snapshotSources(getters);
            const endFingerprint = await fingerprint(end);
            const refreshAtEnd = getters.isRefreshInProgress?.() === true;
            const generationChanged = startFingerprint !== endFingerprint;
            const reasons = [...contract.reasons];
            if (qri?.contract && price?.contract && qri.contract !== price.contract &&
                !reasons.includes("contract_mismatch")) reasons.push("contract_mismatch");
            if (qri?.tradingDate && price?.qriTradingDateMapping?.qriTradingDate &&
                qri.tradingDate !== price.qriTradingDateMapping.qriTradingDate &&
                !reasons.includes("trading_date_mismatch")) reasons.push("trading_date_mismatch");
            if ((refreshAtStart || refreshAtEnd) && !reasons.includes("refresh_in_progress"))
                reasons.unshift("refresh_in_progress");
            if (generationChanged && !reasons.includes("source_generation_changed"))
                reasons.push("source_generation_changed");
            const manualMode = priceState?.diagnostics?.formalCurrentPriceMode === "manual";
            if (manualMode && !reasons.includes("current_price_manual")) reasons.push("current_price_manual");
            const ready = reasons.length === 0;
            const builderInput = ready ? { capturedAt: collectedAt,
                marketContext: { captureCalendarDate: sessionScope.captureCalendarDate,
                    formalTradingDate: sessionScope.formalTradingDate,
                    sessionIdentity: sessionScope.scopeId,
                    sessionMappingStatus: sessionScope.sessionMappingStatus },
                overallV2Context: { origin: "formal_live", formalApplied: true,
                    superseded: false, logicVersion: overall.logicVersion,
                    evaluatedAt: overall.evaluatedAt, result: clone(overallResult),
                    inputIdentity: { source: "overall_v2", versionKey: overall.inputFingerprint,
                        signature: overall.inputFingerprint, verified: true },
                    componentIdentities: { option: { source: "qri_formal",
                        versionKey: qri.canonicalVersionKey, signature: qri.canonicalSignature,
                        verified: true }, weekly: { source: "weekly_formal",
                        versionKey: weekly.currentVersionKey, signature: weekly.currentSignature,
                        verified: true } } }, currentPriceContext: clone(price),
                qriContext: { available: true, origin: "formal_live", sourceKind: "live",
                    formalRevisionAvailable: true, referenceOnly: false, usingFallback: false,
                    restored: false, superseded: false, openInterestStatus: "available",
                    identity: { verified: true, contract: qri.contract, tradingDate: qri.tradingDate,
                        pageUpdatedAt: qri.pageUpdatedAt, canonicalSignature: qri.canonicalSignature,
                        canonicalVersionKey: qri.canonicalVersionKey,
                        historyEntryId: qri.historyEntryIdentity,
                        historyRevisionId: qri.historyRevisionIdentity } },
                weeklyContext: { available: true, origin: "formal_history", formalApplied: true,
                    usingFallback: false, superseded: false, sourceDate: weekly.sourceDate,
                    versionKey: weekly.currentVersionKey, signature: weekly.currentSignature,
                    identityVerified: true, normalizedDirection: weekly.normalizedDirection,
                    qualityFactor: weekly.qualityFactor, effectiveWeight: weekly.effectiveWeight,
                    weightedContribution: weekly.weightedContribution,
                    metadata: clone(weekly.componentMetadata) }, nearestLevelsContext: null,
                dataQualityContext: clone(dataQuality) } : null;
            const state = { collectorVersion: COLLECTOR_VERSION, ready,
                status: ready ? "ready" : "not_ready", reason: reasons[0] || null, reasons,
                collectedAt, formalSnapshotInputFingerprint:
                    ready ? contract.diagnostics.formalSnapshotInputFingerprint : null,
                sourceGenerations: { start: sourceIdentity(start), end: sourceIdentity(end) },
                sessionScope: clone(sessionScope), factContract: clone(contract), builderInput,
                baselineCandidate: null, diagnostics: { currentPriceReady: priceState?.status === "available",
                    qriReady: qriState?.status === "available", weeklyReady: weeklyState?.status === "available",
                    overallReady: overallState?.status === "available", sessionReady: sessionScope?.available === true,
                    dataQualityReady: Boolean(dataQuality), nearestLevelsIncluded: false,
                    refreshInProgress: refreshAtStart || refreshAtEnd,
                    startFingerprint, endFingerprint, fingerprintMatched: !generationChanged,
                    mixedAcquisitionDetected: reasons.includes("mixed_acquisition"),
                    builderInvoked: false, baselineCandidateValid: false,
                    builderDeferredReason: "builder_not_connected",
                    storageAccessed: false, databaseAccessed: false, fetchTriggered: false,
                    formalRecalculationTriggered: false, domMutated: false } };
            lastState = freeze(clone(state)); return freeze(clone(state));
        }
        const getState = () => freeze(clone(lastState));
        return Object.freeze({ collect, getState });
    }
    return Object.freeze({ COLLECTOR_VERSION, sourceIdentity, fingerprint,
        currentPriceFormalFact, createRuntimeCollector });
});
