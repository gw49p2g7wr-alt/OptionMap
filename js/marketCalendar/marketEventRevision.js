(function (root, factory) {
    const schedules = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./marketEventSchedule.js") : root?.OptionMapMarketEventSchedule;
    const dates = typeof module === "object" && module.exports && !(root && root.document)
        ? require("../calendarDate/calendarDate.js") : root?.OptionMapCalendarDate;
    const api = factory(schedules, dates);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketEventRevision = api;
})(typeof window !== "undefined" ? window : globalThis, function (schedules, dates) {
    "use strict";
    const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
    function selectAsKnownAt(revisions, knowledgeAt) {
        if (!timestamp(knowledgeAt)) throw new TypeError("knowledge_at_invalid");
        const matches = (revisions || []).filter(item => timestamp(item.validFrom) &&
            item.validFrom <= knowledgeAt && (item.validTo === null || timestamp(item.validTo) && knowledgeAt < item.validTo));
        if (matches.length > 1) throw new Error("revision_interval_overlap");
        return matches[0] || null;
    }
    function projectForCalendarDate({ entries = [], calendarDate, knowledgeAt,
        displayTimeZone = "Asia/Tokyo" } = {}) {
        if (!dates.isValid(calendarDate)) throw new TypeError("calendar_date_invalid");
        return Object.freeze(entries.flatMap(entry => { const revision = selectAsKnownAt(entry.revisions, knowledgeAt);
            if (!revision) return []; const interval = schedules.calendarDateIntervalFor(
                revision.schedule, displayTimeZone);
            return interval.start <= calendarDate && calendarDate <= interval.end ? [revision] : []; }).sort((left, right) =>
            (left.schedule.canonicalStart || "").localeCompare(right.schedule.canonicalStart || "") ||
            left.eventKey.localeCompare(right.eventKey)));
    }
    return Object.freeze({ selectAsKnownAt, projectForCalendarDate });
});
