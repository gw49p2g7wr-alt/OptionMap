const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../js/mobileSummary.js");

const NOW = "2026-08-18T03:00:00.000Z";
function canonical(records) {
    return { parserVersion: 2, schemaVersion: 2, source: "qri-nikkei225-options",
        isActiveContract: true, contract: "2026-09", pageUpdatedAt: NOW,
        tradingDate: "2026-08-18", availableContracts: [
            { contract: "2026-09", active: true }
        ], records };
}
const record = (optionType, strike, value, published = true, contract = "2026-09") =>
    ({ contract, optionType, strike, published, value: published ? value : null });
function input(overrides = {}) {
    return { generatedAt: NOW, marketDate: "2026-08-18",
        producer: { appVersion: "1.0.0", platform: "darwin" },
        overallV2: { status: "complete", direction: 32, directionLabel: "買い優勢",
            confidence: 78, metadata: { coverage: 100 }, confidenceFactors: { agreement: 80 } },
        currentPrice: { value: 40000, source: "qri-nikkei225-futures", mode: "automatic",
            contract: "2026-09", quotedAt: NOW, fetchedAt: NOW },
        qri: { available: true, activeContract: "2026-09", versionKey: "qri-v2-a",
            pageUpdatedAt: NOW, canonical: canonical([
                record("call", 40100, 100), record("call", 40200, 900), record("call", 40300, 800),
                record("call", 40400, 700), record("put", 39900, 100), record("put", 39800, 900),
                record("put", 39700, 800), record("put", 39600, 700)
            ]) }, sourceVersions: [{ source: "qri-options", tradingDate: "2026-08-18",
                contract: "2026-09", versionKey: "qri-v2-a", signature: "sha256:abc" }],
        freshness: {}, ...overrides };
}
const build = overrides => api.buildMobileSummary(input(overrides));
const changed = (value, mutate) => { const copy = structuredClone(value); mutate(copy); return copy; };

test("builder creates a valid schema v1 summary from complete v2 state", async () => {
    const summary = await build();
    assert.equal((await api.validateMobileSummary(summary)).valid, true);
    assert.equal(summary.schemaVersion, 1);
    assert.equal(summary.payload.overallV2.direction, 32);
    assert.equal(summary.payload.nearestLevels.upper.price, 40200);
    assert.equal(summary.payload.nearestLevels.lower.price, 39800);
});

test("builder handles v2 unavailable and partial", async () => {
    const unavailable = await build({ overallV2: { status: "unavailable", direction: null,
        confidence: 0, metadata: { coverage: 0 }, confidenceFactors: { agreement: 0 } } });
    assert.equal(unavailable.payload.overallV2.available, false);
    assert.equal(unavailable.dataQuality.status, "partial");
    assert.ok(unavailable.payload.alerts.some(alert => alert.code === "v2_unavailable"));
    const partial = await build({ overallV2: { status: "partial", direction: 10,
        directionLabel: "中立", confidence: 40, metadata: { coverage: 50 },
        confidenceFactors: { agreement: 50 } } });
    assert.equal(partial.payload.overallV2.available, true);
    assert.ok(partial.payload.alerts.some(alert => alert.code === "v2_partial"));
});

test("current price availability and manual source are retained", async () => {
    const manual = await build({ currentPrice: { value: 40123, source: "manual", mode: "manual",
        contract: null, quotedAt: null, fetchedAt: NOW } });
    assert.equal(manual.payload.currentPrice.source, "manual");
    assert.ok(manual.payload.alerts.some(alert => alert.code === "current_price_manual"));
    const unavailable = await build({ currentPrice: { value: null } });
    assert.deepEqual([unavailable.payload.currentPrice.available, unavailable.payload.currentPrice.value], [false, null]);
    assert.equal(unavailable.payload.nearestLevels.upper.available, false);
});

test("baseline, morning changes and option changes are explicitly unavailable", async () => {
    const summary = await build();
    assert.deepEqual(summary.payload.morningBaseline, { available: false, reason: "not_captured",
        baselineId: null, capturedAt: null, dataQuality: null, sourceSummaryId: null,
        sourceSummarySignature: null });
    assert.deepEqual(summary.payload.changeSinceMorning,
        { available: false, reason: "morning_baseline_missing" });
    assert.deepEqual(summary.payload.optionChanges,
        { available: false, reason: "morning_baseline_missing", items: [] });
});

test("builder generates quality, alerts, source versions and freshness", async () => {
    const summary = await build();
    assert.equal(summary.dataQuality.status, "complete");
    assert.equal(summary.sourceVersions[0].versionKey, "qri-v2-a");
    assert.equal(summary.freshness.currentPriceAt, NOW);
    assert.equal(summary.freshness.qriAt, NOW);
    assert.ok(summary.payload.alerts.some(alert => alert.code === "morning_baseline_missing"));
});

test("builder does not mutate input and signature ignores generatedAt", async () => {
    const original = input(); const before = structuredClone(original);
    const first = await api.buildMobileSummary(original);
    assert.deepEqual(original, before);
    const second = await api.buildMobileSummary({ ...original, generatedAt: "2026-08-18T03:01:00.000Z" });
    assert.equal(first.signature, second.signature);
    assert.equal(first.summaryId, second.summaryId);
});

