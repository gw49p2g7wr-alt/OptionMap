const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Policy = require("../js/morningBaselineV4CapturePolicy.js");
const Runtime = require("../js/morningBaselineV4CaptureRuntime.js");
const Storage = require("../js/morningBaselineV4Storage.js");

const clone = value => structuredClone(value);
const identity = (source, versionKey) => ({ source, versionKey, signature: `${source}-${versionKey}`,
    verified: true });
const component = (name, direction, weight) => ({ name, available: true, invalid: false,
    normalizedDirection: direction, directionScore: direction * 100, baseWeight: weight,
    qualityFactor: 1, effectiveWeight: weight, weightedContribution: direction * weight,
    evidenceFactor: Math.abs(direction), notes: [], metadata: null });
function builderInput(options = {}) {
    const date = options.date || "2026-08-27"; const contract = "2026-09";
    const capturedAt = options.capturedAt || `${date}T08:03:00+09:00`;
    return { capturedAt, marketContext: { captureCalendarDate: date, formalTradingDate: date,
        sessionIdentity: `morning-v4-scope|${contract}|${date}|same_date_explicit`,
        sessionMappingStatus: "verified" }, overallV2Context: { origin: "formal_live",
        formalApplied: true, superseded: false, logicVersion: "overall-v2-v1", evaluatedAt: capturedAt,
        inputIdentity: identity("overall", options.qri || "qri-v1"), componentIdentities: {
            option: identity("qri", options.qri || "qri-v1"), weekly: identity("weekly", "weekly-v1") },
        result: { status: "complete", direction: 20, directionLabel: "買い優勢", confidence: 80,
            confidenceFactors: { agreement: 80 }, components: { option: component("option", .2, 55),
                weekly: component("weekly", .2, 45) }, metadata: { coverage: 100, warnings: [] } } },
    currentPriceContext: { available: true, sourceKind: "live", origin: "live", mode: "automatic",
        value: options.price || 66000, contract, quoteDate: date, quotedAtNormalized: capturedAt,
        quoteSignature: "price-signature", versionKey: options.priceVersion || "price-v1",
        wrapperSignature: "wrapper", requestId: options.requestId || "request-1", fetchedAt: capturedAt,
        currentRequestVerified: true, identityVerified: true, acquisitionVerified: true,
        acquisitionIdentity: { requestId: options.requestId || "request-1", fetchedAt: capturedAt,
            sourceUrl: "https://svc.qri.jp/jpx/nkopm/", wrapperSignature: "wrapper" },
        qriTradingDateMapping: { status: "verified", quoteDate: date, qriTradingDate: date,
            relation: "same_date", mappingVerified: true, mappingSource: "same_date_explicit" } },
    qriContext: { available: true, origin: "formal_live", sourceKind: "live",
        formalRevisionAvailable: true, referenceOnly: false, usingFallback: false, restored: false,
        superseded: false, openInterestStatus: "available", identity: { verified: true, contract,
            tradingDate: date, pageUpdatedAt: capturedAt, canonicalSignature: "qri-signature",
            canonicalVersionKey: options.qri || "qri-v1", historyEntryId: `${contract}|${date}`,
            historyRevisionId: options.qri || "qri-v1" } }, weeklyContext: { available: true,
        origin: "formal_history", formalApplied: true, usingFallback: false, superseded: false,
        sourceDate: date, versionKey: "weekly-v1", signature: "weekly-signature",
        identityVerified: true, normalizedDirection: .2, qualityFactor: 1, effectiveWeight: 45,
        weightedContribution: 9, metadata: null }, nearestLevelsContext: null,
    dataQualityContext: { status: "complete", warnings: [], sourceAvailability: { currentPrice: true,
        qri: true, weekly: true, overallV2: true }, componentAvailability: { option: true, weekly: true },
        fallbackFlags: { currentPrice: false, qri: false, weekly: false, overallV2: false } } };
}
function collector(options = {}) {
    const date = options.date || "2026-08-27"; const requestId = options.requestId || "request-1";
    const generation = { currentPriceGeneration: options.priceGeneration || 1,
        currentPriceVersionKey: options.priceVersion || "price-v1", qriGeneration: 1,
        qriVersionKey: options.qri || "qri-v1", weeklyGeneration: 1, weeklyVersionKey: "weekly-v1",
        overallGeneration: 1, overallInputFingerprint: options.overall || "overall-v1",
        requestIds: [requestId, requestId, requestId, requestId] };
    return { collectorVersion: 1, ready: options.ready !== false,
        status: options.ready === false ? "not_ready" : "ready", reason: null, reasons: [],
        collectedAt: `${date}T08:03:00+09:00`, formalSnapshotInputFingerprint: options.fingerprint || "f".repeat(64),
        sourceGenerations: { start: clone(generation), end: clone(generation) },
        sessionScope: { available: true, status: "verified", mappingVerified: true,
            sessionClass: "same_date_verified", scopeId: `morning-v4-scope|2026-09|${date}|same_date_explicit`,
            formalTradingDate: date, contract: "2026-09" }, factContract: { ready: true,
            status: "ready", reasons: [], facts: {} }, builderInput: builderInput(options),
        baselineCandidate: null, diagnostics: { fingerprintMatched: true, refreshInProgress: false,
            mixedAcquisitionDetected: false, builderInvoked: false } };
}
function memoryStorage(initial = null) { let value = initial; const writes = []; const reads = [];
    return { writes, reads, get value() { return value; }, getItem(key) { reads.push(key); return value; },
        setItem(key, next) { writes.push([key, next]); value = next; } }; }
