(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarUpdatePresentation = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const STATES = Object.freeze(["idle", "checking", "success", "partial", "failed", "unavailable"]);
    const safeState = state => STATES.includes(state) ? state : "unavailable";
    function time(instant) {
        if (!Number.isFinite(Date.parse(instant))) return null;
        const parts = Object.fromEntries(new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo",
            hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant))
            .map(part => [part.type, part.value]));
        return `${parts.hour}:${parts.minute}`;
    }
    function build(input = {}) {
        const state = safeState(input.state), success = Number.isInteger(input.successfulSourceCount)
            ? input.successfulSourceCount : 0, total = Number.isInteger(input.requestedSourceCount)
            ? input.requestedSourceCount : 0, checked = time(input.checkedAt), failed =
            Array.isArray(input.sources) ? input.sources.filter(source => source.status !== "success") : [];
        const values = {
            idle: ["公式データ：未確認", "公式データを確認"],
            checking: ["公式データを確認中…", "確認中…"],
            success: [`公式データ：本日 ${checked || "時刻不明"} 確認済み（${success} / ${total} source）`,
                "公式データを再確認"],
            partial: [`公式データ：${success} / ${total} source確認済み・一部失敗`, "失敗sourceを再確認"],
            failed: [`公式データ：${total || failed.length} sourceの確認に失敗`, "公式データを再確認"],
            unavailable: ["公式データ：確認できません", "公式データを再確認"]
        }[state];
        const persistWarnings = (input.runtimeStateDiagnostics || []).filter(value =>
            ["runtime_state_persist_failed", "runtime_state_restore_failed"].includes(value));
        // A restored timestamp may be from a previous day; never label it as today's check.
        const restoredDate = input.restored && Number.isFinite(Date.parse(input.checkedAt)) ?
            new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric",
                month: "2-digit", day: "2-digit" }).format(new Date(input.checkedAt)) : null;
        return Object.freeze({ state, statusText: input.runtimePhase === "restoring" ?
            "公式データ：確認状態を読み込み中…" : input.runtimePhase === "cooldown" ?
            "公式データ：再試行待ち（確認間隔の制限中）" : input.runtimePhase === "blocked" ?
            "公式データ：安全条件により確認を停止" : restoredDate ?
            `${values[0].replace("本日 ", "")}（最終確認 ${restoredDate} ${checked}）` : values[0],
            buttonText: values[1], buttonDisabled: state === "checking",
            detailsHidden: failed.length === 0 && persistWarnings.length === 0,
            detailsText: [...failed.map(source => `${source.displayName || source.sourceId || "不明なsource"}：${
                source.reasonClass || "確認失敗"}`), ...persistWarnings].join("\n"),
            writerQualifier: "保存は行っていません" });
    }
    return Object.freeze({ STATES, build });
});
