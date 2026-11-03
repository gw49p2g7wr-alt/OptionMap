"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Identity = require("../js/overallTraceIdentityContract.js");
const Overall = require("../js/overallJudgmentV2.js");
const Observation = require("../js/overallTraceObservation.js");
const Delta = require("../js/overallTraceDelta.js");

const hex = character => character.repeat(64);
const key = (name, character) => `${name}|sha256:${hex(character)}`;
const clone = value => structuredClone(value);
const generations = Object.freeze({ option: "option-1", weekly: "weekly-1",
    overall: "overall-1", futures: "futures-1" });
function option(revision = "a", referenceState = "current_formal") {
    return { readinessState: "available", reason: null, referenceState,
        currentQri: { contract: "2026-11", tradingDate: "2026-11-04",
            pageUpdatedAt: "2026-11-04T07:30:00+09:00",
            revisionIdentity: key("qri-current", revision),
            versionKey: key("qri-current", revision), canonicalSignature: hex(revision) },
        previousComparisonQri: { contract: "2026-11",
            sourceDate: "2026-11-03T07:30:00+09:00",
            revisionIdentity: key("qri-previous", "b"),
            versionKey: key("qri-previous", "b"), canonicalSignature: hex("b") },
        comparisonFingerprint: hex("c"), futuresQuote: {
            source: "qri-nikkei225-futures", contract: "2026-12",
            quotedAt: "2026-11-04T06:00:00+09:00", value: 66480,
            versionKey: key("futures", "d"), quoteSignature: hex("d") } };
}
function weekly(revision = "f") {
    return { readinessState: "available", reason: null,
        previous: { sourceDate: "2026-10-22", versionKey: key("weekly-previous", "e"),
            signature: hex("e") }, current: { sourceDate: "2026-10-29",
            versionKey: key("weekly-current", revision), signature: hex(revision) },
        activeVersionKey: key("weekly-current", revision), sourceSchemaVersion: 2,
        parserVersion: 2, brokerSetVersion: 1, scoringVersion: 2,
        contractExpiries: ["2026-12", "2027-03"] };
}
const component = (normalizedDirection, qualityFactor = 1, evidenceFactor = .8,
    metadata = {}) => ({ available: true, normalizedDirection, qualityFactor,
    evidenceFactor, metadata });
async function trace({ acceptedAt = "2026-11-04T00:10:00.000Z", observedAt = acceptedAt,
    session = "day", calendarDay = "2026-11-04", logic = Identity.CURRENT_LOGIC_IDENTITY,
    optionInput = option(), weeklyInput = weekly(), optionComponent = component(.4, 1, .8,
        { usingFallback: false, scoreDifference: 3 }),
    weeklyComponent = component(.2, 1, .6, { scoreDiff: .02 }) } = {}) {
    const identity = await Identity.createObservationIdentity({ logic,
        inputs: { option: optionInput, weekly: weeklyInput }, observationSlot: {
            calendarDay, sessionIdentity: { kind: session, key: calendarDay } } });
    assert.equal(identity.accepted, true, identity.reason);
    const result = Overall.calculateOverallJudgmentV2({ option: optionComponent,
        weekly: weeklyComponent }, "2026-11-04T00:09:00.000Z");
    const built = await Observation.buildTraceObservation({ identity: identity.identity,
        envelope: { formalApplied: true, identityVerified: true,
            inputFingerprint: hex("9"), publicationGeneration: 4, result },
        observedAt, acceptedAt, generationBinding: generations });
    assert.equal(built.success, true, built.reason);
    return built.observation;
}
const later = overrides => trace({ acceptedAt: "2026-11-04T00:20:00.000Z", ...overrides });

