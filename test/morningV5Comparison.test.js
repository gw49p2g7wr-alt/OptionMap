"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const Compare = require("../js/morningV5Comparison.js");
const supply = direction => ({ available: true, formalScopeId: "scope", optionContract: "2026-10",
    formalTradingDate: "2026-09-14", direction, confidence: 0.8,
    identity: { logicVersion: "overall-v2" } });
const price = value => ({ available: true, mappingId: "mapping", optionContract: "2026-10",
    referenceContract: "2026-12", formalTradingDate: "2026-09-14", value });
test("reports aligned and divergent movement without merging authorities", () => {
    const aligned = Compare.compareMorningV5({ baselineSupplyDemand: supply(0.1),
        currentSupplyDemand: supply(0.5), baselineReferencePrice: price(43000),
        currentReferencePrice: price(43400) });
    assert.equal(aligned.divergence.relation, "aligned");
    const divergent = Compare.compareMorningV5({ baselineSupplyDemand: supply(0.1),
        currentSupplyDemand: supply(0.5), baselineReferencePrice: price(43000),
        currentReferencePrice: price(42600) });
    assert.equal(divergent.divergence.relation, "divergent");
});
test("supply remains comparable when reference mapping changes", () => {
    const result = Compare.compareMorningV5({ baselineSupplyDemand: supply(0.1),
        currentSupplyDemand: supply(0.5), baselineReferencePrice: price(43000),
        currentReferencePrice: { ...price(43400), referenceContract: "2027-03" } });
    assert.equal(result.supplyDemand.available, true); assert.equal(result.price.available, false);
    assert.equal(result.divergence.available, false);
});
test("neutral deltas are explicit", () => {
    const result = Compare.compareMorningV5({ baselineSupplyDemand: supply(0.1),
        currentSupplyDemand: supply(0.1), baselineReferencePrice: price(43000),
        currentReferencePrice: price(43400) });
    assert.equal(result.divergence.relation, "neutral");
});
