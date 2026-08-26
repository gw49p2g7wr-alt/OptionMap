const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Baseline = require("../js/morningBaselineV4.js");
const Storage = require("../js/morningBaselineV4Storage.js");
const Policy = require("../js/morningBaselineV4CapturePolicy.js");

const clone = value => structuredClone(value);
const identity = (source, versionKey) => ({ source, versionKey,
    signature: `${source}-${versionKey}`, verified: true });
const component = (name, direction, weight) => ({ name, available: true, invalid: false,
    normalizedDirection: direction, directionScore: direction * 100, baseWeight: weight,
    qualityFactor: 1, effectiveWeight: weight, weightedContribution: direction * weight,
    evidenceFactor: Math.abs(direction), notes: [], metadata: null });

function builderInput(options = {}) {
    const tradingDate = options.tradingDate || "2026-08-26";
    const contract = options.contract || "2026-09";
    const qriVersion = options.qriVersion || "qri-v1";
    const capturedAt = options.capturedAt || `${tradingDate}T08:03:00+09:00`;
    const sourceAt = `${tradingDate}T08:00:00+09:00`;
    return { capturedAt, marketContext: { captureCalendarDate: tradingDate,
        formalTradingDate: tradingDate,
        sessionIdentity: options.scopeId || `morning-v4-scope|${contract}|${tradingDate}|same_date_explicit`,
        sessionMappingStatus: "verified" }, overallV2Context: { origin: "formal_live",
        formalApplied: true, superseded: false, logicVersion: "overall-v2-v1", evaluatedAt: sourceAt,
        inputIdentity: identity("overall-v2", qriVersion), componentIdentities: {
            option: identity("qri", qriVersion), weekly: identity("weekly", "weekly-v1") },
        result: { status: "complete", direction: options.direction ?? 29,
            directionLabel: "買い優勢", confidence: 80, confidenceFactors: { agreement: 90 },
            components: { option: component("option", options.optionDirection ?? 0.2, 55),
                weekly: component("weekly", 0.4, 45) },
            metadata: { coverage: 100, warnings: [] } } },
    currentPriceContext: { available: true, sourceKind: "live", origin: "live", mode: "automatic",
        value: options.price || 66000, contract, quoteDate: tradingDate,
        quotedAtNormalized: `${tradingDate}T07:59:00+09:00`, quoteSignature: "price-signature",
        versionKey: options.priceVersion || "price-v1", wrapperSignature: "wrapper-signature",
        requestId: options.requestId || "request-1", fetchedAt: sourceAt,
        currentRequestVerified: true, identityVerified: true, acquisitionVerified: true,
        acquisitionIdentity: { requestId: options.requestId || "request-1", fetchedAt: sourceAt,
            sourceUrl: "https://svc.qri.jp/jpx/nkopm/", wrapperSignature: "wrapper-signature" },
        qriTradingDateMapping: { status: "verified", quoteDate: tradingDate,
            qriTradingDate: tradingDate, relation: "same_date", mappingVerified: true,
            mappingSource: "same_date_explicit" } },
    qriContext: { available: true, origin: "formal_live", sourceKind: "live",
        formalRevisionAvailable: true, referenceOnly: false, usingFallback: false, restored: false,
        superseded: false, openInterestStatus: "available", identity: { verified: true, contract,
            tradingDate, pageUpdatedAt: sourceAt, canonicalSignature: "qri-signature",
            canonicalVersionKey: qriVersion, historyEntryId: `${contract}|${tradingDate}`,
            historyRevisionId: qriVersion } },
    weeklyContext: { available: true, origin: "formal_history", formalApplied: true,
        usingFallback: false, superseded: false, sourceDate: tradingDate, versionKey: "weekly-v1",
        signature: "weekly-signature", identityVerified: true, normalizedDirection: 0.4,
        qualityFactor: 1, effectiveWeight: 45, weightedContribution: 18, metadata: null },
    nearestLevelsContext: options.levels === undefined ? null : options.levels,
    dataQualityContext: { status: "complete", warnings: [],
        sourceAvailability: { currentPrice: true, qri: true, weekly: true, overallV2: true },
        componentAvailability: { option: true, weekly: true },
        fallbackFlags: { currentPrice: false, qri: false, weekly: false, overallV2: false } } };
}

