(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const sourceApi = commonJs ? require("./qriOptionsDisplaySourceState.js") :
        root?.OptionMapQriOptionsDisplaySourceState;
    const positionsApi = commonJs ? require("./qriOptionsDisplayPositionsAdapter.js") :
        root?.OptionMapQriOptionsDisplayPositionsAdapter;
    const uiApi = commonJs ? require("./qriOptionsSavedUiState.js") :
        root?.OptionMapQriOptionsSavedUiState;
    const api = factory(sourceApi, positionsApi, uiApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapQriOptionsDisplayRuntime = api;
})(typeof window !== "undefined" ? window : globalThis,
function (sourceApi, positionsApi, uiApi) {
    "use strict";

    const RUNTIME_VERSION = 1;

    function buildQriOptionsDisplayRuntimeState(input = {}) {
        const sourceState = sourceApi.buildQriOptionsDisplaySourceState(input);
        const positionsState = positionsApi.buildQriOptionsDisplayPositions({
            displaySourceState: sourceState
        });
        const uiState = uiApi.buildQriOptionsSavedUiState({
            displaySourceState: sourceState
        });
        return Object.freeze({ runtimeVersion: RUNTIME_VERSION, sourceState,
            positionsState, uiState });
    }

    function renderSavedUiState(uiState, documentRef) {
        const region = documentRef?.getElementById?.("qriOptionsSavedSourceState");
        const badge = documentRef?.getElementById?.("qriOptionsSavedBadge");
        const message = documentRef?.getElementById?.("qriOptionsSavedMessage");
        const metadata = documentRef?.getElementById?.("qriOptionsSavedMetadata");
        if (!region || !badge || !message || !metadata) {
            return Object.freeze({ rendered: false, reason: "dom_missing" });
        }
        const visible = uiState?.visible === true;
        region.hidden = !visible;
        badge.hidden = !visible || uiState.showSavedBadge !== true;
        badge.textContent = badge.hidden ? "" : uiState.badgeText || "";
        message.hidden = !visible || !uiState.message;
        message.textContent = message.hidden ? "" : uiState.message;
        message.dataset.severity = visible ? uiState.severity || "neutral" : "";
        const items = visible ? [uiState.contractText,
            uiState.tradingDateText ? `取引日 ${uiState.tradingDateText}` : null,
            uiState.pageUpdatedAtText ? `QRI更新 ${uiState.pageUpdatedAtText}` : null,
            uiState.fetchedAtText ? `最終取得 ${uiState.fetchedAtText}` : null]
            .filter(Boolean) : [];
        metadata.hidden = items.length === 0;
        metadata.textContent = items.join(" / ");
        return Object.freeze({ rendered: true, visible,
            sourceKind: uiState?.sourceKind ?? null });
    }

    function createQriOptionsDisplayRuntime({ renderPositions = () => false,
        clearPositions = () => false, renderUi = () => null,
        preserveLegacy = () => null } = {}) {
        let generation = 0;
        let lastState = null;

        function nextGeneration() { return ++generation; }
        function getState() { return lastState; }
        function render(input = {}, options = {}) {
            const requestedGeneration = Number.isSafeInteger(options.generation)
                ? options.generation : ++generation;
            if (requestedGeneration < generation) {
                return Object.freeze({ applied: false, reason: "stale_generation",
                    generation: requestedGeneration, currentGeneration: generation });
            }
            generation = requestedGeneration;
            const built = buildQriOptionsDisplayRuntimeState(input);
            const source = built.sourceState;
            renderUi(built.uiState);
            let displayResult = null;
            if (source.sourceKind === "saved") {
                const policy = source.analysisPolicy;
                if (policy.allowFormalAnalysis || policy.allowLegacyAnalysis ||
                    policy.calculationSourcePolicy !== "none") {
                    return Object.freeze({ applied: false,
                        reason: "saved_analysis_policy_mismatch", generation });
                }
                displayResult = renderPositions(built.positionsState);
            } else if (source.sourceKind === "live") {
                displayResult = clearPositions({ preserveCanvas: true,
                    redrawFormal: false, reason: "live_source" });
            } else if (source.sourceKind === "legacy") {
                displayResult = preserveLegacy(built.positionsState);
            } else {
                displayResult = clearPositions({ preserveCanvas: true,
                    redrawFormal: false, reason: "unavailable" });
            }
            lastState = Object.freeze({ ...built, generation });
            return Object.freeze({ applied: true, generation,
                sourceKind: source.sourceKind, state: source.state,
                formalAnalysisRequested: false, legacyAnalysisRequested: false,
                displayResult, runtimeState: lastState });
        }
        return Object.freeze({ nextGeneration, render, getState });
    }

    return Object.freeze({ RUNTIME_VERSION, buildQriOptionsDisplayRuntimeState,
        renderSavedUiState, createQriOptionsDisplayRuntime });
});
