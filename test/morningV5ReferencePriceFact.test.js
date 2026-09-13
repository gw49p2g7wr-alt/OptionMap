"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const Fact = require("../js/morningV5ReferencePriceFact.js");
const input = () => ({ referencePrice: { available: true, price: 43210,
    contract: "26年12月限", quotedAt: "09/14 15:15" }, optionContract: "2026-10",
formalTradingDate: "2026-09-14", pageUpdatedAt: "2026-09-14T15:20:00+09:00",
sourceUrl: "https://svc.qri.jp/jpx/nkopm/", requestId: "request-1",
fetchedAt: "2026-09-14T06:21:00.000Z", isCurrentRequest: true });
test("cross-contract reference is verified but never Overall eligible", async () => {
    const result = await Fact.buildMorningV5ReferencePriceFact(input());
    assert.deepEqual([result.available, result.optionContract, result.contract],
        [true, "2026-10", "2026-12"]);
    assert.deepEqual([result.referenceOnly, result.overallEligible], [true, false]);
    assert.equal(await Fact.validateMorningV5ReferencePriceFact(result), true);
});
test("identity is deterministic and changes with the reference contract", async () => {
    const first = await Fact.buildMorningV5ReferencePriceFact(input());
    const second = await Fact.buildMorningV5ReferencePriceFact(input());
    const changed = input(); changed.referencePrice.contract = "27年3月限";
    const third = await Fact.buildMorningV5ReferencePriceFact(changed);
    assert.equal(first.versionKey, second.versionKey); assert.notEqual(first.versionKey, third.versionKey);
});
test("invalid stale and unverifiable input fail closed", async () => {
    for (const mutate of [x => { x.referencePrice.price = 0; }, x => { x.optionContract = null; },
        x => { x.sourceUrl = null; }, x => { x.isCurrentRequest = false; }]) {
        const value = input(); mutate(value);
        assert.equal((await Fact.buildMorningV5ReferencePriceFact(value)).available, false);
    }
});
test("builder is non-mutating and output is deeply frozen", async () => {
    const value = input(); const before = structuredClone(value);
    const result = await Fact.buildMorningV5ReferencePriceFact(value);
    assert.deepEqual(value, before); assert.equal(Object.isFrozen(result.acquisitionIdentity), true);
});