function collector(options = {}) {
    const tradingDate = options.tradingDate || "2026-08-26";
    const contract = options.contract || "2026-09";
    const scopeId = options.scopeId || `morning-v4-scope|${contract}|${tradingDate}|same_date_explicit`;
    const generation = { currentPriceGeneration: 1, qriGeneration: 1, weeklyGeneration: 1,
        overallGeneration: 1 };
    return { collectorVersion: 1, ready: true, status: "ready", reason: null, reasons: [],
        collectedAt: `${tradingDate}T08:03:00+09:00`, formalSnapshotInputFingerprint: "f".repeat(64),
        sourceGenerations: { start: clone(generation), end: clone(generation) },
        sessionScope: { available: true, status: "verified", mappingVerified: true,
            sessionClass: "same_date_verified", scopeId, formalTradingDate: tradingDate, contract },
        factContract: { ready: true, status: "ready", reasons: [], facts: {} },
        builderInput: builderInput({ ...options, scopeId }), baselineCandidate: null,
        diagnostics: { fingerprintMatched: true, refreshInProgress: false,
            mixedAcquisitionDetected: false, builderInvoked: false, storageAccessed: false,
            databaseAccessed: false, fetchTriggered: false, formalRecalculationTriggered: false,
            domMutated: false } };
}

const context = requestedAt => ({ requestedAt: requestedAt || "2026-08-26T08:04:00+09:00",
    mode: "manual", userInitiated: true });
const evaluate = (overrides = {}, dependencies) => Policy.evaluateMorningBaselineV4CapturePolicy({
    collectorResult: overrides.collectorResult || collector(),
    existingStorageState: Object.hasOwn(overrides, "existingStorageState") ?
        overrides.existingStorageState : null,
    captureContext: overrides.captureContext || context() }, dependencies);
async function baseline(options = {}) {
    const result = await Baseline.buildMorningBaselineV4(builderInput(options));
    assert.equal(result.success, true); return result.baseline;
}
async function container(options = {}) {
    const result = await Storage.buildMorningBaselineV4Storage({ baseline: await baseline(options) });
    assert.equal(result.success, true); return result.container;
}
const change = (value, mutate) => { const copy = clone(value); mutate(copy); return copy; };

test("valid create", async () => { const value = await evaluate();
    assert.deepEqual([value.eligible, value.status, value.action], [true, "ready_to_save", "create"]); });
test("valid replace", async () => { const existing = await container(); const c = collector({
    qriVersion: "qri-v2", priceVersion: "price-v2", price: 66100 });
    const value = await evaluate({ collectorResult: c, existingStorageState: existing,
        captureContext: context("2026-08-26T09:00:00+09:00") });
    assert.deepEqual([value.eligible, value.action], [true, "replace"]); });
test("duplicate is a normal no-op", async () => { const existing = await container({
    capturedAt: "2026-08-26T08:04:00+09:00" }); const value = await evaluate({ existingStorageState: existing });
    assert.deepEqual([value.eligible, value.status, value.action, value.reason],
        [false, "no_change", "duplicate", null]); });
test("collector not_ready rejects", async () => { const c = collector(); c.ready = false; c.status = "not_ready";
    assert.equal((await evaluate({ collectorResult: c })).reason, "collector_not_ready"); });
test("missing collector fingerprint rejects", async () => { const c = collector(); c.formalSnapshotInputFingerprint = null;
    assert.equal((await evaluate({ collectorResult: c })).reason, "collector_identity_invalid"); });
test("session unresolved rejects", async () => { const c = collector(); c.sessionScope.status = "unresolved";
    assert.equal((await evaluate({ collectorResult: c })).reason, "session_unverified"); });
test("cross-date scope rejects", async () => { const c = collector(); c.sessionScope.sessionClass = "cross_date_unresolved";
    assert.equal((await evaluate({ collectorResult: c })).reason, "session_unverified"); });
test("refresh in progress rejects", async () => { const c = collector(); c.diagnostics.refreshInProgress = true;
    assert.equal((await evaluate({ collectorResult: c })).reason, "collector_identity_invalid"); });
test("mixed acquisition rejects", async () => { const c = collector(); c.diagnostics.mixedAcquisitionDetected = true;
    assert.equal((await evaluate({ collectorResult: c })).reason, "collector_identity_invalid"); });
test("manual capture accepted", async () => assert.equal((await evaluate()).diagnostics.manualCapture, true));
test("automatic capture rejected", async () => assert.equal((await evaluate({ captureContext: {
    ...context(), mode: "automatic" } })).reason, "capture_not_manual"));
test("non-user capture rejected", async () => assert.equal((await evaluate({ captureContext: {
    ...context(), userInitiated: false } })).reason, "capture_not_user_initiated"));
test("invalid builder input rejected before build", async () => { const c = collector(); delete c.builderInput.overallV2Context;
    const value = await evaluate({ collectorResult: c }); assert.equal(value.reason, "builder_input_invalid");
    assert.equal(value.diagnostics.builderInvoked, false); });
