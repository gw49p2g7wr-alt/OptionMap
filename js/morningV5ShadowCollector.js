(function (root, factory) { const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const supplyApi = commonJs ? require("./morningV5SupplyDemandLane.js") : root?.OptionMapMorningV5SupplyDemandLane;
    const priceApi = commonJs ? require("./morningV5ReferencePriceLane.js") : root?.OptionMapMorningV5ReferencePriceLane;
    const api = factory(supplyApi, priceApi); if (commonJs) module.exports = api;
    if (root) { root.OptionMapMorningV5ShadowCollector = api; const collector = api.createCollector({
        getQri: () => root.getQriFormalIdentityFact?.(), getWeekly: () => root.getWeeklyFormalIdentityFact?.(),
        getOverall: () => root.getOverallV2FormalEnvelope?.(),
        getReference: () => root.getMorningV5ReferencePriceFact?.(),
        isRefreshInProgress: () => root.isMarketRefreshInProgress?.() === true });
        root.collectMorningV5Shadow = collector.collect; root.getMorningV5ShadowCollectorState = collector.getState; }
})(typeof window !== "undefined" ? window : globalThis, function (supplyApi, priceApi) {
    "use strict"; const COLLECTOR_VERSION = 1;
    const clone = value => value == null ? value : typeof structuredClone === "function" ?
        structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    function sourceSnapshot(getters) { return { qri: clone(getters.getQri?.() || null),
        weekly: clone(getters.getWeekly?.() || null), overall: clone(getters.getOverall?.() || null),
        reference: clone(getters.getReference?.() || null) }; }
    function sourceGenerations(value) { return { qri: value.qri?.publicationGeneration ?? null,
        weekly: value.weekly?.publicationGeneration ?? null, overall: value.overall?.publicationGeneration ?? null,
        reference: value.reference?.publicationGeneration ?? null,
        requestIds: [value.qri?.requestId || null, value.weekly?.requestId || null,
            value.overall?.requestId || null, value.reference?.requestId || null] }; }
    function supplyInput(sources) { const qri = sources.qri?.fact, weekly = sources.weekly?.fact,
        overall = sources.overall?.envelope; return { qri: qri ? { available: true,
            origin: "formal_live", referenceOnly: qri.referenceOnly, usingFallback: qri.usingFallback,
            restored: false, identity: { verified: qri.identityVerified, contract: qri.contract,
                tradingDate: qri.tradingDate, canonicalVersionKey: qri.canonicalVersionKey } } : null,
        weekly: weekly ? { available: true, origin: "formal_history", formalApplied: true,
            usingFallback: false, identityVerified: true, versionKey: weekly.currentVersionKey } : null,
        overall: overall ? { origin: "formal_live", formalApplied: overall.formalApplied,
            referenceOnly: overall.referenceOnly, superseded: false, logicVersion: overall.logicVersion,
            inputIdentity: { verified: overall.identityVerified, versionKey: overall.inputFingerprint },
            componentIdentities: { option: { versionKey: overall.optionSourceIdentity?.canonicalVersionKey },
                weekly: { versionKey: overall.weeklySourceIdentity?.currentVersionKey } },
            result: overall.result } : null }; }
    function createCollector(getters = {}) { let state = freeze({ collectorVersion: COLLECTOR_VERSION,
        status: "empty", reason: "not_collected", collectedAt: null, formalSupplyDemand: null,
        referencePrice: null, sourceGenerations: null });
        async function collect({ collectedAt = new Date().toISOString(), beforeEndSnapshot } = {}) {
            const refreshAtStart = getters.isRefreshInProgress?.() === true; const start = sourceSnapshot(getters);
            const formalSupplyDemand = await supplyApi.buildMorningV5SupplyDemandLane(supplyInput(start));
            const referencePrice = await priceApi.buildMorningV5ReferencePriceLane({
                fact: start.reference?.fact, mapping: start.reference?.mapping });
            await beforeEndSnapshot?.(); const end = sourceSnapshot(getters);
            const refreshAtEnd = getters.isRefreshInProgress?.() === true;
            const startGeneration = sourceGenerations(start), endGeneration = sourceGenerations(end);
            const changed = JSON.stringify(startGeneration) !== JSON.stringify(endGeneration);
            const ready = formalSupplyDemand.available === true && !refreshAtStart && !refreshAtEnd && !changed;
            state = freeze({ collectorVersion: COLLECTOR_VERSION, status: ready ? "ready" : "not_ready",
                reason: refreshAtStart || refreshAtEnd ? "refresh_in_progress" : changed ?
                    "source_generation_changed" : formalSupplyDemand.reason, collectedAt,
                formalSupplyDemand, referencePrice, sourceGenerations: { start: startGeneration,
                    end: endGeneration }, diagnostics: { formalReady: formalSupplyDemand.available === true,
                    referenceReady: referencePrice.available === true, refreshInProgress:
                        refreshAtStart || refreshAtEnd, generationsMatched: !changed } });
            return state;
        }
        return freeze({ collect, getState: () => freeze(clone(state)) }); }
    return freeze({ COLLECTOR_VERSION, createCollector, sourceGenerations });
});
