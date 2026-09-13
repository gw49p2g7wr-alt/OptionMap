"use strict";
const test = require("node:test"); const assert = require("node:assert/strict");
const Collector = require("../js/morningV5ShadowCollector.js");
const Runtime = require("../js/morningV5ShadowRuntime.js");
function sources() { const generation = 1; return { qri: { status: "available", publicationGeneration: generation,
    requestId: "r1", fact: { identityVerified: true, contract: "2026-10", tradingDate: "2026-09-14",
        canonicalVersionKey: "qri:v1", referenceOnly: false, usingFallback: false } },
weekly: { status: "available", publicationGeneration: generation, requestId: "r1", fact: {
    currentVersionKey: "weekly:v1" } }, overall: { status: "available", publicationGeneration: generation,
    requestId: "r1", envelope: { formalApplied: true, referenceOnly: false, identityVerified: true,
        logicVersion: "overall-v2", inputFingerprint: "overall:v1", optionSourceIdentity: {
            canonicalVersionKey: "qri:v1" }, weeklySourceIdentity: { currentVersionKey: "weekly:v1" },
        result: { direction: 0.4, directionLabel: "bullish", confidence: 0.8 } } },
reference: { status: "unavailable", publicationGeneration: generation, requestId: "r1",
    fact: null, mapping: null } }; }
test("collector publishes formal shadow even when reference is unavailable", async () => {
    const value = sources(); const collector = Collector.createCollector({ getQri: () => value.qri,
        getWeekly: () => value.weekly, getOverall: () => value.overall,
        getReference: () => value.reference, isRefreshInProgress: () => false });
    const result = await collector.collect(); assert.equal(result.status, "ready");
    assert.equal(result.diagnostics.referenceReady, false);
});
test("runtime keeps v5 shadow outside UI and storage", async () => {
    const runtime = Runtime.createRuntime({ collect: async () => ({ status: "ready", marker: "shadow" }) });
    await runtime.publish(); assert.equal(runtime.getState().shadow.marker, "shadow");
    runtime.invalidate("new_market_refresh"); assert.equal(runtime.getState().shadow, null);
});
