const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Eligibility = require("../js/qriOptionsSavedShadowIdentityEligibility.js");

const CURRENT_SIGNATURE = "a".repeat(64);
const PREVIOUS_SIGNATURE = "b".repeat(64);
const CURRENT_VERSION = "qri-options-v2|2026-09|current";
const PREVIOUS_VERSION = "qri-options-v2|2026-09|previous";
const currentIdentity = { contract: "2026-09", tradingDate: "2026-08-26",
    pageUpdatedAt: "2026-08-26T06:00:00+09:00",
    fetchedAt: "2026-08-26T06:10:00+09:00",
    canonicalSignature: CURRENT_SIGNATURE, canonicalVersionKey: CURRENT_VERSION,
    generation: 7 };

function fixture() {
    return { savedCurrentContext: { available: true, sourceKind: "saved",
        state: "saved_fallback", canonicalPresent: true, canonicalValid: true,
        integrityVerified: true, signatureValid: true, versionKeyValid: true,
        ...currentIdentity, coverage: { callPublishedCount: 12,
            putPublishedCount: 11 } },
    previousComparisonContext: { available: true, canonicalPresent: true,
        origin: "formal_history", canonicalValid: true, signatureValid: true,
        versionKeyValid: true, openInterestStatus: "available",
        identity: { contract: currentIdentity.contract, tradingDate: "2026-08-25",
            pageUpdatedAt: "2026-08-25T06:00:00+09:00",
            fetchedAt: "2026-08-25T06:10:00+09:00",
            canonicalSignature: PREVIOUS_SIGNATURE,
            canonicalVersionKey: PREVIOUS_VERSION },
        explicitRevisionComparison: false,
        coverage: { callPublishedCount: 12, putPublishedCount: 11,
            commonPublishedStrikeCount: 9, comparisonCoverageVerified: true,
            missingStrikeZeroFilled: false } },
    currentPriceContext: { available: true, source: "qri-nikkei225-futures",
        mode: "automatic", origin: "live", restored: false, value: 41625,
        contract: currentIdentity.contract, quotedAtRaw: "08/26 05:30",
        quoteDate: "2026-08-26", quotedAtNormalized: "2026-08-26T05:30:00+09:00",
        fetchedAt: "2026-08-26T05:31:00+09:00", identity: "price-live-1",
        versionKey: "price-v2-1", identityVerified: true,
        quoteDateResolution: "nearest_not_after_page_updated_at",
        quoteDateResolutionSource: "pageUpdatedAt", freshnessContextVerified: true,
        dateContext: { resolved: true, relation: "same_date",
            quoteDate: "2026-08-26", qriTradingDate: "2026-08-26",
            mappedTradingDate: "2026-08-26", tradingDateContextVerified: true,
            sessionContextVerified: false } },
    referenceContext: { available: true, identityVerified: true,
        identity: { ...currentIdentity }, currentSourceGeneration: 7,
        combinedIdentityVerified: true, combinedContractVerified: true,
        combinedDateContextVerified: true } };
}

const build = input => Eligibility.buildQriOptionsSavedShadowIdentityEligibility(input);

test("all validated identity facts are eligible", () => {
    const result = build(fixture());
    assert.deepEqual([result.eligibilityVersion, result.eligible, result.status,
        result.reason], [1, true, "eligible", null]);
    assert.deepEqual(result.combinedIdentity, { contract: "2026-09",
        currentTradingDate: "2026-08-26", previousTradingDate: "2026-08-25",
        priceQuoteDate: "2026-08-26", currentVersionKey: CURRENT_VERSION,
        previousVersionKey: PREVIOUS_VERSION });
});

test("invalid and superseded saved current fail closed", () => {
    const invalid = fixture(); invalid.savedCurrentContext.integrityVerified = false;
    assert.equal(build(invalid).reason, "saved_current_invalid");
    const generation = fixture(); generation.referenceContext.currentSourceGeneration = 8;
    assert.equal(build(generation).reason, "saved_current_invalid");
    const superseded = fixture(); superseded.savedCurrentContext.state = "superseded";
    assert.deepEqual([build(superseded).status, build(superseded).reason],
        ["superseded", "saved_current_superseded"]);
});

