(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapQriOptionsSavedReferenceUiState = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const UI_STATE_VERSION = 1;
    const TITLE = "保存済み建玉からの参考情報";
    const NOTE = "保存済みデータからの参考情報です。現在の相場判断には使用していません。";
    const SAVED_STATES = new Set(["saved_pending", "saved_fallback"]);

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function text(value) {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    function integer(value) {
        if (!Number.isSafeInteger(value)) return null;
        const sign = value < 0 ? "-" : "";
        const digits = String(Math.abs(value));
        return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    function formatContract(value) {
        const match = text(value)?.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
        return match ? `${match[1]}年${Number(match[2])}月限` : null;
    }

    function formatDate(value) {
        const match = text(value)?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return match ? `${match[1]}/${match[2]}/${match[3]}` : null;
    }

    function formatJst(value) {
        const candidate = text(value);
        if (!candidate || !/^\d{4}-\d{2}-\d{2}T/.test(candidate)) return null;
        const timestamp = Date.parse(candidate);
        if (!Number.isFinite(timestamp)) return null;
        const shifted = new Date(timestamp + 9 * 60 * 60 * 1000);
        const year = shifted.getUTCFullYear();
        const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
        const day = String(shifted.getUTCDate()).padStart(2, "0");
        const hour = String(shifted.getUTCHours()).padStart(2, "0");
        const minute = String(shifted.getUTCMinutes()).padStart(2, "0");
        return `${year}/${month}/${day} ${hour}:${minute} JST`;
    }

    function subtitle(tier) {
        if (tier === "same_trading_date_verified") return "保存時点の建玉データです";
        if (tier === "older_trading_date") return "以前に取得した建玉データです";
        return "取得時点を確認できる保存データです";
    }

    function item(candidate, rank, maximum) {
        const strike = Number(candidate?.strike);
        const openInterest = Number(candidate?.openInterest);
        const strikeNumber = integer(strike);
        const openInterestNumber = integer(openInterest);
        if (!strikeNumber || !openInterestNumber || strike <= 0 || openInterest < 0) return null;
        const isMaximum = maximum?.strike === strike &&
            maximum?.openInterest === openInterest;
        return { rank, strike, openInterest, strikeText: `${strikeNumber}円`,
            openInterestText: `${openInterestNumber}枚`,
            text: `${rank}. ${strikeNumber}円　${openInterestNumber}枚`, isMaximum };
    }

    function sideState(side, maximum, label, emptyText) {
        const candidates = Array.isArray(side?.topOpenInterest)
            ? side.topOpenInterest : [];
        const topItems = candidates.map((candidate, index) =>
            item(candidate, index + 1, maximum)).filter(Boolean);
        return { label, topItems,
            maximumItem: maximum ? item(maximum, 1, maximum) : null,
            emptyText: topItems.length === 0 ? emptyText : null };
    }

    function metadata(identity) {
        const values = [
            ["限月", formatContract(identity?.contract)],
            ["取引日", formatDate(identity?.tradingDate)],
            ["QRI更新", formatJst(identity?.pageUpdatedAt)],
            ["最終取得", formatJst(identity?.fetchedAt)]
        ];
        return values.filter(([, value]) => value).map(([label, value]) =>
            ({ label, value, text: `${label}：${value}` }));
    }

    function diagnostics(input, visible) {
        const identity = input?.identity || {};
        return { inputSourceKind: text(input?.sourceKind),
            inputSourceState: text(input?.sourceState), visible,
            contract: text(identity.contract),
            tradingDate: text(identity.tradingDate),
            canonicalVersionKey: text(identity.canonicalVersionKey),
            displayGeneration: Number.isSafeInteger(identity.displayGeneration)
                ? identity.displayGeneration : null,
            referenceOnly: true, calculationEligible: false,
            currentPriceAccessed: false, historyAccessed: false,
            storageAccessed: false, databaseAccessed: false,
            fetchTriggered: false, timerScheduled: false,
            domAccessed: false, chartAccessed: false,
            judgmentGenerated: false, overallV2Generated: false };
    }

    function hidden(input, state = "hidden") {
        return deepFreeze({ uiStateVersion: UI_STATE_VERSION, visible: false, state,
            title: null, subtitle: null,
            call: { label: null, topItems: [], maximumItem: null, emptyText: null },
            put: { label: null, topItems: [], maximumItem: null, emptyText: null },
            metadataLines: [], note: null, severity: "neutral",
            referenceOnly: true, calculationEligible: false,
            diagnostics: diagnostics(input, false) });
    }

    function valid(input) {
        const policy = input?.analysisPolicy || {};
        const identity = input?.identity;
        return input?.accepted === true && input?.available === true &&
            input.sourceKind === "saved" && SAVED_STATES.has(input.sourceState) &&
            input.referenceOnly === true && input.calculationEligible === false &&
            input.comparison === null && input.judgment === null &&
            input.overallV2 === null && input.currentPrice === null &&
            policy.allowReferenceAnalysis === true &&
            policy.allowFormalAnalysis === false &&
            policy.allowLegacyAnalysis === false &&
            policy.allowOverallV2 === false &&
            Boolean(text(identity?.contract)) &&
            Boolean(text(identity?.canonicalVersionKey)) &&
            Number.isSafeInteger(identity?.displayGeneration) &&
            Array.isArray(input.call?.topOpenInterest) &&
            Array.isArray(input.put?.topOpenInterest);
    }

    function buildQriOptionsSavedReferenceUiState(input = {}) {
        const analysis = input?.referenceAnalysisState;
        if (!valid(analysis)) return hidden(analysis,
            analysis?.sourceState === "superseded" ? "superseded" : "hidden");
        return deepFreeze({ uiStateVersion: UI_STATE_VERSION,
            visible: true, state: "saved_reference_visible",
            title: TITLE, subtitle: subtitle(analysis.freshness?.tier),
            call: sideState(analysis.call, analysis.call.maximumOpenInterest,
                "CALL 建玉上位", "CALL：公表建玉なし"),
            put: sideState(analysis.put, analysis.put.maximumOpenInterest,
                "PUT 建玉上位", "PUT：公表建玉なし"),
            metadataLines: metadata(analysis.identity), note: NOTE,
            severity: "neutral", referenceOnly: true,
            calculationEligible: false, diagnostics: diagnostics(analysis, true) });
    }

    return Object.freeze({ UI_STATE_VERSION,
        buildQriOptionsSavedReferenceUiState, formatContract, formatDate,
        formatJst, formatInteger: integer });
});
