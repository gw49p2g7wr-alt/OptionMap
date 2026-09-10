const test = require("node:test");
const assert = require("node:assert/strict");
const Targeted = require("../js/morningBaselineV4TargetedRefresh.js");

test("deficiency classification identifies source and coherent-session deficiencies", () => {
    assert.deepEqual(Targeted.classifyDeficiency("current_price_identity_missing").sources, ["qri"]);
    assert.deepEqual(Targeted.classifyDeficiency("qri_not_formal").sources, ["qri"]);
    assert.deepEqual(Targeted.classifyDeficiency("weekly_identity_missing").sources, ["weekly"]);
    assert.deepEqual(Targeted.classifyDeficiency("session_unverified").sources, ["qri", "weekly"]);
    assert.deepEqual(Targeted.classifyDeficiency("overall_input_mismatch").sources, ["overall"]);
    assert.equal(Targeted.classifyDeficiency("unknown_reason").classified, false);
});
test("QRI deficiency without a reusable weekly identity refreshes the coherent pair", async () => {
    const calls = []; const coordinator = Targeted.createCoordinator({
        refreshQri: async () => calls.push("qri"), refreshWeekly: async () => calls.push("weekly"),
        publishOverall: async () => calls.push("overall"), evaluateRestore: async () => calls.push("restore") });
    const result = await coordinator.run({ reason: "qri_revision_identity_missing", requestId: "r1" });
    assert.deepEqual(calls, ["qri", "weekly", "overall", "restore"]);
    assert.deepEqual(result.targetedSources, ["qri", "weekly", "overallV2"]);
    assert.equal(result.fullRefreshTriggered, false);
});
test("available Formal peer identity avoids unnecessary network and preserves binding", async () => {
    const calls = []; const requestIds = []; const coordinator = Targeted.createCoordinator({
        getFormalRequestIds: () => ({ qri: "shared-qri", weekly: "shared-weekly" }),
        refreshQri: async input => { calls.push("qri"); requestIds.push(input.requestId); },
        refreshWeekly: async input => { calls.push("weekly"); requestIds.push(input.requestId); },
        publishOverall: async () => calls.push("overall"), evaluateRestore: async () => calls.push("restore") });
    await coordinator.run({ reason: "qri_not_formal", requestId: "new" });
    assert.deepEqual(calls, ["qri", "overall", "restore"]);
    assert.deepEqual(requestIds, ["shared-weekly"]); calls.length = 0; requestIds.length = 0;
    await coordinator.run({ reason: "weekly_ineligible", requestId: "new" });
    assert.deepEqual(calls, ["weekly", "overall", "restore"]);
    assert.deepEqual(requestIds, ["shared-qri"]);
});
test("weekly and Overall deficiencies never invoke participant reference or IV paths", async () => {
    const calls = []; const coordinator = Targeted.createCoordinator({
        refreshQri: async () => calls.push("qri"), refreshWeekly: async () => calls.push("weekly"),
        publishOverall: async () => calls.push("overall"), evaluateRestore: async () => calls.push("restore") });
    await coordinator.run({ reason: "weekly_ineligible", requestId: "r2" });
    assert.deepEqual(calls, ["qri", "weekly", "overall", "restore"]); calls.length = 0;
    await coordinator.run({ reason: "overall_ineligible", requestId: "r3" });
    assert.deepEqual(calls, ["overall", "restore"]);
});
test("unknown deficiency waits without full refresh fallback", async () => {
    let called = false; const coordinator = Targeted.createCoordinator({
        refreshQri: async () => { called = true; }, publishOverall: async () => { called = true; } });
    const result = await coordinator.run({ reason: "unclassified" });
    assert.deepEqual([result.status, result.fullRefreshTriggered, called], ["waiting", false, false]);
});
test("user refresh has priority before and during targeted work", async () => {
    let active = true; const coordinator = Targeted.createCoordinator({ isUserRefreshActive: () => active,
        refreshQri: async () => {}, publishOverall: async () => {} });
    assert.equal((await coordinator.run({ reason: "qri_ineligible" })).status, "stale");
    active = false; const during = Targeted.createCoordinator({ isUserRefreshActive: () => active,
        refreshQri: async () => { active = true; }, publishOverall: async () => {
            throw new Error("must not publish"); } });
    assert.equal((await during.run({ reason: "qri_ineligible" })).status, "stale");
});
