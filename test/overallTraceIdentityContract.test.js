const test = require("node:test");
const assert = require("node:assert/strict");
const Contract = require("../js/overallTraceIdentityContract.js");

const hex = character => character.repeat(64);
const key = (name, character) => `${name}|sha256:${hex(character)}`;
const clone = value => structuredClone(value);

function option(overrides = {}) {
    return { readinessState: "available", reason: null, referenceState: "current_formal",
        currentQri: { contract: "2026-11", tradingDate: "2026-11-04",
            pageUpdatedAt: "2026-11-04T07:30:00+09:00",
            revisionIdentity: key("qri-current", "a"), versionKey: key("qri-current", "a"),
            canonicalSignature: hex("a") },
        previousComparisonQri: { contract: "2026-11",
            sourceDate: "2026-11-03T07:30:00+09:00",
            revisionIdentity: key("qri-previous", "b"), versionKey: key("qri-previous", "b"),
            canonicalSignature: hex("b") }, comparisonFingerprint: hex("c"),
        futuresQuote: { source: "qri-nikkei225-futures", contract: "2026-12",
            quotedAt: "2026-11-04T06:00:00+09:00", value: 66480,
            versionKey: key("futures", "d"), quoteSignature: hex("d") }, ...overrides };
}
function weekly(overrides = {}) {
    return { readinessState: "available", reason: null,
        previous: { sourceDate: "2026-10-22", versionKey: key("weekly-previous", "e"),
            signature: hex("e") }, current: { sourceDate: "2026-10-29",
            versionKey: key("weekly-current", "f"), signature: hex("f") },
        activeVersionKey: key("weekly-current", "f"), sourceSchemaVersion: 2,
        parserVersion: 2, brokerSetVersion: 1, scoringVersion: 2,
        contractExpiries: ["2026-12", "2027-03"], ...overrides };
}
const slot = (kind = "day", calendarDay = "2026-11-04") => ({ calendarDay,
    sessionIdentity: { kind, key: calendarDay } });
async function record({ logic = Contract.CURRENT_LOGIC_IDENTITY,
    optionInput = option(), weeklyInput = weekly(), observationSlot = slot() } = {}) {
    return Contract.createObservationIdentity({ logic,
        inputs: { option: optionInput, weekly: weeklyInput }, observationSlot });
}

test("T1-1 same material identity produces same hashes and observationId", async () => {
    const [left, right] = await Promise.all([record(), record()]);
    assert.equal(left.accepted, true); assert.equal(right.accepted, true);
    assert.equal(left.identity.logicIdentityHash, right.identity.logicIdentityHash);
    assert.equal(left.identity.inputSetIdentityHash, right.identity.inputSetIdentityHash);
    assert.equal(left.identity.observationId, right.identity.observationId);
    assert.equal(await Contract.classifyIdentityChange(left.identity, right.identity), "same");
});

test("T1-2 current Option revision changes only input identity", async () => {
    const left = await record(); const changed = option();
    changed.currentQri.revisionIdentity = key("qri-current-2", "1");
    changed.currentQri.versionKey = changed.currentQri.revisionIdentity;
    changed.currentQri.canonicalSignature = hex("1");
    const right = await record({ optionInput: changed });
    assert.equal(left.identity.logicIdentityHash, right.identity.logicIdentityHash);
    assert.notEqual(left.identity.inputSetIdentityHash, right.identity.inputSetIdentityHash);
    assert.notEqual(left.identity.observationId, right.identity.observationId);
    assert.equal(await Contract.classifyIdentityChange(left.identity, right.identity), "market_data_change");
});

test("T1-3 previous Option revision changes even at the same source time", async () => {
    const left = await record(); const changed = option();
    changed.previousComparisonQri.revisionIdentity = key("qri-previous-revision", "2");
    changed.previousComparisonQri.versionKey = changed.previousComparisonQri.revisionIdentity;
    changed.previousComparisonQri.canonicalSignature = hex("2");
    const right = await record({ optionInput: changed });
    assert.notEqual(left.identity.inputSetIdentityHash, right.identity.inputSetIdentityHash);
});

