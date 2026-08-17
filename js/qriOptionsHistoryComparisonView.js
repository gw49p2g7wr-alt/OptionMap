(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapQriOptionsHistoryComparisonView = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const number = value => Number.isFinite(value) ? value.toLocaleString("ja-JP") : "—";
    const date = value => typeof value === "string" ? value.replaceAll("-", "/") : "—";
    const changeLine = item => `${number(item.strike)}円：${number(item.previous.value)} → ` +
        `${number(item.current.value)}（${item.delta > 0 ? "+" : ""}${number(item.delta)}）`;
    function typeView(typeResult) {
        const summary = typeResult.summary;
        return { comparable: summary.comparableCount, previousOnly: summary.previousOnlyCount,
            currentOnly: summary.currentOnlyCount, unobserved: summary.unobservedCount,
            increase: summary.increaseCount, decrease: summary.decreaseCount,
            unchanged: summary.unchangedCount,
            absoluteDeltaTotal: number(summary.absoluteDeltaTotal),
            topIncreases: summary.topIncreases.map(changeLine),
            topDecreases: summary.topDecreases.map(changeLine),
            newlyPublished: summary.newlyPublished.slice(0, 3).map(item =>
                `${number(item.strike)}円：最新 ${number(item.current.value)}（差分なし）`),
            noLongerPublished: summary.noLongerPublished.slice(0, 3).map(item =>
                `${number(item.strike)}円：前回 ${number(item.previous.value)}（差分なし）`) };
    }
    function createView(result) {
        const base = { title: "QRI建玉 前回保存日比較",
            notices: ["非掲載を0として補完していません。", "総合判定には未使用です。"],
            contract: result?.contract || null, comparisonLabel: null,
            state: "invalid", message: "正式history比較を検証できません。", call: null, put: null };
        if (!result || result.status === "invalid") return base;
        if (result.status === "unavailable") return { ...base, state: "empty",
            message: result.reason === "history_empty_for_contract" && result.contract
                ? `${result.contract}の正式historyはまだありません。`
                : "正式historyがまだありません。" };
        if (result.status === "waiting_previous") return { ...base, state: "waiting",
            message: "1日分保存済み・前回比較なし",
            comparisonLabel: `最新保存日：${date(result.currentSourceDate)}` };
        return { ...base, state: "ready", message: null,
            comparisonLabel: `${date(result.previousSourceDate)} → ${date(result.currentSourceDate)}`,
            call: typeView(result.comparison.byType.call),
            put: typeView(result.comparison.byType.put) };
    }
    return Object.freeze({ createView });
});
