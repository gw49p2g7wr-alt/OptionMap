(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const api = factory(
        commonJs ? require("./qriIvGraphSourceState.js") : root?.OptionMapQriIvGraphSourceState,
        commonJs ? require("./qriIvGraphViewModel.js") : root?.OptionMapQriIvGraphViewModel,
        commonJs ? require("./qriIvSavedUiState.js") : root?.OptionMapQriIvSavedUiState
    );
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriIvGraphRuntime = api;
})(typeof window !== "undefined" ? window : globalThis,
function (sourceApi, viewModelApi, uiApi) {
    "use strict";

    const RUNTIME_VERSION = 1;
    const RADIUS_MODES = new Set(["plus_minus_3000", "plus_minus_5000"]);

    function clone(value) {
        if (value === undefined) return undefined;
        return typeof structuredClone === "function"
            ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    }
    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }
    function canonicalContract(value) {
        const candidate = typeof value === "string" ? value.trim() : "";
        if (/^20\d{2}-(0[1-9]|1[0-2])$/.test(candidate)) return candidate;
        const label = candidate.match(/^(\d{2})年(0?[1-9]|1[0-2])月限$/);
        return label ? `20${label[1]}-${String(Number(label[2])).padStart(2, "0")}` : null;
    }
    function matchingLivePrice(currentPrice, contract) {
        const value = Number(currentPrice?.value);
        return currentPrice?.mode === "automatic" && Number.isFinite(value) && value > 0 &&
            canonicalContract(currentPrice.contract) === contract ? value : null;
    }
    function effectiveRange(source, requestedRange, rangeUserSelected, currentPrice) {
        if (source.sourceKind === "live") {
            const rangeMode = rangeUserSelected === true &&
                viewModelApi?.RANGE_MODES?.[requestedRange]
                ? requestedRange : source.rangePolicy?.defaultRange || "plus_minus_3000";
            return { rangeMode, currentPrice: Number(currentPrice?.value),
                radiusEnabled: true, fallbackReason: null };
        }
        if (source.sourceKind !== "saved") {
            return { rangeMode: "all", currentPrice: null,
                radiusEnabled: false, fallbackReason: null };
        }
        const price = matchingLivePrice(currentPrice, source.contract);
        if (rangeUserSelected === true && RADIUS_MODES.has(requestedRange) && price !== null) {
            return { rangeMode: requestedRange, currentPrice: price,
                radiusEnabled: true, fallbackReason: null };
        }
        return { rangeMode: "all", currentPrice: null, radiusEnabled: price !== null,
            fallbackReason: rangeUserSelected === true && RADIUS_MODES.has(requestedRange)
                ? "matching_live_automatic_price_unavailable" : null };
    }

    function buildQriIvGraphRuntimeState(input = {}) {
        const runtimeBefore = JSON.stringify(input.runtimeState ?? null);
        const source = sourceApi.buildQriIvGraphSourceState({
            selectionMode: input.selection?.mode,
            selectedContract: input.selection?.contract,
            activeContract: input.activeContract,
            activeRuntime: input.runtimeState?.active,
            selectedRuntime: input.runtimeState?.selected,
            bootShadowState: input.bootShadowState,
            liveStatus: input.liveStatus
        });
        const policy = effectiveRange(source, input.requestedRange,
            input.rangeUserSelected, input.currentPrice);
        const viewModel = source.available && source.canonical
            ? viewModelApi.build({ canonical: source.canonical,
                rangeMode: policy.rangeMode, currentPrice: policy.currentPrice })
            : viewModelApi.build({ canonical: null,
                rangeMode: policy.rangeMode, currentPrice: policy.currentPrice });
        const uiState = uiApi.buildQriIvSavedUiState({ graphSourceState: source,
            graphViewModel: viewModel, rangeMode: policy.rangeMode });
        return deepFreeze({ runtimeVersion: RUNTIME_VERSION, source: clone(source),
            viewModel: clone(viewModel), uiState: clone(uiState), rangePolicy: policy,
            diagnostics: { activeRuntimeMutated:
                    runtimeBefore !== JSON.stringify(input.runtimeState ?? null),
                savedCanonicalAppliedToActive: false,
                savedCanonicalAppliedToSelected: false,
                calculationConnected: false,
                storageConnected: false }
        });
    }

    return Object.freeze({ RUNTIME_VERSION, canonicalContract, matchingLivePrice,
        effectiveRange, buildQriIvGraphRuntimeState });
});