test("D1 same verified trace is unchanged and deterministic", async () => {
    const value = await trace();
    const first = await Delta.projectOverallTraceDelta(value, clone(value));
    const second = await Delta.projectOverallTraceDelta(value, clone(value));
    assert.equal(first.classification, "unchanged");
    assert.equal(first.comparability, "comparable");
    assert.deepEqual(first, second);
    assert.match(first.deltaId, /^overall-v2-trace-delta\|sha256:[0-9a-f]{64}$/);
});

test("D2 same logic and current Option revision change is market_data_change", async () => {
    const previous = await trace(), current = await later({ optionInput: option("1") });
    const result = await Delta.projectOverallTraceDelta(previous, current);
    assert.equal(result.classification, "market_data_change");
    assert.equal(result.componentDeltas.option.currentQriRevisionChanged, true);
    assert.equal(result.logicIdentityChanges.changed, false);
});

test("D3 same inputs and canonical logic change is logic_change", async () => {
    const logic = clone(Identity.CURRENT_LOGIC_IDENTITY);
    logic.fallbackPolicyVersion = "overall-v2-quality-origin-v2";
    const previous = await trace(), current = await later({ logic });
    const result = await Delta.projectOverallTraceDelta(previous, current);
    assert.equal(result.classification, "logic_change");
    assert.deepEqual(result.logicIdentityChanges.changedFields.map(item => item.field),
        ["fallbackPolicyVersion"]);
});

test("D4 Option unavailable to available is readiness_change", async () => {
    const unavailable = { readinessState: "unavailable", reason: "formal_revision_missing",
        referenceState: "unavailable" };
    const previous = await trace({ optionInput: unavailable,
        optionComponent: { available: false, reason: "formal_revision_missing" } });
    const current = await later({});
    const result = await Delta.projectOverallTraceDelta(previous, current);
    assert.equal(result.classification, "readiness_change");
    assert.deepEqual([result.readinessChanges.option.previous,
        result.readinessChanges.option.current], ["unavailable", "available"]);
});

test("D5 logic and inputs change is mixed", async () => {
    const logic = clone(Identity.CURRENT_LOGIC_IDENTITY);
    logic.readinessPolicyVersion = "overall-v2-component-availability-v2";
    const result = await Delta.projectOverallTraceDelta(await trace(),
        await later({ logic, optionInput: option("1") }));
    assert.equal(result.classification, "mixed");
});

test("D6 previous comparison QRI revision change is market_data_change", async () => {
    const changed = option();
    changed.previousComparisonQri.revisionIdentity = key("qri-previous", "2");
    changed.previousComparisonQri.versionKey = key("qri-previous", "2");
    changed.previousComparisonQri.canonicalSignature = hex("2");
    const result = await Delta.projectOverallTraceDelta(await trace(),
        await later({ optionInput: changed }));
    assert.equal(result.classification, "market_data_change");
    assert.equal(result.componentDeltas.option.previousComparisonRevisionChanged, true);
});

test("D7 Futures quote-only change is market_data_change", async () => {
    const changed = option(); changed.futuresQuote.value = 66500;
    changed.futuresQuote.versionKey = key("futures", "3");
    changed.futuresQuote.quoteSignature = hex("3");
    const result = await Delta.projectOverallTraceDelta(await trace(),
        await later({ optionInput: changed }));
    assert.equal(result.classification, "market_data_change");
    assert.equal(result.componentDeltas.option.futuresQuoteChanged, true);
});

test("D8 Weekly current revision-only change is market_data_change", async () => {
    const result = await Delta.projectOverallTraceDelta(await trace(),
        await later({ weeklyInput: weekly("4") }));
    assert.equal(result.classification, "market_data_change");
    assert.equal(result.componentDeltas.weekly.currentRevisionChanged, true);
    assert.equal(result.componentDeltas.weekly.activeVersionChanged, true);
});

