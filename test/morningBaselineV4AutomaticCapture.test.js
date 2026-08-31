const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Runtime = require("../js/morningBaselineV4CaptureRuntime.js");
const Storage = require("../js/morningBaselineV4Storage.js");

const clone = value => structuredClone(value);
const identity = (source, versionKey) => ({ source, versionKey,
    signature: `${source}-${versionKey}`, verified: true });
const component = (name, direction, weight) => ({ name, available: true, invalid: false,
    normalizedDirection: direction, directionScore: direction * 100, baseWeight: weight,
    qualityFactor: 1, effectiveWeight: weight, weightedContribution: direction * weight,
    evidenceFactor: Math.abs(direction), notes: [], metadata: null });
function collector(options = {}) {
    const date = options.date || "2026-09-01"; const contract = options.contract || "2026-09";
    const requestId = options.requestId || "market-1"; const capturedAt = options.capturedAt ||
        `${date}T05:00:00+09:00`; const scopeId = `morning-v4-scope|${contract}|${date}|same_date_explicit`;
    const generation = { currentPriceGeneration: 1, currentPriceVersionKey: "price-v1",
        qriGeneration: 1, qriVersionKey: "qri-v1", weeklyGeneration: 1,
        weeklyVersionKey: "weekly-v1", overallGeneration: 1,
        overallInputFingerprint: "overall-v1", requestIds: Array(4).fill(requestId) };
    const builderInput = { capturedAt, marketContext: { captureCalendarDate: date,
        formalTradingDate: date, sessionIdentity: scopeId, sessionMappingStatus: "verified" },
    overallV2Context: { origin: "formal_live", formalApplied: true, superseded: false,
        logicVersion: "overall-v2-v1", evaluatedAt: capturedAt,
        inputIdentity: identity("overall", "qri-v1"), componentIdentities: {
            option: identity("qri", "qri-v1"), weekly: identity("weekly", "weekly-v1") },
        result: { status: "complete", direction: 20, directionLabel: "買い優勢", confidence: 80,
            confidenceFactors: { agreement: 80 }, components: { option: component("option", .2, 55),
                weekly: component("weekly", .2, 45) }, metadata: { coverage: 100, warnings: [] } } },
    currentPriceContext: { available: true, sourceKind: "live", origin: "live", mode: "automatic",
        value: 66000, contract, quoteDate: date, quotedAtNormalized: capturedAt,
        quoteSignature: "price-signature", versionKey: "price-v1", wrapperSignature: "wrapper",
        requestId, fetchedAt: capturedAt, currentRequestVerified: true, identityVerified: true,
        acquisitionVerified: true, acquisitionIdentity: { requestId, fetchedAt: capturedAt,
            sourceUrl: "https://svc.qri.jp/jpx/nkopm/", wrapperSignature: "wrapper" },
        qriTradingDateMapping: { status: "verified", quoteDate: date, qriTradingDate: date,
            relation: "same_date", mappingVerified: true, mappingSource: "same_date_explicit" } },
    qriContext: { available: true, origin: "formal_live", sourceKind: "live",
        formalRevisionAvailable: true, referenceOnly: false, usingFallback: false, restored: false,
        superseded: false, openInterestStatus: "available", identity: { verified: true, contract,
            tradingDate: date, pageUpdatedAt: capturedAt, canonicalSignature: "qri-signature",
            canonicalVersionKey: "qri-v1", historyEntryId: `${contract}|${date}`,
            historyRevisionId: "qri-v1" } }, weeklyContext: { available: true,
        origin: "formal_history", formalApplied: true, usingFallback: false, superseded: false,
        sourceDate: date, versionKey: "weekly-v1", signature: "weekly-signature",
        identityVerified: true, normalizedDirection: .2, qualityFactor: 1, effectiveWeight: 45,
        weightedContribution: 9, metadata: null }, nearestLevelsContext: null,
    dataQualityContext: { status: "complete", warnings: [], sourceAvailability: {
        currentPrice: true, qri: true, weekly: true, overallV2: true }, componentAvailability: {
        option: true, weekly: true }, fallbackFlags: { currentPrice: false, qri: false,
        weekly: false, overallV2: false } } };
    return { collectorVersion: 1, ready: options.ready !== false,
        status: options.ready === false ? "not_ready" : "ready", reason: null, reasons: [],
        collectedAt: capturedAt, formalSnapshotInputFingerprint: "f".repeat(64),
        sourceGenerations: { start: clone(generation), end: clone(generation) },
        sessionScope: { available: true, status: "verified", mappingVerified: true,
            sessionClass: "same_date_verified", scopeId, formalTradingDate: date, contract },
        factContract: { ready: true, status: "ready", reasons: [], facts: {} }, builderInput,
        baselineCandidate: null, diagnostics: { fingerprintMatched: true, refreshInProgress: false,
            mixedAcquisitionDetected: false, builderInvoked: false } };
}
function memoryStorage(initial = {}) {
    const values = new Map(Object.entries(initial)); const writes = [];
    return { values, writes, getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { writes.push(key); values.set(key, value); } };
}
function runtime(options = {}) {
    const storage = options.storage || memoryStorage(); const source = options.collector || collector();
    let reads = 0; const instance = Runtime.createRuntime({ storage,
        collect: async () => { reads += 1; return clone(source); },
        isRefreshInProgress: () => false, now: () => options.now || "2026-09-01T05:00:01+09:00" });
    return { storage, instance, reads: () => reads };
}

