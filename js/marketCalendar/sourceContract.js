(function (root, factory) {
    const taxonomy = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./eventTaxonomy.js") : root?.OptionMapMarketEventTaxonomy;
    const registry = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./sourceRegistry.js") : root?.OptionMapMarketEventSourceRegistry;
    const identity = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./marketEventIdentity.js") : root?.OptionMapMarketEventIdentity;
    const api = factory(taxonomy, registry, identity);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketEventSourceContract = api;
})(typeof window !== "undefined" ? window : globalThis, function factory(taxonomy, registry, identity) {
    "use strict";
    const SCHEDULE_KINDS = Object.freeze(["instant", "date_only", "all_day", "date_range"]);
    const PRECISIONS = Object.freeze(["exact", "date_only", "all_day", "range"]);
    const isoDate = value => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
        const time = Date.parse(`${value}T00:00:00.000Z`);
        return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
    };
    const time = value => /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value || "");
    const timestampOrNull = value => value === null || typeof value === "string" && Number.isFinite(Date.parse(value));
    const hash = value => /^[0-9a-f]{64}$/.test(value || "");
    const isJgb = value => value?.sourceId === "jp-mof-jgb-auction-calendar" || value?.eventType === "JP_JGB_AUCTION";
    const normalLabel = value => typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, "")
        .match(/^(2|5|10|20|30|40)年利付国債(?:\(第\d+回\))?$/) : null;
    function jgbErrors(value, source) {
        const a = value?.auctionIdentity, s = value?.sourceLocalSchedule, errors = [];
        if (value?.sourceId !== "jp-mof-jgb-auction-calendar" || value.eventType !== "JP_JGB_AUCTION" ||
            source?.authority !== "MOF" || source?.jurisdiction !== "JP" ||
            value?.authority !== undefined && value.authority !== "MOF" ||
            value?.jurisdiction !== undefined && value.jurisdiction !== "JP") errors.push("jgb_source_binding_invalid");
        if (!identity?.validateAuctionIdentity(a)) errors.push("jgb_identity_invalid");
        if (["referencePeriod", "edition", "scope"].some(key => Object.hasOwn(value || {}, key)) || value?.authorityEventId != null)
            errors.push("jgb_statistical_identity_fields_forbidden");
        const labels = [value?.sourceTitle, ...(value?.rawLabel !== undefined ? [value.rawLabel] : [])];
        if (labels.some(label => normalLabel(label)?.[1] + "Y" !== a?.maturity) ||
            value?.instrumentClass !== undefined && value.instrumentClass !== a?.instrumentClass ||
            value?.maturity !== undefined && value.maturity !== a?.maturity) errors.push("jgb_product_invalid");
        if (s?.kind !== "date_only" || s?.precision !== "date_only" || s?.timeZone !== "Asia/Tokyo" ||
            s?.startDate !== a?.auctionDate || s?.startTime !== null || s?.endDate !== null || s?.endTime !== null ||
            value?.time !== null || value?.eventDate !== undefined && value.eventDate !== a?.auctionDate)
            errors.push("jgb_schedule_invalid");
        if (value?.sourceStatus !== "scheduled" || value?.absenceAuthority !== "none") errors.push("jgb_lifecycle_invalid");
        if (value?.parserId !== source?.parserId || value?.parserVersion !== source?.parserVersion)
            errors.push("jgb_parser_binding_invalid");
        return errors;
    }
    // Explicit pure conversion of G1 parser facts; never adopts its isolated key/hash.
    // Statistical projection fields are checked then removed, not reused as identity.
    function toTypedJgbRecord(record) {
        if (!record || record.sourceId !== "jp-mof-jgb-auction-calendar" || record.eventType !== "JP_JGB_AUCTION" ||
            record.referencePeriod !== `auction-date:${record.eventDate}` || record.edition !== "normal-fixed-rate" ||
            record.scope !== record.maturity) throw new TypeError("jgb_isolated_projection_invalid");
        const { referencePeriod, edition, scope, ...facts } = record;
        const typed = { ...facts, auctionIdentity: { authority: "MOF", eventType: "JP_JGB_AUCTION",
            instrumentClass: record.instrumentClass, maturity: record.maturity, auctionDate: record.eventDate } };
        const checked = validateSourceRecord(typed);
        if (!checked.valid) throw new TypeError(checked.errors[0]);
        return typed;
    }
    function validateSourceRecord(value) {
        const errors = [], source = registry?.getSource(value?.sourceId);
        if (!source) errors.push("source_unregistered");
        if (isJgb(value)) errors.push(...jgbErrors(value, source));
        else if (value?.auctionIdentity !== undefined) errors.push("auction_identity_for_wrong_event_type");
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
    const isolatedFactory = typeof module === "object" && module.exports &&
        !(typeof window !== "undefined" && window.document)
        ? { createSourceContract: sourceRegistry => factory(taxonomy, sourceRegistry, identity) } : {};
    return Object.freeze({ SCHEDULE_KINDS, PRECISIONS, isoDate, time, validateSourceRecord, toTypedJgbRecord, ...isolatedFactory });
});
