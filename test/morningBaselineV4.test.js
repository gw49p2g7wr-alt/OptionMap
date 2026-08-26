const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const V4 = require("../js/morningBaselineV4.js");

const identity = (source, versionKey) => ({ source, versionKey,
    signature: `sha256:${source}-signature`, verified: true });
const component = (name, direction, quality, weight) => ({ name, available: true,
    invalid: false, normalizedDirection: direction, directionScore: direction * 100,
    baseWeight: weight, qualityFactor: quality, effectiveWeight: weight * quality,
    weightedContribution: direction * weight * quality, evidenceFactor: Math.abs(direction),
    notes: [], metadata: { scoreDifference: direction * 8 } });

function fixture() {
    const option = component("option", 0.5, 1, 55);
    const weekly = component("weekly", 0.2, 0.9, 45);
    return {
        capturedAt: "2026-08-26T08:00:00+09:00",
        marketContext: { captureCalendarDate: "2026-08-26",
            formalTradingDate: "2026-08-26", sessionIdentity: "jpx-day-2026-08-26",
            sessionMappingStatus: "verified" },
        overallV2Context: { origin: "formal_live", formalApplied: true, superseded: false,
            logicVersion: "overall-v2-weights-55-45", evaluatedAt: "2026-08-26T08:00:00+09:00",
            inputIdentity: identity("overall-v2-input", "overall-input-v1"),
            componentIdentities: { option: identity("qri-options", "qri-v1"),
                weekly: identity("weekly-futures-history", "weekly-v1") },
            result: { status: "complete", direction: 37, directionLabel: "買い優勢",
                confidence: 78, confidenceFactors: { coverage: 100, quality: 95,
                    evidence: 35, agreement: 85 }, effectiveWeightTotal: 95.5,
                components: { option, weekly }, invalidComponents: [],
                metadata: { calculatedAt: "2026-08-26T08:00:00+09:00",
                    availableComponentCount: 2, plannedComponentCount: 2, coverage: 100,
                    warnings: [], timeHorizon: { code: "multi_day", label: "1日～数日" } } } },
        currentPriceContext: { available: true, sourceKind: "live", origin: "live",
            mode: "automatic", value: 42000, contract: "2026-09", quoteDate: "2026-08-26",
            quotedAtNormalized: "2026-08-26T07:59:00+09:00",
            quoteSignature: "a".repeat(64), versionKey: "price-v1",
            wrapperSignature: "b".repeat(64), requestId: "request-1",
            fetchedAt: "2026-08-26T08:00:00+09:00", currentRequestVerified: true,
            identityVerified: true, acquisitionVerified: true,
            acquisitionIdentity: { requestId: "request-1",
                fetchedAt: "2026-08-26T08:00:00+09:00",
                sourceUrl: "https://svc.qri.jp/jpx/nkopm/",
                wrapperSignature: "b".repeat(64) },
            qriTradingDateMapping: { status: "verified", quoteDate: "2026-08-26",
                qriTradingDate: "2026-08-26", relation: "same_date", mappingVerified: true,
                mappingSource: "same_date_explicit" } },
        qriContext: { available: true, origin: "formal_live", sourceKind: "live",
            formalRevisionAvailable: true, referenceOnly: false, usingFallback: false,
            restored: false, superseded: false, openInterestStatus: "available",
            identity: { verified: true, contract: "2026-09", tradingDate: "2026-08-26",
                pageUpdatedAt: "2026-08-26T07:58:00+09:00",
                canonicalSignature: "c".repeat(64), canonicalVersionKey: "qri-v1",
                historyEntryId: "2026-09|2026-08-26", historyRevisionId: "qri-v1" } },
        weeklyContext: { available: true, origin: "formal_history", formalApplied: true,
            usingFallback: false, superseded: false, sourceDate: "2026-08-21",
            versionKey: "weekly-v1", signature: null, identityVerified: true,
            normalizedDirection: 0.2, qualityFactor: 0.9, effectiveWeight: 40.5,
            weightedContribution: 8.1,
            metadata: { previousVersionKey: "weekly-v0", currentVersionKey: "weekly-v1" } },
        nearestLevelsContext: { generatedFromFormalOnly: true, referenceOnly: false,
            usingFallback: false, contract: "2026-09", sourceVersionKey: "qri-v1",
            upper: { available: true, price: 42500, distance: 500, optionType: "CALL" },
            lower: { available: true, price: 41500, distance: 500, optionType: "PUT" } },
        dataQualityContext: { status: "complete", warnings: [],
            sourceAvailability: { overallV2: true, currentPrice: true, qri: true, weekly: true },
            fallbackFlags: { currentPrice: false, qri: false, weekly: false },
            componentAvailability: { option: true, weekly: true } }
    };
}

