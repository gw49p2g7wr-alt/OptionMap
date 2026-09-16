(function (root, factory) {
    const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const planCanonicalizer = commonJs ? require("./planCanonicalizer.js") :
        root?.OptionMapMarketCalendarPlanCanonicalizer;
    const schedule = commonJs ? require("../marketCalendar/marketEventSchedule.js") :
        root?.OptionMapMarketEventSchedule;
    const api = factory(planCanonicalizer, schedule);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketCalendarStorageRecordMapper = api;
})(typeof window !== "undefined" ? window : globalThis, function (planCanonicalizer, schedule) {
    "use strict";
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const runKey = value => `${value.sourceId}|${value.runId}`;
    const observationKey = value => `${value.eventKey}|${value.acceptedAt}|${value.runId}`;
    function revision(value, sourceId) { const result = clone(value), interval =
        schedule.calendarDateIntervalFor(result.schedule, "Asia/Tokyo");
        result.sourceId = sourceId; result.calendarDateStart = interval.start;
        result.calendarDateEnd = interval.end; return result; }
    function mapPlan(plan) { return Object.freeze(planCanonicalizer.canonicalizePlan({
        ...clone(plan), appendRuns: plan.appendRuns.map(value => ({ ...clone(value), runKey: runKey(value) })),
        appendRevisions: plan.appendRevisions.map(value => revision(value, plan.sourceId)),
        appendObservations: plan.appendObservations.map(value => ({ ...clone(value),
            observationKey: observationKey(value) })), updateCursors: plan.updateCursors.map(value => ({
            ...clone(value), runKey: runKey({ sourceId: value.sourceId, runId: value.runId }) })) })); }
    return Object.freeze({ runKey, observationKey, revision, mapPlan });
});
