(function (root, factory) {
    const taxonomy = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./eventTaxonomy.js") : root?.OptionMapMarketEventTaxonomy;
    const registry = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./sourceRegistry.js") : root?.OptionMapMarketEventSourceRegistry;
    const api = factory(taxonomy, registry);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketEventSourceContract = api;
})(typeof window !== "undefined" ? window : globalThis, function (taxonomy, registry) {
    "use strict";
    const SCHEDULE_KINDS = Object.freeze(["instant", "date_only", "all_day", "date_range"]);
    const PRECISIONS = Object.freeze(["exact", "date_only", "all_day", "range"]);
    const isoDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "") &&
        new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
    const time = value => /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value || "");
    const timestampOrNull = value => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
    const hash = value => /^[0-9a-f]{64}$/.test(value || "");
    function validateSourceRecord(value) {
        const errors = [], source = registry?.getSource(value?.sourceId);
        if (!source) errors.push("source_unregistered");
        if (!taxonomy?.isEventType(value?.eventType)) errors.push("event_type_invalid");
        if (!value?.sourceTitle || typeof value.sourceTitle !== "string") errors.push("source_title_invalid");
        const schedule = value?.sourceLocalSchedule;
        if (!schedule || !SCHEDULE_KINDS.includes(schedule.kind)) errors.push("schedule_kind_invalid");
        if (!isoDate(schedule?.startDate)) errors.push("start_date_invalid");
        if (schedule?.timeZone !== source?.sourceTimeZone) errors.push("timezone_mismatch");
        if (!PRECISIONS.includes(schedule?.precision)) errors.push("precision_invalid");
        if (schedule?.kind === "instant" && !time(schedule.startTime)) errors.push("start_time_invalid");
        if (schedule?.kind !== "instant" && schedule?.startTime !== null) errors.push("false_time_for_date_event");
        if (schedule?.kind === "date_range" && (!isoDate(schedule.endDate) || schedule.endDate < schedule.startDate))
            errors.push("end_date_invalid");
        if (schedule?.kind !== "date_range" && schedule?.endDate !== null) errors.push("unexpected_end_date");
        if (!timestampOrNull(value?.sourcePublishedAt) || !timestampOrNull(value?.sourceUpdatedAt) ||
            !timestampOrNull(value?.fetchedAt) || value?.fetchedAt === null) errors.push("timestamp_invalid");
        if (!hash(value?.rawContentHash)) errors.push("raw_content_hash_invalid");
        const url = registry?.validateSourceUrl(value?.sourceId, value?.sourceUrl);
        if (!url?.valid) errors.push(url?.reason || "source_url_invalid");
        return { valid: errors.length === 0, errors };
    }
    return Object.freeze({ SCHEDULE_KINDS, PRECISIONS, isoDate, time, validateSourceRecord });
});
