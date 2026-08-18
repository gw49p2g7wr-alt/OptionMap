const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const mobile = require("../js/mobileSummary.js");
const baselineApi = require("../js/morningBaseline.js");

const NOW = "2026-08-18T00:24:00.000Z";
const LATER = "2026-08-18T00:31:00.000Z";
const record = (optionType, strike, value) => ({ contract: "2026-09", optionType,
    strike, published: true, value });
function input(overrides = {}) {
    return { generatedAt: NOW, marketDate: "2026-08-18", producer: { appVersion: "1", platform: "test" },
        overallV2: { status: "complete", direction: 20, directionLabel: "買い優勢", confidence: 70,
            metadata: { coverage: 100 }, confidenceFactors: { agreement: 80 } },
        currentPrice: { value: 40000, source: "qri-nikkei225-futures", mode: "automatic",
            contract: "2026-09", quotedAt: NOW, fetchedAt: NOW },
        qri: { available: true, activeContract: "2026-09", versionKey: "qri-version",
            pageUpdatedAt: NOW, canonical: { parserVersion: 2, schemaVersion: 2,
                source: "qri-nikkei225-options", isActiveContract: true, contract: "2026-09",
                availableContracts: [{ contract: "2026-09", active: true }], records: [
                    record("call", 40500, 20), record("put", 39500, 30)
                ] } }, sourceVersions: [{ source: "qri-options", sourceDate: "2026-08-18",
            tradingDate: "2026-08-18", contract: "2026-09", versionKey: "qri-version",
            signature: `sha256:${"a".repeat(64)}` }], freshness: {}, ...overrides };
}
const summary = overrides => mobile.buildMobileSummary(input(overrides));
async function fixture(options = {}) {
    const value = await summary(options.summary);
    if (options.partial) value.dataQuality = { status: "partial", warnings: ["nearestLevels.upper"] };
    if (options.unavailable) value.dataQuality = { status: "unavailable", warnings: ["overallV2"] };
    if (options.partial || options.unavailable) {
        value.signature = await mobile.createSignature(value);
        value.summaryId = `ms1-${value.signature.slice(0, 24)}`;
    }
    return value;
}
const mutate = (value, fn) => { const copy = structuredClone(value); fn(copy); return copy; };

test("valid complete and partial baseline revisions", async () => {
    for (const partial of [false, true]) {
        const candidate = await baselineApi.createCandidate(await fixture({ partial }), NOW);
        const saved = await baselineApi.saveCandidate(null, candidate, "2026-08-18");
        assert.equal(saved.status, "created");
        assert.equal((await baselineApi.validateBaseline(saved.baseline)).valid, true);
        assert.equal(saved.baseline.revisions[0].dataQuality.status, partial ? "partial" : "complete");
    }
});

test("unavailable summary cannot be captured", async () => {
    await assert.rejects(async () => baselineApi.createCandidate(await fixture({ unavailable: true }), NOW),
        /source_summary_unavailable/);
});

test("initial save sets active id and immutable source references", async () => {
    const source = await fixture(); const candidate = await baselineApi.createCandidate(source, NOW);
    const saved = (await baselineApi.saveCandidate(null, candidate, source.marketDate)).baseline;
    assert.equal(saved.activeBaselineId, candidate.baselineId);
    assert.equal(saved.firstCapturedAt, NOW);
    assert.equal(saved.revisions[0].sourceSummaryId, source.summaryId);
    assert.equal(saved.revisions[0].sourceSummarySignature, source.signature);
    assert.deepEqual(saved.revisions[0].sourceVersions, source.sourceVersions);
    assert.equal(saved.revisions[0].comparisonReference.versionKey, "qri-version");
});

