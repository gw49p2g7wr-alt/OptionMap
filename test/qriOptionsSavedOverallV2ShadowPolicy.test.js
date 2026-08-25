const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Policy = require("../js/qriOptionsSavedOverallV2ShadowPolicy.js");

const CURRENT_SIGNATURE = "a".repeat(64);
const PREVIOUS_SIGNATURE = "b".repeat(64);
const CURRENT_VERSION = "qri-options-v2|2026-09|current";
const PREVIOUS_VERSION = "qri-options-v2|2026-09|previous";
const sourceIdentity = { contract: "2026-09", tradingDate: "2026-08-25",
    canonicalSignature: CURRENT_SIGNATURE, canonicalVersionKey: CURRENT_VERSION,
    displayGeneration: 7 };

function fixture() {
    return { savedSourceState: { available: true, sourceKind: "saved",
        state: "saved_fallback", contract: sourceIdentity.contract,
        displayEligible: true, metadata: { ...sourceIdentity },
        diagnostics: { savedIntegrityVerified: true } },
    savedReferenceAnalysisState: { accepted: true, available: true,
        sourceKind: "saved", referenceOnly: true, calculationEligible: false,
        identity: { ...sourceIdentity },
        freshness: { tier: "same_trading_date_verified" } },
    comparisonContext: { available: true, previousCanonicalPresent: true,
        currentContract: sourceIdentity.contract,
        currentTradingDate: sourceIdentity.tradingDate,
        currentSignature: CURRENT_SIGNATURE, currentVersionKey: CURRENT_VERSION,
        currentSignatureValid: true, previousSignatureValid: true,
        currentVersionKeyValid: true, previousVersionKeyValid: true,
        tradingDateOrderVerified: true, explicitRevisionComparison: false,
        previousIdentity: { contract: sourceIdentity.contract,
            tradingDate: "2026-08-24", canonicalSignature: PREVIOUS_SIGNATURE,
            canonicalVersionKey: PREVIOUS_VERSION },
        coverage: { callComparable: true, putComparable: true } },
    currentPriceContext: { available: true, mode: "automatic", value: 41625,
        origin: "live", restored: false, identity: "qri-price-live-1",
        identityVerified: true, contract: sourceIdentity.contract,
        tradingDate: sourceIdentity.tradingDate,
        quotedAt: "2026-08-25T05:30:00+09:00" },
    formalOverallV2Context: { available: true, identity: "formal-1",
        fingerprint: "formal-fingerprint-1" } };
}

const build = input => Policy.buildQriOptionsSavedOverallV2ShadowPolicy(input);

test("all identity facts make the saved source shadow-eligible", () => {
    const result = build(fixture());
    assert.deepEqual([result.policyVersion, result.eligible, result.status,
        result.reason], [1, true, "eligible", null]);
    assert.equal(result.diagnostics.sourceEligible, true);
});

test("live legacy and unavailable sources are rejected", () => {
    for (const sourceKind of ["live", "legacy", "unavailable"]) {
        const input = fixture(); input.savedSourceState.sourceKind = sourceKind;
        const result = build(input);
        assert.deepEqual([result.eligible, result.status, result.reason],
            [false, "shadow_unavailable", "saved_source_unavailable"]);
    }
});

test("invalid saved source and reference identity are rejected", () => {
    const hidden = fixture(); hidden.savedSourceState.available = false;
    assert.equal(build(hidden).eligible, false);
    const integrity = fixture();
    integrity.savedSourceState.diagnostics.savedIntegrityVerified = false;
    assert.equal(build(integrity).reason, "saved_source_unavailable");
    const generation = fixture();
    generation.savedReferenceAnalysisState.identity.displayGeneration = 8;
    assert.equal(build(generation).eligible, false);
});

test("superseded source has a dedicated terminal policy state", () => {
    const input = fixture(); input.savedSourceState.state = "superseded";
    const result = build(input);
    assert.deepEqual([result.eligible, result.status, result.reason,
        result.freshnessTier], [false, "superseded", "saved_source_superseded",
        "superseded"]);
});

