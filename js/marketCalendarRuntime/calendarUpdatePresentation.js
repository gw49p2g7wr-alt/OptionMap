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
        return Object.freeze({ state, statusText: values[0], buttonText: values[1],
            buttonDisabled: state === "checking", detailsHidden: failed.length === 0,
            detailsText: failed.map(source => `${source.displayName || source.sourceId || "不明なsource"}：${
                source.reasonClass || "確認失敗"}`).join("\n"), writerQualifier: "保存は行っていません" });
    }
    return Object.freeze({ STATES, build });
});
