"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Identity = require("../js/overallTraceIdentityContract.js");
const Overall = require("../js/overallJudgmentV2.js");
const Observation = require("../js/overallTraceObservation.js");
const Store = require("../js/overallTraceHistoryStore.js");
const Writer = require("../js/overallTraceMainWriter.js");
const Binding = require("../js/overallTraceMainAuthorityBinding.js");

const hex = character => character.repeat(64);
const key = (name, character) => `${name}|sha256:${hex(character)}`;
const generations = Object.freeze({ option: "option-1", weekly: "weekly-1",
    overall: "overall-1", futures: "futures-1" });
const clone = value => structuredClone(value);
function isolatedRoot(t) { const root = fs.realpathSync(fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()), "optionmap-overall-trace-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function option(revision = "a") { return { readinessState: "available", reason: null,
    referenceState: "current_formal", currentQri: { contract: "2026-11",
        tradingDate: "2026-11-04", pageUpdatedAt: "2026-11-04T07:30:00+09:00",
        revisionIdentity: key("qri-current", revision), versionKey: key("qri-current", revision),
        canonicalSignature: hex(revision) }, previousComparisonQri: { contract: "2026-11",
        sourceDate: "2026-11-03T07:30:00+09:00", revisionIdentity: key("qri-previous", "b"),
        versionKey: key("qri-previous", "b"), canonicalSignature: hex("b") },
    comparisonFingerprint: hex("c"), futuresQuote: { source: "qri-nikkei225-futures",
        contract: "2026-12", quotedAt: "2026-11-04T06:00:00+09:00", value: 66480,
        versionKey: key("futures", "d"), quoteSignature: hex("d") } }; }
function weekly() { return { readinessState: "available", reason: null,
    previous: { sourceDate: "2026-10-22", versionKey: key("weekly-previous", "e"),
        signature: hex("e") }, current: { sourceDate: "2026-10-29",
        versionKey: key("weekly-current", "f"), signature: hex("f") },
    activeVersionKey: key("weekly-current", "f"), sourceSchemaVersion: 2,
    parserVersion: 2, brokerSetVersion: 1, scoringVersion: 2, contractExpiries: [] }; }
const component = (normalizedDirection, qualityFactor = 1, evidenceFactor = .8,
    metadata = {}) => ({ available: true, normalizedDirection, qualityFactor,
    evidenceFactor, metadata });
async function observation({ acceptedAt = "2026-11-04T00:10:00.000Z",
    observedAt = acceptedAt, session = "day", optionRevision = "a",
    optionAvailable = true, logic = Identity.CURRENT_LOGIC_IDENTITY } = {}) {
    const optionInput = optionAvailable ? option(optionRevision) : { readinessState: "unavailable",
        reason: "formal_revision_missing", referenceState: "unavailable" };
    const identity = await Identity.createObservationIdentity({ logic,
        inputs: { option: optionInput, weekly: weekly() }, observationSlot: {
            calendarDay: "2026-11-04", sessionIdentity: { kind: session, key: "2026-11-04" } } });
    assert.equal(identity.accepted, true);
    const result = Overall.calculateOverallJudgmentV2({
        option: optionAvailable ? component(.4, 1, .8, { usingFallback: false,
            scoreDifference: 3 }) : { available: false, reason: "formal_revision_missing" },
        weekly: component(.2, 1, .6, { scoreDiff: .02 }) }, "2026-11-04T00:09:00.000Z");
    const envelope = { formalApplied: true, identityVerified: true,
        inputFingerprint: hex("9"), publicationGeneration: 4, result };
    const built = await Observation.buildTraceObservation({ identity: identity.identity,
        envelope, observedAt, acceptedAt, generationBinding: generations });
    assert.equal(built.success, true, built.reason); return built.observation;
}
function store(root, crashAt = null) { return Store.createIsolatedStore({ root,
    targetEnvironment: "isolated_test", crashAt }); }

test("T2-1 first accepted trace creates fixed schema and all stores atomically", async t => {
    const root = isolatedRoot(t), value = await observation();
    const result = await store(root).commit(value);
    assert.deepEqual([result.committed, result.transactionCount], [true, 1]);
    const loaded = await store(root).load();
    assert.equal(loaded.databaseName, "optionMapOverallTraceHistory");
    assert.equal(loaded.schemaVersion, 1);
    assert.deepEqual(Object.keys(loaded.stores).sort(), [...Store.STORE_NAMES].sort());
    assert.equal(loaded.stores.overallTraceObservations.length, 1);
});

