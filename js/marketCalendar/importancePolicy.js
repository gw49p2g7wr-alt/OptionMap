(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMarketEventImportancePolicy = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const POLICY_VERSION = 1;
    const CRITICAL = new Set(["BOJ_POLICY_DECISION", "BOJ_GOVERNOR_PRESS_CONFERENCE", "JP_NATIONAL_CPI",
        "US_CPI", "US_EMPLOYMENT_SITUATION", "US_FOMC_POLICY_DECISION",
        "US_FED_CHAIR_PRESS_CONFERENCE", "JPX_NIKKEI225_MAJOR_SQ"]);
    const HIGH = new Set(["JP_TOKYO_CPI", "JP_GDP", "JP_TANKAN", "US_PPI", "US_PCE", "US_GDP",
        "US_ISM_MANUFACTURING", "US_ISM_SERVICES", "US_RETAIL_SALES", "US_JOLTS"]);
    function classify(eventType) { return Object.freeze({ policyVersion: POLICY_VERSION, eventType,
        importance: CRITICAL.has(eventType) ? "critical" : HIGH.has(eventType) ? "high" : "medium",
        reasonCode: "initial_beta_policy" }); }
    return Object.freeze({ POLICY_VERSION, classify });
});
