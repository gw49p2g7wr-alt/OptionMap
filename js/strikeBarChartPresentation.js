(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapStrikeBarChartPresentation = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const SLOT_WIDTH = 12;
    const AXIS_ALLOWANCE = 80;
    const ROW_HEIGHT = 18;
    const MIRRORED_AXIS_ALLOWANCE = 56;
    const MIRRORED_MIN_WIDTH = 720;
    const stickyAxisBindings = new WeakMap();
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

    function prepareMirroredPlot({ container, plot, strikeCount } = {}) {
        if (!container || !plot) return Object.freeze({ width: 0, height: 0 });
        const availableWidth = Math.max(Number(container.clientWidth) || 0, 0);
        const minimumHeight = Math.max(Number(strikeCount) || 0, 0) *
            ROW_HEIGHT + MIRRORED_AXIS_ALLOWANCE;
        const width = Math.max(availableWidth, MIRRORED_MIN_WIDTH);
        plot.style.width = "100%";
        plot.style.minWidth = `${MIRRORED_MIN_WIDTH}px`;
        plot.style.height = `${Math.ceil(minimumHeight)}px`;
        plot.style.minHeight = `${Math.ceil(minimumHeight)}px`;
        return Object.freeze({ width, height: minimumHeight });
    }

    function centerVerticalIndex({ container, plot, chart, index } = {}) {
        if (!container || !plot || !chart || !Number.isInteger(index) || index < 0) return false;
        const center = chart.scales?.y?.getPixelForValue?.(index);
        if (!Number.isFinite(center)) return false;
        const viewportHeight = Number(container.clientHeight) || 0;
        const plotHeight = Number(plot.scrollHeight) ||
            Number.parseFloat(plot.style?.minHeight) || 0;
        const maximum = Math.max(0, plotHeight - viewportHeight);
        container.scrollTop = Math.max(0, Math.min(maximum, center - viewportHeight / 2));
        return true;
    }

    function clearStickyAxis({ axis, scroller } = {}) {
        const binding = axis && stickyAxisBindings.get(axis);
        if (binding?.scroller?.removeEventListener) {
            binding.scroller.removeEventListener("scroll", binding.sync);
        }
        if (axis) {
            stickyAxisBindings.delete(axis);
            axis.replaceChildren?.();
            axis.hidden = true;
        }
        if (scroller && binding?.scroller !== scroller && binding?.sync &&
            scroller.removeEventListener) scroller.removeEventListener("scroll", binding.sync);
        return Boolean(axis);
    }

    function renderStickyAxis({ documentRef, axis, scroller, plot, chart } = {}) {
        clearStickyAxis({ axis });
        const scale = chart?.scales?.x;
        const ticks = Array.isArray(scale?.ticks) ? scale.ticks : [];
        if (!documentRef?.createElement || !axis?.replaceChildren ||
            !scroller?.addEventListener || !plot || !scale || ticks.length === 0) return false;
        const callback = chart?.options?.scales?.x?.ticks?.callback;
        const track = documentRef.createElement("div");
        track.className = "strike-bar-chart-sticky-axis-track";
        const plotWidth = Number(plot.scrollWidth) || Number.parseFloat(plot.style?.minWidth) ||
            Number(scroller.scrollWidth) || Number(scroller.clientWidth) || MIRRORED_MIN_WIDTH;
        track.style.width = `${Math.max(MIRRORED_MIN_WIDTH, plotWidth)}px`;
        const labels = ticks.map((tick, index) => {
            const x = scale.getPixelForValue?.(tick.value);
            if (!Number.isFinite(x)) return null;
            const label = documentRef.createElement("span");
            label.className = "strike-bar-chart-sticky-axis-tick";
            label.style.left = `${x}px`;
            const formatted = typeof callback === "function"
                ? callback.call(scale, tick.value, index, ticks)
                : scale.getLabelForValue?.(tick.value) ?? String(tick.value);
            label.textContent = formatted == null ? "" : String(formatted);
            return label;
        }).filter(Boolean);
        if (labels.length === 0) return false;
        track.replaceChildren(...labels);
        axis.replaceChildren(track);
        axis.hidden = false;
        const sync = () => {
            const offset = Math.max(0, Number(scroller.scrollLeft) || 0);
            track.style.transform = `translateX(${-offset}px)`;
        };
        scroller.addEventListener("scroll", sync, { passive: true });
        stickyAxisBindings.set(axis, { scroller, sync });
        sync();
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

    return Object.freeze({ SLOT_WIDTH, AXIS_ALLOWANCE, ROW_HEIGHT, MIRRORED_AXIS_ALLOWANCE,
        MIRRORED_MIN_WIDTH, DATASET_OPTIONS, preparePlot, centerIndex,
        prepareMirroredPlot, centerVerticalIndex, renderStickyAxis, clearStickyAxis,
        renderLegend });
});
