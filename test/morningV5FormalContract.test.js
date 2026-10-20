"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Authority = require("../js/morningV5FormalAuthority.js");
const Observation = require("../js/morningV5FormalObservation.js");

const hash = char => `sha256:${char.repeat(64)}`;
function fixture(overrides = {}) {
    const qriContract = overrides.qriContract === undefined ? "2026-11" : overrides.qriContract;
    const futuresContract = overrides.futuresContract === undefined ? "2026-12" : overrides.futuresContract;
    const observedAt = overrides.observedAt || "2026-10-14T09:05:00+09:00";
    const quotedAt = overrides.quotedAt || "2026-10-14T09:04:00+09:00";
    const qriVersion = `qri-v|${qriContract || "unknown"}|${overrides.qriRevision || "1"}`;
    const weeklyVersion = overrides.weeklyVersion || "weekly-current-v1";
    return { observedAt, calendarDay: "2026-10-14", tradingDate: "2026-10-14",
        qri: { accepted: true, sourceClass: "formal_live", contract: qriContract,
            tradingDate: "2026-10-14", canonicalVersionKey: qriVersion,
            signature: hash("a"), confirmedAt: "2026-10-14T08:58:00+09:00" },
        weekly: overrides.weekly === null ? null : { accepted: true,
            sourceClass: "formal_history", sourceDate: "2026-10-09",
            previousVersionKey: "weekly-previous-v1", previousSignature: hash("b"),
            currentVersionKey: weeklyVersion, currentSignature: hash("c") },
        overall: { formalApplied: true, logicVersion: "overall-v2-weights-55-45-v1",
            inputFingerprint: overrides.overallFingerprint || "overall-input-v1",
            qriVersionKey: qriVersion, weeklyVersionKey: weeklyVersion,
            direction: overrides.direction ?? 20, confidence: overrides.confidence ?? 80 },
        futures: { available: true, source: "qri-nikkei225-futures",
            instrument: "nikkei225_futures", contract: futuresContract,
            value: overrides.price ?? 68250, quotedAtNormalized: quotedAt,
            quoteSignature: overrides.quoteSignature || hash("d"),
            versionKey: overrides.priceVersion || "price-v1" },
        shadowMappingClass: overrides.shadowMappingClass ||
            (qriContract === futuresContract ? "same_contract_reference" :
                "explicit_cross_contract_reference"),
        freshnessPolicyVersion: "current-price-session-v1",
        calendar: { mode: "read_only", asKnownAt: observedAt, digest: hash("e") },
        calculation: { calculationVersion: "formal-morning-v5-calculation-v1",
            comparisonPolicyVersion: "formal-morning-v5-comparison-v1" } };
}

async function build(input, previous = []) {
    return Observation.buildMorningV5FormalObservation(input, previous);
}

test("V1 same-contract current inputs are Formal eligible", async () => {
    const accepted = await Authority.acceptMorningV5FormalAuthority(fixture({
        qriContract: "2026-12", futuresContract: "2026-12" }));
    assert.deepEqual([accepted.eligible, accepted.writeCandidate, accepted.relation],
        [true, true, "same_contract"]);
});

test("V2 independent QRI and Futures contracts are Formal eligible", async () => {
    const result = await build(fixture());
    assert.equal(result.success, true);
    assert.equal(result.observation.contractContext.relation, "independent_cross_contract");
    assert.equal(await Observation.validateFormalObservation(result.observation), true);
});

test("schema v1 session identity stays stable when freshness diagnostics add fields", async () => {
    const input = fixture({ observedAt: "2026-10-15T20:11:19.694Z",
        quotedAt: "2026-10-16T04:55:00+09:00" });
    input.calendarDay = "2026-10-16";
    input.tradingDate = "2026-10-16";
    input.qri.tradingDate = "2026-10-16";
    input.qri.confirmedAt = "2026-10-15T20:11:00.000Z";
    const result = await build(input);
    assert.deepEqual(result.observation.freshness.sessionIdentity,
        { kind: "night", key: "2026-10-15" });
    assert.deepEqual(Object.keys(result.observation.freshness.sessionIdentity).sort(),
        ["key", "kind"]);
    assert.equal(await Observation.validateFormalObservation(result.observation), true);
});

test("V3 and C8 stale Futures is ineligible and never becomes partial", async () => {
    const stale = fixture({ quotedAt: "2026-10-13T09:04:00+09:00" });
    const authority = await Authority.acceptMorningV5FormalAuthority(stale);
    const result = await build(stale);
    assert.deepEqual([authority.eligible, authority.writeCandidate, authority.reason],
        [false, false, "futures_stale"]);
    assert.deepEqual([result.success, result.writeCandidate, result.observation], [false, false, null]);
});

test("V6 missing Weekly authority rejects", async () => {
    const result = await build(fixture({ weekly: null }));
    assert.deepEqual([result.success, result.reason, result.writeCandidate],
        [false, "weekly_authority_invalid", false]);
});

test("C1 unsupported Futures month rejects", async () => {
    const result = await build(fixture({ futuresContract: "2026-11" }));
    assert.deepEqual([result.success, result.reason], [false, "contract_relation_unsupported"]);
});

test("C2 unknown QRI contract rejects", async () => {
    const result = await build(fixture({ qriContract: null }));
    assert.deepEqual([result.success, result.reason], [false, "qri_authority_invalid"]);
});

test("C3 unknown Futures contract rejects", async () => {
    const result = await build(fixture({ futuresContract: null }));
    assert.deepEqual([result.success, result.reason], [false, "futures_authority_invalid"]);
});

