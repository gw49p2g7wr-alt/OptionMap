"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const Runtime = require("../js/morningV5ReferencePriceRuntime.js");
const input = () => ({ referencePrice: { available: true, price: 43210,
    contract: "26年12月限", quotedAt: "09/14 15:15" }, optionContract: "2026-10",
formalTradingDate: "2026-09-14", pageUpdatedAt: "2026-09-14T15:20:00+09:00",
sourceUrl: "https://svc.qri.jp/jpx/nkopm/", requestId: "r1",
fetchedAt: "2026-09-14T06:21:00.000Z" });
test("publishes verified cross-contract fact and mapping in shadow", async () => {
    const runtime = Runtime.createRuntime({ now: () => "2026-09-14T06:22:00.000Z" });
    assert.equal((await runtime.publish(input(), { isCurrentRequest: () => true })).published, true);
    const state = runtime.getState(); assert.equal(state.status, "available");
    assert.equal(state.mapping.mappingClass, "explicit_cross_contract_reference");
});
test("stale and invalid publications never replace current state", async () => {
    const runtime = Runtime.createRuntime(); await runtime.publish(input(), { isCurrentRequest: () => true });
    const before = runtime.getState(); const stale = await runtime.publish({ ...input(), requestId: "r2" },
        { isCurrentRequest: () => false });
    assert.equal(stale.published, false); assert.deepEqual(runtime.getState(), before);
});
test("invalidation removes reference evidence", async () => {
    const runtime = Runtime.createRuntime(); await runtime.publish(input(), { isCurrentRequest: () => true });
    runtime.invalidate("new_market_refresh"); assert.equal(runtime.getState().fact, null);
});