for (const [time, eligible, status] of [["2026-08-31T19:59:59Z", false, "outside_window_before"],
    ["2026-08-31T20:00:00Z", true, "inside_window"],
    ["2026-08-31T23:59:59Z", true, "inside_window"],
    ["2026-09-01T00:00:00Z", false, "outside_window_after"]])
    test(`JST automatic window ${time}`, () => { const value = runtime().instance
        .evaluateAutomaticWindow(time); assert.deepEqual(value, { eligible, status }); });

test("first eligible refresh saves with actual capturedAt and durable outcome", async () => {
    const value = runtime(); const result = await value.instance.captureAutomatic({ requestId: "market-1",
        requestedAt: "2026-09-01T05:00:01+09:00" });
    assert.deepEqual([result.status, result.saved, result.capturedAt],
        ["saved", true, "2026-09-01T05:00:01+09:00"]);
    assert.equal(value.storage.writes.includes(Storage.STORAGE_KEY), true);
    assert.equal(value.storage.writes.includes(Runtime.AUTOMATIC_OUTCOME_KEY), true);
    assert.equal(value.instance.getAutomaticOutcome().scopeId,
        "morning-v4-scope|2026-09|2026-09-01|same_date_explicit");
});
test("outside window performs no collection and remains retry eligible", async () => {
    const value = runtime(); const result = await value.instance.captureAutomatic({ requestId: "market-1",
        requestedAt: "2026-09-01T04:59:59+09:00" });
    assert.deepEqual([result.reason, result.retryEligible, value.reads()],
        ["outside_window_before", true, 0]);
});
test("ineligible refresh can retry on the next normal refresh", async () => {
    const value = runtime({ collector: collector({ ready: false }) });
    const waiting = await value.instance.captureAutomatic({ requestId: "market-1" });
    assert.deepEqual([waiting.status, waiting.reason, waiting.saved],
        ["waiting_for_eligibility", "collector_not_ready", false]);
    const next = runtime({ storage: value.storage });
    assert.equal((await next.instance.captureAutomatic({ requestId: "market-2" })).saved, true);
});
test("same refresh is attempted only once", async () => { const value = runtime();
    await value.instance.captureAutomatic({ requestId: "market-1" });
    const second = await value.instance.captureAutomatic({ requestId: "market-1" });
    assert.equal(second.errorCode, "same_refresh_attempted"); assert.equal(value.reads(), 2); });