test("instrument and source mismatches reject", async () => {
    for (const patch of [{ source: "other" }, { instrument: "other" }]) {
        const input = fixture(); Object.assign(input.futures, patch);
        assert.equal((await build(input)).reason, "futures_authority_invalid");
    }
});

test("shadow mapping names require the versioned deterministic adapter", () => {
    assert.equal(Authority.adaptShadowRelation("same_contract_reference", "2026-12", "2026-12"),
        "same_contract");
    assert.equal(Authority.adaptShadowRelation("explicit_cross_contract_reference", "2026-11", "2026-12"),
        "independent_cross_contract");
    assert.equal(Authority.adaptShadowRelation("same_contract_reference", "2026-11", "2026-12"),
        "unsupported");
});

test("C4 first accepted observation has no baseline", async () => {
    const result = await build(fixture());
    assert.equal(result.observation.baselineSelection.baselineObservationId, null);
    assert.equal(result.observation.comparison.aggregateClass, "first_observation");
});

async function baseline() {
    return (await build(fixture({ observedAt: "2026-10-14T09:00:00+09:00",
        quotedAt: "2026-10-14T08:59:00+09:00", direction: 10, price: 68000,
        overallFingerprint: "overall-baseline", quoteSignature: hash("f"),
        priceVersion: "price-baseline" }))).observation;
}

test("C5 full comparison selects the exact chronological predecessor", async () => {
    const previous = await baseline();
    const current = await build(fixture({ direction: 25, price: 68300,
        overallFingerprint: "overall-current", quoteSignature: hash("1"),
        priceVersion: "price-current" }), [previous]);
    assert.equal(current.observation.baselineSelection.baselineObservationId,
        previous.observationId);
    assert.equal(current.observation.comparison.aggregateClass, "full");
    assert.deepEqual([current.observation.comparison.supply.delta,
        current.observation.comparison.price.delta], [15, 300]);
    assert.equal(current.observation.comparison.divergence.comparable, true);
});

test("V4/C6 QRI rollover preserves price comparison and is partial", async () => {
    const previous = await baseline();
    const current = await build(fixture({ qriContract: "2026-12", futuresContract: "2026-12",
        qriRevision: "2", direction: 30, price: 68300,
        overallFingerprint: "overall-qri-roll", quoteSignature: hash("2") }), [previous]);
    const comparison = current.observation.comparison;
    assert.equal(comparison.aggregateClass, "partial");
    assert.deepEqual([comparison.supply.comparable, comparison.supply.reason,
        comparison.price.comparable], [false, "qri_contract_roll", true]);
    assert.equal(comparison.divergence.comparable, false);
});

test("V5/C7 Futures rollover preserves supply comparison and is partial", async () => {
    const previous = await baseline();
    const current = await build(fixture({ futuresContract: "2027-03", direction: 30, price: 68300,
        overallFingerprint: "overall-futures-roll", quoteSignature: hash("3") }), [previous]);
    const comparison = current.observation.comparison;
    assert.equal(comparison.aggregateClass, "partial");
    assert.deepEqual([comparison.supply.comparable, comparison.price.comparable,
        comparison.price.reason], [true, false, "futures_contract_roll"]);
    assert.equal(comparison.divergence.comparable, false);
});

test("both lane rollovers produce none rather than partial", async () => {
    const previous = await baseline();
    const current = await build(fixture({ qriContract: "2026-12", futuresContract: "2027-03",
        qriRevision: "2", overallFingerprint: "overall-both-roll",
        quoteSignature: hash("4") }), [previous]);
    assert.equal(current.observation.comparison.aggregateClass, "none");
});

test("observation identity is deterministic and transport-only fields are excluded", async () => {
    const a = fixture(); const b = fixture();
    a.futures.requestId = "transport-a"; b.futures.requestId = "transport-b";
    const left = (await build(a)).observation, right = (await build(b)).observation;
    assert.equal(left.observationId, right.observationId);
    assert.equal(left.signature, right.signature);
    assert.equal(Object.hasOwn(left.sourceIdentities.futures, "requestId"), false);
});

test("tampering and an invalid baseline set fail closed", async () => {
    const previous = await baseline(); const tampered = structuredClone(previous);
    tampered.result.futuresPrice += 1;
    assert.equal(await Observation.validateFormalObservation(tampered), false);
    const result = await build(fixture(), [tampered]);
    assert.deepEqual([result.success, result.reason, result.writeCandidate],
        [false, "baseline_set_invalid", false]);
});

test("V12 Overall dependency remains one-way and Calendar remains read-only context", () => {
    const root = path.join(__dirname, "../js");
    for (const name of ["overallV2FormalEnvelopeRuntime.js", "overallV2OptionQriBinding.js"])
        assert.doesNotMatch(fs.readFileSync(path.join(root, name), "utf8"), /MorningV5|morningV5/);
    const authority = fs.readFileSync(path.join(root, "morningV5FormalAuthority.js"), "utf8");
    assert.doesNotMatch(authority,
        /marketCalendarRuntime|CalendarWriter|writeCalendar|saveCalendar|putCalendar/i);
});

test("M5-1 contract has no persistence runtime IPC DOM or network wiring", () => {
    const source = ["morningV5FormalAuthority.js", "morningV5FormalObservation.js"]
        .map(name => fs.readFileSync(path.join(__dirname, "../js", name), "utf8")).join("\n");
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|ipcRenderer|ipcMain|document\.|\bfetch\s*\(|setItem|objectStore/);
});
