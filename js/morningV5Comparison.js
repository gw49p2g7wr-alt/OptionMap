(function (root, factory) { const commonJs = typeof module === "object" && module.exports && !(root && root.document);
    const supplyApi = commonJs ? require("./morningV5SupplyDemandLane.js") : root?.OptionMapMorningV5SupplyDemandLane;
    const priceApi = commonJs ? require("./morningV5ReferencePriceLane.js") : root?.OptionMapMorningV5ReferencePriceLane;
    const api = factory(supplyApi, priceApi); if (commonJs) module.exports = api;
    if (root) root.OptionMapMorningV5Comparison = api;
})(typeof window !== "undefined" ? window : globalThis, function (supplyApi, priceApi) {
    "use strict"; const COMPARISON_VERSION = 1;
    function freeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
        Object.values(value).forEach(freeze); return Object.freeze(value); }
    const sign = value => value > 0 ? 1 : value < 0 ? -1 : 0;
    function compareMorningV5(input = {}) {
        const supplyDemand = supplyApi?.compareMorningV5SupplyDemandLanes?.(
            input.baselineSupplyDemand, input.currentSupplyDemand) ||
            { available: false, reason: "supply_lane_unavailable" };
        const price = priceApi?.compareMorningV5ReferencePriceLanes?.(
            input.baselineReferencePrice, input.currentReferencePrice) ||
            { available: false, reason: "reference_lane_unavailable" };
        let divergence = { available: false, reason: !supplyDemand.available ?
            "supply_lane_unavailable" : !price.available ? "price_lane_unavailable" : "unavailable" };
        if (supplyDemand.available && price.available) {
            const supplyDirection = sign(supplyDemand.directionDelta), priceDirection = sign(price.delta);
            divergence = { available: true, reason: null, supplyDirection, priceDirection,
                relation: supplyDirection === 0 || priceDirection === 0 ? "neutral" :
                    supplyDirection === priceDirection ? "aligned" : "divergent" };
        }
        return freeze({ comparisonVersion: COMPARISON_VERSION, supplyDemand, price, divergence,
            dataQuality: { formalComparable: supplyDemand.available,
                referenceComparable: price.available, divergenceComparable: divergence.available } });
    }
    return freeze({ COMPARISON_VERSION, compareMorningV5 });
});