test("restart uses baseline storage authority and skips an already-saved scope", async () => {
    const first = runtime(); await first.instance.captureAutomatic({ requestId: "market-1" });
    const restarted = runtime({ storage: first.storage });
    const result = await restarted.instance.captureAutomatic({ requestId: "market-2" });
    assert.deepEqual([result.status, result.saved, restarted.reads()], ["already_saved", false, 1]);
    assert.equal(first.storage.writes.filter(key => key === Storage.STORAGE_KEY).length, 1);
});
test("manual-first then automatic skips and automatic-first then manual adds no revision", async () => {
    const manualFirst = runtime(); await manualFirst.instance.captureManual({ mode: "manual",
        userInitiated: true, requestedAt: "2026-09-01T05:00:01+09:00" });
    assert.equal((await manualFirst.instance.captureAutomatic({ requestId: "market-2" })).status,
        "already_saved");
    const autoFirst = runtime(); await autoFirst.instance.captureAutomatic({ requestId: "market-1" });
    const manual = await autoFirst.instance.captureManual({ mode: "manual", userInitiated: true,
        requestedAt: "2026-09-01T05:00:01+09:00" });
    assert.equal(manual.status, "duplicate");
    const restored = await Storage.restoreMorningBaselineV4Storage(
        autoFirst.storage.getItem(Storage.STORAGE_KEY));
    assert.equal(restored.container.series[0].revisions.length, 1);
});
test("diagnostics corruption never invalidates a valid baseline", async () => { const value = runtime();
    await value.instance.captureAutomatic({ requestId: "market-1" });
    value.storage.values.set(Runtime.AUTOMATIC_OUTCOME_KEY, "{");
    assert.equal(value.instance.getAutomaticOutcome(), null);
    assert.equal((await Storage.restoreMorningBaselineV4Storage(
        value.storage.getItem(Storage.STORAGE_KEY))).success, true); });
test("diagnostics write failure cannot roll back a successful baseline", async () => {
    const storage = memoryStorage(); const original = storage.setItem;
    storage.setItem = function (key, value) { if (key === Runtime.AUTOMATIC_OUTCOME_KEY)
        throw new Error("diagnostics"); return original.call(this, key, value); };
    const value = runtime({ storage }); const result = await value.instance.captureAutomatic({
        requestId: "market-1" });
    assert.deepEqual([result.saved, result.errorCode], [true, "diagnostics_failed"]);
    assert.equal((await Storage.restoreMorningBaselineV4Storage(
        storage.getItem(Storage.STORAGE_KEY))).success, true);
});
test("automatic capture is side-effect isolated and production hook remains fire-and-forget", () => {
    const runtimeSource = fs.readFileSync(path.join(__dirname,
        "../js/morningBaselineV4CaptureRuntime.js"), "utf8");
    assert.doesNotMatch(runtimeSource, /\bfetch\s*\(|setTimeout|setInterval|indexedDB/);
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const publication = html.indexOf("await window.publishMorningComparisonV4Runtime?.()");
    const render = html.indexOf("renderFormalComparisonV4?.()", publication);
    const automatic = html.indexOf("runAutomaticFirstSuccessCapture", render);
    const reference = html.indexOf("completeFormalRender(requestId)", automatic);
    assert.ok(publication >= 0 && render > publication && automatic > render && reference > automatic);
    assert.doesNotMatch(html.slice(automatic - 80, automatic + 80), /await\s+window\.OptionMapMorning/);
});
test("automatic UI distinguishes saved waiting and after-window states", () => {
    const source = fs.readFileSync(path.join(__dirname, "../js/mobileSummaryPreview.js"), "utf8");
    assert.match(source, /自動保存済み/); assert.match(source, /正式朝基準：条件待ち/);
    assert.match(source, /自動保存時間 05:00〜09:00/);
});