test("same-day save requires confirmation and explicit update creates revision", async () => {
    const first = await baselineApi.createCandidate(await fixture(), NOW);
    const initial = (await baselineApi.saveCandidate(null, first, "2026-08-18")).baseline;
    const changedSummary = await fixture({ summary: { currentPrice: { ...input().currentPrice, value: 40100 } } });
    const second = await baselineApi.createCandidate(changedSummary, LATER);
    assert.equal((await baselineApi.saveCandidate(initial, second, "2026-08-18")).status,
        "confirmation_required");
    const updated = await baselineApi.saveCandidate(initial, second, "2026-08-18", { allowUpdate: true });
    assert.equal(updated.status, "updated");
    assert.equal(updated.baseline.revisions.length, 2);
    assert.equal(updated.baseline.revisions[0].replacedAt, LATER);
    assert.equal(updated.baseline.activeBaselineId, second.baselineId);
    assert.equal(updated.baseline.revisions[0].baselineId, first.baselineId);
});

test("same semantic content does not create a redundant revision after explicit update", async () => {
    const source = await fixture(); const first = await baselineApi.createCandidate(source, NOW);
    const initial = (await baselineApi.saveCandidate(null, first, source.marketDate)).baseline;
    const repeated = await baselineApi.createCandidate(source, LATER);
    const result = await baselineApi.saveCandidate(initial, repeated, source.marketDate, { allowUpdate: true });
    assert.equal(result.status, "unchanged");
    assert.equal(result.baseline.revisions.length, 1);
});

test("validator rejects schema, date, timestamps, active/revision and duplicate corruption", async () => {
    const candidate = await baselineApi.createCandidate(await fixture(), NOW);
    const valid = (await baselineApi.saveCandidate(null, candidate, "2026-08-18")).baseline;
    const cases = [
        [x => { x.baselineVersion = 2; }, "baseline_version_invalid"],
        [x => { x.marketDate = "2026-02-30"; }, "market_date_invalid"],
        [x => { x.firstCapturedAt = "bad"; }, "baseline_timestamp_invalid"],
        [x => { x.activeBaselineId = ""; }, "active_baseline_id_invalid"],
        [x => { x.activeBaselineId = "mb1-000000000000000000000000"; }, "active_revision_missing"],
        [x => { x.revisions.push(structuredClone(x.revisions[0])); }, "duplicate_baseline_id"]
    ];
    for (const [change, expected] of cases)
        assert.ok((await baselineApi.validateBaseline(mutate(valid, change))).errors.includes(expected));
});

test("validator rejects revision field corruption", async () => {
    const candidate = await baselineApi.createCandidate(await fixture(), NOW);
    const valid = (await baselineApi.saveCandidate(null, candidate, "2026-08-18")).baseline;
    const cases = [
        [x => { x.revisions[0].replacedAt = LATER; }, "active_revision_replaced"],
        [x => { x.revisions[0].sourceSummaryId = "bad"; }, "source_summary_id_invalid"],
        [x => { x.revisions[0].sourceSummarySignature = "bad"; }, "source_summary_signature_invalid"],
        [x => { x.revisions[0].dataQuality.status = "unavailable"; }, "data_quality_invalid"],
        [x => { x.revisions[0].sourceVersions = null; }, "source_versions_invalid"],
        [x => { x.revisions[0].overallV2.direction = Infinity; }, "overall_v2_invalid"],
        [x => { x.revisions[0].currentPrice.value = null; }, "current_price_invalid"],
        [x => { x.revisions[0].nearestLevels.upper.price = null; }, "nearest_levels_invalid"],
        [x => { x.revisions[0].comparisonReference.versionKey = null; }, "comparison_reference_invalid"]
    ];
    for (const [change, expected] of cases)
        assert.ok((await baselineApi.validateBaseline(mutate(valid, change))).errors.includes(expected));
});

test("market-date storage is isolated and previous day is never reused", async () => {
    const candidate = await baselineApi.createCandidate(await fixture(), NOW);
    const baseline = (await baselineApi.saveCandidate(null, candidate, "2026-08-18")).baseline;
    const storage = await baselineApi.upsertStorage(baselineApi.createEmptyStorage(), baseline);
    assert.equal((await baselineApi.getForMarketDate(storage, "2026-08-18")).available, true);
    assert.deepEqual(await baselineApi.getForMarketDate(storage, "2026-08-19"),
        { available: false, reason: "not_captured", baseline: null });
    assert.equal(storage.baselines.length, 1);
});

