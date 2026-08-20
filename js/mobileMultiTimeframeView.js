(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const builderApi = commonJs ? require("./multiTimeframeState.js")
        : root?.OptionMapMultiTimeframeState;
    const api = factory(builderApi);
    if (commonJs) module.exports = api;
    if (root) root.OptionMapMobileMultiTimeframeView = api;
})(typeof window !== "undefined" ? window : globalThis, function (builderApi) {
    "use strict";

    const arrow = direction => ({ up: "↑", down: "↓", neutral: "→" })[direction] || "--";
    const elapsedLabel = milliseconds => {
        if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
        const minutes = Math.floor(milliseconds / 60000);
        if (minutes < 60) return `${minutes}分`;
        return `${Math.floor(minutes / 60)}時間${String(minutes % 60).padStart(2, "0")}分`;
    };
    const snapshotQuality = (records, comparison) => {
        if (!comparison?.available) return null;
        const ids = [comparison.previous?.snapshotId, comparison.current?.snapshotId];
        const statuses = ids.map(id => records.find(record => record.snapshotId === id)
            ?.dataQuality?.status).filter(Boolean);
        if (statuses.includes("unavailable")) return { status: "unavailable" };
        if (statuses.length !== 2 || statuses.some(status => status !== "complete"))
            return { status: "partial" };
        return { status: "complete" };
    };

    function createState(summary, comparison, records = []) {
        const overall = summary?.payload?.overallV2;
        return builderApi.createMultiTimeframeState({
            asOf: summary?.generatedAt,
            marketDate: summary?.marketDate,
            morning: summary?.payload?.changeSinceMorning,
            previousObservation: comparison?.available ? {
                ...comparison, quality: snapshotQuality(records, comparison)
            } : comparison,
            mediumTerm: overall ? { ...overall, quality: overall.status } : null
        });
    }

    function unavailableMessage(state) {
        if (!state.morning.available) return "朝基準の比較データがありません";
        if (!state.previousObservation.available) return "前回観測の比較データがありません";
        if (!state.mediumTerm.available) return "中期需給を確認できません";
        return "3方向を比較できません";
    }

    function relationshipMessage(state) {
        if (state.status === "unavailable") return unavailableMessage(state);
        const { morning, previousObservation: previous, mediumTerm: medium, relationship } = state;
        if (morning.direction === "neutral") return "朝基準価格は横ばい";
        if (previous.direction === "neutral") return "前回観測価格は横ばい";
        if (medium.direction === "neutral") return "中期需給は中立";
        if (relationship.allAligned) return "3方向が同方向";
        if (relationship.morningVsMedium === "opposite_direction" &&
            relationship.previousVsMedium === "opposite_direction")
            return "朝基準・前回観測とも中期需給と反対方向";
        if (relationship.previousVsMedium === "same_direction" &&
            relationship.morningVsMedium === "opposite_direction")
            return "前回観測区間では中期需給と同方向";
        if (relationship.previousVsMedium === "opposite_direction" &&
            relationship.morningVsMedium === "same_direction")
            return "前回観測のみ他の2方向と反対";
        return "方向関係に中立が含まれます";
    }

    function qualityMessage(state) {
        if (state.status !== "partial") return "";
        const partial = [
            [state.morning, "朝基準"],
            [state.previousObservation, "前回観測"],
            [state.mediumTerm, "中期需給"]
        ].filter(([component]) => component.quality.status !== "complete").map(([, label]) => label);
        return `${partial.join("・")}：一部材料不足`;
    }

    function createView(summary, comparison, records = []) {
        const state = createState(summary, comparison, records);
        const morning = state.morning.available ? `朝 ${arrow(state.morning.direction)}` : "朝 比較待ち";
        const previous = state.previousObservation.available
            ? `前回 ${arrow(state.previousObservation.direction)}（${elapsedLabel(state.previousObservation.elapsedMs)}）`
            : "前回 比較待ち";
        const medium = state.mediumTerm.available ? `中期 ${arrow(state.mediumTerm.direction)}` : "中期 判定不能";
        return { state, summary: `${morning} / ${previous} / ${medium}`,
            relationship: relationshipMessage(state), quality: qualityMessage(state) };
    }

    return Object.freeze({ elapsedLabel, createState, relationshipMessage, createView });
});
