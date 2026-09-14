(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapWallHistoryChartSelection = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const CONTRACT = /^20\d{2}-(0[1-9]|1[0-2])$/;
    function createGestureGuard(threshold = 8) {
        let start = null, moved = false;
        return Object.freeze({ pointerDown(event) { start = { x: event.clientX, y: event.clientY,
            id: event.pointerId }; moved = false; }, pointerMove(event) { if (!start ||
            event.pointerId !== start.id) return; if (Math.hypot(event.clientX - start.x,
            event.clientY - start.y) > threshold) moved = true; }, pointerUp(event) {
            if (!start || event.pointerId !== start.id) return; start = null; },
        shouldSuppressClick() { const result = moved; moved = false; return result; } });
    }
    function select({ chart, event, rendererIdentity, currentIdentity } = {}) {
        if (!chart || !event || !rendererIdentity || rendererIdentity.rendererKind !== "formal" ||
            rendererIdentity.displayOnly === true || rendererIdentity.mode !== "openInterest" ||
            !CONTRACT.test(rendererIdentity.contract || "") ||
            rendererIdentity.generation !== currentIdentity?.generation) return null;
        const hits = chart.getElementsAtEventForMode?.(event, "nearest", { intersect: true }, true) || [];
        if (hits.length !== 1) return null;
        const hit = hits[0], dataset = chart.data?.datasets?.[hit.datasetIndex];
        if (dataset?.optionSide !== "call" && dataset?.optionSide !== "put") return null;
        const strike = Number(String(chart.data?.labels?.[hit.index] || "").replace(/,/g, ""));
        if (!Number.isFinite(strike) || strike <= 0) return null;
        return Object.freeze({ contract: rendererIdentity.contract, strike,
            side: dataset.optionSide, rendererGeneration: rendererIdentity.generation });
    }
    return Object.freeze({ createGestureGuard, select });
});
