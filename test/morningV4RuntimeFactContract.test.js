const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Contract = require("../js/morningV4RuntimeFactContract.js");

const generation = (source, sequence = 1) => ({ source, sequence,
    fingerprint: `${source}-generation-${sequence}`, current: true });

async function fixture() {
    const requestId = "market-refresh-1";
    const facts = {
        marketSession: { formalTradingDate: "2026-08-26",
            captureCalendarDate: "2026-08-26", sessionScopeId: "qri-session-2026-08-26-2026-09",
            sessionMappingStatus: "verified", mappingVerified: true,
            source: "formal_session_scope_policy", generation: generation("marketSession") },
        overallV2: { sourceClass: "formal_live", formalApplied: true, referenceOnly: false,
            result: { status: "complete", direction: 45 }, logicVersion: "overall-v2-weights-55-45",
            evaluatedAt: "2026-08-26T08:00:00+09:00", requestId, inputFingerprint: "pending",
            optionSourceIdentity: { canonicalVersionKey: "qri-v1",
                sourceFingerprint: "qri-source-fingerprint" },
            weeklySourceIdentity: { currentVersionKey: "weekly-v1",
                sourceFingerprint: "weekly-source-fingerprint" }, generation: generation("overallV2") },
        currentPrice: { available: true, sourceKind: "live", origin: "live", mode: "automatic",
            value: 66000, contract: "2026-09", quoteDate: "2026-08-26",
            quotedAtNormalized: "2026-08-26T07:59:00+09:00", quoteSignature: "a".repeat(64),
            versionKey: "price-v1", requestId, fetchedAt: "2026-08-26T08:00:00+09:00",
            acquisitionIdentity: { requestId, wrapperSignature: "b".repeat(64) },
            identityVerified: true, acquisitionVerified: true, currentRequestVerified: true,
            qriTradingDateMapping: { status: "verified", qriTradingDate: "2026-08-26",
                mappingVerified: true, mappingSource: "same_date_explicit" },
            generation: generation("currentPrice") },
        qri: { sourceClass: "formal_live", origin: "live", usingFallback: false,
            referenceOnly: false, superseded: false, contract: "2026-09",
            tradingDate: "2026-08-26", pageUpdatedAt: "2026-08-26T07:58:00+09:00",
            canonicalSignature: "c".repeat(64), canonicalVersionKey: "qri-v1",
            historyEntryIdentity: "2026-09|2026-08-26",
            historyRevisionIdentity: "qri-v1", persistenceStatus: "saved", requestId,
            fetchedAt: "2026-08-26T08:00:00+09:00", generation: generation("qri") },
        weekly: { sourceClass: "formal_history", previousVersionKey: "weekly-v0",
            currentVersionKey: "weekly-v1", currentSignature: "d".repeat(64),
            activeVersionMatched: true, normalizedDirection: 0.2, qualityFactor: 1,
            evidenceFactor: 0.2, effectiveWeight: 45, weightedContribution: 9,
            componentMetadata: { scoreDiff: 0.02 }, sourceFingerprint: "weekly-source-fingerprint",
            requestContext: { requestId: "weekly-request-1", marketRefreshRequestId: requestId },
            generation: generation("weekly") },
        dataQuality: { status: "complete", warnings: [],
            sourceAvailability: { overallV2: true, currentPrice: true, qri: true, weekly: true },
            componentAvailability: { option: true, weekly: true },
            fallbackFlags: { currentPrice: false, qri: false, weekly: false },
            sourceIdentities: { qriVersionKey: "qri-v1", priceVersionKey: "price-v1",
                weeklyVersionKey: "weekly-v1", logicVersion: "overall-v2-weights-55-45" },
            sourceFingerprint: "quality-fingerprint",
            generation: generation("dataQuality") },
        nearestLevels: { upper: { available: true, price: 66500, distance: 500 },
            lower: { available: true, price: 65500, distance: 500 }, contract: "2026-09",
            sourceVersionKey: "qri-v1", generatedFromFormalOnly: true,
            generation: generation("nearestLevels") }
    };
    facts.overallV2.inputFingerprint = await Contract.expectedOverallInputFingerprint(facts);
    return { facts, collectionContext: { refreshInProgress: false,
        startGenerationFingerprint: "collection-generation-1",
        endGenerationFingerprint: "collection-generation-1",
        sourceGenerationChanged: false, marketRefreshRequestId: requestId } };
}

async function evaluate(mutator = () => undefined) {
    const input = await fixture(); mutator(input);
    return Contract.evaluateMorningV4RuntimeFactReadiness(input);
}