test("missing or invalid previous candidate is unavailable", () => {
    const missing = fixture(); missing.previousComparisonContext = null;
    assert.equal(build(missing).reason, "comparison_missing");
    const invalid = fixture(); invalid.previousComparisonContext.canonicalValid = false;
    assert.equal(build(invalid).reason, "comparison_invalid");
    const unpublished = fixture();
    unpublished.previousComparisonContext.openInterestStatus = "unavailable";
    assert.equal(build(unpublished).reason, "comparison_invalid");
});

test("comparison contract mismatch and future previous are rejected", () => {
    const contract = fixture();
    contract.previousComparisonContext.identity.contract = "2026-12";
    assert.equal(build(contract).reason, "comparison_contract_mismatch");
    const future = fixture();
    future.previousComparisonContext.identity.tradingDate = "2026-08-27";
    assert.deepEqual([build(future).reason, build(future).comparison.dateRelation],
        ["comparison_date_invalid", "future"]);
});

test("same versionKey or signature is rejected as the same acquisition", () => {
    const version = fixture();
    version.previousComparisonContext.identity.canonicalVersionKey = CURRENT_VERSION;
    assert.equal(build(version).reason, "comparison_same_acquisition");
    const signature = fixture();
    signature.previousComparisonContext.identity.canonicalSignature = CURRENT_SIGNATURE;
    assert.equal(build(signature).diagnostics.sameAcquisitionRejected, true);
});

test("same-date revision requires complete formal revision proof", () => {
    const input = fixture();
    input.previousComparisonContext.identity.tradingDate = currentIdentity.tradingDate;
    input.previousComparisonContext.explicitRevisionComparison = true;
    assert.equal(build(input).reason, "comparison_same_date_unqualified");
    input.previousComparisonContext.revisionIdentity = {
        entryKey: "2026-09|2026-08-26", orderVerified: true,
        previousRevisionKey: `2026-09|2026-08-26|${PREVIOUS_VERSION}`,
        currentRevisionKey: `2026-09|2026-08-26|${CURRENT_VERSION}`,
        activeVersionKey: CURRENT_VERSION,
        previousReplacedAt: "2026-08-26T06:05:00+09:00",
        previousVersionKey: PREVIOUS_VERSION, currentVersionKey: CURRENT_VERSION };
    assert.equal(build(input).eligible, true);
});

test("coverage requires both sides and verified common published strikes", () => {
    for (const change of [
        value => { value.callPublishedCount = 0; },
        value => { value.putPublishedCount = 0; },
        value => { value.commonPublishedStrikeCount = 0; },
        value => { value.comparisonCoverageVerified = false; },
        value => { value.missingStrikeZeroFilled = true; }
    ]) {
        const input = fixture(); change(input.previousComparisonContext.coverage);
        assert.equal(build(input).reason, "comparison_coverage_insufficient");
    }
});

test("coverage policy does not invent a numeric threshold or zero-fill strikes", () => {
    const input = fixture();
    input.previousComparisonContext.coverage.commonPublishedStrikeCount = 1;
    const result = build(input);
    assert.equal(result.eligible, true);
    assert.equal(result.comparison.coverage.missingStrikeZeroFilled, false);
    assert.equal(Object.hasOwn(result.comparison.coverage, "threshold"), false);
});

test("missing manual restored and malformed price candidates are rejected", () => {
    const missing = fixture(); missing.currentPriceContext = null;
    assert.equal(build(missing).reason, "price_missing");
    const manual = fixture(); manual.currentPriceContext.mode = "manual";
    assert.equal(build(manual).reason, "price_manual");
    const restored = fixture(); restored.currentPriceContext.restored = true;
    assert.equal(build(restored).reason, "price_restored");
    const malformed = fixture(); malformed.currentPriceContext.fetchedAt = "bad";
    assert.equal(build(malformed).reason, "price_invalid");
});

test("zero negative NaN and infinite prices remain invalid", () => {
    for (const value of [0, -1, NaN, Infinity]) {
        const input = fixture(); input.currentPriceContext.value = value;
        assert.equal(build(input).reason, "price_invalid");
    }
});

test("price contract and opaque identity must match", () => {
    const contract = fixture(); contract.currentPriceContext.contract = "2026-12";
    assert.equal(build(contract).reason, "price_contract_mismatch");
    const identity = fixture(); identity.currentPriceContext.identityVerified = false;
    assert.equal(build(identity).reason, "price_identity_invalid");
});

