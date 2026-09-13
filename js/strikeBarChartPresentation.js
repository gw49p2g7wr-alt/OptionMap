(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapStrikeBarChartPresentation = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const SLOT_WIDTH = 12;
    const AXIS_ALLOWANCE = 80;
    const DATASET_OPTIONS = Object.freeze({
        categoryPercentage: 0.82,
        barPercentage: 0.90,
        maxBarThickness: 10
    });

    function preparePlot({ container, plot, strikeCount } = {}) {
        if (!container || !plot) return 0;
        const availableWidth = Math.max(Number(container.clientWidth) || 0, 0);
        const minimumWidth = Math.max(Number(strikeCount) || 0, 0) *
            SLOT_WIDTH + AXIS_ALLOWANCE;
        plot.style.width = "100%";
        plot.style.minWidth = `${Math.ceil(minimumWidth)}px`;
        return Math.max(availableWidth, minimumWidth);
    }

    function centerIndex({ container, plot, chart, index } = {}) {
        if (!container || !plot || !chart || !Number.isInteger(index) || index < 0) return false;
        const center = chart.scales?.x?.getPixelForValue?.(index);
        if (!Number.isFinite(center)) return false;
        const viewportWidth = Number(container.clientWidth) || 0;
        const plotWidth = Number(plot.scrollWidth) ||
            Number.parseFloat(plot.style?.minWidth) || 0;
        const maximum = Math.max(0, plotWidth - viewportWidth);
        container.scrollLeft = Math.max(0, Math.min(maximum, center - viewportWidth / 2));
        return true;
    }

    return Object.freeze({ SLOT_WIDTH, AXIS_ALLOWANCE, DATASET_OPTIONS,
        preparePlot, centerIndex });
});
