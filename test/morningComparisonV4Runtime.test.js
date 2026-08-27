const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Baseline = require("../js/morningBaselineV4.js");
const Runtime = require("../js/morningComparisonV4Runtime.js");

const identity = (source, versionKey) => ({ source, versionKey,
    signature: `${source}-${versionKey}`, verified: true });
const component = (name, direction, weight) => ({ name, available: true, invalid: false,
    normalizedDirection: direction, directionScore: direction * 100, baseWeight: weight,
    qualityFactor: 1, effectiveWeight: weight, weightedContribution: direction * weight,
    evidenceFactor: Math.abs(direction), notes: [], metadata: {} });
function builderInput({ capturedAt = "2026-08-28T04:45:00+09:00", score = -37,
    price = 65950, qriVersion = "qri-v1", optionDirection = -0.125,
    weeklyDirection = -0.676350431, logicVersion = "overall-v2-weights-55-45-v1",
    contract = "2026-09", tradingDate = "2026-08-28", scopeId =
        "morning-v4-scope|2026-09|2026-08-28|same_date_explicit" } = {}) {
    const option = component("option", optionDirection, 55);
    const weekly = component("weekly", weeklyDirection, 45);
    return { capturedAt, marketContext: { captureCalendarDate: "2026-08-28",
        formalTradingDate: tradingDate, sessionIdentity: scopeId,
        sessionMappingStatus: "verified" }, overallV2Context: { origin: "formal_live",
        formalApplied: true, superseded: false, logicVersion, evaluatedAt: capturedAt,
        inputIdentity: identity("overall_v2", `overall-${qriVersion}`),
        componentIdentities: { option: identity("qri_formal", qriVersion),
            weekly: identity("weekly_formal", "weekly-v1") }, result: { status: "complete",
            direction: score, directionLabel: score < 0 ? "売り優勢" : "買い優勢",
            confidence: 85, confidenceFactors: { agreement: 72 },
            components: { option, weekly }, metadata: { coverage: 100, warnings: [] } } },
    currentPriceContext: { available: true, sourceKind: "live", origin: "live",
        mode: "automatic", value: price, contract, quoteDate: tradingDate,
        quotedAtNormalized: capturedAt, quoteSignature: `price-${price}`,
        versionKey: `price-${price}`, wrapperSignature: `wrapper-${price}`,
        requestId: "request-1", fetchedAt: capturedAt,
        acquisitionIdentity: { requestId: "request-1", fetchedAt: capturedAt,
            sourceUrl: "https://example.test/price", wrapperSignature: `wrapper-${price}` },
        identityVerified: true, acquisitionVerified: true, currentRequestVerified: true,
        qriTradingDateMapping: { mappingVerified: true, mappingSource: "same_date_explicit",
            qriTradingDate: tradingDate } }, qriContext: { available: true,
        origin: "formal_live", sourceKind: "live", formalRevisionAvailable: true,
        referenceOnly: false, usingFallback: false, restored: false, superseded: false,
        openInterestStatus: "available", identity: { verified: true, contract, tradingDate,
            pageUpdatedAt: capturedAt, canonicalSignature: `sig-${qriVersion}`,
            canonicalVersionKey: qriVersion, historyEntryId: `${contract}|${tradingDate}`,
            historyRevisionId: qriVersion } }, weeklyContext: { available: true,
        origin: "formal_history", formalApplied: true, usingFallback: false,
        superseded: false, sourceDate: "2026-08-21", versionKey: "weekly-v1",
        signature: "weekly-sig", identityVerified: true,
        normalizedDirection: weekly.normalizedDirection, qualityFactor: 1,
        effectiveWeight: 45, weightedContribution: weekly.weightedContribution,
        metadata: {} }, nearestLevelsContext: null, dataQualityContext: { status: "complete",
        warnings: [], sourceAvailability: { currentPrice: true, qri: true, weekly: true,
            overallV2: true }, componentAvailability: { option: true, weekly: true },
        fallbackFlags: { currentPrice: false, qri: false, weekly: false, overallV2: false } } };
}

const sourceIdentity = (requestId = "request-1", generation = 2) => ({
    currentPriceGeneration: generation, currentPriceVersionKey: "price-66020",
    qriGeneration: generation, qriVersionKey: "qri-v2", weeklyGeneration: 15,
    weeklyVersionKey: "weekly-v1", overallGeneration: 15,
    overallInputFingerprint: "overall-input", requestIds: Array(4).fill(requestId) });