test("D9 confidence factors expose exact previous current and delta", async () => {
    const previous = await trace();
    const current = await later({ optionInput: option("1"),
        optionComponent: component(.4, 1, .6, { usingFallback: false, scoreDifference: 3 }) });
    const result = await Delta.projectOverallTraceDelta(previous, current);
    assert.equal(result.confidenceFactorDeltas.evidence.previous,
        previous.confidenceFactors.evidence);
    assert.equal(result.confidenceFactorDeltas.evidence.current,
        current.confidenceFactors.evidence);
    assert.equal(result.confidenceFactorDeltas.evidence.delta,
        current.confidenceFactors.evidence - previous.confidenceFactors.evidence);
    assert.equal(result.confidenceFactorDeltas.finalConfidence.delta,
        current.confidence - previous.confidence);
});

test("D10 coverage 50 to 100 retains availability-percent semantics", async () => {
    const unavailable = { readinessState: "unavailable", reason: "missing",
        referenceState: "unavailable" };
    const previous = await trace({ optionInput: unavailable,
        optionComponent: { available: false, reason: "missing" } });
    const current = await later({});
    const result = await Delta.projectOverallTraceDelta(previous, current);
    assert.deepEqual(result.outputDelta.coverage,
        { previous: 50, current: 100, delta: 50 });
    assert.equal(result.outputDelta.coverageSemantic,
        "componentAvailabilityCoveragePercent");
});

test("D11 same final direction with changed inputs is not unchanged", async () => {
    const result = await Delta.projectOverallTraceDelta(await trace(),
        await later({ optionInput: option("1") }));
    assert.equal(result.outputDelta.direction.delta, 0);
    assert.equal(result.classification, "market_data_change");
});

test("D12 same identities with conflicting valid output fails closed", async () => {
    const previous = await trace();
    const current = await later({ optionComponent: component(.5, 1, .8,
        { usingFallback: false, scoreDifference: 3 }) });
    const result = await Delta.projectOverallTraceDelta(previous, current);
    assert.deepEqual([result.classification, result.reason],
        ["not_comparable", "trace_inconsistency"]);
});

test("D13 denominator change prevents false additive causal claim", async () => {
    const previous = await trace();
    const current = await later({ optionInput: option("1"),
        optionComponent: component(.4, .7, .8, { usingFallback: false, scoreDifference: 3 }) });
    const result = await Delta.projectOverallTraceDelta(previous, current);
    assert.equal(result.contributionExplanation.denominatorChanged, true);
    assert.equal(result.contributionExplanation.additiveAttributionSupported, false);
    assert.equal(result.contributionExplanation.reason, "effective_weight_denominator_changed");
});

test("D14 fallback begins as an explicit readiness/reference transition", async () => {
    const previous = await trace();
    const current = await later({ optionInput: option("a", "fallback"),
        optionComponent: component(.4, .7, .8, { usingFallback: true, scoreDifference: 3 }) });
    const result = await Delta.projectOverallTraceDelta(previous, current);
    assert.equal(result.classification, "readiness_change");
    assert.deepEqual([result.fallbackChanges.option.previousReferenceState,
        result.fallbackChanges.option.currentReferenceState], ["current_formal", "fallback"]);
    assert.equal(result.fallbackChanges.option.usingFallbackChanged, true);
});

test("D15 fallback ending is represented without market inference", async () => {
    const previous = await trace({ optionInput: option("a", "fallback"),
        optionComponent: component(.4, .7, .8, { usingFallback: true, scoreDifference: 3 }) });
    const current = await later({});
    const result = await Delta.projectOverallTraceDelta(previous, current);
    assert.equal(result.classification, "readiness_change");
    assert.deepEqual([result.fallbackChanges.option.previousUsingFallback,
        result.fallbackChanges.option.currentUsingFallback], [true, false]);
});

test("D16 future trace schema is not comparable", async () => {
    const previous = await trace(), current = clone(await later({})); current.schemaVersion = 2;
    const result = await Delta.projectOverallTraceDelta(previous, current);
    assert.deepEqual([result.classification, result.reason],
        ["not_comparable", "trace_integrity_invalid"]);
});

