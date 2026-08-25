(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    if (root) root.OptionMapQriOptionsSavedUiState = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    const UI_STATE_VERSION = 1;
    const SAVED_BADGE_TEXT = "保存済み建玉";

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }

    function cleanText(value) {
        return typeof value === "string" && value.trim() ? value.trim() : null;
    }

    function formatContract(value) {
        const text = cleanText(value);
        const match = text?.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
        return match ? `${match[1]}年${Number(match[2])}月限` : null;
    }

    function formatTradingDate(value) {
        const text = cleanText(value);
        const match = text?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return match ? `${match[1]}/${match[2]}/${match[3]}` : null;
    }

    function jstParts(value) {
        const text = cleanText(value);
        if (!text || !/^\d{4}-\d{2}-\d{2}T/.test(text)) return null;
        const timestamp = Date.parse(text);
        if (!Number.isFinite(timestamp)) return null;
        const date = new Date(timestamp + 9 * 60 * 60 * 1000);
        return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1,
            day: date.getUTCDate(), hour: String(date.getUTCHours()).padStart(2, "0"),
            minute: String(date.getUTCMinutes()).padStart(2, "0") };
    }

    function formatPageUpdatedAt(value, tradingDate) {
        const parts = jstParts(value);
        if (!parts) return null;
        const sameDate = tradingDate === `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
        return sameDate ? `${parts.hour}:${parts.minute}` :
            `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
    }

    function formatFetchedAt(value) {
        const parts = jstParts(value);
        return parts ? `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}` : null;
    }

    function baseState(source, values) {
        const policy = source?.analysisPolicy || {};
        const freshness = source?.freshness || {};
        return deepFreeze({ uiStateVersion: UI_STATE_VERSION,
            visible: values.visible === true,
            sourceKind: values.sourceKind,
            state: values.state,
            showSavedBadge: values.showSavedBadge === true,
            badgeText: values.badgeText ?? null,
            message: values.message ?? null,
            note: values.note ?? null,
            severity: values.severity ?? "neutral",
            contractText: values.contractText ?? null,
            tradingDateText: values.tradingDateText ?? null,
            pageUpdatedAtText: values.pageUpdatedAtText ?? null,
            fetchedAtText: values.fetchedAtText ?? null,
            showLegacyNotice: false,
            diagnostics: { sourceKind: values.sourceKind,
                displayState: values.state,
                freshnessStatus: freshness.status ?? null,
                freshnessReason: freshness.reason ?? null,
                contractContext: source?.metadata?.contract ?? source?.contract ?? null,
                analysisSuppressed: source?.diagnostics?.analysisSuppressed ??
                    (!policy.allowFormalAnalysis && !policy.allowLegacyAnalysis),
                allowFormalAnalysis: policy.allowFormalAnalysis ?? null,
                allowLegacyAnalysis: policy.allowLegacyAnalysis ?? null,
                calculationSourcePolicy: policy.calculationSourcePolicy ?? null,
                legacyMode: values.sourceKind === "legacy",
                uiStateVersion: UI_STATE_VERSION }
        });
    }

    function buildQriOptionsSavedUiState(input = {}) {
        const source = input?.displaySourceState || {};
        const sourceKind = cleanText(source.sourceKind) || "unavailable";
        const state = cleanText(source.state) || "unavailable";
        const common = { sourceKind, state, visible: false, showSavedBadge: false };

        if (sourceKind === "live" || sourceKind === "legacy") {
            return baseState(source, common);
        }

        if (sourceKind === "saved") {
            const metadata = source.metadata || {};
            let message = "保存済み建玉を表示中";
            let severity = "neutral";
            if (state === "saved_pending") {
                message = "保存済み建玉を表示中 — 最新建玉を確認中…";
            } else if (state === "saved_fallback") {
                message = "QRI取得に失敗しました。保存済み建玉を表示しています";
                severity = "caution";
            } else if (state === "saved_stale") {
                message = "前回取得した建玉データです";
            }
            return baseState(source, { ...common, visible: true, showSavedBadge: true,
                badgeText: SAVED_BADGE_TEXT, message, severity,
                contractText: formatContract(metadata.contract),
                tradingDateText: formatTradingDate(metadata.tradingDate),
                pageUpdatedAtText: formatPageUpdatedAt(metadata.pageUpdatedAt,
                    metadata.tradingDate),
                fetchedAtText: formatFetchedAt(metadata.fetchedAt) });
        }

        let message = "建玉データを表示できません";
        if (state === "contract_mismatch") {
            message = "選択中の限月では保存済み建玉を利用できません";
        } else if (state === "specific_unavailable") {
            message = "選択した限月の建玉データを表示できません";
        }
        return baseState(source, { ...common, visible: true, message });
    }

    return Object.freeze({ UI_STATE_VERSION, buildQriOptionsSavedUiState,
        formatContract, formatTradingDate, formatPageUpdatedAt, formatFetchedAt });
});
