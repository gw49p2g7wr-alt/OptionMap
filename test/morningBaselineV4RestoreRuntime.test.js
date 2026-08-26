const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Baseline = require("../js/morningBaselineV4.js");
const Storage = require("../js/morningBaselineV4Storage.js");
const Runtime = require("../js/morningBaselineV4RestoreRuntime.js");

const clone = value => structuredClone(value);
const identity = (source, versionKey) => ({ source, versionKey, signature: `${source}-${versionKey}`,
    verified: true });
const component = (name, direction, weight) => ({ name, available: true, invalid: false,
    normalizedDirection: direction, directionScore: direction * 100, baseWeight: weight,
    qualityFactor: 1, effectiveWeight: weight, weightedContribution: direction * weight,
    evidenceFactor: Math.abs(direction), notes: [], metadata: null });
function input(options = {}) {
    const date = options.date || "2026-08-27"; const contract = options.contract || "2026-09";
    const capturedAt = options.capturedAt || `${date}T08:00:00+09:00`;
    const logicVersion = options.logicVersion || "overall-v2-v1";
    return { capturedAt, marketContext: { captureCalendarDate: date, formalTradingDate: date,
        sessionIdentity: `morning-v4-scope|${contract}|${date}|same_date_explicit`,
        sessionMappingStatus: "verified" }, overallV2Context: { origin: "formal_live",
        formalApplied: true, superseded: false, logicVersion, evaluatedAt: capturedAt,
        inputIdentity: identity("overall", options.qriVersion || "overall-v1"), componentIdentities: {
            option: identity("qri", options.qriVersion || "qri-v1"), weekly: identity("weekly", "weekly-v1") },
        result: { status: "complete", direction: 20, directionLabel: "買い優勢", confidence: 80,
            confidenceFactors: { agreement: 80 }, components: { option: component("option", .2, 55),
                weekly: component("weekly", .2, 45) }, metadata: { coverage: 100, warnings: [] } } },
    currentPriceContext: { available: true, sourceKind: "live", origin: "live", mode: "automatic",
        value: options.price || 66000, contract, quoteDate: date, quotedAtNormalized: capturedAt,
        quoteSignature: "price-signature", versionKey: options.priceVersion || "price-v1", wrapperSignature: "wrapper",
        requestId: "request-1", fetchedAt: capturedAt, currentRequestVerified: true,
        identityVerified: true, acquisitionVerified: true, acquisitionIdentity: { requestId: "request-1",
            fetchedAt: capturedAt, sourceUrl: "https://svc.qri.jp/jpx/nkopm/", wrapperSignature: "wrapper" },
        qriTradingDateMapping: { status: "verified", quoteDate: date, qriTradingDate: date,
            relation: "same_date", mappingVerified: true, mappingSource: "same_date_explicit" } },
    qriContext: { available: true, origin: "formal_live", sourceKind: "live",
        formalRevisionAvailable: true, referenceOnly: false, usingFallback: false, restored: false,
        superseded: false, openInterestStatus: "available", identity: { verified: true, contract,
            tradingDate: date, pageUpdatedAt: capturedAt, canonicalSignature: "qri-signature",
            canonicalVersionKey: options.qriVersion || "qri-v1", historyEntryId: `${contract}|${date}`,
            historyRevisionId: options.qriVersion || "qri-v1" } }, weeklyContext: { available: true,
        origin: "formal_history", formalApplied: true, usingFallback: false, superseded: false,
        sourceDate: date, versionKey: "weekly-v1", signature: "weekly-signature",
        identityVerified: true, normalizedDirection: .2, qualityFactor: 1, effectiveWeight: 45,
        weightedContribution: 9, metadata: null }, nearestLevelsContext: null,
    dataQualityContext: { status: "complete", warnings: [], sourceAvailability: { currentPrice: true,
        qri: true, weekly: true, overallV2: true }, componentAvailability: { option: true, weekly: true },
        fallbackFlags: { currentPrice: false, qri: false, weekly: false, overallV2: false } } };
}
async function baseline(options = {}) { const built = await Baseline.buildMorningBaselineV4(input(options));
    assert.equal(built.success, true); return built.baseline; }
async function serialized(options = {}) { const built = await Storage.buildMorningBaselineV4Storage({
    baseline: await baseline(options), existingContainer: options.existingContainer || null });
    assert.equal(built.success, true); const result = await Storage.serializeMorningBaselineV4Storage(built.container);
    return result.serialized; }
