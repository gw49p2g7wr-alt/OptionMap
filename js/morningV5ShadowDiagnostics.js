(function (root, factory) { const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) { root.OptionMapMorningV5ShadowDiagnostics = api;
        root.getMorningV5ShadowDiagnostics = () => api.createDiagnostics({
            referenceState: root.getMorningV5ReferencePriceFact?.(),
            collectorState: root.getMorningV5ShadowCollectorState?.(),
            runtimeState: root.getMorningV5ShadowState?.() }); }
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict"; const DIAGNOSTICS_VERSION = 1;
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    function createDiagnostics({ referenceState, collectorState, runtimeState } = {}) {
        const referenceFact = referenceState?.fact, mapping = referenceState?.mapping;
        const formalLane = collectorState?.formalSupplyDemand;
        const priceLane = collectorState?.referencePrice;
        return freeze({ diagnosticsVersion: DIAGNOSTICS_VERSION, mode: "shadow_only",
            status: runtimeState?.status || "empty", reason: runtimeState?.reason || null,
            formal: { available: formalLane?.available === true,
                scopeId: formalLane?.formalScopeId || null,
                optionContract: formalLane?.optionContract || null,
                sourceFingerprint: formalLane?.sourceFingerprint || null },
            reference: { available: priceLane?.available === true,
                referenceOnly: referenceFact?.referenceOnly === true,
                overallEligible: referenceFact?.overallEligible === true,
                optionContract: referenceFact?.optionContract || null,
                referenceContract: referenceFact?.contract || null,
                mappingClass: mapping?.mappingClass || null, mappingId: mapping?.mappingId || null },
            guards: { refreshInProgress: collectorState?.diagnostics?.refreshInProgress === true,
                generationsMatched: collectorState?.diagnostics?.generationsMatched === true,
                generationAccepted: collectorState?.diagnostics?.generationGuard?.accepted === true },
            isolation: { storageWritten: false, uiRendered: false, fullExportIncluded: false,
                overallReferencePriceInjected: false } });
    }
    return freeze({ DIAGNOSTICS_VERSION, createDiagnostics });
});