const build = overrides => {
    const input = fixture();
    for (const [key, value] of Object.entries(overrides || {})) {
        if (value && typeof value === "object" && !Array.isArray(value) &&
            input[key] && typeof input[key] === "object") Object.assign(input[key], value);
        else input[key] = value;
    }
    return V4.buildMorningBaselineV4(input);
};

test("valid formal live snapshot builds and validates", async () => {
    const result = await build();
    assert.deepEqual([result.success, result.reason], [true, null]);
    assert.equal(await V4.validateMorningBaselineV4(result.baseline), true);
});

test("saved QRI is rejected", async () => {
    assert.equal((await build({ qriContext: { origin: "saved" } })).reason, "qri_not_formal");
});
test("reference-only QRI is rejected", async () => {
    assert.equal((await build({ qriContext: { referenceOnly: true } })).reason, "qri_not_formal");
});
test("legacy QRI fallback is rejected", async () => {
    assert.equal((await build({ qriContext: { usingFallback: true } })).reason, "qri_not_formal");
});
test("manual CurrentPrice is rejected", async () => {
    assert.equal((await build({ currentPriceContext: { mode: "manual" } })).reason,
        "current_price_not_live");
});
test("restored CurrentPrice is rejected", async () => {
    assert.equal((await build({ currentPriceContext: { origin: "cache" } })).reason,
        "current_price_not_live");
});
test("invalid CurrentPrice identity is rejected", async () => {
    assert.equal((await build({ currentPriceContext: { identityVerified: false } })).reason,
        "current_price_identity_invalid");
});
test("QRI contract mismatch is rejected", async () => {
    const input = fixture(); input.qriContext.identity.contract = "2026-12";
    assert.equal((await V4.buildMorningBaselineV4(input)).reason, "contract_mismatch");
});
test("invalid Weekly identity is rejected", async () => {
    assert.equal((await build({ weeklyContext: { identityVerified: false } })).reason,
        "weekly_identity_invalid");
});
test("unavailable OverallV2 is rejected", async () => {
    const input = fixture(); input.overallV2Context.result.status = "unavailable";
    assert.equal((await V4.buildMorningBaselineV4(input)).reason, "overall_unavailable");
});
test("missing logic version is rejected", async () => {
    assert.equal((await build({ overallV2Context: { logicVersion: null } })).reason,
        "logic_version_missing");
});

