(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapWeeklyFuturesTwelveGroupReferenceView = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const AGREEMENT_LABELS = Object.freeze({
        same_direction: "同方向",
        different_strength: "同方向・強さ違い",
        opposite_direction: "逆方向",
        zero_involved: "中立を含む",
        unavailable: "比較不可"
    });
    const GROUP_LABELS = Object.freeze({
        JPM: "JPM",
        GS: "GS",
        NOMURA: "野村",
        BNP: "BNP",
        ABN: "ABN",
        SG: "ソシエテG",
        MORGAN_MUFG: "MorganMUFG",
        SBI_RAKUTEN: "SBI＋楽天",
        MITSUBISHI_UFJ: "三菱UFJ",
        DAIWA: "大和",
        CITI: "シティ",
        BARCLAYS: "バークレイズ"
    });
    const QUALITY_LABELS = Object.freeze({
        full: "全group確認",
        partial_one_missing: "1 group欠損",
        partial_two_missing: "2 group欠損",
        unavailable: "利用不可"
    });
    const GROUP_ORDER = Object.freeze([
        "JPM", "GS", "NOMURA", "BNP", "ABN", "SG", "MORGAN_MUFG",
        "SBI_RAKUTEN", "MITSUBISHI_UFJ", "DAIWA", "CITI", "BARCLAYS"
    ]);
    const CLASSIFICATION_LABELS = Object.freeze({
        estimatedBuy: "買い寄与",
        estimatedSell: "売り寄与",
        reducedBuy: "買い縮小",
        reducedSell: "売り縮小",
        unconfirmed: "未確定"
    });

    function freeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) {
            return value;
        }
        Object.values(value).forEach(freeze);
        return Object.freeze(value);
    }

    const finite = Number.isFinite;
    const groupLabel = value => GROUP_LABELS[value] || String(value || "—");
    const fixed = value => finite(value) ? value.toFixed(3) : "—";
    const signed = value => finite(value)
        ? `${value >= 0 ? "+" : ""}${value.toFixed(3)}` : "—";

    function contributionDirection(group) {
        if (group?.availability !== true || group.contribution === null) {
            return "—";
        }
        if (!finite(group.contribution) || group.contribution === 0) {
            return "寄与なし";
        }
        return group.contribution > 0 ? "買い" : "売り";
    }

    function createDetailRows(groups, dominantGroup) {
        if (!groups || typeof groups !== "object") return [];
        return GROUP_ORDER.map(id => groups[id]).filter(Boolean).map(group => ({
            id: group.id,
            group: groupLabel(group.id),
            available: group.availability === true,
            classification: group.availability === true
                ? CLASSIFICATION_LABELS[group.status] || "未確定"
                : "利用不可",
            contributionDirection: contributionDirection(group),
            dominant: group.availability === true && group.id === dominantGroup
        }));
    }

    function guardsPass(state) {
        return state?.groups12?.shadowOnly === true &&
            state.groups12.referenceOnly === true &&
            state.groups12.formalApplied === false &&
            state.groups12.overallV2Eligible === false &&
            state?.comparison?.tradeDecisionEligible === false &&
            state.comparison.overallV2Applied === false;
    }

    function explainDelta(major, twelve, delta, agreement) {
        if (!finite(major) || !finite(twelve) || !finite(delta)) return "比較不可";
        if (agreement === "opposite_direction") return "主要5社と方向が異なります";
        if (major === 0 || twelve === 0) return "中立を含む比較です";
        if (delta === 0) return "主要5社と強さは同じです";
        if (major > 0 && twelve > 0) {
            return delta > 0
                ? "12-groupの方が買い強め"
                : "12-groupの方が買い弱め";
        }
        if (major < 0 && twelve < 0) {
            return delta < 0
                ? "12-groupの方が売り強め"
                : "12-groupの方が売り弱め";
        }
        return "主要5社と方向が異なります";
    }

    function unavailable(reason, guardRejected = false, state = null) {
        const groups = state?.groups12;
        const missing = Array.isArray(groups?.missingGroups)
            ? groups.missingGroups.map(groupLabel) : [];
        return freeze({
            available: false,
            guardRejected,
            heading: "12-group参考分析",
            formalLabel: "正式判定：主要5社",
            warning: "参考分析・OverallV2には未使用",
            status: "利用不可",
            reason: reason || "dual-run結果を利用できません",
            direction: "—",
            normalizedDirection: "—",
            delta: "—",
            deltaExplanation: "比較不可",
            agreement: AGREEMENT_LABELS.unavailable,
            dominant: "—",
            coverage: Number.isInteger(groups?.availableGroupCount)
                ? `${groups.availableGroupCount} / 12` : "— / 12",
            quality: QUALITY_LABELS[groups?.qualityState] || "利用不可",
            missing: missing.length ? missing.join("・") : "—",
            detailRows: []
        });
    }

    function createViewModel(state) {
        if (!state || state.status !== "available") {
            return unavailable(state?.reason, false, state);
        }
        if (!guardsPass(state)) {
            return unavailable("正式/参考境界を確認できません", true);
        }
        const groups = state.groups12;
        const major = state.major5;
        const comparison = state.comparison;
        if (major?.available !== true || major.formalApplied !== true ||
            groups.available !== true || comparison.available !== true ||
            !finite(major.normalizedDirection) ||
            !finite(groups.normalizedDirection) ||
            !finite(comparison.normalizedDirectionDelta)) {
            return unavailable(groups?.reason || state.reason);
        }
        const agreementKey = comparison.agreement;
        const missing = Array.isArray(groups.missingGroups)
            ? groups.missingGroups.map(groupLabel) : [];
        const dominance = finite(groups.dominanceRatio)
            ? `（${(groups.dominanceRatio * 100).toFixed(1)}%）` : "";
        return freeze({
            available: true,
            guardRejected: false,
            heading: "12-group参考分析",
            formalLabel: "正式判定：主要5社",
            warning: "参考分析・OverallV2には未使用",
            status: "利用可能",
            reason: null,
            direction: groups.direction || "—",
            normalizedDirection: fixed(groups.normalizedDirection),
            delta: signed(comparison.normalizedDirectionDelta),
            deltaExplanation: explainDelta(
                major.normalizedDirection,
                groups.normalizedDirection,
                comparison.normalizedDirectionDelta,
                agreementKey
            ),
            agreement: AGREEMENT_LABELS[agreementKey] ||
                AGREEMENT_LABELS.unavailable,
            dominant: groups.dominantGroup
                ? `${groupLabel(groups.dominantGroup)}${dominance}` : "—",
            coverage: `${Number.isInteger(groups.availableGroupCount)
                ? groups.availableGroupCount : "—"} / 12`,
            quality: QUALITY_LABELS[groups.qualityState] || "—",
            missing: missing.length ? missing.join("・") : "なし",
            detailRows: createDetailRows(groups.groups, groups.dominantGroup)
        });
    }

    return freeze({
        AGREEMENT_LABELS,
        GROUP_LABELS,
        GROUP_ORDER,
        CLASSIFICATION_LABELS,
        guardsPass,
        contributionDirection,
        createDetailRows,
        explainDelta,
        createViewModel
    });
});
