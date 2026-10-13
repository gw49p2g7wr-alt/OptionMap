(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketEventTaxonomy = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const CATEGORY = Object.freeze({ CENTRAL_BANK: "central_bank", INFLATION: "inflation",
        GROWTH: "growth", LABOR: "labor", SURVEY: "survey", DERIVATIVES: "derivatives",
        MARKET_SESSION: "market_session", FIXED_INCOME: "fixed_income" });
    const EVENT_TYPES = Object.freeze({
        BOJ_MPM: { category: CATEGORY.CENTRAL_BANK, jurisdiction: "JP" },
        BOJ_POLICY_DECISION: { category: CATEGORY.CENTRAL_BANK, jurisdiction: "JP" },
        BOJ_GOVERNOR_PRESS_CONFERENCE: { category: CATEGORY.CENTRAL_BANK, jurisdiction: "JP" },
        BOJ_SPEECH: { category: CATEGORY.CENTRAL_BANK, jurisdiction: "JP" },
        BOJ_SUMMARY_OF_OPINIONS: { category: CATEGORY.CENTRAL_BANK, jurisdiction: "JP" },
        BOJ_OUTLOOK_REPORT: { category: CATEGORY.CENTRAL_BANK, jurisdiction: "JP" },
        BOJ_MPM_MINUTES: { category: CATEGORY.CENTRAL_BANK, jurisdiction: "JP" },
        JP_CGPI: { category: CATEGORY.INFLATION, jurisdiction: "JP" },
        JP_NATIONAL_CPI: { category: CATEGORY.INFLATION, jurisdiction: "JP" },
        JP_TOKYO_CPI: { category: CATEGORY.INFLATION, jurisdiction: "JP" },
        JP_GDP: { category: CATEGORY.GROWTH, jurisdiction: "JP" },
        JP_LABOR_FORCE: { category: CATEGORY.LABOR, jurisdiction: "JP" },
        JP_INDUSTRIAL_PRODUCTION: { category: CATEGORY.GROWTH, jurisdiction: "JP" },
        JP_MACHINERY_ORDERS: { category: CATEGORY.GROWTH, jurisdiction: "JP" },
        JP_JGB_AUCTION: { category: CATEGORY.FIXED_INCOME, jurisdiction: "JP" },
        JP_TANKAN: { category: CATEGORY.SURVEY, jurisdiction: "JP" },
        US_CPI: { category: CATEGORY.INFLATION, jurisdiction: "US" },
        US_PPI: { category: CATEGORY.INFLATION, jurisdiction: "US" },
        US_EMPLOYMENT_SITUATION: { category: CATEGORY.LABOR, jurisdiction: "US" },
        US_FOMC_MEETING: { category: CATEGORY.CENTRAL_BANK, jurisdiction: "US" },
        US_FOMC_POLICY_DECISION: { category: CATEGORY.CENTRAL_BANK, jurisdiction: "US" },
        US_FED_CHAIR_PRESS_CONFERENCE: { category: CATEGORY.CENTRAL_BANK, jurisdiction: "US" },
        US_PCE: { category: CATEGORY.INFLATION, jurisdiction: "US" },
        US_GDP: { category: CATEGORY.GROWTH, jurisdiction: "US" },
        US_ISM_MANUFACTURING: { category: CATEGORY.SURVEY, jurisdiction: "US" },
        US_ISM_SERVICES: { category: CATEGORY.SURVEY, jurisdiction: "US" },
        US_RETAIL_SALES: { category: CATEGORY.GROWTH, jurisdiction: "US" },
        US_JOLTS: { category: CATEGORY.LABOR, jurisdiction: "US" },
        JPX_NIKKEI225_SQ: { category: CATEGORY.DERIVATIVES, jurisdiction: "JP" },
        JPX_NIKKEI225_MAJOR_SQ: { category: CATEGORY.DERIVATIVES, jurisdiction: "JP" },
        JPX_NIKKEI225_LAST_TRADING_DAY: { category: CATEGORY.DERIVATIVES, jurisdiction: "JP" },
        JPX_MARKET_HOLIDAY: { category: CATEGORY.MARKET_SESSION, jurisdiction: "JP" },
        US_NYSE_MARKET_HOLIDAY: { category: CATEGORY.MARKET_SESSION, jurisdiction: "US" },
        US_NYSE_EARLY_CLOSE: { category: CATEGORY.MARKET_SESSION, jurisdiction: "US" }
    });
    const isEventType = value => Object.hasOwn(EVENT_TYPES, value);
    return Object.freeze({ CATEGORY, EVENT_TYPES, isEventType });
});
