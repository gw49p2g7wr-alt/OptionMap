(function (root, factory) { const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const factApi = commonJs ? require("./morningV5ReferencePriceFact.js") : root?.OptionMapMorningV5ReferencePriceFact;
    const mappingApi = commonJs ? require("./morningV5CrossContractMapping.js") : root?.OptionMapMorningV5CrossContractMapping;
    const api = factory(factApi, mappingApi); if (commonJs) module.exports = api;
    if (root) root.OptionMapMorningV5ReferencePriceLane = api;
})(typeof window !== "undefined" ? window : globalThis, function (factApi, mappingApi) {
    "use strict"; const LANE_VERSION = 1;
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    function unavailable(reason) { return freeze({ laneVersion: LANE_VERSION, available: false,
        status: "unavailable", reason, referenceOnly: true, overallEligible: false }); }
    async function buildMorningV5ReferencePriceLane(input = {}) {
        const fact = input.fact, mapping = input.mapping;
        if (!await factApi?.validateMorningV5ReferencePriceFact?.(fact) ||
            !await mappingApi?.validateMorningV5CrossContractMapping?.(mapping, fact))
            return unavailable("reference_identity_invalid");
        return freeze({ laneVersion: LANE_VERSION, available: true, status: "available", reason: null,
            referenceOnly: true, overallEligible: false, value: fact.value, optionContract: fact.optionContract,
            referenceContract: fact.contract, formalTradingDate: fact.formalTradingDate,
            quoteDate: fact.quoteDate, quotedAtNormalized: fact.quotedAtNormalized,
            mappingClass: mapping.mappingClass, mappingId: mapping.mappingId,
            referenceVersionKey: fact.versionKey });
    }
    function compareMorningV5ReferencePriceLanes(baseline, current) {
        if (baseline?.available !== true || current?.available !== true)
            return freeze({ available: false, reason: "reference_lane_unavailable" });
        if (baseline.mappingId !== current.mappingId || baseline.optionContract !== current.optionContract ||
            baseline.referenceContract !== current.referenceContract ||
            baseline.formalTradingDate !== current.formalTradingDate)
            return freeze({ available: false, reason: "reference_mapping_changed" });
        const delta = current.value - baseline.value;
        return freeze({ available: true, reason: null, baselineValue: baseline.value,
            currentValue: current.value, delta, deltaRate: delta / baseline.value });
    }
    return freeze({ LANE_VERSION, buildMorningV5ReferencePriceLane,
        compareMorningV5ReferencePriceLanes });
});