function sourceFacts(options = {}) {
    const date = options.date || "2026-08-27"; const contract = options.contract || "2026-09";
    const requestId = "request-1"; const qriVersion = options.qriVersion || "qri-current";
    const weeklyVersion = options.weeklyVersion || "weekly-current";
    const price = { available: true, sourceKind: "live", origin: options.priceOrigin || "live",
        mode: options.priceMode || "automatic", identityVerified: options.priceVerified !== false,
        acquisitionVerified: true, currentRequestVerified: true, contract, requestId,
        quoteDate: date, versionKey: options.priceVersion || "price-current",
        qriTradingDateMapping: { mappingVerified: true, mappingSource: "same_date_explicit",
            qriTradingDate: date, status: "verified" } };
    const qri = { sourceClass: "formal_live", origin: options.qriOrigin || "live",
        usingFallback: options.qriFallback === true, referenceOnly: options.qriReference === true,
        superseded: false, identityVerified: options.qriVerified !== false, acquisitionVerified: true,
        contract, tradingDate: date, canonicalVersionKey: qriVersion, canonicalSignature: "qri-signature",
        requestId, generation: { source: "qri", sequence: 1, fingerprint: "qri-fingerprint", current: true } };
    const weekly = { sourceClass: "formal_history", activeVersionMatched: options.weeklyVerified !== false,
        currentVersionKey: weeklyVersion, currentSignature: "weekly-signature",
        sourceFingerprint: "weekly-fingerprint", requestId,
        generation: { source: "weekly", sequence: 1, fingerprint: "weekly-generation", current: true } };
    const overall = { status: options.overallResultStatus || "complete", formalApplied: true,
        referenceOnly: false, identityVerified: options.overallVerified !== false,
        logicVersion: options.logicVersion || "overall-v2-v1", inputFingerprint: "overall-fingerprint",
        requestId, optionSourceIdentity: { canonicalVersionKey: qriVersion,
            canonicalSignature: qri.canonicalSignature }, weeklySourceIdentity: {
            currentVersionKey: weeklyVersion, sourceFingerprint: weekly.sourceFingerprint } };
    const wrap = (status, fact, reason = null) => ({ status, reason, publicationGeneration: 1,
        requestId, fact });
    return { currentPrice: { ...wrap(options.priceStatus || "available", price,
            options.priceReason), diagnostics: { formalCurrentPriceMode: options.formalPriceMode || "automatic" } },
        qri: wrap(options.qriStatus || "available", qri, options.qriReason),
        weekly: wrap(options.weeklyStatus || "available", weekly, options.weeklyReason),
        overall: { status: options.overallStatus || "available", reason: options.overallReason || null,
            publicationGeneration: 1, requestId, envelope: overall } };
}
function memoryStorage(value) { const reads = []; return { reads, value,
    getItem(key) { reads.push(key); return this.value ?? null; },
    setItem() { throw new Error("write forbidden"); } }; }
function scope(options = {}) { const date = options.date || "2026-08-27";
    const contract = options.contract || "2026-09"; const verified = options.verified !== false;
    return { available: verified, status: verified ? "verified" : "unresolved",
        reason: verified ? null : "price_mapping_unresolved", mappingVerified: verified,
        sessionClass: verified ? "same_date_verified" : "cross_date_unresolved",
        scopeId: verified ? `morning-v4-scope|${contract}|${date}|same_date_explicit` : null,
        formalTradingDate: date, contract };
}
function create(storage, sources = sourceFacts(), currentScope = scope()) {
    return Runtime.createRuntime({ storage, getCurrentPrice: () => clone(sources.currentPrice),
        getQri: () => clone(sources.qri), getWeekly: () => clone(sources.weekly),
        getOverall: () => clone(sources.overall), getCurrentScope: async () => clone(currentScope),
        now: () => "2026-08-27T08:05:00+09:00" });
}

test("missing storage is a normal no_baseline state", async () => { const runtime = create(memoryStorage(null));
    const value = await runtime.restoreAndEvaluate(); assert.deepEqual([value.restoreStatus,
        value.integrityStatus, value.applicabilityStatus, value.reason],
        ["missing", "missing", "no_baseline", "no_baseline"]); });