test("T1-4 Futures quote change changes input identity", async () => {
    const left = await record(); const changed = option();
    changed.futuresQuote.value = 66500;
    changed.futuresQuote.versionKey = key("futures-2", "3");
    changed.futuresQuote.quoteSignature = hex("3");
    const right = await record({ optionInput: changed });
    assert.notEqual(left.identity.inputSetIdentityHash, right.identity.inputSetIdentityHash);
});

test("T1-5 Weekly current revision changes input identity", async () => {
    const left = await record(); const changed = weekly();
    changed.current.versionKey = key("weekly-current-2", "4");
    changed.current.signature = hex("4"); changed.activeVersionKey = changed.current.versionKey;
    const right = await record({ weeklyInput: changed });
    assert.notEqual(left.identity.inputSetIdentityHash, right.identity.inputSetIdentityHash);
});

test("T1-6 Weekly scoring version changes input identity", async () => {
    const left = await record(); const right = await record({ weeklyInput: weekly({ scoringVersion: 3 }) });
    assert.notEqual(left.identity.inputSetIdentityHash, right.identity.inputSetIdentityHash);
    assert.equal(left.identity.logicIdentityHash, right.identity.logicIdentityHash);
});

test("T1-7 Overall configured weight changes logic identity", async () => {
    const changed = clone(Contract.CURRENT_LOGIC_IDENTITY);
    changed.configuredWeights.option = 54; changed.configuredWeights.weekly = 46;
    const left = await record(); const right = await record({ logic: changed });
    assert.notEqual(left.identity.logicIdentityHash, right.identity.logicIdentityHash);
    assert.equal(left.identity.inputSetIdentityHash, right.identity.inputSetIdentityHash);
    assert.equal(await Contract.classifyIdentityChange(left.identity, right.identity), "logic_change");
});

test("T1-8 confidence policy change changes logic identity", async () => {
    const changed = clone(Contract.CURRENT_LOGIC_IDENTITY);
    changed.confidenceWeights.coverage = 0.34;
    const left = await record(); const right = await record({ logic: changed });
    assert.notEqual(left.identity.logicIdentityHash, right.identity.logicIdentityHash);
});

test("T1-9 readiness transition has a distinct deterministic classification", async () => {
    const left = await record();
    const right = await record({ optionInput: { readinessState: "unavailable",
        reason: "formal_revision_missing", referenceState: "unavailable" } });
    assert.notEqual(left.identity.inputSetIdentityHash, right.identity.inputSetIdentityHash);
    assert.equal(await Contract.classifyIdentityChange(left.identity, right.identity), "readiness_change");
    const unavailableA = await record({ optionInput: { readinessState: "unavailable",
        reason: "formal_revision_missing", referenceState: "unavailable" } });
    const unavailableB = await record({ optionInput: { readinessState: "stale",
        reason: "formal_revision_missing", referenceState: "unavailable" } });
    assert.equal(await Contract.classifyIdentityChange(unavailableA.identity,
        unavailableB.identity), "readiness_change");
});

test("readiness plus independent Weekly source change classifies as mixed", async () => {
    const left = await record(); const changedWeekly = weekly();
    changedWeekly.current.versionKey = key("weekly-current-2", "8");
    changedWeekly.current.signature = hex("8");
    changedWeekly.activeVersionKey = changedWeekly.current.versionKey;
    const right = await record({ optionInput: { readinessState: "unavailable",
        reason: "formal_revision_missing", referenceState: "unavailable" },
    weeklyInput: changedWeekly });
    assert.equal(await Contract.classifyIdentityChange(left.identity, right.identity), "mixed");
});

test("T1-10 identical unavailable state produces identical input hash", async () => {
    const unavailable = { readinessState: "unavailable",
        reason: "formal_revision_missing", referenceState: "unavailable" };
    const [left, right] = await Promise.all([
        record({ optionInput: unavailable }), record({ optionInput: clone(unavailable) })]);
    assert.equal(left.identity.inputSetIdentityHash, right.identity.inputSetIdentityHash);
});

test("T1-11 session change changes slot and observationId only", async () => {
    const left = await record(); const right = await record({ observationSlot: slot("night") });
    assert.equal(left.identity.logicIdentityHash, right.identity.logicIdentityHash);
    assert.equal(left.identity.inputSetIdentityHash, right.identity.inputSetIdentityHash);
    assert.notEqual(left.identity.observationId, right.identity.observationId);
});

