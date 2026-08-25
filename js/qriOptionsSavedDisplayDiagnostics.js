(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapQriOptionsSavedDisplayDiagnostics = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const DIAGNOSTICS_VERSION = 2;

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

    function stableValue(value) {
        if (Array.isArray(value)) return value.map(stableValue);
        if (!value || typeof value !== "object") return value;
        return Object.keys(value).sort().reduce((result, key) => {
            result[key] = stableValue(value[key]); return result;
        }, {});
    }

    function fingerprint(value) {
        const serialized = JSON.stringify(stableValue(value ?? null));
        let hash = 0x811c9dc5;
        for (let index = 0; index < serialized.length; index += 1) {
            hash ^= serialized.charCodeAt(index);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return Object.freeze({ algorithm: "fnv1a32-stable-json",
            value: hash.toString(16).padStart(8, "0"),
            serializedLength: serialized.length });
    }

    function identity(candidate) {
        if (!candidate) return null;
        return { origin: candidate.origin ?? null, contract: candidate.contract ?? null,
            tradingDate: candidate.tradingDate ?? null,
            pageUpdatedAt: candidate.pageUpdatedAt ?? null,
            fetchedAt: candidate.fetchedAt ?? null,
            canonicalSignature: candidate.canonicalSignature ?? null,
            canonicalVersionKey: candidate.canonicalVersionKey ?? null };
    }

    function createQriOptionsSavedDisplayDiagnostics({ getDisplayState = () => null,
        getChartState = () => null, getChartIdentity = () => null,
        getFormalState = () => null,
        getBootShadowState = () => null, getLiveState = () => null,
        getSavedUiDomState = () => null, getCanvasCount = () => 0 } = {}) {
        function getDiagnostics() {
            const display = clone(getDisplayState()) || null;
            const chart = clone(getChartState()) || null;
            const chartIdentity = clone(getChartIdentity()) || null;
            const formal = clone(getFormalState()) || {};
            const boot = clone(getBootShadowState()) || null;
            const live = clone(getLiveState()) || null;
            const uiDom = clone(getSavedUiDomState()) || null;
            const source = display?.sourceState || null;
            const ui = display?.uiState || null;
            const result = { diagnosticsVersion: DIAGNOSTICS_VERSION,
                display: { sourceKind: source?.sourceKind || "unavailable",
                    state: source?.state || "unavailable",
                    generation: display?.generation ?? 0,
                    displayOnly: display?.positionsState?.displayOnly === true },
                savedUi: { visible: ui?.visible === true,
                    showSavedBadge: ui?.showSavedBadge === true,
                    badgeText: ui?.badgeText ?? null, message: ui?.message ?? null,
                    severity: ui?.severity ?? null,
                    metadata: { contractText: ui?.contractText ?? null,
                        tradingDateText: ui?.tradingDateText ?? null,
                        pageUpdatedAtText: ui?.pageUpdatedAtText ?? null,
                        fetchedAtText: ui?.fetchedAtText ?? null },
                    actualDom: uiDom },
                chart: { actualStateAvailable: chartIdentity !== null,
                    displayDataAvailable: chart !== null,
                    rendererKind: chartIdentity?.rendererKind ?? "unknown",
                    sourceKind: chartIdentity?.sourceKind ?? "unknown",
                    state: chart?.state ?? null,
                    contract: chart?.contract ?? null,
                    displayOnly: typeof chartIdentity?.displayOnly === "boolean"
                        ? chartIdentity.displayOnly : null,
                    generation: chartIdentity?.generation ?? null,
                    displayGeneration: chartIdentity?.displayGeneration ?? null,
                    renderedAt: chartIdentity?.renderedAt ?? null,
                    canvasCount: Number(getCanvasCount()) || 0 },
                formal: { sourceIdentity: formal.sourceIdentity ? {
                    ...clone(formal.sourceIdentity),
                    contract: formal.sourceIdentity.contract ?? live?.contract ?? null
                } : null,
                    globalsFingerprint: fingerprint(formal.formalGlobals),
                    wallFingerprint: fingerprint(formal.wallState),
                    judgmentFingerprint: fingerprint(formal.judgmentState),
                    overallV2Fingerprint: fingerprint(formal.overallV2State) },
                bootShadow: { status: boot?.status ?? null,
                    reason: boot?.reason ?? null, generation: boot?.generation ?? 0,
                    savedCandidateIdentity: identity(boot?.candidate),
                    liveAcquisitionIdentity:
                        boot?.diagnostics?.liveAcquisitionIdentity ?? null,
                    liveRequestId: boot?.diagnostics?.liveRequestId ?? null,
                    liveContract: boot?.diagnostics?.liveContract ?? null,
                    liveFetchedAt: boot?.diagnostics?.liveFetchedAt ?? null },
                liveAcquisition: { contract: live?.contract ?? null,
                    fetchedAt: live?.fetchedAt ?? null,
                    sourceStatus: live?.sourceStatus ?? null,
                    identity: boot?.diagnostics?.liveAcquisitionIdentity ?? null,
                    canonicalSignature: live?.canonicalSignature ?? null,
                    canonicalVersionKey: live?.canonicalVersionKey ?? null },
                resource: { fetchStateFingerprint: fingerprint(formal.fetchState),
                    storageAccessed: false, databaseAccessed: false,
                    fetchTriggered: false, timerScheduled: false }
            };
            return deepFreeze(clone(result));
        }
        return Object.freeze({ getDiagnostics });
    }

    return Object.freeze({ DIAGNOSTICS_VERSION, fingerprint,
        createQriOptionsSavedDisplayDiagnostics });
});