test("option component is retained", async () => {
    const option = (await build()).baseline.overallV2.components.option;
    assert.deepEqual([option.name, option.directionScore], ["option", 50]);
});
test("weekly component is retained", async () => {
    const weekly = (await build()).baseline.overallV2.components.weekly;
    assert.deepEqual([weekly.name, weekly.directionScore], ["weekly", 20]);
});
test("qualityFactor is retained", async () => {
    assert.equal((await build()).baseline.overallV2.components.weekly.qualityFactor, 0.9);
});
test("effectiveWeight is retained", async () => {
    assert.equal((await build()).baseline.overallV2.components.option.effectiveWeight, 55);
});
test("weightedContribution is retained", async () => {
    assert.equal((await build()).baseline.overallV2.components.weekly.weightedContribution, 8.1);
});
test("CurrentPrice identity is retained", async () => {
    const price = (await build()).baseline.currentPrice;
    assert.deepEqual([price.quoteSignature, price.versionKey, price.requestId],
        ["a".repeat(64), "price-v1", "request-1"]);
});
test("QRI formal history identity is retained", async () => {
    const qri = (await build()).baseline.qri;
    assert.deepEqual([qri.historyEntryId, qri.historyRevisionId],
        ["2026-09|2026-08-26", "qri-v1"]);
});
test("nearestLevels formal snapshot is retained", async () => {
    const levels = (await build()).baseline.nearestLevels;
    assert.deepEqual([levels.upper.price, levels.lower.price, levels.generatedFromFormalOnly],
        [42500, 41500, true]);
});
test("nearestLevels explicit null builds a schema-valid Phase 1 snapshot", async () => {
    const result = await build({ nearestLevelsContext: null });
    assert.equal(result.success, true);
    assert.equal(Object.hasOwn(result.baseline, "nearestLevels"), true);
    assert.equal(result.baseline.nearestLevels, null);
    assert.equal(await V4.validateMorningBaselineV4(result.baseline), true);
});
test("nearestLevels input omission is not treated as explicit null", async () => {
    const input = fixture(); delete input.nearestLevelsContext;
    assert.equal((await V4.buildMorningBaselineV4(input)).reason, "qri_identity_invalid");
});
test("nearestLevels field omission from a final baseline is rejected", async () => {
    const baseline = structuredClone((await build({ nearestLevelsContext: null })).baseline);
    delete baseline.nearestLevels;
    assert.equal(await V4.validateMorningBaselineV4(baseline), false);
});
for (const [name, mutate] of [
    ["malformed", value => { value.upper.price = NaN; }],
    ["unknown context field", value => { value.unexpected = true; }],
    ["unknown level field", value => { value.upper.unexpected = true; }],
    ["invalid contract", value => { value.contract = "2026-12"; }],
    ["invalid sourceVersionKey", value => { value.sourceVersionKey = "qri-v0"; }],
    ["not formal-only", value => { value.generatedFromFormalOnly = false; }],
    ["reference-only", value => { value.referenceOnly = true; }],
    ["fallback", value => { value.usingFallback = true; }],
    ["saved-like", value => { value.origin = "saved"; }]
]) test(`nearestLevels ${name} non-null input is rejected instead of becoming null`, async () => {
    const input = fixture(); mutate(input.nearestLevelsContext);
    const result = await V4.buildMorningBaselineV4(input);
    assert.equal(result.success, false); assert.equal(result.baseline, null);
});
test("nearestLevels unknown final field is rejected", async () => {
    const baseline = structuredClone((await build()).baseline);
    baseline.nearestLevels.upper.unexpected = true;
    assert.equal(await V4.validateMorningBaselineV4(baseline), false);
});
test("DataQuality facts are retained", async () => {
    const quality = (await build()).baseline.dataQuality;
    assert.deepEqual([quality.status, quality.sourceAvailability.qri,
        quality.fallbackFlags.qri], ["complete", true, false]);
});
test("schema contains no IV", async () => {
    assert.equal(Object.hasOwn((await build()).baseline, "iv"), false);
});
test("schema contains no optionChanges result", async () => {
    assert.equal(Object.hasOwn((await build()).baseline, "optionChanges"), false);
});

