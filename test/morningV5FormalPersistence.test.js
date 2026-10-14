"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Observation = require("../js/morningV5FormalObservation.js");
const Store = require("../js/morningV5FormalStore.js");
const Writer = require("../js/morningV5FormalWriter.js");

const digest = character => `sha256:${character.repeat(64)}`;
const generation = Object.freeze({ qri: "qri-generation-1", weekly: "weekly-generation-1",
    overall: "overall-generation-1", futures: "futures-generation-1" });

function input(overrides = {}) {
    const qriContract = overrides.qriContract || "2026-11";
    const futuresContract = overrides.futuresContract || "2026-12";
    const observedAt = overrides.observedAt || "2026-10-14T09:05:00+09:00";
    const quotedAt = overrides.quotedAt || "2026-10-14T09:04:00+09:00";
    const qriVersion = `qri-v|${qriContract}|${overrides.qriRevision || "1"}`;
    const weeklyVersion = overrides.weeklyVersion || "weekly-current-v1";
    return { observedAt, calendarDay: "2026-10-14", tradingDate: "2026-10-14",
        qri: { accepted: true, sourceClass: "formal_live", contract: qriContract,
            tradingDate: "2026-10-14", canonicalVersionKey: qriVersion,
            signature: digest("a"), confirmedAt: "2026-10-14T08:58:00+09:00" },
        weekly: { accepted: true, sourceClass: "formal_history", sourceDate: "2026-10-09",
            previousVersionKey: "weekly-previous-v1", previousSignature: digest("b"),
            currentVersionKey: weeklyVersion, currentSignature: digest("c") },
        overall: { formalApplied: true, logicVersion: "overall-v2-weights-55-45-v1",
            inputFingerprint: overrides.overallFingerprint || "overall-input-v1",
            qriVersionKey: qriVersion, weeklyVersionKey: weeklyVersion,
            direction: overrides.direction ?? 20, confidence: overrides.confidence ?? 80 },
        futures: { available: true, source: "qri-nikkei225-futures",
            instrument: "nikkei225_futures", contract: futuresContract,
            value: overrides.price ?? 68250, quotedAtNormalized: quotedAt,
            quoteSignature: overrides.quoteSignature || digest("d"),
            versionKey: overrides.priceVersion || "price-v1",
            requestId: overrides.requestId },
        shadowMappingClass: qriContract === futuresContract ? "same_contract_reference" :
            "explicit_cross_contract_reference",
        freshnessPolicyVersion: "current-price-session-v1",
        calendar: { mode: "read_only", asKnownAt: observedAt, digest: digest("e") },
        calculation: { calculationVersion: "formal-morning-v5-calculation-v1",
            comparisonPolicyVersion: "formal-morning-v5-comparison-v1" } };
}

async function observation(overrides = {}, previous = []) {
    const result = await Observation.buildMorningV5FormalObservation(input(overrides), previous);
    assert.equal(result.success, true);
    return result.observation;
}

function isolatedRoot(t) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),
        "optionmap-m5-2-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function harness(t, { faultAt = null } = {}) {
    const root = isolatedRoot(t);
    let currentGeneration = structuredClone(generation);
    let storeCrashAt = null;
    let sequence = 0;
    const storeFactory = ({ purpose } = {}) => Store.createIsolatedStore({ root,
        targetEnvironment: "isolated_test",
        crashAt: purpose === "write" ? storeCrashAt : null });
    const makeWriter = writerFault => Writer.createMainOwnedWriter({ storeFactory,
        getCurrentAuthorityBinding: async () => structuredClone(currentGeneration),
        createOperationId: () => `operation-${++sequence}`, faultAt: writerFault });
    return { root, storeFactory, writer: makeWriter(faultAt), makeWriter,
        setGeneration(value) { currentGeneration = value; },
        setStoreCrash(value) { storeCrashAt = value; } };
}

async function write(writer, candidate, binding = generation) {
    const ticket = await writer.registerMainAcceptedObservation({ observation: candidate,
        generationBinding: binding });
    return writer.commitAcceptedObservation(ticket);
}

