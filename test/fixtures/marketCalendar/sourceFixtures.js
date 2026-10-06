"use strict";
const Registry = require("../../../js/marketCalendar/sourceRegistry.js");
const HASH = "a".repeat(64), FETCHED_AT = "2026-09-15T00:00:00.000Z";
const schedule = (kind, startDate, startTime, timeZone, endDate = null) => ({ kind, startDate,
    startTime, endDate, endTime: null, timeZone, precision: kind === "instant" ? "exact"
        : kind === "date_range" ? "range" : kind });
const definitions = {
    "jp-boj-calendar": ["BOJ_POLICY_DECISION", "2026-09-meeting", "national", "date_only", "2026-09-18", null],
    "jp-stat-cpi": ["JP_NATIONAL_CPI", "2026-08", "national", "instant", "2026-09-18", "08:30"],
    "jp-stat-labor": ["JP_LABOR_FORCE", "2026-08", "national", "instant", "2026-10-02", "08:30"],
    "jp-esri-machinery-orders-calendar": ["JP_MACHINERY_ORDERS", "2026-07", "national", "instant", "2026-09-16", "08:50"],
    "jp-esri-sna-calendar": ["JP_GDP", "2026-Q3", "national", "instant", "2026-11-16", "08:50"],
    "us-fed-fomc-calendar": ["US_FOMC_POLICY_DECISION", "2026-09-meeting", "federal", "instant", "2026-09-16", "14:00"],
    "us-bls-calendar": ["US_CPI", "2026-08", "national", "instant", "2026-09-11", "08:30"],
    "us-bea-calendar": ["US_PCE", "2026-08", "national", "instant", "2026-09-30", "08:30"],
    "us-census-calendar": ["US_RETAIL_SALES", "2026-08", "national", "instant", "2026-09-16", "08:30"],
    "jp-jpx-derivatives-calendar": ["JPX_NIKKEI225_MAJOR_SQ", "2026-09", "OSE", "all_day", "2026-09-11", null],
    "jp-jpx-market-holidays": ["JPX_MARKET_HOLIDAY", "2026-09-22", "JPX", "all_day", "2026-09-22", null],
    "us-nyse-market-holidays": ["US_NYSE_MARKET_HOLIDAY", "2026-09-07", "NYSE_CASH", "all_day", "2026-09-07", null]
};
function record(sourceId, overrides = {}) {
    const source = Registry.getSource(sourceId), definition = definitions[sourceId];
    return { sourceTitle: definition[0], eventType: definition[0], referencePeriod: definition[1],
        edition: "initial", scope: definition[2], authorityEventId: null,
        sourceLocalSchedule: schedule(definition[3], definition[4], definition[5], source.sourceTimeZone),
        sourceStatus: "scheduled", sourcePublishedAt: null, sourceUpdatedAt: null,
        sourceUrl: source.canonicalUrl, titleJa: definition[0], titleEn: definition[0], ...overrides };
}
function document(sourceId, overrides = {}) { const source = Registry.getSource(sourceId); return {
    sourceId, parserId: source.parserId, parserVersion: source.parserVersion,
    fetchedAt: FETCHED_AT, rawContentHash: HASH, records: [record(sourceId)], ...overrides }; }
const allSources = Registry.HISTORICAL_SOURCE_ORDER.map(document);
const variants = Object.freeze({
    dstSummer: document("us-bls-calendar"),
    dstWinter: document("us-bls-calendar", { records: [record("us-bls-calendar", {
        referencePeriod: "2026-11", sourceLocalSchedule: schedule("instant", "2026-12-10", "08:30",
            "America/New_York") })] }),
    timeUndecided: document("jp-boj-calendar"),
    allDay: document("jp-jpx-market-holidays"),
    dateRange: document("jp-boj-calendar", { records: [record("jp-boj-calendar", { eventType: "BOJ_MPM",
        referencePeriod: "2026-09-meeting", sourceTitle: "BOJ MPM",
        sourceLocalSchedule: schedule("date_range", "2026-09-17", null, "Asia/Tokyo", "2026-09-18") })] }),
    rescheduled: document("us-bea-calendar", { records: [record("us-bea-calendar", {
        sourceLocalSchedule: schedule("instant", "2026-10-01", "08:30", "America/New_York"),
        changeReason: "official_reschedule" })] }),
    malformed: document("us-bls-calendar", { records: [record("us-bls-calendar", {
        sourceLocalSchedule: schedule("instant", "2026-02-30", "25:90", "America/New_York") })] })
});
module.exports = Object.freeze({ HASH, FETCHED_AT, schedule, record, document,
    allSources: Object.freeze(allSources), variants });
