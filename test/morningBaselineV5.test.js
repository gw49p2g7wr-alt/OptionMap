"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const Fact = require("../js/morningV5ReferencePriceFact.js");
const Mapping = require("../js/morningV5CrossContractMapping.js");
const V5 = require("../js/morningBaselineV5.js");
async function input(withPrice = true) { const fact = await Fact.buildMorningV5ReferencePriceFact({
    referencePrice: { available: true, price: 43210, contract: "26年12月限", quotedAt: "09/14 15:15" },
    optionContract: "2026-10", formalTradingDate: "2026-09-14",
    pageUpdatedAt: "2026-09-14T15:20:00+09:00", sourceUrl: "https://svc.qri.jp/jpx/nkopm/",
    requestId: "r1", fetchedAt: "2026-09-14T06:21:00.000Z", isCurrentRequest: true });
const mapping = await Mapping.buildMorningV5CrossContractMapping(fact);
return { capturedAt: "2026-09-14T06:30:00.000Z",
    formalScope: { formalScopeId: "formal:2026-10:2026-09-14", optionContract: "2026-10",
        formalTradingDate: "2026-09-14" }, formalSupplyDemand: { available: true,
        referenceOnly: false, formalScopeId: "formal:2026-10:2026-09-14",
        optionContract: "2026-10", formalTradingDate: "2026-09-14", sourceFingerprint: "formal:abc" },
    referencePrice: withPrice ? { fact, mapping } : null, dataQuality: { formal: "verified" } }; }
test("v5 schema signs independently comparable formal and reference lanes", async () => {
    const built = await V5.buildMorningBaselineV5(await input());
    assert.equal(built.success, true); assert.equal(await V5.validateMorningBaselineV5(built.baseline), true);
    assert.deepEqual(built.baseline.comparability,
        { supplyDemandEligible: true, priceEligible: true, divergenceEligible: true });
});
test("reference lane may be absent without weakening formal supply authority", async () => {
    const built = await V5.buildMorningBaselineV5(await input(false));
    assert.equal(built.success, true); assert.equal(built.baseline.comparability.supplyDemandEligible, true);
    assert.equal(built.baseline.comparability.priceEligible, false);
});
test("signature is deterministic and rejects tampering or v4 input", async () => {
    const source = await input(); const a = (await V5.buildMorningBaselineV5(source)).baseline;
    const b = (await V5.buildMorningBaselineV5(source)).baseline;
    assert.equal(a.signature, b.signature);
    assert.equal(await V5.validateMorningBaselineV5({ ...a, formalScope: { ...a.formalScope,
        optionContract: "2026-12" } }), false);
    assert.equal(await V5.validateMorningBaselineV5({ ...a, baselineVersion: 4 }), false);
});
