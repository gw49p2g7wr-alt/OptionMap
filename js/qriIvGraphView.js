(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapQriIvGraphView = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const VIEW_VERSION = 1;
    const RANGE_MODES = Object.freeze([
        "plus_minus_3000", "plus_minus_5000", "all"
    ]);

    function resolveChannel(selection, runtime) {
        if (selection?.mode === "auto") {
            return runtime?.active?.available === true
                ? { available: true, channel: "active", contract: runtime.active.contract }
                : { available: false, channel: "active", reason: runtime?.active?.reason || "data_unavailable" };
        }
        if (selection?.mode === "specific") {
            if (runtime?.selected?.available === true && selection.contract &&
                runtime.selected.contract === selection.contract) {
                return { available: true, channel: "selected", contract: selection.contract };
            }
            return { available: false, channel: "selected", reason: "data_unavailable" };
        }
        return { available: false, channel: null, reason: "data_unavailable" };
    }

    function dataset(series) {
        if (!series || series.state === "empty") return null;
        const call = series.optionType === "call";
        return {
            label: call ? "CALL IV" : "PUT IV",
            data: series.values.slice(),
            borderColor: call ? "rgba(36, 111, 192, 1)" : "rgba(211, 65, 101, 1)",
            backgroundColor: call ? "rgba(36, 111, 192, 0.18)" : "rgba(211, 65, 101, 0.18)",
            pointBackgroundColor: call ? "rgba(36, 111, 192, 1)" : "rgba(211, 65, 101, 1)",
            borderWidth: 2,
            pointRadius: 4,
            pointHoverRadius: 6,
            showLine: series.state === "line_and_point",
            spanGaps: false,
            tension: 0
        };
    }

    function contractLabel(contract) {
        const match = String(contract || "").match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
        return match ? `${match[1]}年${Number(match[2])}月限` : "限月不明";
    }

    function dateLabel(value) {
        return /^20\d{2}-\d{2}-\d{2}$/.test(value || "")
            ? value.replace(/-/g, "/") : "--";
    }

    function timeLabel(value) {
        if (typeof value !== "string") return "--";
        const match = value.match(/T(\d{2}):(\d{2})/);
        return match ? `${match[1]}:${match[2]}` : "--";
    }

    function presentation(viewModel) {
        if (!viewModel?.available) {
            return { viewVersion: VIEW_VERSION, available: false,
                reason: viewModel?.reason || "data_unavailable",
                systemMessage: "IVデータを表示できません", emptyMessage: null,
                metadata: [], coverage: [], sideMessages: [], datasets: [] };
        }
        const call = viewModel.series.call;
        const put = viewModel.series.put;
        const sideMessage = (label, series) => series.state === "empty"
            ? `${label} IV：公表データなし`
            : series.message ? `${label} IV：${series.message}` : null;
        return {
            viewVersion: VIEW_VERSION,
            available: true,
            reason: null,
            systemMessage: null,
            emptyMessage: viewModel.chartAvailable ? null
                : viewModel.message || "この範囲にはIV公表データがありません",
            metadata: [
                contractLabel(viewModel.metadata.contract),
                `取引日 ${dateLabel(viewModel.metadata.tradingDate)}`,
                `QRI更新 ${timeLabel(viewModel.metadata.pageUpdatedAt)}`,
                `表示範囲 ${viewModel.metadata.rangeLabel || "--"}`
            ],
            coverage: [
                `CALL ${call.availablePoints} / ${call.strikeCount}点`,
                `PUT ${put.availablePoints} / ${put.strikeCount}点`
            ],
            sideMessages: [sideMessage("CALL", call), sideMessage("PUT", put)].filter(Boolean),
            datasets: [dataset(call), dataset(put)].filter(Boolean)
        };
    }

    return Object.freeze({ VIEW_VERSION, RANGE_MODES, resolveChannel,
        dataset, contractLabel, dateLabel, timeLabel, presentation });
});