test("T1-12 calendar day change changes observationId", async () => {
    const left = await record(); const right = await record({
        observationSlot: slot("day", "2026-11-05") });
    assert.notEqual(left.identity.observationId, right.identity.observationId);
});

test("T1-13 request/fetch/UI runtime noise is excluded", async () => {
    const noisyOption = option({ requestId: "request-a", fetchDuration: 11,
        renderedLabel: "old" });
    const noisyWeekly = weekly({ requestId: "request-b", fetchDuration: 99,
        uiState: { expanded: true } });
    const clean = await record(); const noisy = await record({ optionInput: noisyOption,
        weeklyInput: noisyWeekly, observationSlot: { ...slot(), requestId: "noise" } });
    assert.equal(clean.identity.logicIdentityHash, noisy.identity.logicIdentityHash);
    assert.equal(clean.identity.inputSetIdentityHash, noisy.identity.inputSetIdentityHash);
    assert.equal(clean.identity.observationId, noisy.identity.observationId);
});

test("T1-14 future and malformed schemas fail closed", async () => {
    assert.equal((await Contract.createLogicIdentity({
        ...clone(Contract.CURRENT_LOGIC_IDENTITY), schemaVersion: 2 })).reason,
    "logic_identity_invalid");
    assert.equal((await Contract.createOptionInputIdentity({ ...option(), schemaVersion: 2 })).accepted,
        false);
    const malformed = option(); malformed.currentQri.canonicalSignature = "not-a-hash";
    assert.equal((await Contract.createOptionInputIdentity(malformed)).accepted, false);
    const good = await record(); const future = clone(good.identity); future.schemaVersion = 2;
    assert.equal(await Contract.classifyIdentityChange(good.identity, future), "not_comparable");
});

test("logic identity includes every material policy family", async () => {
    const result = await Contract.createLogicIdentity();
    assert.equal(result.accepted, true);
    for (const keyName of ["algorithmName", "algorithmVersion", "plannedComponents",
        "configuredWeights", "normalizationBases", "confidenceWeights",
        "singleComponentAgreement", "roundingPolicy", "clampPolicy",
        "optionScoringPolicyVersion", "weeklyScoringVersion", "weeklyBrokerSetVersion",
        "fallbackPolicyVersion", "readinessPolicyVersion", "materialRules"])
        assert.ok(Object.hasOwn(result.identity, keyName), keyName);
    assert.deepEqual(result.identity.materialRules.quality.weekly,
        { liveCurrent: 1, cacheCurrent: 0.95, waitingUpdate: 0.5,
            remoteFailed: 0.7, pending: 0.7 });
});

test("identity builders are pure and deeply freeze outputs", async () => {
    const input = option(); const before = clone(input);
    const result = await Contract.createOptionInputIdentity(input);
    assert.deepEqual(input, before); assert.equal(Object.isFrozen(result.identity.currentQri), true);
});

test("forged prebuilt wrapper hashes are never trusted", async () => {
    const logic = await Contract.createLogicIdentity();
    const inputs = await Contract.createInputSetIdentity({ option: option(), weekly: weekly() });
    const built = await Contract.createObservationIdentity({
        logic: { ...logic, hash: hex("0") },
        inputs: { ...inputs, hash: hex("1") }, observationSlot: slot() });
    assert.equal(built.accepted, true);
    assert.equal(built.identity.logicIdentityHash, logic.hash);
    assert.equal(built.identity.inputSetIdentityHash, inputs.hash);
});

test("logic plus market and readiness changes classify as mixed", async () => {
    const changed = clone(Contract.CURRENT_LOGIC_IDENTITY);
    changed.configuredWeights.option = 54; changed.configuredWeights.weekly = 46;
    const left = await record(); const right = await record({ logic: changed,
        optionInput: { readinessState: "unavailable", reason: "missing",
            referenceState: "unavailable" } });
    assert.equal(await Contract.classifyIdentityChange(left.identity, right.identity), "mixed");
});

test("current envelope adapter fails closed without exact prior QRI and quote evidence", async () => {
    const result = await Contract.adaptCurrentEnvelope({ envelope: { envelopeVersion: 1,
        formalApplied: true, identityVerified: true, inputFingerprint: hex("a"),
        result: { components: { option: { available: true }, weekly: { available: false } } } },
    observationSlot: slot() });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "option_adapter_binding_invalid");
});

