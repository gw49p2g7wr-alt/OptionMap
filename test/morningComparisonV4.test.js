const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Baseline = require("../js/morningBaselineV4.js");
const Comparison = require("../js/morningComparisonV4.js");

const sourceIdentity = (source, versionKey) => ({ source, versionKey,
    signature: `sha256:${source}-${versionKey}`, verified: true });
const component = (name, direction, quality, weight) => ({ name, available: true,
    invalid: false, normalizedDirection: direction, directionScore: direction * 100,
    baseWeight: weight, qualityFactor: quality, effectiveWeight: weight * quality,
    weightedContribution: direction * weight * quality, evidenceFactor: Math.abs(direction),
    notes: [], metadata: { scoreDifference: direction * 8 } });

function input(options = {}) {
    const contract = options.contract || "2026-09";
    const tradingDate = options.tradingDate || "2026-08-26";
    const qriVersion = options.qriVersion || "qri-v1";
    const weeklyVersion = options.weeklyVersion || "weekly-v1";
    const optionDirection = options.optionDirection ?? 0.4;
    const weeklyDirection = options.weeklyDirection ?? 0.2;
    const optionQuality = options.optionQuality ?? 1;
    const weeklyQuality = options.weeklyQuality ?? 0.9;
    const option = component("option", optionDirection, optionQuality, 55);
    const weekly = component("weekly", weeklyDirection, weeklyQuality, 45);
    return { capturedAt: options.capturedAt || "2026-08-26T08:00:00+09:00",
        marketContext: { captureCalendarDate: options.captureCalendarDate || "2026-08-26",
            formalTradingDate: tradingDate, sessionIdentity: options.sessionIdentity === undefined
                ? "jpx-day-2026-08-26" : options.sessionIdentity,
            sessionMappingStatus: options.sessionMappingStatus || "verified" },
        overallV2Context: { origin: "formal_live", formalApplied: true, superseded: false,
            logicVersion: options.logicVersion || "overall-v2-weights-55-45",
            evaluatedAt: options.evaluatedAt || options.capturedAt || "2026-08-26T08:00:00+09:00",
            inputIdentity: sourceIdentity("overall-v2-input", options.inputVersion || "input-v1"),
            componentIdentities: { option: sourceIdentity("qri-options", qriVersion),
                weekly: sourceIdentity(options.weeklySource || "weekly-futures-history", weeklyVersion) },
            result: { status: "complete", direction: options.score ?? 45,
                directionLabel: options.label || "買い優勢", confidence: options.confidence ?? 70,
                confidenceFactors: { coverage: options.coverage ?? 100, quality: 95,
                    evidence: 30, agreement: options.agreement ?? 80 },
                components: { option, weekly }, invalidComponents: [],
                metadata: { calculatedAt: options.evaluatedAt || "2026-08-26T08:00:00+09:00",
                    availableComponentCount: 2, plannedComponentCount: 2,
                    coverage: options.coverage ?? 100, warnings: [],
                    timeHorizon: { code: "multi_day", label: "1日～数日" } } } },
        currentPriceContext: { available: true, sourceKind: "live", origin: "live",
            mode: "automatic", value: options.price ?? 66000, contract,
            quoteDate: options.quoteDate || tradingDate,
            quotedAtNormalized: `${options.quoteDate || tradingDate}T07:59:00+09:00`,
            quoteSignature: (options.priceSignature || "a").repeat(64),
            versionKey: options.priceVersion || "price-v1", wrapperSignature: "b".repeat(64),
            requestId: options.requestId || "request-1",
            fetchedAt: options.evaluatedAt || "2026-08-26T08:00:00+09:00",
            currentRequestVerified: true, identityVerified: true, acquisitionVerified: true,
            acquisitionIdentity: { requestId: options.requestId || "request-1",
                fetchedAt: options.evaluatedAt || "2026-08-26T08:00:00+09:00",
                sourceUrl: "https://svc.qri.jp/jpx/nkopm/", wrapperSignature: "b".repeat(64) },
            qriTradingDateMapping: { status: options.mappingVerified === false ? "date_context_unresolved" : "verified",
                quoteDate: options.quoteDate || tradingDate, qriTradingDate: tradingDate,
                relation: options.mappingVerified === false ? "previous_date" : "same_date",
                mappingVerified: options.mappingVerified !== false,
                mappingSource: options.mappingVerified === false ? null : "same_date_explicit" } },
        qriContext: { available: true, origin: "formal_live", sourceKind: "live",
            formalRevisionAvailable: true, referenceOnly: false, usingFallback: false,
            restored: false, superseded: false, openInterestStatus: "available",
            identity: { verified: true, contract, tradingDate,
                pageUpdatedAt: options.evaluatedAt || "2026-08-26T08:00:00+09:00",
                canonicalSignature: "c".repeat(64), canonicalVersionKey: qriVersion,
                historyEntryId: options.historyEntryId || `${contract}|${tradingDate}`,
                historyRevisionId: qriVersion } },
        weeklyContext: { available: true, origin: "formal_history", formalApplied: true,
            usingFallback: false, superseded: false, sourceDate: options.weeklyDate || "2026-08-21",
            versionKey: weeklyVersion, signature: null, identityVerified: true,
            normalizedDirection: weeklyDirection, qualityFactor: weeklyQuality,
            effectiveWeight: weekly.effectiveWeight,
            weightedContribution: weekly.weightedContribution,
            metadata: { previousVersionKey: "weekly-v0", currentVersionKey: weeklyVersion } },
        nearestLevelsContext: options.nearestLevelsContext === undefined ? {
            generatedFromFormalOnly: true, referenceOnly: false,
            usingFallback: false, contract, sourceVersionKey: qriVersion,
            upper: { available: true, price: 66500, distance: 500, optionType: "CALL" },
            lower: { available: true, price: 65500, distance: 500, optionType: "PUT" } }
            : options.nearestLevelsContext,
        dataQualityContext: { status: options.qualityStatus || "complete",
            warnings: options.warnings || [],
            sourceAvailability: { overallV2: true, currentPrice: true, qri: true, weekly: true },
            fallbackFlags: { currentPrice: false, qri: false, weekly: false },
            componentAvailability: options.componentAvailability || { option: true, weekly: true } } };
}