async function fixture() {
    const scopeId = "morning-v4-scope|2026-09|2026-08-28|same_date_explicit";
    const baseline = (await Baseline.buildMorningBaselineV4(builderInput())).baseline;
    const currentInput = builderInput({ capturedAt: "2026-08-28T05:00:00+09:00",
        score: -30, price: 66020, qriVersion: "qri-v2", optionDirection: 0 });
    const sources = { value: sourceIdentity() };
    const restore = { value: { restoreStatus: "valid", integrityStatus: "valid",
        applicabilityStatus: "applicable", reason: null, storageFingerprint: "storage-fp",
        selectedScopeId: scopeId, selectedBaselineId: baseline.baselineId, baseline,
        currentScope: { scopeId, formalTradingDate: "2026-08-28", contract: "2026-09" },
        diagnostics: { selectedActiveRevision: true } } };
    const collected = { ready: true, status: "ready", reason: null,
        formalSnapshotInputFingerprint: "formal-fingerprint",
        sourceGenerations: { start: sourceIdentity(), end: sourceIdentity() },
        sessionScope: { scopeId, formalTradingDate: "2026-08-28", contract: "2026-09" },
        builderInput: currentInput, diagnostics: { fingerprintMatched: true,
            mixedAcquisitionDetected: false } };
    const calls = { collect: 0, build: 0, validate: 0, compare: 0 };
    const runtime = Runtime.createRuntime({ now: () => "2026-08-28T05:01:00+09:00",
        getRestoreState: () => restore.value,
        collect: async () => { calls.collect += 1; return collected; },
        getSourceStates: () => sources.value, sourceIdentity: value => value,
        buildSnapshot: async input => { calls.build += 1;
            return Baseline.buildMorningBaselineV4(input); },
        validateSnapshot: async value => { calls.validate += 1;
            return Baseline.validateMorningBaselineV4(value); },
        compare: async input => { calls.compare += 1;
            return require("../js/morningComparisonV4.js").buildMorningComparisonV4(input); },
        isRefreshInProgress: () => false });
    return { runtime, restore, collected, sources, calls, baseline };
}

test("applicable active v4 baseline publishes comparable state", async () => {
    const f = await fixture(); const result = await f.runtime.publish(); const state = f.runtime.getState();
    assert.equal(result.status, "available"); assert.equal(state.comparison.status, "comparable");
    assert.equal(state.selectedBaselineId, f.baseline.baselineId);
    assert.equal(state.baselineIdentity.baselineId, f.baseline.baselineId);
});
test("collector is called once and its builderInput creates an ephemeral current snapshot", async () => {
    const f = await fixture(); await f.runtime.publish(); const state = f.runtime.getState();
    assert.equal(f.calls.collect, 1); assert.equal(f.calls.build, 1);
    assert.match(state.currentIdentity.baselineId, /^mb4-/);
    assert.notEqual(state.currentIdentity.baselineId, state.selectedBaselineId);
});
test("comparison deltas are retained", async () => { const f = await fixture(); await f.runtime.publish();
    const c = f.runtime.getState().comparison; assert.equal(c.overallV2.delta, 7);
    assert.equal(c.optionComponent.directionDelta, 12.5);
    assert.equal(c.weeklyComponent.directionDelta, 0); assert.equal(c.price.delta, 70);
    assert.equal(c.dataQuality.transition, "unchanged");
    assert.equal(c.divergence.relation, "same_direction"); });
test("identity and diagnostics are published", async () => { const f = await fixture(); await f.runtime.publish();
    const s = f.runtime.getState(); assert.equal(s.requestId, "request-1");
    assert.equal(s.formalSnapshotInputFingerprint, "formal-fingerprint");
    for (const key of ["baselineValidated", "collectorReady", "currentSnapshotBuilt",
        "currentSnapshotValidated", "comparisonInvoked", "comparisonAvailable",
        "sameScopeVerified", "requestMatched", "generationsMatched", "fingerprintMatched",
        "baselineIdentityMatched", "raceGuardPassed"]) assert.equal(s.diagnostics[key], true); });

for (const [name, mutate, reason] of [
    ["restore missing", f => { f.restore.value = null; }, "restore_missing"],
    ["restore invalid", f => { f.restore.value.restoreStatus = "invalid"; }, "restore_invalid"],
    ["restore not applicable", f => { f.restore.value.applicabilityStatus = "not_applicable"; }, "restore_not_applicable"],
    ["inactive revision", f => { f.restore.value.diagnostics.selectedActiveRevision = false; }, "active_revision_invalid"],
    ["legacy mb1 rejected", f => { f.restore.value.selectedBaselineId = "mb1-legacy"; }, "baseline_identity_mismatch"],
    ["collector not ready", f => { f.collected.ready = false; f.collected.reason = "mixed_acquisition"; }, "mixed_acquisition"],
    ["mixed acquisition", f => { f.collected.diagnostics.mixedAcquisitionDetected = true; }, "mixed_acquisition"],
    ["request mismatch", f => { f.collected.sourceGenerations.end.requestIds[3] = "other"; }, "request_mismatch"],
    ["generation mismatch", f => { f.collected.sourceGenerations.end.qriGeneration = 3; }, "generation_mismatch"],
    ["fingerprint mismatch", f => { f.collected.diagnostics.fingerprintMatched = false; }, "fingerprint_mismatch"],
    ["scope mismatch", f => { f.collected.sessionScope.scopeId = "other"; }, "scope_mismatch"],
    ["trading date mismatch", f => { f.collected.sessionScope.formalTradingDate = "2026-08-29"; }, "trading_date_mismatch"],
    ["contract mismatch", f => { f.collected.sessionScope.contract = "2026-12"; }, "contract_mismatch"]
]) test(name, async () => { const f = await fixture(); mutate(f); await f.runtime.publish();
    assert.equal(f.runtime.getState().reason, reason); assert.equal(f.runtime.getState().comparison, null); });

