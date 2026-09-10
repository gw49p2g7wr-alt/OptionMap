(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMorningBaselineV4StatusView = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";

    function deepFreeze(value) {
        if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(deepFreeze);
        return Object.freeze(value);
    }
    const formatTime = value => {
        if (!value || Number.isNaN(Date.parse(value))) return null;
        return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo",
            hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
    };

    function createViewModel(restoreState = null, automaticOutcome = null, schedulerState = null) {
        const valid = restoreState?.restoreStatus === "valid" &&
            restoreState?.integrityStatus === "valid";
        const missing = restoreState?.restoreStatus === "missing";
        const applicable = valid && restoreState?.applicabilityStatus === "applicable";
        const notApplicable = valid && restoreState?.applicabilityStatus === "not_applicable";
        const capturedAt = applicable ? restoreState?.baseline?.capturedAt : null;
        const savedTime = formatTime(capturedAt);
        const storageLabel = applicable
            ? `正式朝基準：${savedTime ? `${savedTime} ` : ""}保存済み`
            : notApplicable ? "正式朝基準：保存済み（現在の正式scope対象外）"
                : missing && schedulerState?.stoppedReason === "window_closed"
                    ? "正式朝基準：本日は正式朝基準を取得できませんでした"
                    : missing ? "正式朝基準：本日は保存されていません"
                    : valid ? "正式朝基準：保存済み（現在状態の確認待ち）"
                        : restoreState?.restoreStatus === "invalid"
                            ? "正式朝基準：保存データを検証できません"
                            : "正式朝基準：状態確認待ち";
        const automaticTime = formatTime(automaticOutcome?.capturedAt);
        const automaticLabel = schedulerState?.stoppedReason === "storage_invalid"
            ? "自動取得：停止（保存データを確認できません）"
            : schedulerState?.stoppedReason === "baseline_applicable"
                ? "自動取得：完了"
                : schedulerState?.stoppedReason === "window_closed"
                    ? "自動取得：終了（05:00〜09:00）"
                : schedulerState?.status === "running" || schedulerState?.status === "waiting" ||
                    schedulerState?.status === "scheduled" && schedulerState?.windowState === "inside"
                    ? "自動取得：09:00まで自動再試行中"
                    : automaticOutcome?.windowStatus === "outside_window_after"
            ? "自動取得：終了（05:00〜09:00）"
            : automaticOutcome?.windowStatus === "outside_window_before"
                ? "自動取得：開始前（05:00〜09:00）"
                : automaticOutcome?.saved === true
                    ? `自動取得：${automaticTime ? `${automaticTime} ` : ""}保存完了`
                    : automaticOutcome?.status === "already_saved" || automaticOutcome?.status === "duplicate"
                        ? "自動取得：保存済みscopeを確認"
                        : "自動取得：条件待ち（次回更新時に再試行／05:00〜09:00）";
        return deepFreeze({ storageLabel, automaticLabel, storageStatus: applicable ? "applicable" :
            notApplicable ? "not_applicable" : missing ? "missing" : valid ? "pending" :
                restoreState?.restoreStatus === "invalid" ? "invalid" : "pending",
        restoreReason: restoreState?.reason || null });
    }

    return deepFreeze({ createViewModel });
});