function runtime(options = {}) {
    const storage = options.storage || memoryStorage(); const values = options.collectors || [collector(), collector()];
    let index = 0; return { storage, instance: Runtime.createRuntime({ storage,
        collect: async () => clone(values[Math.min(index++, values.length - 1)]),
        isRefreshInProgress: options.refresh || (() => false), evaluatePolicy: options.policy,
        store: options.store, now: () => options.now || "2026-08-27T08:04:00+09:00" }) };
}
const capture = instance => instance.captureManual({ mode: "manual", userInitiated: true,
    requestedAt: "2026-08-27T08:04:00+09:00" });

test("manual create writes once and validates read-back", async () => { const { instance, storage } = runtime();
    const value = await capture(instance); assert.deepEqual([value.status, value.action, value.saved],
        ["saved", "create", true]); assert.equal(storage.writes.length, 1);
    assert.deepEqual([value.diagnostics.readBackValidated, value.diagnostics.savedBaselineActive], [true, true]); });
test("manual replace writes once and retains previous revision", async () => {
    const first = runtime(); await capture(first.instance); const original = first.storage.value;
    const changed = collector({ qri: "qri-v2", price: 66100, priceVersion: "price-v2" });
    const second = runtime({ storage: memoryStorage(original), collectors: [changed, changed],
        now: "2026-08-27T09:00:00+09:00" });
    const value = await second.instance.captureManual({ mode: "manual", userInitiated: true,
        requestedAt: "2026-08-27T09:00:00+09:00" });
    const restored = await Storage.restoreMorningBaselineV4Storage(second.storage.value);
    assert.deepEqual([value.status, value.action, second.storage.writes.length], ["saved", "replace", 1]);
    assert.equal(restored.container.series[0].revisions.length, 2); });
test("duplicate is success-equivalent with zero writes", async () => { const first = runtime();
    await capture(first.instance); const second = runtime({ storage: memoryStorage(first.storage.value) });
    const value = await capture(second.instance); assert.deepEqual([value.status, value.reason,
        value.diagnostics.duplicateNoWrite, second.storage.writes.length], ["duplicate", "duplicate", true, 0]); });
test("collector not ready rejects without write", async () => { const value = runtime({
    collectors: [collector({ ready: false })] }); assert.equal((await capture(value.instance)).reason,
        "collector_not_ready"); assert.equal(value.storage.writes.length, 0); });
test("non-manual and non-user requests reject", async () => { const { instance, storage } = runtime();
    assert.equal((await instance.captureManual({ mode: "automatic", userInitiated: true })).reason,
        "policy_rejected"); assert.equal((await instance.captureManual({ mode: "manual",
            userInitiated: false })).reason, "policy_rejected"); assert.equal(storage.writes.length, 0); });
test("refresh before collect rejects", async () => { const value = runtime({ refresh: () => true });
    assert.equal((await capture(value.instance)).reason, "refresh_in_progress"); });
test("refresh before write rejects", async () => { let calls = 0; const value = runtime({
    refresh: () => ++calls >= 2 }); assert.equal((await capture(value.instance)).reason,
        "refresh_in_progress"); assert.equal(value.storage.writes.length, 0); });
test("refresh starting after concurrency checks still blocks the write", async () => { let calls = 0;
    const value = runtime({ refresh: () => ++calls >= 4 });
    assert.equal((await capture(value.instance)).reason, "refresh_in_progress");
    assert.equal(value.storage.writes.length, 0); });
