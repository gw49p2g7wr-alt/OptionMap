"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const Fact = require("../js/morningV5ReferencePriceFact.js");
const Mapping = require("../js/morningV5CrossContractMapping.js");
const Lane = require("../js/morningV5ReferencePriceLane.js");
async function bundle(price = 43000, referenceContract = "26年12月限") { const fact =
    await Fact.buildMorningV5ReferencePriceFact({ referencePrice: { available: true, price,
        contract: referenceContract, quotedAt: "09/14 15:15" }, optionContract: "2026-10",
        formalTradingDate: "2026-09-14", pageUpdatedAt: "2026-09-14T15:20:00+09:00",
        sourceUrl: "https://svc.qri.jp/jpx/nkopm/", requestId: "r1",
        fetchedAt: "2026-09-14T06:21:00.000Z", isCurrentRequest: true });
return { fact, mapping: await Mapping.buildMorningV5CrossContractMapping(fact) }; }
test("reference lane remains reference-only and Overall-ineligible", async () => {
    const lane = await Lane.buildMorningV5ReferencePriceLane(await bundle());
    assert.deepEqual([lane.available, lane.referenceOnly, lane.overallEligible], [true, true, false]);
});
test("price comparison requires the identical mapping identity", async () => {
    const baseline = await Lane.buildMorningV5ReferencePriceLane(await bundle(43000));
    const current = await Lane.buildMorningV5ReferencePriceLane(await bundle(43430));
    assert.deepEqual(Lane.compareMorningV5ReferencePriceLanes(baseline, current), {
        available: true, reason: null, baselineValue: 43000, currentValue: 43430,
        delta: 430, deltaRate: 0.01 });
    const changed = await Lane.buildMorningV5ReferencePriceLane(await bundle(43430, "27年3月限"));
    assert.equal(Lane.compareMorningV5ReferencePriceLanes(baseline, changed).reason,
        "reference_mapping_changed");
});
test("tampered fact and mapping fail closed", async () => {
    const source = await bundle(); source.mapping = { ...source.mapping, optionContract: "2026-12" };
    assert.equal((await Lane.buildMorningV5ReferencePriceLane(source)).available, false);
});