test("T2-2 failed first write leaves no empty DB shell", async t => {
    const root = isolatedRoot(t), value = await observation();
    await assert.rejects(store(root, "after_temp").commit(value), /transaction_aborted/);
    assert.equal(fs.existsSync(path.join(root, Store.FILE_NAME)), false);
    assert.deepEqual(fs.readdirSync(root), []);
});

test("T2-3 duplicate semantic observation performs write0", async t => {
    const root = isolatedRoot(t), value = await observation(); await store(root).commit(value);
    const duplicate = await store(root).commit(value);
    assert.deepEqual([duplicate.classification, duplicate.transactionCount, duplicate.committed],
        ["exact_duplicate", 0, false]);
});

test("T2-4 same slot with new Option revision appends immutably", async t => {
    const root = isolatedRoot(t), first = await observation(); await store(root).commit(first);
    const second = await observation({ optionRevision: "1", acceptedAt: "2026-11-04T00:11:00.000Z" });
    await store(root).commit(second);
    const loaded = await store(root).load();
    assert.equal(loaded.stores.overallTraceObservations.length, 2);
    assert.notEqual(first.observationId, second.observationId);
});

test("T2-5 same slot with a material logic identity change appends", async t => {
    const root = isolatedRoot(t), first = await observation(); await store(root).commit(first);
    const logic = clone(Identity.CURRENT_LOGIC_IDENTITY);
    logic.fallbackPolicyVersion = "overall-v2-quality-origin-v2";
    const second = await observation({ logic, acceptedAt: "2026-11-04T00:12:00.000Z" });
    await store(root).commit(second);
    assert.equal((await store(root).load()).stores.overallTraceObservations.length, 2);
    assert.notEqual(first.logicIdentityHash, second.logicIdentityHash);
});

test("T2-6 valid Weekly-only partial trace persists with Option weight zero", async t => {
    const root = isolatedRoot(t), value = await observation({ optionAvailable: false });
    assert.equal(value.status, "partial");
    assert.equal(value.componentSnapshots.option.effectiveWeight, 0);
    await store(root).commit(value);
    assert.equal((await store(root).latest()).observation.status, "partial");
});

test("T2-7 restart durability preserves exact trace hashes", async t => {
    const root = isolatedRoot(t), value = await observation(); await store(root).commit(value);
    const reopened = await store(root).readByObservationId(value.observationId);
    assert.deepEqual(reopened.observation, value);
});

test("T2-8 latest reader uses acceptedAt then observationId ordering", async t => {
    const root = isolatedRoot(t), first = await observation();
    const second = await observation({ optionRevision: "1", acceptedAt: "2026-11-04T00:20:00.000Z" });
    await store(root).commit(second); await store(root).commit(first);
    assert.equal((await store(root).latest()).observationId, second.observationId);
});

test("T2-9 session reader keeps day and night observations separate", async t => {
    const root = isolatedRoot(t), day = await observation();
    const night = await observation({ session: "night", acceptedAt: "2026-11-04T09:10:00.000Z" });
    await store(root).commit(day); await store(root).commit(night);
    assert.deepEqual((await store(root).byCalendarDaySession("2026-11-04", "night"))
        .map(item => item.observationId), [night.observationId]);
});

test("T2-10 as-known-at returns the latest previously accepted trace", async t => {
    const root = isolatedRoot(t), first = await observation();
    const second = await observation({ optionRevision: "1", acceptedAt: "2026-11-04T00:20:00.000Z" });
    await store(root).commit(first); await store(root).commit(second);
    assert.equal((await store(root).asKnownAt("2026-11-04T00:15:00.000Z")).observationId,
        first.observationId);
});

for (const [name, mutate] of [
    ["T2-11 forged logic hash", value => { value.logicIdentity.configuredWeights.option = 54; }],
    ["T2-12 forged input hash", value => { value.inputSetIdentity.option.currentQri.contract = "2026-12"; }],
    ["T2-13 forged observationId", value => { value.observationId =
        `overall-v2-trace|sha256:${hex("0")}`; }],
    ["altered component contribution", value => { value.componentSnapshots.option.weightedContribution += 1; }],
    ["altered observation slot", value => { value.observationSlot.sessionIdentity.kind = "night"; }]
]) test(name + " fails closed", async () => { const value = clone(await observation()); mutate(value);
    assert.equal(await Observation.validateTraceObservation(value), false); });

