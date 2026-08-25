const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Analysis = require("../js/qriOptionsSavedReferenceAnalysis.js");

const SIGNATURE = "a".repeat(64);
const VERSION_KEY = "qri-options-v2|2026-09|saved";
const identity = { contract: "2026-09", tradingDate: "2026-08-25",
    pageUpdatedAt: "2026-08-25T05:50:00+09:00",
    fetchedAt: "2026-08-25T06:10:00Z", canonicalSignature: SIGNATURE,
    canonicalVersionKey: VERSION_KEY, displayGeneration: 7 };
const rows = [
    { strike: 65000, callOpenInterest: 500, putOpenInterest: 80,
        callPublished: true, putPublished: true },
    { strike: 64500, callOpenInterest: 900, putOpenInterest: 700,
        callPublished: true, putPublished: true },
    { strike: 65500, callOpenInterest: 900, putOpenInterest: null,
        callPublished: true, putPublished: false },
    { strike: 64000, callOpenInterest: 100, putOpenInterest: 700,
        callPublished: false, putPublished: true },
    { strike: 63500, callOpenInterest: 300, putOpenInterest: 200,
        callPublished: true, putPublished: true }
];

function fixture(overrides = {}) {
    const displaySourceState = { available: true, sourceKind: "saved",
        state: "saved_fallback", contract: identity.contract,
        displayEligible: true, displayGeneration: identity.displayGeneration,
        metadata: { ...identity },
        freshness: { status: "stale", reason: "saved_last_valid",
            expectedTradingDate: "2026-08-25" },
        diagnostics: { savedIntegrityVerified: true } };
    const displayPositionsState = { available: true, sourceKind: "saved",
        state: "saved_fallback", contract: identity.contract, displayOnly: true,
        displayGeneration: identity.displayGeneration, metadata: { ...identity },
        rows: rows.map(row => ({ ...row })) };
    return { displaySourceState, displayPositionsState, ...overrides };
}

const build = input => Analysis.buildQriOptionsSavedReferenceAnalysis(input);

test("saved source produces reference-only OI analysis", () => {
    const result = build(fixture());
    assert.deepEqual([result.accepted, result.available, result.sourceKind,
        result.sourceState], [true, true, "saved", "saved_fallback"]);
    assert.deepEqual([result.referenceOnly, result.calculationEligible], [true, false]);
});

test("non-saved sources are rejected", () => {
    for (const sourceKind of ["live", "legacy", "unavailable"]) {
        const input = fixture(); input.displaySourceState.sourceKind = sourceKind;
        const result = build(input);
        assert.equal(result.accepted, false); assert.match(result.reason, /source_rejected/);
    }
});

test("invalid tampered and superseded states are rejected", () => {
    for (const state of ["invalid", "tampered", "superseded"]) {
        const input = fixture(); input.displaySourceState.state = state;
        assert.equal(build(input).accepted, false);
    }
    const superseded = fixture(); superseded.displaySourceState.state = "superseded";
    assert.equal(build(superseded).reason, "saved_superseded");
});

test("integrity and display eligibility are mandatory", () => {
    const invalid = fixture();
    invalid.displaySourceState.diagnostics.savedIntegrityVerified = false;
    assert.equal(build(invalid).reason, "integrity_invalid");
    const hidden = fixture(); hidden.displaySourceState.displayEligible = false;
    assert.equal(build(hidden).reason, "saved_display_ineligible");
});

test("contract identity and generation mismatches are rejected", () => {
    const contract = fixture(); contract.displayPositionsState.contract = "2026-12";
    contract.displayPositionsState.metadata.contract = "2026-12";
    assert.equal(build(contract).reason, "contract_mismatch");
    const signature = fixture(); signature.displayPositionsState.metadata.canonicalSignature = "b".repeat(64);
    assert.equal(build(signature).reason, "identity_mismatch");
    const version = fixture(); version.displayPositionsState.metadata.canonicalVersionKey = "different";
    assert.equal(build(version).reason, "identity_mismatch");
    const tradingDate = fixture(); tradingDate.displayPositionsState.metadata.tradingDate = "2026-08-24";
    assert.equal(build(tradingDate).reason, "identity_mismatch");
    const generation = fixture(); generation.displayPositionsState.displayGeneration = 8;
    generation.displayPositionsState.metadata.displayGeneration = 8;
    assert.equal(build(generation).reason, "generation_mismatch");
});

test("positions source and source state must match saved display", () => {
    const live = fixture(); live.displayPositionsState.sourceKind = "live";
    assert.equal(build(live).reason, "positions_source_rejected");
    const pending = fixture(); pending.displayPositionsState.state = "saved_pending";
    assert.equal(build(pending).reason, "source_state_mismatch");
});

test("CALL and PUT rankings use all published strikes without price filtering", () => {
    const result = build(fixture());
    assert.deepEqual(result.call.topOpenInterest, [
        { strike: 64500, openInterest: 900 },
        { strike: 65500, openInterest: 900 },
        { strike: 65000, openInterest: 500 }
    ]);
    assert.deepEqual(result.put.topOpenInterest, [
        { strike: 64500, openInterest: 700 },
        { strike: 64000, openInterest: 700 },
        { strike: 63500, openInterest: 200 }
    ]);
});

test("maximum OI and ties preserve source order", () => {
    const result = build(fixture());
    assert.deepEqual(result.call.maximumOpenInterest,
        { strike: 64500, openInterest: 900 });
    assert.deepEqual(result.put.maximumOpenInterest,
        { strike: 64500, openInterest: 700 });
});

