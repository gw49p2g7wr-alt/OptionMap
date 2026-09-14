(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const api = factory(commonJs ? require("./wallHistoryContract.js") : root?.OptionMapWallHistoryContract,
        commonJs ? require("./wallHistoryDrawerModel.js") : root?.OptionMapWallHistoryDrawerModel,
        commonJs ? require("./wallHistoryChartSelection.js") : root?.OptionMapWallHistoryChartSelection,
        commonJs ? require("./wallHistoryDrawerView.js") : root?.OptionMapWallHistoryDrawerView);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapWallHistoryDrawerRuntime = api;
})(typeof window !== "undefined" ? window : globalThis,
function (contractApi, modelApi, selectionApi, viewApi) {
    "use strict";
    function create({ root, documentRef, ChartConstructor } = {}) {
        const canvas = documentRef?.getElementById("combinedPriceChart");
        if (!canvas || !contractApi || !modelApi || !selectionApi || !viewApi) return null;
        const view = viewApi.create({ documentRef, ChartConstructor }), gesture = selectionApi.createGestureGuard();
        let projectionPromise = null, lookup = null, requestGeneration = 0;
        function loadProjection() { if (lookup) return Promise.resolve(lookup); if (projectionPromise) return projectionPromise;
            projectionPromise = Promise.resolve(root.runWallHistoryShadowEvaluation?.()).then(result => {
                if (result?.status !== "ready" || !Array.isArray(result.evaluation?.projection?.walls))
                    throw new Error("projection_unavailable");
                lookup = new Map(result.evaluation.projection.walls.map(wall => [wall.wallIdentity, wall]));
                return lookup;
            }).finally(() => { projectionPromise = null; }); return projectionPromise; }
        async function handleClick(event) {
            if (gesture.shouldSuppressClick()) return;
            const chart = ChartConstructor?.getChart?.(canvas), identity = root.getQriChartRendererIdentity?.();
            const selected = selectionApi.select({ chart, event, rendererIdentity: identity,
                currentIdentity: root.getQriChartRendererIdentity?.() });
            if (!selected) return;
            const wallIdentity = contractApi.wallIdentity(selected.contract, selected.strike, selected.side);
            const ownRequest = ++requestGeneration; view.openLoading(canvas);
            try { const walls = await loadProjection(), current = root.getQriChartRendererIdentity?.();
                if (ownRequest !== requestGeneration || current?.generation !== selected.rendererGeneration ||
                    current?.mode !== "openInterest") { view.close(); return; }
                const wall = walls.get(wallIdentity); if (!wall) throw new Error("wall_not_in_saved_history");
                const unavailable = root.getWallHistoryShadowDiagnostics?.()?.evaluation?.projection?.unavailableMetrics || [];
                view.render(modelApi.build(wall, unavailable));
            } catch (error) { if (ownRequest === requestGeneration) view.showError(error?.message ===
                "wall_not_in_saved_history" ? "この壁の保存済み履歴はありません。" :
                "Wall Historyを読み込めませんでした。"); }
        }
        canvas.addEventListener("pointerdown", gesture.pointerDown);
        canvas.addEventListener("pointermove", gesture.pointerMove);
        canvas.addEventListener("pointerup", gesture.pointerUp);
        canvas.addEventListener("pointercancel", gesture.pointerUp);
        canvas.addEventListener("click", handleClick);
        documentRef.getElementById("wallHistoryDrawerClose")?.addEventListener("click", () => {
            requestGeneration += 1; view.close(); });
        documentRef.getElementById("wallHistoryDrawerBackdrop")?.addEventListener("click", () => {
            requestGeneration += 1; view.close(); });
        documentRef.addEventListener("keydown", event => { if (event.key === "Escape" && view.isOpen()) {
            requestGeneration += 1; view.close(); } });
        function close() { requestGeneration += 1; return view.close(); }
        return Object.freeze({ handleClick, close, getDiagnostics: () => Object.freeze({
            projectionCached: Boolean(lookup), projectionInFlight: Boolean(projectionPromise),
            rendererIdentity: root.getQriChartRendererIdentity?.() || null, open: view.isOpen() }) });
    }
    function initialize(root) { const runtime = create({ root, documentRef: root.document,
        ChartConstructor: root.Chart }); if (runtime) { root.wallHistoryDrawerRuntime = runtime;
        root.getWallHistoryDrawerDiagnostics = runtime.getDiagnostics; } return runtime; }
    return Object.freeze({ create, initialize });
});

if (typeof window !== "undefined" && window.document && window.OptionMapWallHistoryDrawerRuntime) {
    window.OptionMapWallHistoryDrawerRuntime?.initialize(window);
}