test("missing comparison and previous canonical are unavailable", () => {
    const missing = fixture(); missing.comparisonContext = null;
    assert.equal(build(missing).reason, "comparison_unavailable");
    const previous = fixture();
    previous.comparisonContext.previousCanonicalPresent = false;
    assert.equal(build(previous).reason, "comparison_unavailable");
});

test("comparison contract and identity mismatches fail closed", () => {
    const contract = fixture();
    contract.comparisonContext.previousIdentity.contract = "2026-12";
    assert.equal(build(contract).reason, "comparison_identity_invalid");
    const signature = fixture(); signature.comparisonContext.previousSignatureValid = false;
    assert.equal(build(signature).eligible, false);
    const version = fixture(); version.comparisonContext.currentVersionKeyValid = false;
    assert.equal(build(version).eligible, false);
    const currentVersion = fixture();
    currentVersion.comparisonContext.currentVersionKey = "different-current";
    assert.equal(build(currentVersion).comparisonEligibility.currentIdentityMatched, false);
    const currentSignature = fixture();
    currentSignature.comparisonContext.currentSignature = "c".repeat(64);
    assert.equal(build(currentSignature).eligible, false);
});

test("same version or signature is rejected as self-comparison", () => {
    const version = fixture();
    version.comparisonContext.previousIdentity.canonicalVersionKey = CURRENT_VERSION;
    assert.deepEqual([build(version).reason,
        build(version).diagnostics.sameVersionRejected],
    ["same_acquisition_rejected", true]);
    const signature = fixture();
    signature.comparisonContext.previousIdentity.canonicalSignature = CURRENT_SIGNATURE;
    assert.deepEqual([build(signature).reason,
        build(signature).diagnostics.sameSignatureRejected],
    ["same_acquisition_rejected", true]);
});

test("same-date revision requires explicit revision context", () => {
    const input = fixture();
    input.comparisonContext.previousIdentity.tradingDate = sourceIdentity.tradingDate;
    assert.equal(build(input).reason, "same_date_revision_unqualified");
    input.comparisonContext.explicitRevisionComparison = true;
    assert.equal(build(input).eligible, true);
});

test("CALL and PUT comparison coverage are both mandatory", () => {
    for (const side of ["callComparable", "putComparable"]) {
        const input = fixture(); input.comparisonContext.coverage[side] = false;
        assert.equal(build(input).reason, "comparison_coverage_unavailable");
    }
});

test("missing manual invalid and mismatched CurrentPrice are rejected", () => {
    const missing = fixture(); missing.currentPriceContext = null;
    assert.equal(build(missing).reason, "current_price_unavailable");
    const manual = fixture(); manual.currentPriceContext.mode = "manual";
    assert.equal(build(manual).eligible, false);
    for (const value of [0, -1, NaN, Infinity]) {
        const input = fixture(); input.currentPriceContext.value = value;
        assert.equal(build(input).eligible, false);
    }
    const contract = fixture(); contract.currentPriceContext.contract = "2026-12";
    assert.equal(build(contract).diagnostics.contractMatched, false);
});

test("CurrentPrice date and identity context must be verified", () => {
    const date = fixture(); date.currentPriceContext.tradingDate = "2026-08-24";
    assert.equal(build(date).eligible, false);
    const quote = fixture(); quote.currentPriceContext.quotedAt = null;
    assert.equal(build(quote).eligible, false);
    const identity = fixture(); identity.currentPriceContext.identityVerified = false;
    assert.equal(build(identity).eligible, false);
});

test("saved CurrentPrice has a separate unsupported identity class", () => {
    const input = fixture();
    Object.assign(input.currentPriceContext, { origin: "cache", restored: true });
    const result = build(input);
    assert.deepEqual([result.eligible, result.reason,
        result.currentPriceEligibility.identityClass],
    [false, "saved_current_price_policy_undefined", "saved"]);
});