test("V7 first observation commits once and fresh readers resolve all supported views", async t => {
    const h = harness(t); const first = await observation();
    const result = await write(h.writer, first);
    assert.deepEqual([result.status, result.receipt.classification,
        result.receipt.transaction.count, result.receipt.transaction.committed,
        result.receipt.readBack.reopened, result.receipt.readBack.matched],
    ["committed", "new", 1, 1, true, true]);
    assert.deepEqual(Object.keys(result.receipt).sort(), [...Writer.RECEIPT_FIELDS].sort());
    assert.equal(result.receipt.durableSignature, first.signature);
    const reader = h.storeFactory({ purpose: "reader" });
    assert.equal((await reader.readByObservationId(first.observationId)).observationId,
        first.observationId);
    assert.equal((await reader.latestAcceptedObservation()).observationId, first.observationId);
    assert.deepEqual((await reader.observationSlotHistory(first.observationSlotId))
        .map(item => item.observationId), [first.observationId]);
    assert.deepEqual((await reader.calendarDayHistory("2026-10-14"))
        .map(item => item.observationId), [first.observationId]);
    assert.deepEqual(await reader.calendarDayHistory("2026-10-15"), []);
});

test("V7 exact and transport-only semantic duplicates both perform write0", async t => {
    const h = harness(t); const first = await observation({ requestId: "transport-a" });
    assert.equal((await write(h.writer, first)).status, "committed");
    const exact = await write(h.writer, first);
    const semantic = await observation({ requestId: "transport-b" });
    assert.equal(semantic.observationId, first.observationId);
    assert.equal(semantic.signature, first.signature);
    const semanticResult = await write(h.writer, semantic);
    for (const result of [exact, semanticResult]) {
        assert.equal(result.status, "unchanged");
        assert.equal(result.receipt.classification, "exact_duplicate");
        assert.deepEqual(result.receipt.transaction, { count: 0, committed: 0, aborted: 0 });
    }
    assert.equal((await h.storeFactory({ purpose: "reader" }).load()).observations.length, 1);
});

test("same observation identity with different signed baseline material fails closed", async t => {
    const h = harness(t); const first = await observation(); await write(h.writer, first);
    const unrelatedPrior = await observation({ observedAt: "2026-10-14T09:00:00+09:00",
        quotedAt: "2026-10-14T08:59:00+09:00", direction: 10,
        overallFingerprint: "unrelated-prior", price: 68000,
        quoteSignature: digest("9"), priceVersion: "prior-price" });
    const conflicting = await observation({}, [unrelatedPrior]);
    assert.equal(conflicting.observationId, first.observationId);
    assert.notEqual(conflicting.signature, first.signature);
    const result = await write(h.writer, conflicting);
    assert.deepEqual([result.status, result.reason, result.receipt.transaction.count],
        ["failed", "observation_identity_conflict", 0]);
    assert.equal((await h.storeFactory({ purpose: "reader" }).load()).observations.length, 1);
});

test("V7 meaningful same-slot revision appends and links its exact predecessor", async t => {
    const h = harness(t); const first = await observation();
    await write(h.writer, first);
    const revised = await observation({ observedAt: "2026-10-14T09:10:00+09:00",
        quotedAt: "2026-10-14T09:09:00+09:00", direction: 25,
        overallFingerprint: "overall-input-v2", price: 68300,
        quoteSignature: digest("f"), priceVersion: "price-v2" }, [first]);
    const result = await write(h.writer, revised);
    assert.deepEqual([result.status, result.receipt.classification,
        result.receipt.supersedesObservationId], ["committed", "revision", first.observationId]);
    const history = await h.storeFactory({ purpose: "reader" })
        .observationSlotHistory(first.observationSlotId);
    assert.equal(history.length, 2);
    assert.equal(history[0].observation.signature, first.signature);
    assert.equal(history[1].supersedesObservationId, first.observationId);
});

test("pre-write generation validation and single-flight reject without a transaction", async t => {
    const h = harness(t); const first = await observation();
    const ticket = await h.writer.registerMainAcceptedObservation({ observation: first,
        generationBinding: generation });
    await assert.rejects(h.writer.registerMainAcceptedObservation({ observation: first,
        generationBinding: generation }), /writer_single_flight/);
    h.setGeneration({ ...generation, futures: "futures-generation-2" });
    await assert.rejects(h.writer.commitAcceptedObservation(ticket), /authority_generation_stale/);
    assert.equal((await h.storeFactory({ purpose: "reader" }).load()).observations.length, 0);
});