test("T2-14 current envelope adapter rejects mixed generation", async () => {
    const qri = { source: "qri", sequence: 1, fingerprint: "one", current: true };
    const result = await Identity.adaptCurrentEnvelope({ envelope: { envelopeVersion: 1,
        formalApplied: true, identityVerified: true, inputFingerprint: hex("9"),
        optionSourceIdentity: { canonicalVersionKey: key("qri-current", "a"),
            canonicalSignature: hex("a"), generation: qri }, result: { components: {
            option: { available: true, metadata: {} }, weekly: { available: false, notes: [] } } } },
    optionComparisonEnvelope: { envelopeVersion: 1, available: true,
        current: { versionKey: key("qri-current", "a"), canonicalSignature: hex("a") },
        generation: { ...qri, sequence: 2 } }, futuresQuoteFact: { factVersion: 1,
        available: true, identityVerified: true, acquisitionVerified: true },
    observationSlot: { calendarDay: "2026-11-04", sessionIdentity: { kind: "day",
        key: "2026-11-04" } } });
    assert.equal(result.reason, "option_adapter_binding_invalid");
});

test("T2-15 transaction abort preserves prior snapshot", async t => {
    const root = isolatedRoot(t), first = await observation(); await store(root).commit(first);
    const second = await observation({ optionRevision: "1", acceptedAt: "2026-11-04T00:20:00.000Z" });
    await assert.rejects(store(root, "before_rename").commit(second), /transaction_aborted/);
    assert.deepEqual((await store(root).load()).stores.overallTraceObservations
        .map(item => item.observationId), [first.observationId]);
});

test("T2-16 future store and trace schemas fail closed", async t => {
    const root = isolatedRoot(t), value = await observation(); await store(root).commit(value);
    const file = path.join(root, Store.FILE_NAME), data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.schemaVersion = 2; fs.writeFileSync(file, JSON.stringify(data));
    await assert.rejects(store(root).load(), /store_schema_invalid/);
    const future = clone(value); future.schemaVersion = 2;
    assert.equal(await Observation.validateTraceObservation(future), false);
});

test("main-owned writer revalidates authority and performs fresh readback", async t => {
    const root = isolatedRoot(t); let current = clone(generations); let operation = 0;
    const factory = ({ purpose } = {}) => store(root, purpose === "write" ? null : null);
    const writer = Writer.createMainOwnedWriter({ storeFactory: factory,
        getCurrentAuthorityBinding: async () => clone(current),
        createOperationId: () => `operation-${++operation}` });
    const value = await observation(), ticket = await writer.registerMainAcceptedObservation({
        observation: value, generationBinding: generations });
    const result = await writer.commitAcceptedObservation(ticket);
    assert.deepEqual([result.status, result.transactionCount, result.readBack],
        ["committed", 1, true]);
    current = { ...generations, overall: "overall-2" };
    await assert.rejects(writer.registerMainAcceptedObservation({ observation: value,
        generationBinding: generations }), /authority_generation_stale/);
});

test("binding generation covers all four current authorities deterministically", () => {
    const snapshot = { optionEvidence: { publicationGeneration: 1, status: "unavailable",
        reason: "missing" }, weekly: { publicationGeneration: 2, status: "available",
        fact: { sourceFingerprint: "weekly" } }, overall: { publicationGeneration: 3,
        status: "available", envelope: { inputFingerprint: hex("a") } }, futures: {
        publicationGeneration: 4, status: "unavailable", reason: "missing" } };
    assert.deepEqual(Object.keys(Binding.generationOf(snapshot)).sort(),
        ["futures", "option", "overall", "weekly"]);
});