test("valid restore and matching scope are applicable", async () => { const runtime = create(memoryStorage(await serialized()));
    const value = await runtime.restoreAndEvaluate(); assert.deepEqual([value.integrityStatus,
        value.applicabilityStatus, value.diagnostics.selectedActiveRevision], ["valid", "applicable", true]); });
test("invalid and signature-tampered storage remain integrity_invalid", async () => {
    for (const raw of ["{", await (async () => { const parsed = JSON.parse(await serialized());
        parsed.series[0].revisions[0].snapshot.signature = "0".repeat(64); return JSON.stringify(parsed); })()]) {
        const value = await create(memoryStorage(raw)).restoreAndEvaluate();
        assert.equal(value.integrityStatus, "integrity_invalid"); assert.equal(value.baseline, null); } });
test("active revision is selected and replaced revision is not", async () => { const first = await baseline();
    const initial = (await Storage.buildMorningBaselineV4Storage({ baseline: first })).container;
    const raw = await serialized({ capturedAt: "2026-08-27T09:00:00+09:00", existingContainer: initial,
        price: 66100, priceVersion: "price-v2", qriVersion: "qri-v2" });
    const value = await create(memoryStorage(raw)).restoreAndEvaluate();
    assert.equal(value.selectedBaselineId, value.baseline.baselineId);
    assert.notEqual(value.selectedBaselineId, first.baselineId); });
test("scope missing is not applicable", async () => { const value = await create(memoryStorage(await serialized()),
    sourceFacts(), scope({ date: "2026-08-28", contract: "2026-12" })).restoreAndEvaluate();
    assert.equal(value.reason, "scope_not_found"); });
test("contract mismatch and next day retain valid restore", async () => {
    for (const [current, reason] of [[scope({ contract: "2026-12" }), "contract_mismatch"],
        [scope({ date: "2026-08-28" }), "trading_date_mismatch"]]) { const value = await create(
            memoryStorage(await serialized()), sourceFacts(), current).restoreAndEvaluate();
        assert.deepEqual([value.integrityStatus, value.applicabilityStatus, value.reason],
            ["valid", "not_applicable", reason]); } });
test("unresolved current session is not applicable", async () => { const value = await create(
    memoryStorage(await serialized()), sourceFacts(), scope({ verified: false })).restoreAndEvaluate();
    assert.equal(value.reason, "price_mapping_unresolved"); });
test("current facts pending stays pending then becomes applicable without reread", async () => {
    const sources = sourceFacts({ qriStatus: "empty", qriReason: "not_published" });
    const storage = memoryStorage(await serialized()); const runtime = create(storage, sources);
    await runtime.restore(); assert.equal((await runtime.evaluateApplicability()).applicabilityStatus, "pending");
    Object.assign(sources, sourceFacts()); const value = await runtime.evaluateApplicability();
    assert.equal(value.applicabilityStatus, "applicable"); assert.equal(storage.reads.length, 1); });
for (const [name, options, reason] of [
    ["QRI saved", { qriOrigin: "saved" }, "qri_saved_or_reference"],
    ["QRI fallback", { qriFallback: true }, "qri_fallback"],
    ["CurrentPrice manual", { priceMode: "manual", formalPriceMode: "manual" }, "current_price_manual"],
    ["CurrentPrice restored", { priceOrigin: "saved" }, "current_price_ineligible"],
    ["QRI identity invalid", { qriVerified: false }, "qri_ineligible"],
    ["Weekly invalid", { weeklyVerified: false }, "weekly_ineligible"],
    ["Overall invalid", { overallVerified: false }, "overall_ineligible"]
]) test(`${name} is not applicable while restore remains valid`, async () => { const value = await create(
    memoryStorage(await serialized()), sourceFacts(options)).restoreAndEvaluate();
    assert.deepEqual([value.integrityStatus, value.applicabilityStatus, value.reason],
        ["valid", "not_applicable", reason]); });
for (const [name, options] of [["QRI", { qriStatus: "empty", qriReason: "not_published" }],
    ["CurrentPrice", { priceStatus: "unavailable", priceReason: "acquisition_pending" }],
    ["Weekly", { weeklyStatus: "empty", weeklyReason: "not_published" }],
    ["Overall", { overallStatus: "empty", overallReason: "not_published" }]])
    test(`${name} not-yet-available is pending`, async () => { const value = await create(
        memoryStorage(await serialized()), sourceFacts(options)).restoreAndEvaluate();
        assert.equal(value.applicabilityStatus, "pending"); });