test("V8 pre-write crash leaves record0", async t => {
    const h = harness(t, { faultAt: "pre_write" });
    await assert.rejects(write(h.writer, await observation()), /pre_write_crash/);
    assert.equal((await h.storeFactory({ purpose: "reader" }).load()).observations.length, 0);
});

test("V8 transaction abort preserves prior durable observations", async t => {
    const h = harness(t); const first = await observation(); await write(h.writer, first);
    const revised = await observation({ observedAt: "2026-10-14T09:10:00+09:00",
        quotedAt: "2026-10-14T09:09:00+09:00", price: 68300,
        quoteSignature: digest("f"), priceVersion: "price-v2",
        direction: 25, overallFingerprint: "overall-input-v2" }, [first]);
    h.setStoreCrash("after_temp");
    const result = await write(h.writer, revised);
    assert.deepEqual([result.status, result.reason, result.receipt.transaction.aborted],
        ["failed", "transaction_aborted", 1]);
    const state = await h.storeFactory({ purpose: "reader" }).load();
    assert.deepEqual(state.observations.map(item => item.observationId), [first.observationId]);
});

test("V8 commit ambiguity is diagnosed read-only with no second transaction", async t => {
    const h = harness(t); h.setStoreCrash("after_rename"); const first = await observation();
    const result = await write(h.writer, first);
    assert.deepEqual([result.status, result.reason, result.receipt.commit,
        result.receipt.transaction.count, result.receipt.transaction.committed],
    ["committed", "commit_ambiguity_resolved", "ambiguous_durable", 1, 1]);
    assert.equal((await h.storeFactory({ purpose: "reader" }).load()).observations.length, 1);
});

test("V8 receipt crash does not cause a blind second write", async t => {
    const h = harness(t); const first = await observation();
    await assert.rejects(write(h.makeWriter("after_readback"), first), /receipt_delivery_crash/);
    const result = await write(h.makeWriter(null), first);
    assert.deepEqual([result.status, result.receipt.classification,
        result.receipt.transaction.count], ["unchanged", "exact_duplicate", 0]);
    assert.equal((await h.storeFactory({ purpose: "reader" }).load()).observations.length, 1);
});

test("store rejects tampering and constrains production authority", async t => {
    const h = harness(t); const first = await observation(); await write(h.writer, first);
    const file = h.storeFactory({ purpose: "reader" }).file;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.observations[0].observation.result.futuresPrice += 1;
    fs.writeFileSync(file, JSON.stringify(data));
    await assert.rejects(h.storeFactory({ purpose: "reader" }).load(), /store_schema_invalid/);
    assert.throws(() => Store.createProductionStore({ getUserDataPath: () => h.root,
        path: "/tmp/other" }), /production_store_authority_invalid/);
    assert.throws(() => Store.createIsolatedStore({ root: "/tmp",
        targetEnvironment: "isolated_test", crashAt: null }),
    /store_root_invalid|isolated_store_root_invalid/);
});

test("V9 V4 and Calendar boundaries remain byte-identical and no write surface is exposed", () => {
    const root = path.join(__dirname, "..");
    const protectedFiles = ["js/morningBaselineV4Storage.js", "js/morningBaselineV4.js",
        "js/marketCalendarRuntime/formalPersistence.js", "preload.js"]
        .filter(name => fs.existsSync(path.join(root, name)));
    const hashes = protectedFiles.map(name => crypto.createHash("sha256")
        .update(fs.readFileSync(path.join(root, name))).digest("hex"));
    const sources = ["js/morningV5FormalStore.js", "js/morningV5FormalWriter.js"]
        .map(name => fs.readFileSync(path.join(root, name), "utf8")).join("\n");
    assert.doesNotMatch(sources, /optionMapMorningBaselinesV4|ipcMain|ipcRenderer|\bfetch\s*\(|https?:|marketCalendar.*Writer/i);
    const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
    assert.match(preload, /readMorningV5Formal/);
    assert.doesNotMatch(preload,
        /commitAcceptedObservation|registerMainAcceptedObservation|saveMorningV5|arbitrary/i);
    assert.deepEqual(protectedFiles.map(name => crypto.createHash("sha256")
        .update(fs.readFileSync(path.join(root, name))).digest("hex")), hashes);
});
