(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapQriIvSavedUiState = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const UI_STATE_VERSION = 1;
    const RANGE_TEXT = Object.freeze({
        plus_minus_3000: "±3,000円",
        plus_minus_5000: "±5,000円",
        all: "全範囲"
    });

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

    function text(value) {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    function formatContract(value) {
        const match = text(value)?.match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
        return match ? `${match[1]}年${Number(match[2])}月限` : null;
    }

    function formatTradingDate(value) {
        const match = text(value)?.match(/^20\d{2}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/);
        return match ? `${Number(match[1])}/${Number(match[2])}` : null;
    }

    function formatJst(value) {
        const candidate = text(value);
        if (!candidate || !Number.isFinite(Date.parse(candidate))) return null;
        const parts = new Intl.DateTimeFormat("ja-JP", {
            timeZone: "Asia/Tokyo", month: "numeric", day: "numeric",
            hour: "2-digit", minute: "2-digit", hourCycle: "h23"
        }).formatToParts(new Date(candidate));
        const part = type => parts.find(item => item.type === type)?.value;
        return `${Number(part("month"))}/${Number(part("day"))} ${part("hour")}:${part("minute")}`;
    }

    function rangeText(mode, graphViewModel) {
        return RANGE_TEXT[mode] || text(graphViewModel?.metadata?.rangeLabel);
    }

    function graphFacts(graphViewModel) {
        if (!graphViewModel || typeof graphViewModel !== "object") {
            return { graphAvailable: false, graphState: null, graphMessage: null,
                sideMessages: [] };
        }
        const sides = [graphViewModel.series?.call, graphViewModel.series?.put]
            .filter(Boolean).map(side => side.message).filter(Boolean);
        return { graphAvailable: graphViewModel.chartAvailable === true,
            graphState: text(graphViewModel.state),
            graphMessage: text(graphViewModel.message), sideMessages: sides };
    }

    function metadata(source, graphViewModel, mode) {
        const sourceMeta = source?.metadata || {};
        const graphMeta = graphViewModel?.metadata || {};
        const contract = source?.contract || graphMeta.contract;
        return {
            contractText: formatContract(contract),
            tradingDateText: formatTradingDate(sourceMeta.tradingDate || graphMeta.tradingDate),
            pageUpdatedAtText: formatJst(sourceMeta.pageUpdatedAt || graphMeta.pageUpdatedAt),
            fetchedAtText: formatJst(sourceMeta.fetchedAt),
            rangeText: rangeText(mode, graphViewModel)
        };
    }

    function unavailableMessage(state) {
        if (state === "contract_mismatch") return "選択中の限月では保存済みIVを利用しません";
        if (state === "selected_unavailable") return "選択した限月のIVデータを表示できません";
        return "IVデータを表示できません";
    }

    function buildQriIvSavedUiState(input = {}) {
        const source = input.graphSourceState && typeof input.graphSourceState === "object"
            ? input.graphSourceState : {};
        const graph = input.graphViewModel && typeof input.graphViewModel === "object"
            ? input.graphViewModel : null;
        const sourceKind = text(source.sourceKind) || "unavailable";
        const sourceState = text(source.state) || "unavailable";
        const mode = text(input.rangeMode) || text(graph?.metadata?.rangeMode) ||
            text(source.rangePolicy?.defaultRange);
        const graphInfo = graphFacts(graph);
        const meta = metadata(source, graph, mode);
        const diagnostics = {
            sourceKind,
            graphSourceState: sourceState,
            freshnessStatus: text(source.freshness?.status),
            freshnessReason: text(source.freshness?.reason),
            contractContext: source.diagnostics?.contractMatched ?? null,
            graphAvailable: graphInfo.graphAvailable,
            rangeMode: mode,
            liveStatus: text(source.liveStatus),
            savedReason: sourceKind === "saved" ? text(source.reason) : null,
            graphState: graphInfo.graphState
        };

        if (sourceKind === "unavailable" || source.available !== true) {
            return deepFreeze({ uiStateVersion: UI_STATE_VERSION, visible: true,
                sourceKind: "unavailable", state: sourceState, statusLabel: null,
                message: unavailableMessage(sourceState), severity: "neutral",
                showSavedBadge: false, ...meta, graphAvailable: false,
                sideMessages: [], diagnostics });
        }

        if (sourceKind === "live") {
            return deepFreeze({ uiStateVersion: UI_STATE_VERSION, visible: true,
                sourceKind: "live", state: sourceState, statusLabel: null,
                message: graphInfo.graphMessage, severity: "neutral",
                showSavedBadge: false, ...meta,
                graphAvailable: graphInfo.graphAvailable,
                sideMessages: clone(graphInfo.sideMessages), diagnostics });
        }

        if (sourceKind !== "saved") {
            return deepFreeze({ uiStateVersion: UI_STATE_VERSION, visible: true,
                sourceKind: "unavailable", state: "unavailable", statusLabel: null,
                message: "IVデータを表示できません", severity: "neutral",
                showSavedBadge: false, ...meta, graphAvailable: false,
                sideMessages: [], diagnostics });
        }

        const allMissing = graph && graphInfo.graphAvailable === false &&
            graphInfo.graphState === "empty";
        const fallback = sourceState === "saved_fallback";
        const message = allMissing
            ? "保存済みIVはありますが、この範囲にはIV公表データがありません"
            : fallback ? "IV取得に失敗しました。保存済みIVを表示しています"
                : "保存済みIVを表示中 — 最新IVを確認中…";
        return deepFreeze({ uiStateVersion: UI_STATE_VERSION, visible: true,
            sourceKind: "saved", state: sourceState, statusLabel: "保存済みIV",
            message, severity: fallback ? "caution" : "neutral",
            showSavedBadge: true, ...meta,
            graphAvailable: graphInfo.graphAvailable,
            sideMessages: clone(graphInfo.sideMessages), diagnostics });
    }

    return Object.freeze({ UI_STATE_VERSION, RANGE_TEXT, buildQriIvSavedUiState,
        formatContract, formatTradingDate, formatJst });
});