test("signature is deterministic", async () => {
    assert.equal((await build()).baseline.signature, (await build()).baseline.signature);
});
test("null nearestLevels content signature and versionKey are deterministic", async () => {
    const first = (await build({ nearestLevelsContext: null })).baseline;
    const second = (await build({ nearestLevelsContext: null })).baseline;
    assert.deepEqual([first.contentSignature, first.versionKey],
        [second.contentSignature, second.versionKey]);
});
test("null to actual nearestLevels changes content identity", async () => {
    const absent = (await build({ nearestLevelsContext: null })).baseline;
    const actual = (await build()).baseline;
    assert.notEqual(absent.contentSignature, actual.contentSignature);
    assert.notEqual(absent.versionKey, actual.versionKey);
});
test("capturedAt-only change keeps null nearestLevels content identity", async () => {
    const first = (await build({ nearestLevelsContext: null })).baseline;
    const second = (await build({ nearestLevelsContext: null,
        capturedAt: "2026-08-26T09:00:00+09:00" })).baseline;
    assert.equal(first.contentSignature, second.contentSignature);
    assert.equal(first.versionKey, second.versionKey);
    assert.notEqual(first.signature, second.signature);
});
test("null nearestLevels does not alter DataQuality", async () => {
    const actual = (await build()).baseline.dataQuality;
    const absent = (await build({ nearestLevelsContext: null })).baseline.dataQuality;
    assert.deepEqual(absent, actual);
});
test("signature tampering is rejected", async () => {
    const baseline = structuredClone((await build()).baseline); baseline.currentPrice.value += 1;
    assert.equal(await V4.validateMorningBaselineV4(baseline), false);
});
test("versionKey is stable for the same formal identity", async () => {
    const first = (await build()).baseline;
    const second = (await build({ capturedAt: "2026-08-26T09:00:00+09:00" })).baseline;
    assert.equal(first.versionKey, second.versionKey);
});
test("versionKey changes when a source identity changes", async () => {
    const first = (await build()).baseline;
    const input = fixture();
    input.qriContext.identity.canonicalVersionKey = "qri-v2";
    input.qriContext.identity.historyRevisionId = "qri-v2";
    input.nearestLevelsContext.sourceVersionKey = "qri-v2";
    input.overallV2Context.componentIdentities.option.versionKey = "qri-v2";
    const second = (await V4.buildMorningBaselineV4(input)).baseline;
    assert.notEqual(first.versionKey, second.versionKey);
});
test("capturedAt changes capture identity but not snapshot identity", async () => {
    const first = (await build()).baseline;
    const second = (await build({ capturedAt: "2026-08-26T09:00:00+09:00" })).baseline;
    assert.equal(first.contentSignature, second.contentSignature);
    assert.notEqual(first.signature, second.signature);
    assert.notEqual(first.baselineId, second.baselineId);
});
test("verified session is comparison-ready", async () => {
    const baseline = (await build()).baseline;
    assert.deepEqual([baseline.comparability.sessionVerified,
        baseline.comparability.comparisonClass], [true, "formal_live_verified_session"]);
});
test("unresolved session can be captured but stays a separate comparison class", async () => {
    const result = await build({ marketContext: { sessionIdentity: null,
        sessionMappingStatus: "unresolved" } });
    assert.deepEqual([result.success, result.reason, result.baseline.comparability.sessionVerified],
        [true, "session_context_unresolved", false]);
});
test("builder does not mutate input", async () => {
    const input = fixture(); const before = structuredClone(input);
    await V4.buildMorningBaselineV4(input);
    assert.deepEqual(input, before);
});
test("output and nested state are deeply frozen", async () => {
    const result = await build();
    for (const value of [result, result.baseline, result.baseline.marketContext,
        result.baseline.overallV2.components.option.sourceIdentity,
        result.baseline.currentPrice.acquisitionIdentity, result.baseline.comparability])
        assert.equal(Object.isFrozen(value), true);
});
test("top-level schema uses exact fields", async () => {
    const baseline = structuredClone((await build()).baseline); baseline.unexpected = true;
    assert.equal(await V4.validateMorningBaselineV4(baseline), false);
    assert.deepEqual(Object.keys((await build()).baseline).sort(), [...V4.TOP_LEVEL_FIELDS].sort());
});
test("schema version remains v4 schema 1 with null nearestLevels", async () => {
    const baseline = (await build({ nearestLevelsContext: null })).baseline;
    assert.deepEqual([baseline.baselineVersion, baseline.schemaVersion], [4, 1]);
});

test("module has no storage dependency", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/morningBaselineV4.js"), "utf8");
    assert.equal(/localStorage|indexedDB|setItem\s*\(|getItem\s*\(/.test(source), false);
});
test("module has no runtime wiring", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/morningBaselineV4.js"), "utf8");
    assert.equal(/currentPriceState|getMobileSummaryRendererState|addEventListener/.test(source), false);
});
test("module has no DOM connection", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/morningBaselineV4.js"), "utf8");
    assert.equal(/document\.|querySelector|getElementById/.test(source), false);
});
test("module has no Mobile dependency", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/morningBaselineV4.js"), "utf8");
    assert.equal(/MobileSummary|mobileMorning|mobileSummary/.test(source), false);
});
test("module has no network or scheduling", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/morningBaselineV4.js"), "utf8");
    assert.equal(/\bfetch\s*\(|setTimeout|setInterval|polling/.test(source), false);
});
test("existing Morning v1-v3 files are not connected or modified", () => {
    const index = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const legacy = fs.readFileSync(path.join(__dirname, "../js/morningBaseline.js"), "utf8");
    assert.equal(index.includes("morningBaselineV4.js"), false);
    assert.match(legacy, /const BASELINE_VERSION = 3;/);
    assert.doesNotMatch(legacy, /OptionMapMorningBaselineV4/);
});
test("saved/reference/fallback flags cannot enter formal DataQuality", async () => {
    const input = fixture(); input.dataQualityContext.fallbackFlags.qri = true;
    assert.equal((await V4.buildMorningBaselineV4(input)).reason, "data_quality_invalid");
});
test("superseded formal sources fail closed", async () => {
    assert.equal((await build({ qriContext: { superseded: true } })).reason, "qri_not_formal");
    assert.equal((await build({ weeklyContext: { superseded: true } })).reason,
        "weekly_identity_invalid");
});
