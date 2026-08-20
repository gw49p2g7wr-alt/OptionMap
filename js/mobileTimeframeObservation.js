(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) {
        module.exports = api;
    }
    if (root) root.OptionMapMobileTimeframeObservation = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const finite = value => typeof value === "number" && Number.isFinite(value);

    function shortPriceDirection(changeSinceMorning) {
        const price = changeSinceMorning?.currentPrice;
        if (changeSinceMorning?.available !== true || price?.available !== true ||
            !finite(price.delta)) {
            return { available: false, direction: "unavailable", arrow: "--",
                label: "判定不能", delta: null,
                reason: price?.reason || changeSinceMorning?.reason || "comparison_unavailable" };
        }
        const direction = price.delta > 0 ? "up" : price.delta < 0 ? "down" : "neutral";
        return { available: true, direction,
            arrow: direction === "up" ? "↑" : direction === "down" ? "↓" : "→",
            label: direction === "up" ? "上昇" : direction === "down" ? "下落" : "横ばい",
            delta: price.delta, reason: null };
    }

    function mediumDemandDirection(overallV2) {
        if (overallV2?.available !== true || !finite(overallV2.direction)) {
            return { available: false, direction: "unavailable", arrow: "--",
                label: "判定不能", score: null, reason: "overall_v2_unavailable" };
        }
        const label = typeof overallV2.directionLabel === "string"
            ? overallV2.directionLabel : "";
        const direction = label.includes("買い") ? "up" : label.includes("売り")
            ? "down" : "neutral";
        return { available: true, direction,
            arrow: direction === "up" ? "↑" : direction === "down" ? "↓" : "→",
            label: label || "中立", score: overallV2.direction, reason: null };
    }

    function alignment(shortTerm, mediumTerm) {
        if (!shortTerm.available || !mediumTerm.available) {
            return { status: "unavailable", label: "判定不能",
                reason: !shortTerm.available ? "short_term_unavailable" : "medium_term_unavailable",
                message: "短期価格と中期需給を比較できません。" };
        }
        if (shortTerm.direction === "neutral" || mediumTerm.direction === "neutral") {
            return { status: "neutral_mixed", label: "中立混在", reason: "neutral_included",
                message: "短期価格または中期需給に中立が含まれています。" };
        }
        if (shortTerm.direction === mediumTerm.direction) {
            return { status: "aligned", label: "一致", reason: "same_direction",
                message: "短期価格と中期需給は同じ方向です。" };
        }
        return { status: "diverged", label: "不一致", reason: "opposite_direction",
            message: "短期価格と中期需給の方向が一致していません。" };
    }

    function createTimeframeObservation(summary) {
        const shortTerm = shortPriceDirection(summary?.payload?.changeSinceMorning);
        const mediumTerm = mediumDemandDirection(summary?.payload?.overallV2);
        return { shortTerm, mediumTerm, alignment: alignment(shortTerm, mediumTerm) };
    }

    return Object.freeze({ shortPriceDirection, mediumDemandDirection, alignment,
        createTimeframeObservation });
});