async function snapshot(options) {
    const result = await Baseline.buildMorningBaselineV4(input(options));
    assert.equal(result.success, true, result.reason);
    return result.baseline;
}

async function compare(currentOptions = {}, baselineOptions = {}) {
    return Comparison.buildMorningComparisonV4({ baseline: await snapshot(baselineOptions),
        currentSnapshot: await snapshot({ capturedAt: "2026-08-26T12:00:00+09:00",
            evaluatedAt: "2026-08-26T12:00:00+09:00", requestId: "request-2",
            priceVersion: "price-v2", qriVersion: "qri-v2", weeklyVersion: "weekly-v2",
            ...currentOptions }) });
}

test("valid same-session comparison", async () => {
    const result = await compare();
    assert.deepEqual([result.available, result.status, result.reason], [true, "comparable", null]);
});
test("baseline invalid", async () => {
    assert.equal((await Comparison.buildMorningComparisonV4({ baseline: {},
        currentSnapshot: await snapshot() })).reason, "baseline_invalid");
});
test("current invalid", async () => {
    assert.equal((await Comparison.buildMorningComparisonV4({ baseline: await snapshot(),
        currentSnapshot: {} })).reason, "current_invalid");
});
test("logic version mismatch", async () => {
    assert.equal((await compare({ logicVersion: "overall-v3" })).reason, "logic_version_mismatch");
});
test("contract mismatch is classified as contract roll", async () => {
    assert.equal((await compare({ contract: "2026-12" })).reason, "contract_roll");
});
test("contract roll never produces score deltas", async () => {
    assert.equal((await compare({ contract: "2026-12" })).overallV2, null);
});
test("trading date mismatch", async () => {
    assert.equal((await compare({ tradingDate: "2026-08-27", quoteDate: "2026-08-27",
        historyEntryId: "2026-09|2026-08-27" })).reason, "trading_date_mismatch");
});
test("session unverified", async () => {
    assert.equal((await compare({ sessionIdentity: null,
        sessionMappingStatus: "unresolved" })).reason, "session_unverified");
});
test("QRI history entry mismatch", async () => {
    assert.equal((await compare({ historyEntryId: "unexpected-entry" })).reason,
        "qri_identity_mismatch");
});
test("CurrentPrice date identity mismatch", async () => {
    assert.equal((await compare({ quoteDate: "2026-08-25", mappingVerified: false })).reason,
        "price_identity_mismatch");
});
test("Weekly source identity mismatch", async () => {
    assert.equal((await compare({ weeklySource: "unknown-weekly-source" })).reason,
        "weekly_identity_mismatch");
});

