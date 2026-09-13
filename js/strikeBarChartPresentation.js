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

    function firstColor(value) {
        return Array.isArray(value) ? value.find(color => typeof color === "string") : value;
    }

    function renderLegend({ documentRef, legend, datasets } = {}) {
        if (!legend?.replaceChildren || !documentRef?.createElement) return false;
        const visibleDatasets = Array.isArray(datasets)
            ? datasets.filter(dataset => dataset && dataset.label) : [];
        const items = visibleDatasets.map(dataset => {
            const item = documentRef.createElement("span");
            const swatch = documentRef.createElement("span");
            const label = documentRef.createElement("span");
            item.className = "strike-bar-chart-legend-item";
            swatch.className = "strike-bar-chart-legend-swatch";
            const backgroundColor = firstColor(dataset.backgroundColor);
            const borderColor = firstColor(dataset.borderColor);
            if (swatch.style) {
                if (typeof backgroundColor === "string") swatch.style.backgroundColor = backgroundColor;
                if (typeof borderColor === "string") swatch.style.borderColor = borderColor;
            }
            label.textContent = String(dataset.label);
            item.replaceChildren(swatch, label);
            return item;
        });
        legend.replaceChildren(...items);
        legend.hidden = items.length === 0;
        return items.length > 0;
    }

    return Object.freeze({ SLOT_WIDTH, AXIS_ALLOWANCE, DATASET_OPTIONS,
        preparePlot, centerIndex, renderLegend });
});