for (const [name, second] of [["generation", collector({ priceGeneration: 2 })],
    ["requestId", collector({ requestId: "request-2" })],
    ["source fingerprint", collector({ overall: "overall-v2" })],
    ["formal snapshot fingerprint", collector({ fingerprint: "e".repeat(64) })]])
    test(`${name} change blocks write`, async () => { const value = runtime({ collectors: [collector(), second] });
        assert.equal((await capture(value.instance)).reason, "source_changed_during_capture");
        assert.equal(value.storage.writes.length, 0); });
test("storage appearing after missing policy blocks write", async () => { const storage = memoryStorage();
    const wrapped = async input => { const result = await Policy.evaluateMorningBaselineV4CapturePolicy(input);
        storage.setItem(Storage.STORAGE_KEY, "unexpected"); storage.writes.length = 0; return result; };
    const value = runtime({ storage, policy: wrapped }); assert.equal((await capture(value.instance)).reason,
        "storage_changed_during_capture"); assert.equal(storage.writes.length, 0); });
test("invalid existing storage is never overwritten", async () => { const value = runtime({
    storage: memoryStorage("{") }); assert.equal((await capture(value.instance)).reason,
        "existing_storage_invalid"); assert.equal(value.storage.writes.length, 0); });
test("policy rejection performs no write", async () => { const value = runtime({ policy: async () => ({
    eligible: false, status: "rejected", action: "reject", reason: "test" }) });
    assert.equal((await capture(value.instance)).reason, "policy_rejected");
    assert.equal(value.storage.writes.length, 0); });
test("setItem and quota failures are isolated", async () => { for (const errorName of ["Error", "QuotaExceededError"]) {
    const storage = memoryStorage(); storage.setItem = () => { const error = new Error("write");
        error.name = errorName; throw error; }; const value = runtime({ storage });
    assert.equal((await capture(value.instance)).reason, "storage_write_failed"); } });
test("invalid read-back is reported without repair", async () => { const storage = memoryStorage();
    storage.setItem = function (key, value) { this.writes.push([key, value]); Object.defineProperty(this,
        "value", { configurable: true, get: () => "{" }); };
    const value = runtime({ storage }); const result = await capture(value.instance);
    assert.equal(result.reason, "storage_readback_failed"); assert.equal(storage.writes.length, 1); });
test("runtime state and getter snapshots are detached and deeply frozen", async () => {
    const { instance } = runtime(); const value = await capture(instance); const state = instance.getState();
    assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.diagnostics), true);
    assert.notEqual(value, state); assert.equal(Object.isFrozen(state), true); });
test("runtime touches only fixed v4 key and has no forbidden connections", async () => {
    const { instance, storage } = runtime(); await capture(instance);
    assert.equal(storage.reads.every(key => key === Storage.STORAGE_KEY), true);
    assert.equal(storage.writes.every(([key]) => key === Storage.STORAGE_KEY), true);
    const source = fs.readFileSync(path.join(__dirname, "../js/morningBaselineV4CaptureRuntime.js"), "utf8");
    assert.doesNotMatch(source, /indexedDB|\bfetch\s*\(|setTimeout|setInterval|MobileSummary|optionMapMobileMorning|bootRestore|migration/); });
test("existing save button keeps legacy save first and adds isolated v4 capture", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/mobileSummaryPreview.js"), "utf8");
    const legacy = source.indexOf("OptionMapMorningBaselineStorage.save(saved.baseline)");
    const v4 = source.indexOf("OptionMapMorningBaselineV4CaptureRuntime?.captureManual");
    assert.ok(legacy >= 0 && v4 > legacy); assert.match(source, /legacyMessage/);
});
test("successful capture notifies restore runtime without changing save semantics", async () => {
    let notified = null; const value = runtime(); value.instance = Runtime.createRuntime({
        storage: value.storage, collect: async () => collector(), isRefreshInProgress: () => false,
        notifyCaptureSuccess: result => { notified = result; }, now: () => "2026-08-27T08:04:00+09:00" });
    const result = await capture(value.instance); assert.equal(result.status, "saved");
    assert.equal(notified.activeBaselineId, result.activeBaselineId);
});
test("restore notification failure cannot roll back or relabel a completed save", async () => {
    const value = runtime(); const instance = Runtime.createRuntime({ storage: value.storage,
        collect: async () => collector(), isRefreshInProgress: () => false,
        notifyCaptureSuccess: async () => { throw new Error("restore failed"); },
        now: () => "2026-08-27T08:04:00+09:00" });
    const result = await capture(instance); assert.deepEqual([result.status, result.saved,
        value.storage.writes.length], ["saved", true, 1]);
});