test("D17 absent previous trace is first_observation", async () => {
    const current = await trace();
    const result = await Delta.projectOverallTraceDelta(null, current);
    assert.deepEqual([result.classification, result.comparability, result.reason],
        ["first_observation", "first_observation", "no_previous_trace"]);
    const invalid = clone(current); invalid.signature = "sha256:" + hex("0");
    const rejected = await Delta.projectOverallTraceDelta(null, invalid);
    assert.deepEqual([rejected.classification, rejected.reason],
        ["not_comparable", "trace_integrity_invalid"]);
});

test("D18 tampered trace is rejected before any delta", async () => {
    const previous = await trace(), current = clone(await later({ optionInput: option("1") }));
    current.componentSnapshots.option.weightedContribution += 1;
    const result = await Delta.projectOverallTraceDelta(previous, current);
    assert.deepEqual([result.classification, result.reason],
        ["not_comparable", "trace_integrity_invalid"]);
});

test("output and component deltas preserve exact stored arithmetic", async () => {
    const previous = await trace();
    const current = await later({ optionInput: option("1"),
        optionComponent: component(.6, 1, .8, { usingFallback: false, scoreDifference: 5 }) });
    const result = await Delta.projectOverallTraceDelta(previous, current);
    assert.equal(result.outputDelta.direction.delta, current.direction - previous.direction);
    assert.equal(result.componentDeltas.option.normalizedDirection.delta,
        current.componentSnapshots.option.normalizedDirection -
        previous.componentSnapshots.option.normalizedDirection);
    assert.equal(result.componentDeltas.option.weightedContribution.delta,
        current.componentSnapshots.option.weightedContribution -
        previous.componentSnapshots.option.weightedContribution);
});

test("previous selector chooses closest verified prior same-session trace", async () => {
    const first = await trace({ acceptedAt: "2026-11-03T00:10:00.000Z",
        observedAt: "2026-11-03T00:10:00.000Z", calendarDay: "2026-11-03" });
    const night = await trace({ acceptedAt: "2026-11-04T00:15:00.000Z",
        observedAt: "2026-11-04T00:15:00.000Z", session: "night" });
    const closest = await later({ optionInput: option("1") });
    const current = await trace({ acceptedAt: "2026-11-05T00:10:00.000Z",
        observedAt: "2026-11-05T00:10:00.000Z", calendarDay: "2026-11-05",
        optionInput: option("2") });
    const selected = await Delta.selectPreviousComparable([
        { observation: closest }, night, first], current);
    assert.equal(selected.status, "selected");
    assert.equal(selected.previous.observationId, closest.observationId);
    assert.equal(selected.sessionComparison, "same_session_kind");
});

test("cross-session is rejected by default and explicit when allowed", async () => {
    const previous = await trace(), current = await later({ session: "night",
        optionInput: option("1") });
    assert.equal((await Delta.projectOverallTraceDelta(previous, current)).reason,
        "session_incompatible");
    const allowed = await Delta.projectOverallTraceDelta(previous, current,
        { allowCrossSession: true });
    assert.equal(allowed.sessionComparison, "cross_session_explicit");
});

test("selector returns first_observation when no compatible prior exists", async () => {
    const current = await trace();
    const result = await Delta.selectPreviousComparable([], current);
    assert.deepEqual([result.status, result.reason, result.previous],
        ["first_observation", "no_previous_trace", null]);
});

test("T3 module is pure and has no storage writer score UI network or clock authority", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/overallTraceDelta.js"), "utf8");
    assert.doesNotMatch(source, /indexedDB|localStorage|node:fs|\bfetch\s*\(|document\.|ipcMain|ipcRenderer/);
    assert.doesNotMatch(source, /Date\.now|new Date\s*\(|randomUUID|calculateOverallJudgmentV2\s*\(/);
    assert.doesNotMatch(source, /commit\s*\(|createProductionStore|createIsolatedStore/);
});