test("logic version mismatch is not applicable", async () => { const value = await create(
    memoryStorage(await serialized()), sourceFacts({ logicVersion: "overall-v2-v2" })).restoreAndEvaluate();
    assert.equal(value.reason, "logic_version_mismatch"); });
test("formal partial DataQuality remains eligible without a restore-runtime quality score", async () => {
    const value = await create(memoryStorage(await serialized()), sourceFacts({
        overallResultStatus: "partial" })).restoreAndEvaluate();
    assert.equal(value.applicabilityStatus, "applicable");
    assert.equal(Object.hasOwn(value.diagnostics, "qualityScore"), false);
});
for (const [name, options] of [["QRI", { qriVersion: "qri-later" }],
    ["price", { priceVersion: "price-later" }], ["Weekly", { weeklyVersion: "weekly-later" }]])
    test(`${name} version change in the same scope stays applicable`, async () => { const value = await create(
        memoryStorage(await serialized()), sourceFacts(options)).restoreAndEvaluate();
        assert.equal(value.applicabilityStatus, "applicable"); });
test("real formal session scope integration is applicable", async () => { const raw = await serialized();
    const sources = sourceFacts(); const runtime = Runtime.createRuntime({ storage: memoryStorage(raw),
        getCurrentPrice: () => sources.currentPrice, getQri: () => sources.qri,
        getWeekly: () => sources.weekly, getOverall: () => sources.overall,
        now: () => "2026-08-27T08:05:00+09:00" });
    assert.equal((await runtime.restoreAndEvaluate()).applicabilityStatus, "applicable"); });
test("storage change is ignored until capture success reloads it", async () => { const storage = memoryStorage(await serialized());
    const runtime = create(storage); const first = await runtime.restoreAndEvaluate();
    storage.value = await serialized({ date: "2026-08-28" });
    assert.equal((await runtime.evaluateApplicability()).selectedBaselineId, first.selectedBaselineId);
    const reloaded = await runtime.reloadAfterCapture({ status: "saved", saved: true });
    assert.equal(reloaded.reason, "trading_date_mismatch"); assert.equal(storage.reads.length, 2); });
test("non-success capture notification does not reread storage", async () => { const storage = memoryStorage(await serialized());
    const runtime = create(storage); await runtime.restoreAndEvaluate(); await runtime.reloadAfterCapture({ status: "duplicate" });
    assert.equal(storage.reads.length, 1); });
test("getter and selected baseline are detached and deeply frozen", async () => { const runtime = create(
    memoryStorage(await serialized())); const first = await runtime.restoreAndEvaluate(); const second = runtime.getState();
    assert.notEqual(first, second); assert.equal(Object.isFrozen(second), true);
    assert.equal(Object.isFrozen(second.baseline), true); });
test("runtime only reads the dedicated key and has no forbidden connections", async () => {
    const storage = memoryStorage(await serialized()); await create(storage).restoreAndEvaluate();
    assert.deepEqual(storage.reads, [Storage.STORAGE_KEY]); const source = fs.readFileSync(path.join(__dirname,
        "../js/morningBaselineV4RestoreRuntime.js"), "utf8");
    assert.doesNotMatch(source, /setItem|removeItem|indexedDB|\bfetch\s*\(|setTimeout|setInterval|document\.|querySelector|MobileSummary|migration|backfill|repair/); });
test("diagnostics attest no comparison recalculation DOM or database side effects", async () => {
    const diagnostics = (await create(memoryStorage(await serialized())).restoreAndEvaluate()).diagnostics;
    assert.deepEqual([diagnostics.databaseAccessed, diagnostics.fetchTriggered,
        diagnostics.formalRecalculationTriggered, diagnostics.comparisonTriggered,
        diagnostics.domMutated], [false, false, false, false, false]); });
test("renderer wiring restores before formal lifecycle reevaluation without UI", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    const script = fs.readFileSync(path.join(__dirname, "../js/script.js"), "utf8");
    assert.match(html, /morningBaselineV4RestoreRuntime\.js/);
    assert.match(script, /evaluateMorningBaselineV4Applicability\?\.\(\)/);
});