test("builder failure is fail-closed", async () => assert.equal((await evaluate({}, {
    buildBaseline: async () => { throw new Error("failure"); } })).reason, "baseline_build_failed"));
test("nearestLevels null is valid", async () => assert.equal((await evaluate()).baselineCandidate.nearestLevels, null));
test("actual formal levels are valid", async () => { const levels = { generatedFromFormalOnly: true,
    referenceOnly: false, usingFallback: false, contract: "2026-09", sourceVersionKey: "qri-v1",
    upper: { available: true, price: 66500, distance: 500, optionType: "CALL" },
    lower: { available: true, price: 65500, distance: 500, optionType: "PUT" } };
    assert.equal((await evaluate({ collectorResult: collector({ levels }) })).eligible, true); });
test("malformed non-null levels fail closed", async () => { const c = collector({ levels: { bad: true } });
    assert.equal((await evaluate({ collectorResult: c })).reason, "baseline_build_failed"); });
test("missing storage creates", async () => assert.equal((await evaluate()).action, "create"));
test("valid restored storage is accepted", async () => { const existing = await container();
    const restored = { success: true, status: "ready", container: existing };
    assert.notEqual((await evaluate({ existingStorageState: restored })).reason, "existing_storage_invalid"); });
test("invalid storage rejects without repair", async () => assert.equal((await evaluate({
    existingStorageState: { storageVersion: 99 } })).reason, "existing_storage_invalid"));
test("same scope same content duplicates", async () => { const existing = await container({
    capturedAt: "2026-08-26T08:04:00+09:00" }); assert.equal((await evaluate({
    existingStorageState: existing })).action, "duplicate"); });
test("same scope changed content replaces", async () => { const existing = await container();
    const c = collector({ price: 66100, priceVersion: "price-v2", qriVersion: "qri-v2" });
    assert.equal((await evaluate({ collectorResult: c, existingStorageState: existing,
        captureContext: context("2026-08-26T09:00:00+09:00") })).action, "replace"); });
test("different scope creates a separate series", async () => { const existing = await container();
    const c = collector({ tradingDate: "2026-08-27", qriVersion: "qri-v2", priceVersion: "price-v2" });
    const value = await evaluate({ collectorResult: c, existingStorageState: existing,
        captureContext: context("2026-08-27T08:04:00+09:00") });
    assert.equal(value.action, "create"); assert.equal(value.savePlan.proposedContainer.series.length, 2); });
test("contract roll creates a separate series", async () => { const existing = await container();
    const c = collector({ contract: "2026-12", qriVersion: "qri-v2", priceVersion: "price-v2" });
    assert.equal((await evaluate({ collectorResult: c, existingStorageState: existing })).action, "create"); });
test("trading date change does not replace previous day", async () => { const existing = await container();
    const c = collector({ tradingDate: "2026-08-27", qriVersion: "qri-v2", priceVersion: "price-v2" });
    assert.equal((await evaluate({ collectorResult: c, existingStorageState: existing,
        captureContext: context("2026-08-27T08:04:00+09:00") })).action, "create"); });
test("stale capturedAt rejects", async () => { const existing = await container({
    capturedAt: "2026-08-26T09:00:00+09:00" }); assert.equal((await evaluate({
    existingStorageState: existing })).reason, "stale_capture"); });
test("same timestamp same content duplicates", async () => { const existing = await container({
    capturedAt: "2026-08-26T08:04:00+09:00" }); assert.equal((await evaluate({
    existingStorageState: existing })).action, "duplicate"); });
test("same timestamp different content is ambiguous", async () => { const existing = await container({
    capturedAt: "2026-08-26T08:04:00+09:00" }); const c = collector({ price: 66100,
    priceVersion: "price-v2", qriVersion: "qri-v2" }); assert.equal((await evaluate({
    collectorResult: c, existingStorageState: existing })).reason, "ambiguous_same_timestamp"); });
test("replace plan preserves previous active snapshot", async () => { const existing = await container();
    const oldId = existing.series[0].activeBaselineId; const c = collector({ price: 66100,
        priceVersion: "price-v2", qriVersion: "qri-v2" }); const value = await evaluate({
        collectorResult: c, existingStorageState: existing,
        captureContext: context("2026-08-26T09:00:00+09:00") });
    assert.equal(value.savePlan.proposedContainer.series[0].revisions[0].baselineId, oldId); });