test("logic mismatch remains comparison fail-closed", async () => { const f = await fixture();
    f.collected.builderInput.overallV2Context.logicVersion = "other"; await f.runtime.publish();
    assert.equal(f.runtime.getState().reason, "logic_version_mismatch"); });
test("refresh in progress fails before collect", async () => { const f = await fixture();
    const runtime = Runtime.createRuntime({ getRestoreState: () => f.restore.value,
        collect: async () => { throw new Error("must not collect"); }, isRefreshInProgress: () => true });
    await runtime.publish(); assert.equal(runtime.getState().reason, "refresh_in_progress"); });
test("end request and generation changes reject publication", async () => { const f = await fixture();
    f.sources.value = sourceIdentity("request-2"); await f.runtime.publish();
    assert.equal(f.runtime.getState().reason, "request_mismatch"); });
test("active baseline change at end rejects publication", async () => { const f = await fixture();
    const original = f.runtime; let count = 0; const runtime = Runtime.createRuntime({
        getRestoreState: () => { count += 1; const value = structuredClone(f.restore.value);
            if (count > 1) value.selectedBaselineId = "mb4-changed"; return value; },
        collect: async () => f.collected, getSourceStates: () => f.sources.value,
        sourceIdentity: value => value, isRefreshInProgress: () => false });
    await runtime.publish(); assert.equal(runtime.getState().reason, "active_revision_changed");
    assert.ok(original); });
test("stale async publication is rejected after invalidation", async () => { const f = await fixture();
    let release; const wait = new Promise(resolve => { release = resolve; });
    const runtime = Runtime.createRuntime({ getRestoreState: () => f.restore.value,
        collect: async () => { await wait; return f.collected; }, getSourceStates: () => f.sources.value,
        sourceIdentity: value => value, isRefreshInProgress: () => false });
    const pending = runtime.publish(); runtime.invalidate("new_market_refresh"); release();
    assert.equal((await pending).reason, "stale_publication");
    assert.equal(runtime.getState().reason, "new_market_refresh"); });
test("new request invalidates prior comparison and generation is monotonic", async () => { const f = await fixture();
    await f.runtime.publish(); const first = f.runtime.getState().publicationGeneration;
    f.runtime.invalidate("new_market_refresh"); const second = f.runtime.getState();
    assert.ok(second.publicationGeneration > first); assert.equal(second.comparison, null); });
test("getter is detached and deeply frozen without work", async () => { const f = await fixture();
    await f.runtime.publish(); const before = { ...f.calls }; const a = f.runtime.getState();
    const b = f.runtime.getState(); assert.notEqual(a, b); assert.notEqual(a.comparison, b.comparison);
    assert.equal(Object.isFrozen(a), true); assert.equal(Object.isFrozen(a.comparison), true);
    assert.deepEqual(f.calls, before); });
test("inputs are not mutated and no ephemeral snapshot is persisted", async () => { const f = await fixture();
    const before = structuredClone({ restore: f.restore.value, collected: f.collected });
    await f.runtime.publish(); assert.deepEqual({ restore: f.restore.value, collected: f.collected }, before); });
test("diagnostics deny storage fetch recalculation and DOM side effects", async () => { const f = await fixture();
    await f.runtime.publish(); const d = f.runtime.getState().diagnostics;
    assert.deepEqual([d.storageAccessed, d.storageWritten, d.databaseAccessed, d.fetchTriggered,
        d.formalRecalculationTriggered, d.domMutated], [false, false, false, false, false, false]); });
test("runtime source has no storage fetch timer DOM or legacy dependency", () => { const source = fs.readFileSync(
    path.join(__dirname, "../js/morningComparisonV4Runtime.js"), "utf8");
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|setItem|\bfetch\s*\(|setTimeout|setInterval|document\.|MobileMorning|mb1-/); });
test("scripts load in dependency order and UI module is unchanged downstream", () => { const html = fs.readFileSync(
    path.join(__dirname, "../index.html"), "utf8");
    assert.ok(html.indexOf("morningBaselineV4.js") < html.indexOf("morningComparisonV4.js"));
    assert.ok(html.indexOf("morningComparisonV4.js") < html.indexOf("morningComparisonV4Runtime.js"));
    assert.ok(html.indexOf("morningComparisonV4Runtime.js") < html.indexOf("mobileSummaryPreview.js")); });
test("formal lifecycle publishes outside refresh and refresh completion publishes after clearing the flag", () => {
    const script = fs.readFileSync(path.join(__dirname, "../js/script.js"), "utf8");
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(script, /evaluateMorningBaselineV4Applicability[\s\S]*isMarketRefreshInProgress[\s\S]*publishMorningComparisonV4Runtime/);
    assert.match(html, /finally\(async \(\) => \{\s*marketRefreshPromise = null;\s*await window\.publishMorningComparisonV4Runtime/);
});
