(function (root, factory) {
    const taxonomy = typeof module === "object" && module.exports && !(root && root.document)
        ? require("./eventTaxonomy.js") : root?.OptionMapMarketEventTaxonomy;
    const api = factory(taxonomy);
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketEventAuthorityPolicy = api;
})(typeof window !== "undefined" ? window : globalThis, function (taxonomy) {
    "use strict";
    const POLICY_VERSION = 1;
    const FORMAL_SOURCE_BY_EVENT_TYPE = Object.freeze({
        BOJ_MPM: "jp-boj-calendar", BOJ_POLICY_DECISION: "jp-boj-calendar",
        BOJ_GOVERNOR_PRESS_CONFERENCE: "jp-boj-calendar", JP_TANKAN: "jp-boj-calendar",
        JP_NATIONAL_CPI: "jp-stat-cpi", JP_TOKYO_CPI: "jp-stat-cpi",
        JP_LABOR_FORCE: "jp-stat-labor", JP_GDP: "jp-esri-calendar",
        JP_MACHINERY_ORDERS: "jp-esri-calendar", JP_INDUSTRIAL_PRODUCTION: "jp-meti-calendar",
        US_FOMC_MEETING: "us-fed-fomc-calendar", US_FOMC_POLICY_DECISION: "us-fed-fomc-calendar",
        US_FED_CHAIR_PRESS_CONFERENCE: "us-fed-fomc-calendar",
        US_CPI: "us-bls-calendar", US_PPI: "us-bls-calendar",
        US_EMPLOYMENT_SITUATION: "us-bls-calendar", US_JOLTS: "us-bls-calendar",
        US_PCE: "us-bea-calendar", US_GDP: "us-bea-calendar",
        US_ISM_MANUFACTURING: "us-ism-calendar", US_ISM_SERVICES: "us-ism-calendar",
        US_RETAIL_SALES: "us-census-calendar",
        JPX_NIKKEI225_SQ: "jp-jpx-derivatives-calendar",
        JPX_NIKKEI225_MAJOR_SQ: "jp-jpx-derivatives-calendar",
        JPX_NIKKEI225_LAST_TRADING_DAY: "jp-jpx-derivatives-calendar",
        JPX_MARKET_HOLIDAY: "jp-jpx-market-holidays",
        US_NYSE_MARKET_HOLIDAY: "us-nyse-market-holidays"
    });
    function evaluateFormalEligibility(record, source) {
        if (!record || !taxonomy?.isEventType(record.eventType)) return { eligible: false,
            reason: "event_type_unregistered" };
        if (!source || source.sourceId !== record.sourceId) return { eligible: false,
            reason: "source_unregistered" };
        if (source.authorityLevel !== "primary" || source.formalEligible !== true)
            return { eligible: false, reason: "source_not_primary" };
        return FORMAL_SOURCE_BY_EVENT_TYPE[record.eventType] === source.sourceId
            ? { eligible: true, reason: null }
            : { eligible: false, reason: "source_not_authoritative_for_event_type" };
    }
    return Object.freeze({ POLICY_VERSION, FALLBACK_MODE: "none", FORMAL_SOURCE_BY_EVENT_TYPE,
        evaluateFormalEligibility });
});
