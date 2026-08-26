const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Collector = require("../js/morningBaselineV4RuntimeCollector.js");
const Baseline = require("../js/morningBaselineV4.js");

const generation = (source, fingerprint) => ({ source, sequence: 1, fingerprint, current: true });
function fixture() {
    const requestId = "request-1";
    const qri = { sourceClass: "formal_live", sourceKind: "formal_live", origin: "live",
        usingFallback: false, referenceOnly: false, superseded: false, contract: "2026-09",
        tradingDate: "2026-08-26", pageUpdatedAt: "2026-08-26T08:00:00+09:00",
        canonicalSignature: "qri-signature", canonicalVersionKey: "qri-v1",
        historyEntryIdentity: "2026-09|2026-08-26", historyRevisionIdentity: "qri-v1",
        persistenceStatus: "saved", requestId, fetchedAt: "2026-08-26T08:01:00+09:00",
        identityVerified: true, acquisitionVerified: true, generation: generation("qri", "qri-gen") };
    const price = { available: true, sourceKind: "live", origin: "live", mode: "automatic",
        value: 66000, contract: "2026-09", quoteDate: "2026-08-26",
        quotedAtNormalized: "2026-08-26T07:59:00+09:00", quoteSignature: "price-signature",
        versionKey: "price-v1", wrapperSignature: "wrapper-signature", requestId,
        fetchedAt: "2026-08-26T08:01:00+09:00", sourceUrl: "https://svc.qri.jp/jpx/nkopm/",
        acquisitionIdentity: { requestId, fetchedAt: "2026-08-26T08:01:00+09:00",
            sourceUrl: "https://svc.qri.jp/jpx/nkopm/", wrapperSignature: "wrapper-signature" },
        identityVerified: true, acquisitionVerified: true, currentRequestVerified: true,
        qriTradingDateMapping: { status: "verified", quoteDate: "2026-08-26",
            qriTradingDate: "2026-08-26", relation: "same_date", mappingVerified: true,
            mappingSource: "same_date_explicit" } };
    const weekly = { sourceClass: "formal_history", sourceDate: "2026-08-26",
        previousVersionKey: "weekly-v0", currentVersionKey: "weekly-v1",
        currentSignature: "weekly-signature", activeVersionMatched: true,
        dataStatus: "formal_history", origin: "weekly_futures_history",
        sourceFingerprint: "weekly-fingerprint", weeklyInputFingerprint: "weekly-fingerprint",
        requestId, normalizedDirection: 0.4, qualityFactor: 1, evidenceFactor: 0.4,
        effectiveWeight: 45, weightedContribution: 18,
        componentMetadata: { current: { versionKey: "weekly-v1" } },
        requestContext: { requestId, marketRefreshRequestId: requestId },
        generation: generation("weekly", "weekly-gen") };
    const optionComponent = { name: "option", available: true, invalid: false,
        normalizedDirection: 0.2, directionScore: 20, baseWeight: 55, qualityFactor: 1,
        effectiveWeight: 55, weightedContribution: 11, evidenceFactor: 0.2, notes: [],
        metadata: { usingFallback: false, sourceDate: "2026-08-26" } };
    const weeklyComponent = { name: "weekly", available: true, invalid: false,
        normalizedDirection: 0.4, directionScore: 40, baseWeight: 45, qualityFactor: 1,
        effectiveWeight: 45, weightedContribution: 18, evidenceFactor: 0.4, notes: [],
        metadata: { current: { versionKey: "weekly-v1" } } };
    const result = { status: "complete", direction: 29, directionLabel: "買い優勢",
        confidence: 80, confidenceFactors: { agreement: 90 }, effectiveWeightTotal: 100,
        components: { option: optionComponent, weekly: weeklyComponent },
        metadata: { calculatedAt: "2026-08-26T08:02:00+09:00", coverage: 100, warnings: [] } };
    const envelope = { envelopeVersion: 1, status: "complete", logicVersion: "overall-v2-v1",
        evaluatedAt: "2026-08-26T08:02:00+09:00", publicationGeneration: 1, requestId,
        result, optionSourceIdentity: { canonicalVersionKey: "qri-v1",
            canonicalSignature: "qri-signature", requestId, sourceFingerprint: "qri-gen",
            generation: generation("qri", "qri-gen") }, weeklySourceIdentity: {
            currentVersionKey: "weekly-v1", previousVersionKey: "weekly-v0",
            currentSignature: "weekly-signature", weeklyInputFingerprint: "weekly-fingerprint",
            sourceFingerprint: "weekly-fingerprint", generation: generation("weekly", "weekly-gen") },
        inputFingerprint: "published-overall-fingerprint", formalApplied: true,
        referenceOnly: false, identityVerified: true,
        diagnostics: { warnings: [], fallbackUsed: false } };
    return { currentPrice: { status: "available", publicationGeneration: 1, requestId,
        fact: price, diagnostics: { formalCurrentPriceMode: "automatic" } },
    qri: { status: "available", publicationGeneration: 1, requestId, fact: qri },
    weekly: { status: "available", publicationGeneration: 1, requestId, fact: weekly },
    overall: { status: "available", publicationGeneration: 1, requestId, envelope } };
}
function runtime(states = fixture(), options = {}) {
    return Collector.createRuntimeCollector({ getCurrentPrice: () => states.currentPrice,
        getQri: () => states.qri, getWeekly: () => states.weekly,
        getOverall: () => states.overall,
        isRefreshInProgress: () => options.refresh === true,
        now: () => "2026-08-26T08:03:00+09:00" });
}
const collect = async mutate => { const states = fixture(); mutate?.(states);
    return runtime(states).collect(); };