test("corrupted storage is rejected, never repaired", async () => {
    const result = await baselineApi.getForMarketDate({ storageVersion: 1, baselines: [{}] }, "2026-08-18");
    assert.equal(result.reason, "morning_baseline_corrupted");
});

test("MobileSummary reflects only matching valid baseline and keeps comparison unimplemented", async () => {
    const source = await fixture(); const candidate = await baselineApi.createCandidate(source, NOW);
    const baseline = (await baselineApi.saveCandidate(null, candidate, source.marketDate)).baseline;
    const current = await summary({ morningBaseline: { available: true, baseline } });
    assert.equal(current.payload.morningBaseline.available, true);
    assert.equal(current.payload.morningBaseline.baselineId, candidate.baselineId);
    assert.equal(current.payload.changeSinceMorning.reason, "comparison_not_implemented");
    assert.equal(current.payload.optionChanges.available, false);
    assert.equal(current.payload.optionChanges.reason, "comparison_not_implemented");
    const otherDate = await summary({ morningBaseline: { available: true,
        baseline: { ...baseline, marketDate: "2026-08-17" } } });
    assert.equal(otherDate.payload.morningBaseline.reason, "market_date_mismatch");
});

test("builder does not mutate baseline input", async () => {
    const source = await fixture(); const candidate = await baselineApi.createCandidate(source, NOW);
    const baseline = (await baselineApi.saveCandidate(null, candidate, source.marketDate)).baseline;
    const baselineInput = { available: true, baseline }; const before = structuredClone(baselineInput);
    await summary({ morningBaseline: baselineInput });
    assert.deepEqual(baselineInput, before);
});

test("dedicated Local Storage adapter writes only its namespace and preserves old value on failure", async () => {
    const writes = []; const values = new Map();
    const context = { window: null, globalThis: null, console,
        localStorage: { getItem: key => values.get(key) ?? null,
            setItem: (key, value) => { writes.push(key); values.set(key, value); } },
        OptionMapMorningBaseline: baselineApi };
    context.window = context; context.globalThis = context; vm.createContext(context);
    vm.runInContext(fs.readFileSync(require.resolve("../js/morningBaselineStorage.js"), "utf8"), context);
    const candidate = await baselineApi.createCandidate(await fixture(), NOW);
    const baseline = (await baselineApi.saveCandidate(null, candidate, "2026-08-18")).baseline;
    await context.OptionMapMorningBaselineStorage.save(baseline);
    assert.deepEqual(writes, ["optionMapMobileMorningBaselinesV1"]);
    assert.equal((await context.OptionMapMorningBaselineStorage.getForMarketDate("2026-08-18")).available, true);
    const previous = values.get("optionMapMobileMorningBaselinesV1");
    context.localStorage.setItem = () => { throw new Error("quota"); };
    await assert.rejects(() => context.OptionMapMorningBaselineStorage.save(baseline), /quota/);
    assert.equal(values.get("optionMapMobileMorningBaselinesV1"), previous);
});

test("baseline security rejects sensitive content", async () => {
    const candidate = await baselineApi.createCandidate(await fixture(), NOW);
    const valid = (await baselineApi.saveCandidate(null, candidate, "2026-08-18")).baseline;
    for (const sample of ["/Users/alice/file", "api_key=secret", "git commit abc", "<html>raw</html>",
        "raw Excel workbook", "Local Storage dump", "TypeError: bad\\n at fn (x.js:1)"]) {
        const corrupted = mutate(valid, x => { x.revisions[0].overallV2.directionLabel = sample; });
        assert.equal((await baselineApi.validateBaseline(corrupted)).valid, false);
    }
});
