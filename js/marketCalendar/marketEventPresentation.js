(function (root, factory) {
    const scheduleApi = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./marketEventSchedule.js") : root?.OptionMapMarketEventSchedule;
    const importance = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./importancePolicy.js") : root?.OptionMapMarketEventImportancePolicy;
    const api = factory(scheduleApi, importance);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketEventPresentation = api;
})(typeof window !== "undefined" ? window : globalThis, function (scheduleApi, importance) {
    "use strict";
    function jstTime(instant) { const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date(instant)).map(part => [part.type, part.value]));
        return `${parts.hour}:${parts.minute}`; }
    function build(event, { now, selectedCalendarDate } = {}) {
        const schedule = event.schedule, eventDate = scheduleApi.calendarDateFor(schedule, "Asia/Tokyo");
        let timeLabel = schedule.kind === "instant" ? jstTime(schedule.canonicalStart)
            : schedule.kind === "date_only" ? "時刻未定" : schedule.kind === "all_day" ? "終日" : "期間";
        if (schedule.kind === "instant" && schedule.sourceLocal.startDate !== eventDate) timeLabel = `翌${timeLabel}`;
        let stateLabel = null;
        if (event.lifecycleStatus === "cancelled") stateLabel = "中止";
        else if (event.change?.reason) stateLabel = "日程変更";
        else if (schedule.canonicalStart && Number.isFinite(Date.parse(now))) { const remaining =
            Date.parse(schedule.canonicalStart) - Date.parse(now); stateLabel = remaining <= 0 ? "発表済み"
                : remaining < 86400000 ? `あと${Math.max(1, Math.ceil(remaining / 3600000))}時間` : null; }
        return Object.freeze({ eventKey: event.eventKey, calendarDate: eventDate,
            selectedCalendarDate: selectedCalendarDate || null, timeLabel, title: event.title.ja,
            stateLabel, importance: importance.classify(event.logical.eventType).importance });
    }
    return Object.freeze({ build });
});