test("all formal facts ready", async () => assert.equal((await collect()).ready, true));
test("valid same-date collector ready", async () => assert.equal((await collect()).status, "ready"));
test("CurrentPrice publication generation is adapted for the Fact Contract", async () => {
    const result = await collect(); assert.deepEqual(result.factContract.facts.currentPrice.generation,
        { source: "currentPrice", sequence: 1, fingerprint: "price-v1", current: true }); });
test("CurrentPrice pure fact schema is not mutated", async () => { const states = fixture();
    assert.equal(states.currentPrice.fact.generation, undefined); await runtime(states).collect();
    assert.equal(states.currentPrice.fact.generation, undefined); });
test("CurrentPrice missing publication generation rejected", async () => assert.ok(
    (await collect(x => { delete x.currentPrice.publicationGeneration; })).reasons
        .includes("current_price_identity_missing")));
test("CurrentPrice invalid publication generation rejected", async () => assert.ok(
    (await collect(x => { x.currentPrice.publicationGeneration = -1; })).reasons
        .includes("current_price_identity_missing")));
test("CurrentPrice unavailable publication is not marked current", async () => assert.ok(
    (await collect(x => { x.currentPrice.status = "unavailable"; })).reasons
        .includes("current_price_identity_missing")));
test("CurrentPrice source fingerprint semantics remain wrapper based", async () => {
    const states = fixture(); const before = Collector.sourceIdentity(states);
    await runtime(states).collect(); assert.deepEqual(Collector.sourceIdentity(states), before); });
test("CurrentPrice unavailable", async () => assert.equal((await collect(x => { x.currentPrice.status = "unavailable"; x.currentPrice.fact = null; })).ready, false));
test("CurrentPrice manual", async () => assert.ok((await collect(x => { x.currentPrice.diagnostics.formalCurrentPriceMode = "manual"; })).reasons.includes("current_price_manual")));
test("CurrentPrice cross-date unresolved", async () => assert.equal((await collect(x => { x.currentPrice.fact.quoteDate = "2026-08-25"; x.currentPrice.fact.qriTradingDateMapping.mappingVerified = false; x.currentPrice.fact.qriTradingDateMapping.mappingSource = null; })).ready, false));
test("QRI unavailable", async () => assert.equal((await collect(x => { x.qri.status = "unavailable"; x.qri.fact = null; })).ready, false));
test("QRI saved rejected", async () => assert.equal((await collect(x => { x.qri.fact.sourceClass = "saved"; })).ready, false));
test("QRI fallback rejected", async () => assert.ok((await collect(x => { x.qri.fact.usingFallback = true; })).reasons.includes("fallback_present")));
test("QRI revision missing", async () => assert.ok((await collect(x => { x.qri.fact.historyRevisionIdentity = null; })).reasons.includes("qri_revision_identity_missing")));
test("Weekly unavailable", async () => assert.equal((await collect(x => { x.weekly.status = "unavailable"; x.weekly.fact = null; })).ready, false));
test("Weekly binding mismatch", async () => assert.equal((await collect(x => { x.overall.envelope.weeklySourceIdentity.currentVersionKey = "old"; })).ready, false));
test("Overall unavailable", async () => assert.equal((await collect(x => { x.overall.status = "unavailable"; x.overall.envelope = null; })).ready, false));
test("Overall input mismatch", async () => assert.equal((await collect(x => { x.overall.envelope.optionSourceIdentity.canonicalVersionKey = "old"; })).ready, false));
test("logicVersion missing", async () => assert.ok((await collect(x => { x.overall.envelope.logicVersion = null; })).reasons.includes("overall_identity_missing")));
test("session unverified", async () => assert.ok((await collect(x => { x.currentPrice.fact.qriTradingDateMapping.mappingVerified = false; })).reasons.includes("session_unverified")));
test("contract mismatch", async () => assert.ok((await collect(x => { x.currentPrice.fact.contract = "2026-12"; })).reasons.includes("contract_mismatch")));
test("tradingDate mismatch", async () => assert.equal((await collect(x => { x.currentPrice.fact.qriTradingDateMapping.qriTradingDate = "2026-08-27"; })).ready, false));
test("fallback flag present", async () => assert.equal((await collect(x => { x.overall.envelope.diagnostics.fallbackUsed = true; })).ready, false));
test("refresh in progress", async () => { const states = fixture(); assert.ok((await runtime(states, { refresh: true }).collect()).reasons.includes("refresh_in_progress")); });
test("generation changes during collect", async () => { const states = fixture(); const r = runtime(states);
    const result = await r.collect({ beforeEndSnapshot: () => { states.qri.publicationGeneration += 1; } });
    assert.ok(result.reasons.includes("source_generation_changed")); });