test("current envelope adapter binds exact QRI, quote, Weekly, generation and slot", async () => {
    const qriGeneration = { source: "qri", sequence: 4, fingerprint: "qri-generation", current: true };
    const weeklyGeneration = { source: "weekly", sequence: 5,
        fingerprint: "weekly-generation", current: true };
    const previousKey = key("weekly-previous", "e");
    const currentKey = key("weekly-current", "f");
    const result = await Contract.adaptCurrentEnvelope({
        envelope: { envelopeVersion: 1, formalApplied: true, identityVerified: true,
            inputFingerprint: hex("9"), optionSourceIdentity: {
                canonicalVersionKey: key("qri-current", "a"), canonicalSignature: hex("a"),
                generation: qriGeneration }, weeklySourceIdentity: { previousVersionKey: previousKey,
                currentVersionKey: currentKey, currentSignature: hex("f"),
                generation: weeklyGeneration }, result: { components: {
                    option: { available: true, metadata: { usingFallback: false } },
                    weekly: { available: true, metadata: { previous: {
                        sourceDate: "2026-10-22", versionKey: previousKey, signature: hex("e") },
                    current: { sourceDate: "2026-10-29", versionKey: currentKey,
                        signature: hex("f") }, activeVersionKey: currentKey } }
                } } },
        optionComparisonEnvelope: { envelopeVersion: 1, available: true,
            evidenceFingerprint: hex("c"), generation: qriGeneration,
            previous: { contract: "2026-11", sourceDate: "2026-11-03T07:30:00+09:00",
                revisionIdentity: key("qri-previous", "b"), versionKey: key("qri-previous", "b"),
                canonicalSignature: hex("b") },
            current: { contract: "2026-11", tradingDate: "2026-11-04",
                pageUpdatedAt: "2026-11-04T07:30:00+09:00",
                revisionIdentity: key("qri-current", "a"), versionKey: key("qri-current", "a"),
                canonicalSignature: hex("a") } },
        futuresQuoteFact: { factVersion: 1, available: true, identityVerified: true,
            acquisitionVerified: true, quoteIdentity: { source: "qri-nikkei225-futures",
                contract: "2026-12", quotedAtNormalized: "2026-11-04T06:00:00+09:00",
                value: 66480, versionKey: key("futures", "d"), quoteSignature: hex("d") } },
        weeklyFact: { previousVersionKey: previousKey, currentVersionKey: currentKey,
            currentSignature: hex("f"), generation: weeklyGeneration },
        weeklyContractExpiries: ["2026-12", "2027-03"], observationSlot: slot()
    });
    assert.equal(result.accepted, true);
    assert.equal(result.identity.inputSetIdentity.option.currentQri.versionKey,
        key("qri-current", "a"));
    assert.equal(result.identity.inputSetIdentity.weekly.previous.versionKey, previousKey);
});

test("current envelope adapter rejects mixed source generation", async () => {
    const base = { envelopeVersion: 1, formalApplied: true, identityVerified: true,
        inputFingerprint: hex("9"), optionSourceIdentity: { canonicalVersionKey: key("qri-current", "a"),
            canonicalSignature: hex("a"), generation: { source: "qri", sequence: 1,
                fingerprint: "one", current: true } }, result: { components: {
            option: { available: true, metadata: {} }, weekly: { available: false, notes: [] } } } };
    const result = await Contract.adaptCurrentEnvelope({ envelope: base,
        optionComparisonEnvelope: { envelopeVersion: 1, available: true,
            current: { versionKey: key("qri-current", "a"), canonicalSignature: hex("a") },
            generation: { source: "qri", sequence: 2, fingerprint: "two", current: true } },
        futuresQuoteFact: { factVersion: 1, available: true, identityVerified: true,
            acquisitionVerified: true }, observationSlot: slot() });
    assert.equal(result.reason, "option_adapter_binding_invalid");
});

test("contract module has no persistence, network, DOM, score calculation, or timers", () => {
    const source = require("node:fs").readFileSync(
        require("node:path").join(__dirname, "../js/overallTraceIdentityContract.js"), "utf8");
    assert.doesNotMatch(source, /indexedDB|localStorage|\bfetch\s*\(|document\.|setTimeout|setInterval/);
    assert.doesNotMatch(source, /calculateOverallJudgmentV2\s*\(/);
});