test("canonical signature is stable across object key order", async () => {
    assert.equal(await api.createSignature({ schemaVersion: 1, marketDate: "2026-08-18",
        producer: { b: 2, a: 1 }, sourceVersions: [], dataQuality: {}, freshness: {}, payload: {} }),
    await api.createSignature({ payload: {}, freshness: {}, dataQuality: {}, sourceVersions: [],
        producer: { a: 1, b: 2 }, marketDate: "2026-08-18", schemaVersion: 1 }));
});

test("selector uses published active canonical v2, separates sides, top 3 then nearest", () => {
    const levels = api.selectNearestLevels({ canonical: input().qri.canonical,
        activeContract: "2026-09", versionKey: "v", currentPrice: 40000 });
    assert.equal(levels.upper.price, 40200); // 40100 is close but outside OI top 3
    assert.equal(levels.lower.price, 39800);
    assert.equal(levels.upper.optionType, "CALL");
    assert.equal(levels.lower.optionType, "PUT");
});

test("selector excludes unpublished, wrong side and equal strikes", () => {
    const data = canonical([record("call", 40000, 999), record("put", 40000, 999),
        record("call", 40100, 999, false), record("call", 40200, 1),
        record("put", 39900, 999, false), record("put", 39800, 1)]);
    const levels = api.selectNearestLevels({ canonical: data, activeContract: "2026-09",
        versionKey: "v", currentPrice: 40000 });
    assert.equal(levels.upper.price, 40200);
    assert.equal(levels.lower.price, 39800);
});

test("selector returns unavailable when candidates do not exist", () => {
    const data = canonical([record("call", 39900, 2), record("put", 40100, 3)]);
    const levels = api.selectNearestLevels({ canonical: data, activeContract: "2026-09",
        versionKey: "v", currentPrice: 40000 });
    assert.equal(levels.upper.available, false);
    assert.equal(levels.lower.available, false);
});

test("selector rejects contract mismatch and invalid canonical without mutation", () => {
    const data = input().qri.canonical; const before = structuredClone(data);
    assert.throws(() => api.selectNearestLevels({ canonical: data, activeContract: "2026-10",
        versionKey: "v", currentPrice: 40000 }), /qri_contract_mismatch/);
    assert.throws(() => api.selectNearestLevels({ canonical: { ...data, schemaVersion: 1 },
        activeContract: "2026-09", versionKey: "v", currentPrice: 40000 }), /invalid_qri_canonical/);
    assert.deepEqual(data, before);
});

test("validator rejects unknown schema, missing fields, timestamps, market date and non-finite values", async () => {
    const summary = await build();
    for (const [mutate, expected] of [
        [x => { x.schemaVersion = 2; }, "schema_version_invalid"],
        [x => { delete x.payload; }, "summary_fields_invalid"],
        [x => { x.generatedAt = "yesterday"; }, "generated_at_invalid"],
        [x => { x.marketDate = "2026-02-30"; }, "market_date_invalid"],
        [x => { x.payload.overallV2.confidence = Infinity; }, "overall_v2_invalid"]
    ]) assert.ok((await api.validateMobileSummary(changed(summary, mutate))).errors.includes(expected));
});

test("validator rejects current price state inconsistencies", async () => {
    const summary = await build();
    const invalid = changed(summary, x => { x.payload.currentPrice.available = false; });
    assert.ok((await api.validateMobileSummary(invalid)).errors.includes("current_price_invalid"));
});

test("validator rejects nearest relation, distance and source category", async () => {
    const summary = await build();
    for (const mutate of [
        x => { x.payload.nearestLevels.upper.price = 39000; },
        x => { x.payload.nearestLevels.upper.distance = 1; },
        x => { x.payload.nearestLevels.upper.sourceCategory = "futures"; }
    ]) assert.ok((await api.validateMobileSummary(changed(summary, mutate))).errors.includes("nearest_upper_invalid"));
});

test("validator rejects duplicate alerts and unavailable reason inconsistencies", async () => {
    const summary = await build();
    const duplicate = changed(summary, x => x.payload.alerts.push(structuredClone(x.payload.alerts[0])));
    assert.ok((await api.validateMobileSummary(duplicate)).errors.includes("alerts_invalid"));
    const baseline = changed(summary, x => { x.payload.morningBaseline.reason = null; });
    assert.ok((await api.validateMobileSummary(baseline)).errors.includes("morning_baseline_invalid"));
    const change = changed(summary, x => { x.payload.changeSinceMorning.reason = null; });
    assert.ok((await api.validateMobileSummary(change)).errors.includes("change_since_morning_invalid"));
});

test("validator rejects signature and summary id mismatch", async () => {
    const summary = await build();
    assert.ok((await api.validateMobileSummary(changed(summary,
        x => { x.signature = "0".repeat(64); }))).errors.includes("signature_mismatch"));
    assert.ok((await api.validateMobileSummary(changed(summary,
        x => { x.summaryId = "ms1-wrong"; }))).errors.includes("summary_id_mismatch"));
});

test("security validation rejects paths, credentials, git, raw documents, storage dumps and stacks", async () => {
    const summary = await build();
    const samples = ["/Users/alice/private", "api_key=secret", "git commit abc", "<html>raw</html>",
        "raw Excel workbook", "Local Storage full history", "TypeError: bad\\n at fn (app.js:1)"];
    for (const sample of samples) {
        const invalid = changed(summary, x => { x.payload.alerts[0].message = sample; });
        assert.equal((await api.validateMobileSummary(invalid)).valid, false, sample);
    }
});
