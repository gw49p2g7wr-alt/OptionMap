(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports && !(root && root.document)) module.exports = api;
    if (root) root.OptionMapMorningBaselineV4TargetedRefresh = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    "use strict";
    const clone = value => value == null ? value : typeof structuredClone === "function"
        ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    const QRI_REASONS = new Set(["current_price_identity_missing", "current_price_manual",
        "current_price_ineligible", "qri_revision_identity_missing", "qri_not_formal",
        "qri_ineligible", "qri_fallback", "qri_saved_or_reference", "contract_mismatch",
        "trading_date_mismatch"]);
    const WEEKLY_REASONS = new Set(["weekly_identity_missing", "weekly_component_mismatch",
        "weekly_ineligible"]);
    const OVERALL_REASONS = new Set(["overall_identity_missing", "overall_input_mismatch",
        "overall_ineligible", "data_quality_missing"]);
    const COHERENT_PAIR_REASONS = new Set(["session_unverified", "mixed_acquisition"]);

    function classifyDeficiency(reason) {
        if (QRI_REASONS.has(reason)) return freeze({ classified: true, sources: ["qri"] });
        if (WEEKLY_REASONS.has(reason)) return freeze({ classified: true, sources: ["weekly"] });
        if (COHERENT_PAIR_REASONS.has(reason)) return freeze({ classified: true,
            sources: ["qri", "weekly"] });
        if (OVERALL_REASONS.has(reason)) return freeze({ classified: true, sources: ["overall"] });
        return freeze({ classified: false, sources: [] });
    }

    function createCoordinator(configuration = {}) {
        const refreshQri = configuration.refreshQri;
        const refreshWeekly = configuration.refreshWeekly;
        const publishOverall = configuration.publishOverall;
        const evaluateRestore = configuration.evaluateRestore;
        const getFormalRequestIds = configuration.getFormalRequestIds || (() => ({}));
        const userRefreshActive = configuration.isUserRefreshActive || (() => false);
        async function run(input = {}, guard = () => true) {
            const classification = classifyDeficiency(input.reason);
            if (!classification.classified) return freeze({ status: "waiting", reason: input.reason ||
                "deficiency_unclassified", targetedSources: [], fullRefreshTriggered: false });
            if (userRefreshActive() || !guard()) return freeze({ status: "stale", reason:
                "user_refresh_priority", targetedSources: [], fullRefreshTriggered: false });
            const peerIds = clone(getFormalRequestIds() || {}); let sources = [...classification.sources];
            let requestId = input.requestId;
            // Reuse the available peer's Formal request identity so refreshing one
            // deficient source keeps the collector coherent without extra network.
            if (sources.length === 1 && sources[0] === "qri" && peerIds.weekly) requestId = peerIds.weekly;
            else if (sources.length === 1 && sources[0] === "weekly" && peerIds.qri)
                requestId = peerIds.qri;
            else if (sources.length === 1 && ["qri", "weekly"].includes(sources[0]))
                sources = ["qri", "weekly"];
            const targetedSources = [];
            try {
                if (sources.includes("qri")) {
                    targetedSources.push("qri"); await refreshQri?.({ requestId });
                }
                if (userRefreshActive() || !guard()) return freeze({ status: "stale", reason:
                    "user_refresh_priority", targetedSources, fullRefreshTriggered: false });
                if (sources.includes("weekly")) {
                    targetedSources.push("weekly"); await refreshWeekly?.({ requestId });
                }
                if (userRefreshActive() || !guard()) return freeze({ status: "stale", reason:
                    "user_refresh_priority", targetedSources, fullRefreshTriggered: false });
                targetedSources.push("overallV2"); await publishOverall?.();
                if (userRefreshActive() || !guard()) return freeze({ status: "stale", reason:
                    "user_refresh_priority", targetedSources, fullRefreshTriggered: false });
                await evaluateRestore?.();
                return freeze({ status: "completed", reason: null,
                    targetedSources, fullRefreshTriggered: false });
            } catch (_error) {
                return freeze({ status: "failed", reason: "targeted_refresh_failed",
                    targetedSources, fullRefreshTriggered: false });
            }
        }
        return Object.freeze({ run });
    }
    return Object.freeze({ classifyDeficiency, createCoordinator });
});