test("complete valid contract is ready", async () => {
    const result = await evaluate();
    assert.deepEqual([result.ready, result.status, result.reasons], [true, "ready", []]);
    assert.match(result.diagnostics.formalSnapshotInputFingerprint, /^[a-f0-9]{64}$/);
});
test("session missing", async () => {
    assert.ok((await evaluate(x => { x.facts.marketSession.sessionScopeId = null; }))
        .reasons.includes("session_unverified"));
});
test("JST calendar day is not a verified session source", async () => {
    assert.ok((await evaluate(x => { x.facts.marketSession.source = "jst_calendar_day"; }))
        .reasons.includes("session_unverified"));
});
test("OverallV2 logicVersion missing", async () => {
    assert.ok((await evaluate(x => { x.facts.overallV2.logicVersion = null; }))
        .reasons.includes("overall_identity_missing"));
});
test("OverallV2 input identity missing", async () => {
    assert.ok((await evaluate(x => { x.facts.overallV2.inputFingerprint = null; }))
        .reasons.includes("overall_identity_missing"));
});
test("CurrentPrice identity missing", async () => {
    assert.ok((await evaluate(x => { x.facts.currentPrice.identityVerified = false; }))
        .reasons.includes("current_price_identity_missing"));
});
test("QRI revision missing", async () => {
    const result = await evaluate(x => { x.facts.qri.historyRevisionIdentity = null; });
    assert.ok(result.reasons.includes("qri_revision_identity_missing"));
});
test("saved QRI rejected", async () => {
    assert.ok((await evaluate(x => { x.facts.qri.sourceClass = "saved"; }))
        .reasons.includes("qri_not_formal"));
});
test("QRI fallback rejected", async () => {
    const result = await evaluate(x => { x.facts.qri.usingFallback = true; });
    assert.ok(result.reasons.includes("qri_not_formal"));
    assert.ok(result.reasons.includes("fallback_present"));
});
test("Weekly identity missing", async () => {
    assert.ok((await evaluate(x => { x.facts.weekly.currentSignature = null; }))
        .reasons.includes("weekly_identity_missing"));
});
test("Weekly component mismatch", async () => {
    assert.ok((await evaluate(x => {
        x.facts.overallV2.weeklySourceIdentity.sourceFingerprint = "other";
    })).reasons.includes("weekly_component_mismatch"));
});
test("DataQuality missing", async () => {
    assert.ok((await evaluate(x => { x.facts.dataQuality = null; }))
        .reasons.includes("data_quality_missing"));
});
test("DataQuality source identity mismatch", async () => {
    assert.ok((await evaluate(x => {
        x.facts.dataQuality.sourceIdentities.priceVersionKey = "other-price";
    })).reasons.includes("data_quality_missing"));
});
test("nearestLevels is optional", async () => {
    const result = await evaluate(x => { delete x.facts.nearestLevels; });
    assert.equal(result.ready, true);
    assert.equal(result.facts.nearestLevels, null);
});
test("provided invalid nearestLevels is rejected", async () => {
    assert.ok((await evaluate(x => { x.facts.nearestLevels.generatedFromFormalOnly = false; }))
        .reasons.includes("nearest_levels_invalid"));
});
test("mixed QRI and CurrentPrice acquisition", async () => {
    assert.ok((await evaluate(x => { x.facts.currentPrice.requestId = "request-b"; }))
        .reasons.includes("mixed_acquisition"));
});
test("contract mismatch", async () => {
    assert.ok((await evaluate(x => { x.facts.currentPrice.contract = "2026-12"; }))
        .reasons.includes("contract_mismatch"));
});
test("tradingDate mismatch", async () => {
    assert.ok((await evaluate(x => {
        x.facts.marketSession.formalTradingDate = "2026-08-27";
    })).reasons.includes("trading_date_mismatch"));
});
test("refresh in progress", async () => {
    assert.equal((await evaluate(x => { x.collectionContext.refreshInProgress = true; }))
        .reasons[0], "refresh_in_progress");
});
test("source generation changes during collection", async () => {
    assert.ok((await evaluate(x => {
        x.collectionContext.endGenerationFingerprint = "collection-generation-2";
    })).reasons.includes("source_generation_changed"));
});
test("non-current source generation is rejected", async () => {
    assert.ok((await evaluate(x => { x.facts.qri.generation.current = false; }))
        .reasons.includes("qri_not_formal"));
});
test("Overall input fingerprint mismatch", async () => {
    assert.ok((await evaluate(x => { x.facts.overallV2.inputFingerprint = "wrong"; }))
        .reasons.includes("overall_input_mismatch"));
});
test("readiness is false on a missing required fact", async () => {
    const result = await evaluate(x => { delete x.facts.currentPrice; });
    assert.deepEqual([result.ready, result.status], [false, "not_ready"]);
});
test("reason taxonomy is deterministic", async () => {
    const result = await evaluate(x => {
        x.collectionContext.refreshInProgress = true;
        x.facts.marketSession.sessionScopeId = null;
        x.facts.overallV2.logicVersion = null;
    });
    assert.deepEqual(result.reasons.slice(0, 3),
        ["refresh_in_progress", "session_unverified", "overall_identity_missing"]);
});
test("input is not mutated", async () => {
    const input = await fixture(); const before = structuredClone(input);
    await Contract.evaluateMorningV4RuntimeFactReadiness(input);
    assert.deepEqual(input, before);
});
test("contract definitions and result are deeply frozen", async () => {
    const result = await evaluate();
    for (const value of [Contract.SOURCE_CLASSES, Contract.FACT_CLASSES,
        Contract.INVARIANTS, result, result.reasons, result.facts,
        result.facts.overallV2, result.diagnostics]) assert.equal(Object.isFrozen(value), true);
});
test("formal source classes are explicit", () => {
    assert.deepEqual([...Contract.SOURCE_CLASSES], ["formal_live", "formal_history", "saved",
        "reference", "legacy", "manual", "restored"]);
});
test("no MobileSummary or legacy Morning dependency", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/morningV4RuntimeFactContract.js"), "utf8");
    assert.equal(/MobileSummary|mobileSummary|morningBaseline\.js|OptionMapMorningBaseline/.test(source), false);
});
test("pure contract has no storage runtime DOM or network", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/morningV4RuntimeFactContract.js"), "utf8");
    assert.equal(/localStorage|indexedDB|setItem\s*\(|document\.|getElementById|\bfetch\s*\(|setTimeout|setInterval/.test(source), false);
});
test("contract loads only as collector dependency", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.ok(html.indexOf("morningV4RuntimeFactContract.js") <
        html.indexOf("morningBaselineV4RuntimeCollector.js"));
});
