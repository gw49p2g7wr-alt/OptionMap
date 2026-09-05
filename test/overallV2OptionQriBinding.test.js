const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Binding = require("../js/overallV2OptionQriBinding.js");

const sourceDate = "2026-09-05T23:12:00.000Z";
const qriState = (patch = {}) => ({
    status: "available",
    requestId: "request-2",
    publicationGeneration: 2,
    fact: {
        sourceClass: "formal_live",
        sourceKind: "formal_live",
        origin: "live",
        usingFallback: false,
        referenceOnly: false,
        superseded: false,
        identityVerified: true,
        acquisitionVerified: true,
        requestId: "request-2",
        canonicalVersionKey: "qri-v2",
        canonicalSignature: "signature-v2",
        contract: "2026-09",
        tradingDate: "2026-09-07",
        pageUpdatedAt: "2026-09-06T08:12:00+09:00",
        generation: {
            source: "qri",
            sequence: 2,
            fingerprint: "request-2|qri-v2|saved",
            current: true
        }
    },
    ...patch
});

test("creates an additive binding for the current verified formal QRI", () => {
    const binding = Binding.createBinding(qriState(), sourceDate);
    assert.deepEqual({
        requestId: binding.requestId,
        versionKey: binding.canonicalVersionKey,
        signature: binding.canonicalSignature,
        contract: binding.contract,
        tradingDate: binding.tradingDate,
        sequence: binding.generation.sequence
    }, {
        requestId: "request-2",
        versionKey: "qri-v2",
        signature: "signature-v2",
        contract: "2026-09",
        tradingDate: "2026-09-07",
        sequence: 2
    });
});

test("matching current binding avoids duplicate same-source-date calculation", () => {
    const state = qriState();
    const formalQriIdentity = Binding.createBinding(state, sourceDate);
    assert.equal(Binding.shouldReapplySelectedSnapshot({
        sameSourceDate: true,
        snapshotValid: true,
        judgmentState: { available: true, metadata: { formalQriIdentity } },
        qriState: state,
        sourceDate
    }), false);
});

test("invalidated or unbound judgment reapplies the selected snapshot", () => {
    for (const judgmentState of [
        { available: false, metadata: null },
        { available: true, metadata: {} }
    ]) {
        assert.equal(Binding.shouldReapplySelectedSnapshot({
            sameSourceDate: true,
            snapshotValid: true,
            judgmentState,
            qriState: qriState(),
            sourceDate
        }), true);
    }
});

test("an invalid selected snapshot is never reapplied", () => {
    assert.equal(Binding.shouldReapplySelectedSnapshot({
        sameSourceDate: true,
        snapshotValid: false,
        judgmentState: { available: false },
        qriState: qriState(),
        sourceDate
    }), false);
});

for (const [name, mutate] of [
    ["versionKey", value => { value.canonicalVersionKey = "old"; }],
    ["signature", value => { value.canonicalSignature = "old"; }],
    ["contract", value => { value.contract = "2026-10"; }],
    ["tradingDate", value => { value.tradingDate = "2026-09-08"; }],
    ["request", value => { value.requestId = "old"; }],
    ["generation", value => { value.generation.fingerprint = "old"; }]
]) test(`${name} mismatch rejects an available legacy judgment`, () => {
    const state = qriState();
    const binding = Binding.createBinding(state, sourceDate);
    mutate(binding);
    assert.equal(Binding.matchesCurrent(binding, state, sourceDate), false);
});

for (const [name, patchFact] of [
    ["fallback", { usingFallback: true }],
    ["reference", { referenceOnly: true }],
    ["cache", { origin: "cache" }],
    ["stale generation", { generation: { source: "qri", sequence: 2,
        fingerprint: "old", current: false } }]
]) test(`${name} QRI cannot create a formal judgment binding`, () => {
    const state = qriState();
    Object.assign(state.fact, patchFact);
    assert.equal(Binding.createBinding(state, sourceDate), null);
});

test("source instant must match pageUpdatedAt without changing tradingDate", () => {
    const state = qriState();
    assert.equal(Binding.createBinding(state,
        "2026-09-05T23:12:01.000Z"), null);
    assert.equal(state.fact.tradingDate, "2026-09-07");
});

test("runtime wiring preserves current automatic or manual selection", () => {
    const script = fs.readFileSync(path.join(__dirname, "../js/script.js"), "utf8");
    assert.match(script, /applyComparisonSnapshot\(comparisonSnapshot, \{\s*selectionMode: comparisonSelectionMode/);
    assert.doesNotMatch(script, /selectionMode:\s*"automatic"\s*\}\);\s*}\s*return comparisonSnapshot;/);
});

test("runtime option input requires current Formal QRI binding", () => {
    const script = fs.readFileSync(path.join(__dirname, "../js/script.js"), "utf8");
    assert.match(script, /matchesCurrent\(\s*metadata\.formalQriIdentity/);
    assert.match(script, /formalQriIdentity: metadata\.formalQriIdentity/);
});

test("binding helper is pure and does not perform I/O or market calculation", () => {
    const source = fs.readFileSync(path.join(__dirname,
        "../js/overallV2OptionQriBinding.js"), "utf8");
    assert.doesNotMatch(source,
        /fetch\s*\(|localStorage|indexedDB|\.put\s*\(|\.add\s*\(|\.delete\s*\(|calculateOptionMarketJudgment|calculateOverallJudgmentV2/);
});