test("OverallV2 raw score delta", async () => {
    assert.equal((await compare({ score: 66 })).overallV2.delta, 21);
});
test("confidence delta", async () => {
    assert.equal((await compare({ confidence: 78 })).overallV2.confidenceDelta, 8);
});
test("coverage delta", async () => {
    assert.equal((await compare({ coverage: 90 })).overallV2.coverageDelta, -10);
});
test("agreement delta", async () => {
    assert.equal((await compare({ agreement: 95 })).overallV2.agreementDelta, 15);
});
test("option normalized direction delta", async () => {
    assert.ok(Math.abs((await compare({ optionDirection: 0.6 }))
        .optionComponent.normalizedDirectionDelta - 0.2) < 1e-12);
});
test("option quality delta", async () => {
    assert.ok(Math.abs((await compare({ optionQuality: 0.8 }))
        .optionComponent.qualityFactorDelta + 0.2) < 1e-12);
});
test("option effective weight delta", async () => {
    assert.equal((await compare({ optionQuality: 0.8 })).optionComponent.effectiveWeightDelta, -11);
});
test("option weighted contribution delta", async () => {
    assert.equal((await compare({ optionDirection: 0.5 })).optionComponent.weightedContributionDelta, 5.5);
});
test("weekly direction delta", async () => {
    assert.ok(Math.abs((await compare({ weeklyDirection: -0.1 }))
        .weeklyComponent.directionDelta + 30) < 1e-12);
});
test("weekly quality delta", async () => {
    assert.ok(Math.abs((await compare({ weeklyQuality: 0.8 }))
        .weeklyComponent.qualityFactorDelta + 0.1) < 1e-12);
});
test("weekly effective weight delta", async () => {
    assert.equal((await compare({ weeklyQuality: 0.8 })).weeklyComponent.effectiveWeightDelta, -4.5);
});

test("component availability change is never zero-filled", () => {
    const changed = Comparison.compareComponent(component("option", 0.4, 1, 55),
        { ...component("option", 0.4, 1, 55), available: false });
    assert.deepEqual([changed.status, changed.directionDelta,
        changed.weightedContributionDelta], ["availability_changed", null, null]);
});
test("price delta", async () => {
    assert.equal((await compare({ price: 65620 })).price.delta, -380);
});
test("price percent delta", async () => {
    assert.ok(Math.abs((await compare({ price: 65620 })).price.percentDelta -
        (-380 / 66000 * 100)) < 1e-12);
});
test("opposite direction", async () => {
    assert.equal((await compare({ score: 66, price: 65620 })).divergence.relation,
        "opposite_direction");
});
test("same direction positive", async () => {
    assert.equal((await compare({ score: 66, price: 66100 })).divergence.relation,
        "same_direction");
});
test("same direction negative", async () => {
    assert.equal((await compare({ score: 30, price: 65900 })).divergence.relation,
        "same_direction");
});
test("zero involved", async () => {
    assert.equal((await compare({ score: 45, price: 65900 })).divergence.relation,
        "zero_involved");
});
test("divergence contains no score", async () => {
    assert.equal(Object.hasOwn((await compare()).divergence, "score"), false);
});
test("raw sign has no threshold classification", () => {
    assert.equal(Comparison.relation(0.00001, -0.00001), "opposite_direction");
});