test("quote date context cannot be inferred from the QRI page date", () => {
    const unresolved = fixture();
    unresolved.currentPriceContext.dateContext.resolved = false;
    assert.equal(build(unresolved).reason, "price_date_context_unresolved");
    const copied = fixture(); copied.currentPriceContext.quoteDateResolution = "page_trading_date";
    assert.equal(build(copied).reason, "price_date_context_unresolved");
});

test("explicitly proven overnight mapping is eligible", () => {
    const input = fixture();
    Object.assign(input.currentPriceContext, { quotedAtRaw: "08/25 23:30",
        quoteDate: "2026-08-25",
        quotedAtNormalized: "2026-08-25T23:30:00+09:00" });
    Object.assign(input.currentPriceContext.dateContext, {
        relation: "overnight_previous_date", quoteDate: "2026-08-25",
        mappedTradingDate: "2026-08-26", sessionContextVerified: true });
    assert.deepEqual([build(input).eligible, build(input).currentPrice.dateRelation],
        [true, "overnight_previous_date"]);
});

test("unproven overnight mapping remains unavailable", () => {
    const input = fixture();
    Object.assign(input.currentPriceContext, { quoteDate: "2026-08-25",
        quotedAtNormalized: "2026-08-25T23:30:00+09:00" });
    Object.assign(input.currentPriceContext.dateContext, {
        relation: "overnight_previous_date", quoteDate: "2026-08-25",
        sessionContextVerified: false });
    assert.equal(build(input).reason, "price_date_context_unresolved");
});

test("combined identity proof is mandatory after individual eligibility", () => {
    for (const field of ["combinedIdentityVerified", "combinedContractVerified",
        "combinedDateContextVerified"]) {
        const input = fixture(); input.referenceContext[field] = false;
        assert.equal(build(input).reason, "combined_identity_mismatch");
    }
});

test("identity failures never receive a quality fallback", () => {
    const input = fixture(); input.currentPriceContext.identityVerified = false;
    const result = build(input);
    assert.deepEqual([result.eligible, result.status], [false, "unavailable"]);
    assert.equal(JSON.stringify(result).includes("qualityFactor"), false);
});

test("formal and trade consumers remain permanently disconnected", () => {
    const result = build(fixture());
    assert.deepEqual([result.referenceOnly, result.formalApplied,
        result.tradeDecisionEligible], [true, false, false]);
    assert.deepEqual([result.diagnostics.formalApplied,
        result.diagnostics.tradeDecisionEligible], [false, false]);
});

test("input is unchanged and every output identity fact is deeply frozen", () => {
    const input = fixture(); const before = JSON.stringify(input); const result = build(input);
    assert.equal(JSON.stringify(input), before);
    for (const value of [result, result.savedCurrent, result.savedCurrent.identity,
        result.savedCurrent.coverage, result.comparison, result.comparison.identity,
        result.comparison.coverage, result.currentPrice, result.currentPrice.identity,
        result.combinedIdentity, result.diagnostics]) assert.equal(Object.isFrozen(value), true);
});

test("diagnostics contain only eligibility and isolation facts", () => {
    const result = build(fixture());
    assert.deepEqual(result.diagnostics, { savedCurrentEligible: true,
        comparisonEligible: true, priceEligible: true, contractMatched: true,
        comparisonDateRelation: "previous", priceDateRelation: "same_date",
        sameAcquisitionRejected: false, sameDateRevisionRejected: false,
        coverageComparable: true, dateContextResolved: true,
        formalApplied: false, tradeDecisionEligible: false,
        storageAccessed: false, databaseAccessed: false, historyAccessed: false,
        fetchTriggered: false, runtimeAccessed: false, domAccessed: false });
});

test("module has no calculation persistence network runtime or DOM connector", () => {
    const code = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsSavedShadowIdentityEligibility.js"), "utf8");
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|setItem|removeItem/);
    assert.doesNotMatch(code, /\bfetch\s*\(|ipcRenderer|document\.|querySelector|\bChart\b/);
    assert.doesNotMatch(code, /setTimeout|setInterval|migration|backfill/);
    assert.doesNotMatch(code, /calculateOptionMarketJudgment|calculateOverallJudgmentV2/);
    assert.doesNotMatch(code, /scoreDifference|confidence|nearby|priceDistance|openInterestDiff/);
    assert.doesNotMatch(code, /OptionMapQriOptionsHistory|HistoryStore|CurrentPriceLastValid/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.equal(html.includes("qriOptionsSavedShadowIdentityEligibility.js"), false);
});
