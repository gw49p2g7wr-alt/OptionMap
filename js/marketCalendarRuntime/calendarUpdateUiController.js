(function (root, factory) {
    const presentation = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./calendarUpdatePresentation.js") : root?.OptionMapMarketCalendarUpdatePresentation;
    const api = factory(presentation);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarUpdateUiController = api;
})(typeof window !== "undefined" ? window : globalThis, function (presentation) {
    "use strict";
    function render(nodes, state) {
        const view = presentation.build(state);
        nodes.region.dataset.state = view.state;
        nodes.status.textContent = view.statusText;
        nodes.button.textContent = view.buttonText;
        nodes.button.disabled = view.buttonDisabled;
        nodes.details.hidden = view.detailsHidden;
        nodes.details.textContent = view.detailsText;
        nodes.qualifier.textContent = view.writerQualifier;
        return view;
    }
    function mount({ document = globalThis.document, bridge = globalThis.optionMapBridge,
        enabled, restoreState } = {}) {
        const panel = document?.getElementById("marketCalendarPanel"), region =
            document?.getElementById("marketCalendarUpdateRegion");
        if (!panel || !region) return null;
        const active = enabled ?? panel.dataset.calendarUpdateUiEnabled === "true";
        if (!active || typeof bridge?.checkCalendarSources !== "function") {
            region.hidden = true; return Object.freeze({ enabled: false });
        }
        region.hidden = false;
        const nodes = { region, status: document.getElementById("marketCalendarUpdateStatus"),
            button: document.getElementById("marketCalendarUpdateButton"),
            details: document.getElementById("marketCalendarUpdateDetails"),
            qualifier: document.getElementById("marketCalendarUpdateQualifier") };
        let state = { state: "idle", mode: "writer_disabled", failedSourceIds: [] }, activePromise = null,
            manualStarted = false;
        render(nodes, state);
        const ready = typeof restoreState === "function" ? Promise.resolve().then(restoreState)
            .then(restored => { if (!manualStarted && restored) { state = restored; render(nodes, state); } },
                () => { if (!manualStarted) { state = { ...state,
                    runtimeStateDiagnostics: ["runtime_state_restore_failed"] }; render(nodes, state); } })
            : Promise.resolve();
        function check(sourceIds) {
            if (activePromise) return activePromise;
            manualStarted = true;
            state = { ...state, state: "checking" }; render(nodes, state);
            activePromise = Promise.resolve(bridge.checkCalendarSources(sourceIds?.length ?
                { sourceIds } : {})).then(result => { state = result && typeof result === "object" ?
                    result : { state: "unavailable", mode: "writer_disabled", failedSourceIds: [] };
                return state; }, () => { state = { state: "failed", mode: "writer_disabled",
                    requestedSourceCount: sourceIds?.length || 0, successfulSourceCount: 0,
                    sources: [], failedSourceIds: sourceIds || [] }; return state; })
                .finally(() => { activePromise = null; render(nodes, state); });
            return activePromise;
        }
        nodes.button.addEventListener("click", () => check(state.state === "partial"
            ? state.failedSourceIds : undefined));
        return Object.freeze({ enabled: true, check, ready, getState: () => structuredClone(state) });
    }
    if (typeof document !== "undefined") {
        const start = () => mount();
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
        else start();
    }
    return Object.freeze({ mount, render });
});