test("DataQuality unchanged", async () => {
    assert.equal((await compare()).dataQuality.transition, "unchanged");
});
test("DataQuality improved", async () => {
    assert.equal((await compare({ qualityStatus: "complete" },
        { qualityStatus: "partial" })).dataQuality.transition, "improved");
});
test("DataQuality changed warnings remain unclassified", async () => {
    const result = await compare({ warnings: ["new-warning"] });
    assert.deepEqual([result.dataQuality.changed, result.dataQuality.transition],
        [true, "changed_unclassified"]);
});
test("nearestLevels are not part of comparison output", async () => {
    assert.equal(Object.hasOwn(await compare(), "nearestLevels"), false);
});
test("all Phase 1 comparisons work when baseline and current nearestLevels are null", async () => {
    const result = await compare({ nearestLevelsContext: null, score: 66,
        optionDirection: 0.6, weeklyDirection: -0.1, price: 65620 },
    { nearestLevelsContext: null });
    assert.equal(result.available, true);
    assert.equal(result.overallV2.delta, 21);
    assert.ok(Math.abs(result.optionComponent.normalizedDirectionDelta - 0.2) < 1e-12);
    assert.ok(Math.abs(result.weeklyComponent.directionDelta + 30) < 1e-12);
    assert.equal(result.price.delta, -380);
    assert.equal(result.dataQuality.transition, "unchanged");
    assert.equal(result.divergence.relation, "opposite_direction");
    assert.equal(Object.hasOwn(result, "nearestLevels"), false);
});
test("optionChanges are excluded", async () => {
    assert.equal(Object.hasOwn(await compare(), "optionChanges"), false);
});
test("IV is excluded", async () => {
    assert.equal(Object.hasOwn(await compare(), "iv"), false);
});
test("formal identities are retained in diagnostics", async () => {
    const result = await compare();
    assert.equal(result.diagnostics.qriIdentities.baseline.canonicalVersionKey, "qri-v1");
    assert.equal(result.diagnostics.qriIdentities.current.canonicalVersionKey, "qri-v2");
    assert.equal(result.diagnostics.logicVersion, "overall-v2-weights-55-45");
});
test("input is not mutated", async () => {
    const baseline = await snapshot(); const current = await snapshot({ capturedAt:
        "2026-08-26T12:00:00+09:00", evaluatedAt: "2026-08-26T12:00:00+09:00" });
    const before = structuredClone({ baseline, current });
    await Comparison.buildMorningComparisonV4({ baseline, currentSnapshot: current });
    assert.deepEqual({ baseline, current }, before);
});
test("output and nested states are deeply frozen", async () => {
    const result = await compare();
    for (const value of [result, result.comparability, result.comparability.checks,
        result.overallV2, result.optionComponent, result.price, result.divergence,
        result.diagnostics, result.diagnostics.priceIdentities]) assert.equal(Object.isFrozen(value), true);
});

const source = () => fs.readFileSync(path.join(__dirname, "../js/morningComparisonV4.js"), "utf8");
test("no storage", () => assert.equal(/localStorage|indexedDB|setItem\s*\(/.test(source()), false));
test("no runtime", () => assert.equal(/currentPriceState|getMobileSummaryRendererState|addEventListener/.test(source()), false));
test("no DOM", () => assert.equal(/document\.|querySelector|getElementById/.test(source()), false));
test("no Mobile", () => assert.equal(/MobileSummary|mobileMorning|mobileSummary/.test(source()), false));
test("no fetch timer or polling", () => assert.equal(/\bfetch\s*\(|setTimeout|setInterval|polling/.test(source()), false));
test("index loads pure comparison before its runtime", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.ok(html.indexOf("morningComparisonV4.js") >= 0);
    assert.ok(html.indexOf("morningComparisonV4.js") <
        html.indexOf("morningComparisonV4Runtime.js"));
});