test("same trading date alone cannot overcome missing comparison or price identity", () => {
    const comparison = fixture(); comparison.comparisonContext.available = false;
    assert.equal(build(comparison).eligible, false);
    const price = fixture(); price.currentPriceContext.identity = null;
    assert.equal(build(price).eligible, false);
    assert.equal(build(price).freshnessTier, "same_trading_date_verified");
});

test("freshness tier is retained without granting eligibility", () => {
    for (const tier of ["same_trading_date_verified", "older_trading_date",
        "calendar_context_unresolved", "reference_date_unknown",
        "contract_mismatch"]) {
        const input = fixture();
        input.savedReferenceAnalysisState.freshness.tier = tier;
        input.currentPriceContext.identity = null;
        const result = build(input);
        assert.deepEqual([result.freshnessTier, result.eligible], [tier, false]);
    }
});

test("formal application trade decisions and every formal consumer remain disabled", () => {
    const result = build(fixture());
    assert.deepEqual([result.referenceOnly, result.formalApplied,
        result.tradeDecisionEligible], [true, false, false]);
    assert.deepEqual(result.guards, { allowFormalStateWrite: false,
        allowOverallV2Write: false, allowMobile: false, allowMorning: false,
        allowObservation: false, allowAlerts: false });
});

test("identity failure is unavailable and never replaced by a quality fallback", () => {
    const input = fixture(); input.currentPriceContext.identity = null;
    const result = build(input);
    assert.deepEqual([result.eligible, result.status], [false, "shadow_unavailable"]);
    assert.equal(JSON.stringify(result).includes("qualityFactor"), false);
    assert.equal(JSON.stringify(result).includes("0.70"), false);
});

test("formal baseline is copied read-only without changing the input", () => {
    const input = fixture(); const before = JSON.stringify(input);
    const result = build(input);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(result.formalBaseline, { available: true,
        identity: "formal-1", fingerprint: "formal-fingerprint-1" });
    assert.notStrictEqual(result.formalBaseline, input.formalOverallV2Context);
});

test("output identity guards diagnostics and eligibility facts are deeply frozen", () => {
    const result = build(fixture());
    for (const value of [result, result.sourceIdentity,
        result.comparisonEligibility, result.comparisonEligibility.previousIdentity,
        result.currentPriceEligibility, result.formalBaseline, result.guards,
        result.diagnostics]) assert.equal(Object.isFrozen(value), true);
});

test("diagnostics expose only technical policy facts", () => {
    const result = build(fixture());
    assert.deepEqual(result.diagnostics, { sourceEligible: true,
        comparisonEligible: true, currentPriceEligible: true,
        contractMatched: true, tradingDateContextValid: true,
        freshnessTier: "same_trading_date_verified", sameVersionRejected: false,
        sameSignatureRejected: false, formalBaselineAvailable: true,
        formalApplied: false, tradeDecisionEligible: false,
        storageAccessed: false, historyWritten: false, fetchTriggered: false,
        runtimeAccessed: false, domAccessed: false });
});

test("module is pure disconnected and contains no calculation or side effect connector", () => {
    const code = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsSavedOverallV2ShadowPolicy.js"), "utf8");
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|setItem|removeItem/);
    assert.doesNotMatch(code, /\bfetch\s*\(|ipcRenderer|document\.|querySelector|\bChart\b/);
    assert.doesNotMatch(code, /setTimeout|setInterval|migration|backfill/);
    assert.doesNotMatch(code, /calculateOptionMarketJudgment|calculateOverallJudgmentV2/);
    assert.doesNotMatch(code, /optionMapJudgmentState|OptionMapMobileSummary|OptionMapMorningBaseline|OptionMapMarketObservation/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal(html.includes("qriOptionsSavedOverallV2ShadowPolicy.js"), false);
});
