"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Binding = require("../js/morningV5MainAuthorityBinding.js");
const Authority = require("../js/morningV5FormalAuthority.js");

const hash = value => `sha256:${value.repeat(64)}`;
function snapshot() {
    const qriVersion = "qri-v1", weeklyCurrent = "weekly-current";
    return { qri: { status: "available", publicationGeneration: 2, fact: {
        sourceClass: "formal_live", contract: "2026-11", tradingDate: "2026-10-15",
        canonicalVersionKey: qriVersion, canonicalSignature: hash("a"),
        fetchedAt: "2026-10-15T06:40:00+09:00",
        generation: { fingerprint: "qri-generation" } } },
    weekly: { status: "available", publicationGeneration: 3, fact: {
        sourceClass: "formal_history", previousVersionKey: "weekly-previous",
        currentVersionKey: weeklyCurrent, currentSignature: hash("c"),
        generation: { fingerprint: "weekly-generation" } } },
    weeklyCandidate: { metadata: { previous: { sourceDate: "2026-10-02",
        versionKey: "weekly-previous", signature: hash("b") }, current: {
        sourceDate: "2026-10-09", versionKey: weeklyCurrent, signature: hash("c") },
        activeVersionKey: weeklyCurrent, activeVersionMatched: true } },
    overall: { status: "available", publicationGeneration: 4, envelope: {
        formalApplied: true, logicVersion: "overall-v2-weights-55-45-v1",
        inputFingerprint: "overall-fingerprint", optionSourceIdentity: {
            canonicalVersionKey: qriVersion }, weeklySourceIdentity: {
            currentVersionKey: weeklyCurrent }, result: { direction: 59, confidence: 90 } } },
    reference: { status: "available", publicationGeneration: 5, fact: {
        available: true, source: "qri-nikkei225-futures", instrument: "nikkei225_futures",
        contract: "2026-12", value: 66480, quotedAtNormalized: "2026-10-15T09:04:00+09:00",
        quoteSignature: hash("d"), versionKey: "price-v1" }, mapping: {
        mappingClass: "explicit_cross_contract_reference", optionContract: "2026-11",
        referenceContract: "2026-12", referenceVersionKey: "price-v1",
        formalTradingDate: "2026-10-15" } } };
}

function harness(value = snapshot()) {
    let current = structuredClone(value), calendar = { release: "calendar-v1" };
    const store = { load: async () => ({ observations: [] }) };
    const binding = Binding.createMainAuthorityBinding({
        getFreshSnapshot: async () => structuredClone(current),
        getCalendarContext: async observedAt => ({ asKnownAt: observedAt, value: structuredClone(calendar) }),
        storeFactory: () => store, now: () => "2026-10-15T09:05:00+09:00" });
    return { binding, setCurrent(mutator) { const next = structuredClone(current); mutator(next); current = next; },
        setCalendar(value) { calendar = value; } };
}

test("A1/A8 fresh authorities build a main-owned first observation", async () => {
    const result = await harness().binding.evaluate();
    assert.equal(result.status, "accepted", result.reason); assert.equal(result.writeCandidate, true);
    assert.equal(result.observation.contractContext.relation, "independent_cross_contract");
    assert.equal(result.observation.baselineSelection.baselineObservationId, null);
    assert.equal(result.observation.comparison.aggregateClass, "first_observation");
    assert.equal(await require("../js/morningV5FormalObservation.js")
        .validateFormalObservation(result.observation), true);
});

test("A2 renderer cannot supply a record, identity, baseline, or path", () => {
    const source = require("node:fs").readFileSync(require("node:path").join(__dirname,
        "../preload.js"), "utf8");
    assert.match(source, /evaluateMorningV5Formal:\s*\(\.\.\.args\) => invokeMorningV5Evaluation\(args\)/);
    assert.match(source, /args\.length !== 0/);
    assert.doesNotMatch(source, /evaluate-formal-morning-v5"\s*,\s*(?:request|record|path|observation)/);
});

test("A3 stale Futures produces no accepted observation", async () => {
    const value = snapshot(); value.reference.fact.quotedAtNormalized = "2026-10-14T06:00:00+09:00";
    const result = await harness(value).binding.evaluate();
    assert.equal(result.writeCandidate, false); assert.equal(result.reason, "futures_stale");
});

for (const [name, mutate] of [
    ["A4 QRI generation drift", value => { value.qri.publicationGeneration += 1; }],
    ["A5 Weekly pair drift", value => { value.weeklyCandidate.metadata.current.signature = hash("9"); }],
    ["A6 Overall fingerprint mismatch", value => { value.overall.envelope.optionSourceIdentity.canonicalVersionKey = "wrong"; }]
]) test(name, async () => {
    const h = harness();
    if (name.startsWith("A4")) {
        const first = await h.binding.currentAuthorityBinding(); assert.ok(first);
        h.setCurrent(mutate); assert.notDeepEqual(await h.binding.currentAuthorityBinding(), first); return;
    }
    h.setCurrent(mutate); const result = await h.binding.evaluate();
    assert.equal(result.writeCandidate, false);
});

test("A7 Calendar digest participates in the writer generation binding", async () => {
    const h = harness(); const accepted = await h.binding.evaluate();
    h.setCalendar({ release: "calendar-v2" });
    assert.notDeepEqual(await h.binding.currentAuthorityBinding(), accepted.generationBinding);
});

test("A9 identical accepted authorities rebuild the same observation for writer dedupe", async () => {
    const h = harness(), first = await h.binding.evaluate(), second = await h.binding.evaluate();
    assert.equal(first.observation.observationId, second.observation.observationId);
    assert.equal(first.observation.signature, second.observation.signature);
});

test("authority constants remain the accepted M5-1 contract", () => {
    assert.equal(Authority.CALCULATION_VERSION, "formal-morning-v5-calculation-v1");
    assert.equal(Authority.FRESHNESS_POLICY_VERSION, "current-price-session-v1");
});
