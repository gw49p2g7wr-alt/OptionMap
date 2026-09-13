"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const Lane = require("../js/morningV5SupplyDemandLane.js");
function facts(direction = 0.4) { const qri = { available: true, origin: "formal_live",
    referenceOnly: false, usingFallback: false, restored: false, identity: { verified: true,
        contract: "2026-10", tradingDate: "2026-09-14", canonicalVersionKey: "qri:v1" } };
const weekly = { available: true, origin: "formal_history", formalApplied: true,
    usingFallback: false, identityVerified: true, versionKey: "weekly:v1" };
const overall = { origin: "formal_live", formalApplied: true, referenceOnly: false,
    superseded: false, logicVersion: "overall-v2", inputIdentity: { verified: true,
        versionKey: `overall:${direction}` }, componentIdentities: { option: { versionKey: "qri:v1" },
        weekly: { versionKey: "weekly:v1" } }, result: { direction, directionLabel: "bullish",
        confidence: 0.8 } }; return { qri, weekly, overall }; }
test("formal lane binds QRI weekly and Overall without a price input", async () => {
    const lane = await Lane.buildMorningV5SupplyDemandLane(facts());
    assert.equal(lane.available, true); assert.equal(lane.referenceOnly, false);
    assert.equal(lane.formalScopeId, "morning-v5-formal|2026-10|2026-09-14");
});
test("reference or fallback authority cannot enter the formal lane", async () => {
    const reference = facts(); reference.qri.referenceOnly = true;
    assert.equal((await Lane.buildMorningV5SupplyDemandLane(reference)).available, false);
    const mismatch = facts(); mismatch.overall.componentIdentities.option.versionKey = "other";
    assert.equal((await Lane.buildMorningV5SupplyDemandLane(mismatch)).reason, "overall_binding_invalid");
});
test("comparison requires the same formal scope and logic", async () => {
    const baseline = await Lane.buildMorningV5SupplyDemandLane(facts(0.2));
    const current = await Lane.buildMorningV5SupplyDemandLane(facts(0.6));
    assert.equal(Lane.compareMorningV5SupplyDemandLanes(baseline, current).directionDelta,
        0.39999999999999997);
    assert.equal(Lane.compareMorningV5SupplyDemandLanes(baseline,
        { ...current, optionContract: "2026-12" }).available, false);
});
