"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const Fact = require("../js/morningV5ReferencePriceFact.js");
const Mapping = require("../js/morningV5CrossContractMapping.js");
async function fact(overrides = {}) { const { referencePrice, ...rest } = overrides;
return Fact.buildMorningV5ReferencePriceFact({
    referencePrice: { available: true, price: 43210, contract: "26年12月限",
        quotedAt: "09/14 15:15", ...referencePrice }, optionContract: "2026-10",
    formalTradingDate: "2026-09-14", pageUpdatedAt: "2026-09-14T15:20:00+09:00",
    sourceUrl: "https://svc.qri.jp/jpx/nkopm/", requestId: "request-1",
    fetchedAt: "2026-09-14T06:21:00.000Z", isCurrentRequest: true, ...rest }); }
test("builds an explicit immutable cross-contract mapping", async () => {
    const source = await fact(); const result = await Mapping.buildMorningV5CrossContractMapping(source);
    assert.deepEqual([result.mappingClass, result.optionContract, result.referenceContract],
        ["explicit_cross_contract_reference", "2026-10", "2026-12"]);
    assert.equal(await Mapping.validateMorningV5CrossContractMapping(result, source), true);
    assert.equal(Object.isFrozen(result), true);
});
test("mapping identity is deterministic and binds every relevant identity", async () => {
    const firstFact = await fact(); const first = await Mapping.buildMorningV5CrossContractMapping(firstFact);
    const duplicate = await Mapping.buildMorningV5CrossContractMapping(firstFact);
    const changedFact = await fact({ referencePrice: { contract: "27年3月限" } });
    const changed = await Mapping.buildMorningV5CrossContractMapping(changedFact);
    assert.equal(first.mappingId, duplicate.mappingId); assert.notEqual(first.mappingId, changed.mappingId);
});
test("mapping identity remains stable across price observations", async () => {
    const firstFact = await fact(); const nextFact = await fact({ referencePrice: { price: 43500 } });
    const first = await Mapping.buildMorningV5CrossContractMapping(firstFact);
    const next = await Mapping.buildMorningV5CrossContractMapping(nextFact);
    assert.notEqual(first.referenceVersionKey, next.referenceVersionKey);
    assert.equal(first.mappingId, next.mappingId);
});
test("same-contract is explicit and cross-date evidence remains explicit", async () => {
    const same = await fact({ optionContract: "2026-12" });
    assert.equal((await Mapping.buildMorningV5CrossContractMapping(same)).mappingClass,
        "same_contract_reference");
    const crossDate = await fact({ formalTradingDate: "2026-09-13" });
    const mapped = await Mapping.buildMorningV5CrossContractMapping(crossDate);
    assert.equal(mapped.formalTradingDate, "2026-09-13");
    assert.equal(mapped.quoteDate, "2026-09-14");
    assert.equal(await Mapping.buildMorningV5CrossContractMapping({}), null);
});
test("tampered mapping is rejected", async () => {
    const source = await fact(); const built = await Mapping.buildMorningV5CrossContractMapping(source);
    assert.equal(await Mapping.validateMorningV5CrossContractMapping({ ...built,
        referenceContract: "2027-03" }, source), false);
});