test("expected active identity is retained", async () => { const existing = await container();
    const active = existing.series[0].revisions[0]; const c = collector({ price: 66100,
        priceVersion: "price-v2", qriVersion: "qri-v2" }); const value = await evaluate({
        collectorResult: c, existingStorageState: existing,
        captureContext: context("2026-08-26T09:00:00+09:00") });
    assert.deepEqual([value.savePlan.expectedActiveBaselineId, value.savePlan.expectedActiveVersionKey],
        [active.baselineId, active.versionKey]); });
test("storage fingerprint is deterministic", async () => { const existing = await container();
    const c = collector({ price: 66100, priceVersion: "price-v2", qriVersion: "qri-v2" });
    const captureContext = context("2026-08-26T09:00:00+09:00");
    const first = await evaluate({ collectorResult: c, existingStorageState: existing, captureContext });
    const second = await evaluate({ collectorResult: clone(c), existingStorageState: clone(existing),
        captureContext });
    assert.equal(first.diagnostics.storageFingerprintAvailable, true);
    assert.match(first.savePlan.expectedContainerFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(first.savePlan.expectedContainerFingerprint,
        second.savePlan.expectedContainerFingerprint); });
test("savePlan is deterministic", async () => assert.deepEqual((await evaluate()).savePlan,
    (await evaluate()).savePlan));
test("policy does not read LocalStorage", () => assert.doesNotMatch(fs.readFileSync(path.join(__dirname,
    "../js/morningBaselineV4CapturePolicy.js"), "utf8"), /localStorage|getItem/));
test("policy does not write LocalStorage", () => assert.doesNotMatch(fs.readFileSync(path.join(__dirname,
    "../js/morningBaselineV4CapturePolicy.js"), "utf8"), /setItem|MorningBaselineV4Store/));
test("policy has no IndexedDB", () => assert.doesNotMatch(fs.readFileSync(path.join(__dirname,
    "../js/morningBaselineV4CapturePolicy.js"), "utf8"), /indexedDB/));
test("policy has no fetch", () => assert.doesNotMatch(fs.readFileSync(path.join(__dirname,
    "../js/morningBaselineV4CapturePolicy.js"), "utf8"), /\bfetch\s*\(/));
test("policy performs no formal recalculation", async () => assert.equal((await evaluate()).diagnostics.formalRecalculationTriggered, false));
test("policy has no DOM access", () => assert.doesNotMatch(fs.readFileSync(path.join(__dirname,
    "../js/morningBaselineV4CapturePolicy.js"), "utf8"), /document\.|querySelector/));
test("policy does not write existing Morning storage", () => assert.doesNotMatch(fs.readFileSync(path.join(__dirname,
    "../js/morningBaselineV4CapturePolicy.js"), "utf8"), /optionMapMobileMorning|optionMapMorningBaselinesV[123]/));
test("policy has no Mobile dependency", () => assert.doesNotMatch(fs.readFileSync(path.join(__dirname,
    "../js/morningBaselineV4CapturePolicy.js"), "utf8"), /MobileSummary|mobileSummary|MobileMorning/));
test("inputs are not mutated", async () => { const c = collector(); const existing = await container();
    const capture = context(); const before = clone({ c, existing, capture }); await evaluate({
        collectorResult: c, existingStorageState: existing, captureContext: capture });
    assert.deepEqual({ c, existing, capture }, before); });
test("output and nested candidates are deeply frozen", async () => { const value = await evaluate();
    assert.equal(Object.isFrozen(value), true); assert.equal(Object.isFrozen(value.baselineCandidate), true);
    assert.equal(Object.isFrozen(value.savePlan.proposedContainer), true); });
test("collector requestedAt relation rejects time travel", async () => assert.equal((await evaluate({
    captureContext: context("2026-08-26T08:02:00+09:00") })).reason, "collector_identity_invalid"));
test("fallback flags cannot be promoted", async () => { const c = collector();
    c.builderInput.dataQualityContext.fallbackFlags.qri = true;
    assert.equal((await evaluate({ collectorResult: c })).reason, "fallback_present"); });
test("scope identity mismatch rejects", async () => { const c = collector();
    c.builderInput.marketContext.sessionIdentity = "other";
    assert.equal((await evaluate({ collectorResult: c })).reason, "scope_identity_mismatch"); });
test("status and action taxonomy is stable", async () => { const value = await evaluate();
    assert.deepEqual([value.policyVersion, value.reason, value.reasons.length], [1, null, 0]); });
test("diagnostics attest all forbidden side effects", async () => { const d = (await evaluate()).diagnostics;
    assert.deepEqual([d.storageAccessed, d.databaseAccessed, d.fetchTriggered,
        d.formalRecalculationTriggered, d.domMutated], [false, false, false, false, false]); });