test("canonical main binding adapts the accepted envelope and rejects no renderer record", async () => {
    const qriGeneration = { source: "qri", sequence: 4,
        fingerprint: "qri-generation", current: true };
    const weeklyGeneration = { source: "weekly", sequence: 5,
        fingerprint: "weekly-generation", current: true };
    const previousKey = key("weekly-previous", "e"), currentKey = key("weekly-current", "f");
    const result = Overall.calculateOverallJudgmentV2({ option: component(.4, 1, .8,
        { usingFallback: false, scoreDifference: 3 }), weekly: component(.2, 1, .6, {
            previous: { sourceDate: "2026-10-22", versionKey: previousKey,
                signature: hex("e") }, current: { sourceDate: "2026-10-29",
                versionKey: currentKey, signature: hex("f") }, activeVersionKey: currentKey,
            scoreDiff: .02 }) }, "2026-11-04T00:09:00.000Z");
    const snapshot = { optionEvidence: { publicationGeneration: 6, status: "available",
        reason: null, comparisonEnvelope: { envelopeVersion: 1, available: true,
            evidenceFingerprint: hex("c"), generation: qriGeneration,
            previous: { contract: "2026-11", sourceDate: "2026-11-03T07:30:00+09:00",
                revisionIdentity: key("qri-previous", "b"),
                versionKey: key("qri-previous", "b"), canonicalSignature: hex("b") },
            current: { contract: "2026-11", tradingDate: "2026-11-04",
                pageUpdatedAt: "2026-11-04T07:30:00+09:00",
                revisionIdentity: key("qri-current", "a"),
                versionKey: key("qri-current", "a"), canonicalSignature: hex("a") } } },
    weekly: { publicationGeneration: 5, status: "available", reason: null, fact: {
        previousVersionKey: previousKey, currentVersionKey: currentKey,
        currentSignature: hex("f"), sourceFingerprint: "weekly-source",
        generation: weeklyGeneration } },
    overall: { publicationGeneration: 7, status: "available", reason: null, envelope: {
        envelopeVersion: 1, formalApplied: true, identityVerified: true,
        inputFingerprint: hex("9"), publicationGeneration: 7,
        optionSourceIdentity: { canonicalVersionKey: key("qri-current", "a"),
            canonicalSignature: hex("a"), generation: qriGeneration },
        weeklySourceIdentity: { previousVersionKey: previousKey,
            currentVersionKey: currentKey, currentSignature: hex("f"),
            generation: weeklyGeneration }, result } },
    futures: { publicationGeneration: 8, status: "available", reason: null, fact: {
        factVersion: 1, available: true, identityVerified: true,
        acquisitionVerified: true, versionKey: key("futures", "d"),
        quoteIdentity: { contract: "2026-12",
            quotedAtNormalized: "2026-11-04T06:00:00+09:00", value: 66480,
            versionKey: key("futures", "d"), quoteSignature: hex("d") } } } };
    const binding = Binding.createMainAuthorityBinding({
        getFreshSnapshot: async () => clone(snapshot),
        now: () => "2026-11-04T00:10:00.000Z" });
    const accepted = await binding.evaluate();
    assert.equal(accepted.status, "accepted", accepted.reason);
    assert.equal(accepted.observation.observationSlot.sessionIdentity.kind, "day");
    assert.equal(accepted.observation.componentSnapshots.option.exactInputIdentity
        .currentQri.versionKey, key("qri-current", "a"));
});

test("runtime activation is zero-argument, one-shot and failure-isolated", () => {
    const preload = fs.readFileSync(path.join(__dirname, "../preload.js"), "utf8");
    const script = fs.readFileSync(path.join(__dirname, "../js/script.js"), "utf8");
    const main = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
    assert.match(preload, /invokeOverallTraceEvaluation\(args\)/);
    assert.match(preload, /args\.length !== 0/);
    assert.match(main, /ipcMain\.handle\("evaluate-formal-overall-trace", async event/);
    assert.doesNotMatch(main, /evaluate-formal-overall-trace", async \(event,\s*request/);
    const trigger = script.slice(script.indexOf("const overallPublication"),
        script.indexOf("await window.evaluateMorningBaselineV4Applicability"));
    assert.match(trigger, /evaluateOverallV2Trace\(\)\.then/);
    assert.match(trigger, /\.catch\(error =>/);
    assert.doesNotMatch(trigger, /setTimeout|setInterval|refreshAllMarketData|fetchQri/);
});

test("trace persistence modules expose no network, generic IPC, UI, or score calculation", () => {
    const source = ["overallTraceObservation.js", "overallTraceHistoryStore.js",
        "overallTraceMainWriter.js", "overallTraceMainAuthorityBinding.js"].map(name =>
        fs.readFileSync(path.join(__dirname, "../js", name), "utf8")).join("\n");
    assert.doesNotMatch(source, /\bfetch\s*\(|indexedDB|localStorage|document\.|calculateOverallJudgmentV2\s*\(/);
    assert.doesNotMatch(source, /ipcMain|ipcRenderer|https?:\/\//);
});