test("unpublished values are excluded instead of ranked as zero", () => {
    const result = build(fixture());
    assert.equal(result.call.topOpenInterest.some(item => item.strike === 64000), false);
    assert.equal(result.put.topOpenInterest.some(item => item.strike === 65500), false);
    assert.deepEqual([result.diagnostics.callPublishedCount,
        result.diagnostics.putPublishedCount], [4, 4]);
});

test("strike rows retain source facts and ordering", () => {
    const input = fixture(); const result = build(input);
    assert.deepEqual(result.strikeRows, input.displayPositionsState.rows);
    assert.deepEqual(result.strikeRows.map(row => row.strike),
        [65000, 64500, 65500, 64000, 63500]);
});

test("freshness derives only from supplied facts and never guesses previous trading day", () => {
    const same = build(fixture());
    assert.deepEqual(same.freshness, { tier: "same_trading_date_verified",
        status: "stale", reason: "saved_last_valid", calendarContextResolved: true });
    const olderInput = fixture(); olderInput.displaySourceState.freshness.expectedTradingDate = "2026-08-26";
    assert.equal(build(olderInput).freshness.tier, "older_trading_date");
    const unknownInput = fixture(); delete unknownInput.displaySourceState.freshness.expectedTradingDate;
    const unknown = build(unknownInput);
    assert.deepEqual([unknown.freshness.tier, unknown.freshness.calendarContextResolved],
        ["calendar_context_unresolved", false]);
    assert.doesNotMatch(JSON.stringify(unknown.freshness), /previous/);
    const noDateInput = fixture();
    noDateInput.displaySourceState.metadata.tradingDate = null;
    noDateInput.displayPositionsState.metadata.tradingDate = null;
    assert.equal(build(noDateInput).freshness.tier, "reference_date_unknown");
});

test("comparison judgment OverallV2 and current price remain isolated", () => {
    const result = build(fixture());
    assert.deepEqual([result.comparison, result.judgment, result.overallV2,
        result.currentPrice], [null, null, null, null]);
    assert.deepEqual(result.analysisPolicy, { allowReferenceAnalysis: true,
        allowFormalAnalysis: false, allowLegacyAnalysis: false,
        allowOverallV2: false, calculationEligible: false });
    assert.deepEqual([result.diagnostics.currentPriceAccessed,
        result.diagnostics.savedPriceAccessed, result.diagnostics.historyAccessed,
        result.diagnostics.overallV2Accessed], [false, false, false, false]);
});

test("input is not mutated and accepted output is deeply frozen", () => {
    const input = fixture(); const before = JSON.stringify(input); const result = build(input);
    assert.equal(JSON.stringify(input), before);
    for (const value of [result, result.identity, result.freshness, result.call,
        result.call.topOpenInterest, result.call.topOpenInterest[0], result.put,
        result.put.topOpenInterest, result.strikeRows, result.strikeRows[0],
        result.analysisPolicy, result.diagnostics]) assert.equal(Object.isFrozen(value), true);
    assert.notStrictEqual(result.strikeRows, input.displayPositionsState.rows);
});

test("rejected output and all nested values are frozen", () => {
    const input = fixture(); input.displaySourceState.sourceKind = "live";
    const result = build(input);
    for (const value of [result, result.call, result.call.topOpenInterest,
        result.put, result.put.topOpenInterest, result.strikeRows,
        result.analysisPolicy, result.diagnostics]) assert.equal(Object.isFrozen(value), true);
});

test("diagnostics report pure technical facts", () => {
    const result = build(fixture());
    assert.deepEqual(result.diagnostics, { inputSourceKind: "saved",
        inputSourceState: "saved_fallback", displayGeneration: 7,
        sourceRowCount: 5, callPublishedCount: 4, putPublishedCount: 4,
        topCount: 3, identityMatched: true, referenceOnly: true,
        currentPriceAccessed: false, savedPriceAccessed: false,
        historyAccessed: false, storageAccessed: false, databaseAccessed: false,
        fetchTriggered: false, timerScheduled: false, domAccessed: false,
        chartAccessed: false, formalGlobalsAccessed: false,
        overallV2Accessed: false });
});

test("module contains no forbidden connection and index connects it only before saved reference runtime", () => {
    const code = fs.readFileSync(path.join(__dirname,
        "../js/qriOptionsSavedReferenceAnalysis.js"), "utf8");
    assert.doesNotMatch(code, /localStorage|sessionStorage|indexedDB|setItem|removeItem/);
    assert.doesNotMatch(code, /\bfetch\s*\(|ipcRenderer|document\.|querySelector|\bChart\b/);
    assert.doesNotMatch(code, /drawJpxPriceChart|allJpx|updateWallCandidates/);
    assert.doesNotMatch(code, /optionMapJudgmentState|calculateOptionMarketJudgment/);
    assert.doesNotMatch(code, /require\([^)]*overallJudgmentV2|OptionMapOverallJudgmentV2/);
    assert.doesNotMatch(code, /setTimeout|setInterval|migration|backfill/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.ok(html.indexOf("qriOptionsSavedReferenceAnalysis.js") >= 0);
    assert.ok(html.indexOf("qriOptionsSavedReferenceAnalysis.js") <
        html.indexOf("qriOptionsSavedReferenceRuntime.js"));
});
