(function (root, factory) {
    const presentation = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./calendarUpdatePresentation.js") : root?.OptionMapMarketCalendarUpdatePresentation;
    const startup = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./calendarStartupRuntime.js") : root?.OptionMapCalendarStartupRuntime;
    const api = factory(presentation, startup);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarUpdateUiController = api;
})(typeof window !== "undefined" ? window : globalThis, function (presentation, startup) {
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
    function notifyRuntimeStateUpdated(document) {
        const CustomEvent = document?.defaultView?.CustomEvent;
        if (typeof document?.dispatchEvent === "function" && typeof CustomEvent === "function")
            document.dispatchEvent(new CustomEvent("optionmap:calendar-runtime-state-updated"));
    }
    function mount({ document = globalThis.document, bridge = globalThis.optionMapBridge,
        enabled, restoreState, autoStartup = false, runtime } = {}) {
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
        if (autoStartup) {
            try { runtime = runtime || startup.create({ bridge }); }
            catch (_) { state = { ...state, state: "unavailable" }; render(nodes, state);
                return Object.freeze({ enabled: true, ready: Promise.resolve(), getState: () => structuredClone(state) }); }
            restoreState = runtime.restore;
            state = { ...state, runtimePhase: "restoring" };
        }
        render(nodes, state);
        const ready = typeof restoreState === "function" ? Promise.resolve().then(restoreState)
            .then(restored => { if (!manualStarted && restored) { state = restored; render(nodes, state);
                notifyRuntimeStateUpdated(document); } },
                () => { if (!manualStarted) { state = { ...state,
                    runtimeStateDiagnostics: ["runtime_state_restore_failed"] }; render(nodes, state);
                    notifyRuntimeStateUpdated(document); } })
            : Promise.resolve();
        const startupReady = ready.then(() => {
            if (!autoStartup || manualStarted) return;
            state = { ...state, state: "checking", runtimePhase: "checking" }; render(nodes, state);
            activePromise = Promise.resolve().then(() => runtime.startup())
                .then(result => { state = result || { state: "unavailable" }; }, () => {
                    state = { state: "failed", runtimeStateDiagnostics: ["runtime_state_restore_failed"] };
                }).finally(() => { activePromise = null; render(nodes, state);
                    notifyRuntimeStateUpdated(document); });
            return activePromise;
        });
        function check(sourceIds) {
            if (activePromise) return activePromise;
            manualStarted = true;
            state = { ...state, state: "checking" }; render(nodes, state);
            activePromise = Promise.resolve((runtime ? runtime.check : bridge.checkCalendarSources)(sourceIds?.length ?
                { sourceIds } : {})).then(result => { state = result && typeof result === "object" ?
                    result : { state: "unavailable", mode: "writer_disabled", failedSourceIds: [] };
                return state; }, () => { state = { state: "failed", mode: "writer_disabled",
                    requestedSourceCount: sourceIds?.length || 0, successfulSourceCount: 0,
                    sources: [], failedSourceIds: sourceIds || [] }; return state; })
                .finally(() => { activePromise = null; render(nodes, state);
                    notifyRuntimeStateUpdated(document); });
            return activePromise;
        }
        nodes.button.addEventListener("click", () => check(state.state === "partial"
            ? state.failedSourceIds : undefined));
        return Object.freeze({ enabled: true, check, ready: startupReady, getState: () => structuredClone(state) });
    }
    if (typeof document !== "undefined") {
        const start = () => mount({ autoStartup: true });
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
        else start();
    }
    return Object.freeze({ mount, render });
});