test("mixed acquisition", async () => assert.ok((await collect(x => { x.weekly.fact.requestContext.marketRefreshRequestId = "other"; })).reasons.includes("mixed_acquisition")));
test("deterministic fingerprint", async () => { const states = fixture(); const r = runtime(states);
    assert.equal((await r.collect()).formalSnapshotInputFingerprint, (await r.collect()).formalSnapshotInputFingerprint); });
test("nearestLevels absent still ready", async () => { const result = await collect(); assert.equal(result.ready, true); assert.equal(result.builderInput.nearestLevelsContext, null); });
test("collector builderInput is accepted by the pure v4 builder with null nearestLevels", async () => {
    const collected = await collect();
    const built = await Baseline.buildMorningBaselineV4(collected.builderInput);
    assert.equal(built.success, true); assert.equal(built.baseline.nearestLevels, null);
    assert.equal(collected.diagnostics.builderInvoked, false);
});
test("DataQuality formal fact", async () => { const result = await collect(); assert.deepEqual(result.factContract.facts.dataQuality.fallbackFlags,
    { currentPrice: false, qri: false, weekly: false, overallV2: false }); });
test("builder input maps formal identities", async () => { const input = (await collect()).builderInput;
    assert.deepEqual([input.qriContext.identity.canonicalVersionKey, input.weeklyContext.versionKey], ["qri-v1", "weekly-v1"]); });
test("builder is deliberately not invoked", async () => { const result = await collect(); assert.deepEqual([result.baselineCandidate,
    result.diagnostics.builderInvoked, result.diagnostics.builderDeferredReason],
    [null, false, "builder_not_connected"]); });
test("manual rejects despite live identity fact", async () => { const result = await collect(x => { x.currentPrice.diagnostics.formalCurrentPriceMode = "manual"; });
    assert.equal(result.currentPriceReady, undefined); assert.equal(result.ready, false); });
test("formal states are not mutated", async () => { const states = fixture(); const before = structuredClone(states); await runtime(states).collect(); assert.deepEqual(states, before); });
test("collector result and getter are detached", async () => { const r = runtime(); const result = await r.collect(); const saved = r.getState(); assert.notEqual(result, saved); });
test("output is deeply frozen", async () => { const result = await collect(); for (const value of [result, result.diagnostics,
    result.sourceGenerations, result.builderInput, result.factContract]) assert.equal(Object.isFrozen(value), true); });
test("diagnostics attest no side effects", async () => { const d = (await collect()).diagnostics;
    assert.deepEqual([d.storageAccessed, d.databaseAccessed, d.fetchTriggered,
        d.formalRecalculationTriggered, d.domMutated], [false, false, false, false, false]); });
test("source generations are captured at both boundaries", async () => { const result = await collect(); assert.deepEqual(result.sourceGenerations.start, result.sourceGenerations.end); });
test("session scope is same-date verified", async () => assert.equal((await collect()).sessionScope.sessionClass, "same_date_verified"));
test("collector uses published Overall result without recalculation", async () => assert.equal((await collect()).builderInput.overallV2Context.result.direction, 29));
test("QRI canonical body is not copied", async () => assert.equal((await collect()).builderInput.qriContext.canonical, undefined));
test("collector module has no storage IndexedDB fetch DOM timer or Morning write", () => { const source = fs.readFileSync(path.join(__dirname,
    "../js/morningBaselineV4RuntimeCollector.js"), "utf8"); assert.doesNotMatch(source,
        /localStorage|sessionStorage|indexedDB|\bfetch\s*\(|document\.|setTimeout|setInterval|setItem|saveMorning/); });
test("collector does not import or invoke baseline builder", () => { const source = fs.readFileSync(path.join(__dirname,
    "../js/morningBaselineV4RuntimeCollector.js"), "utf8"); assert.doesNotMatch(source,
        /\.buildMorningBaselineV4|OptionMapMorningBaselineV4\./); });
test("collector has no Mobile dependency", () => { const source = fs.readFileSync(path.join(__dirname,
    "../js/morningBaselineV4RuntimeCollector.js"), "utf8"); assert.doesNotMatch(source, /MobileSummary|mobileSummary|MobileMorning/); });
test("renderer loads dependencies before collector and script", () => { const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.ok(html.indexOf("morningV4RuntimeFactContract.js") < html.indexOf("morningBaselineV4RuntimeCollector.js"));
    assert.ok(html.indexOf("morningV4FormalSessionScope.js") < html.indexOf("morningBaselineV4RuntimeCollector.js"));
    assert.ok(html.indexOf("morningBaselineV4RuntimeCollector.js") < html.indexOf("js/script.js")); });
