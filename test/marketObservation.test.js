const test = require("node:test");
const assert = require("node:assert/strict");
const { indexedDB } = require("fake-indexeddb");
const api = require("../js/marketObservation.js");
const storeApi = require("../js/storage/marketObservationStore.js");

const GENERATED = "2026-08-19T03:16:00.000Z";
const OBSERVED = "2026-08-19T03:16:01.000Z";
const summary = overrides => ({ schemaVersion: 1, summaryId: "ms1-sample", signature: "a".repeat(64),
    generatedAt: GENERATED, marketDate: "2026-08-19", producer: { appVersion: "1.0.0", platform: "test" },
    sourceVersions: [{ source: "qri-options", sourceDate: "2026-08-19", tradingDate: "2026-08-19",
        contract: "2026-09", versionKey: "qri-v1", signature: `sha256:${"b".repeat(64)}` }],
    dataQuality: { status: "complete", warnings: [] }, freshness: { currentPriceAt: GENERATED,
        qriAt: GENERATED, weeklyFuturesAt: GENERATED, weeklyOptionsAt: null, participantAt: null },
    payload: { overallV2: { available: true, status: "complete", direction: 66,
        directionLabel: "強い買い優勢", confidence: 80, coverage: 100, agreement: 75 },
    currentPrice: { available: true, status: "available", value: 65800, source: "qri",
        mode: "auto", quotedAt: GENERATED, fetchedAt: GENERATED, contract: "2026-09" },
    nearestLevels: { upper: { available: true, price: 66000 }, lower: { available: true, price: 65500 } },
    morningBaseline: { available: false, baselineId: null },
    changeSinceMorning: { available: false }, optionChanges: { available: false }, alerts: [] }, ...overrides });

function renderer(overrides = {}) {
    const component = (name, direction) => ({ name, available: true, invalid: false,
        normalizedDirection: direction, directionScore: direction * 100, baseWeight: name === "option" ? 55 : 45,
        qualityFactor: 1, effectiveWeight: name === "option" ? 55 : 45,
        weightedContribution: direction * (name === "option" ? 55 : 45), evidenceFactor: 0.8,
        notes: [], metadata: { sourceDate: "2026-08-19", versionKey: `${name}-v1` } });
    return { overallV2: { components: { option: component("option", 0.8), weekly: component("weekly", 0.5) } },
        currentPrice: { value: 65800, quotedAt: GENERATED, fetchedAt: GENERATED },
        qriOpenInterest: { usingFallback: false }, ...overrides };
}
const qri = overrides => ({ available: true, fetchedAt: GENERATED, confirmedAt: GENERATED,
    formalRevisionAvailable: true, canonicalV2: { tradingDate: "2026-08-19",
    contract: "2026-09", openInterestStatus: "available", pageUpdatedAt: GENERATED }, ...overrides });
const make = (changes = {}) => api.createObservation({ summary: changes.summary || summary(),
    rendererState: changes.rendererState || renderer(), qri: changes.qri || qri(),
    observedAt: changes.observedAt || OBSERVED });
const databaseName = name => `market-observation-${name}-${Date.now()}-${Math.random()}`;

test("Observation v1 fixes overall, price, components, source reference and JST session", async () => {
    const value = await make();
    assert.equal((await api.verifyObservation(value)).valid, true);
    assert.equal(value.session.calendarDay, "2026-08-19");
    assert.equal(value.overallV2.direction, 66);
    assert.equal(value.currentPrice.value, 65800);
    assert.equal(value.currentPrice.quotedAtRaw, GENERATED);
    assert.equal(value.currentPrice.quotedAtNormalized, GENERATED);
    assert.equal(value.components.option.directionScore, 80);
    assert.equal(value.qriReference.versionKey, "qri-v1");
    assert.equal(value.qriReference.confirmedAt, GENERATED);
    assert.equal(value.qriReference.formalRevisionAvailable, true);
});

test("unavailable values remain null and an ambiguous quotedAt is not inferred", async () => {
    const input = summary();
    input.payload.currentPrice = { available: false, status: "unavailable", value: null, source: null,
        mode: null, quotedAt: null, fetchedAt: null, contract: null };
    input.dataQuality = { status: "partial", warnings: ["currentPrice"] };
    const value = await make({ summary: input, rendererState: renderer({ currentPrice:
        { value: null, quotedAt: "08/19 12:16", fetchedAt: null } }) });
    assert.equal(value.currentPrice.value, null);
    assert.equal(value.currentPrice.quotedAtRaw, "08/19 12:16");
    assert.equal(value.currentPrice.quotedAtNormalized, null);
});

test("store appends, dedupes only a same semantic observation in five minutes, and restores after reopen", async () => {
    const name = databaseName("append");
    const firstStore = storeApi.createMarketObservationStore({ indexedDB, databaseName: name });
    const first = await make();
    assert.equal((await firstStore.append(first)).outcome, "appended");
    const duplicate = await make({ observedAt: "2026-08-19T03:19:00.000Z" });
    assert.equal(duplicate.semanticSignature, first.semanticSignature);
    assert.equal((await firstStore.append(duplicate)).outcome, "duplicate");
    const later = await make({ observedAt: "2026-08-19T03:22:00.000Z" });
    assert.equal((await firstStore.append(later)).outcome, "appended");
    firstStore.closeStore();
    const restored = storeApi.createMarketObservationStore({ indexedDB, databaseName: name });
    assert.equal((await restored.listAll()).length, 2);
    assert.equal((await restored.listByMarketDate("2026-08-19")).length, 2);
    restored.closeStore();
});

test("price, overall, QRI revision and quality changes produce distinct semantic records", async () => {
    const base = await make();
    const changed = [];
    const priceSummary = summary(); priceSummary.payload.currentPrice.value = 65810;
    changed.push(await make({ summary: priceSummary }));
    const overallSummary = summary(); overallSummary.payload.overallV2.direction = 67;
    changed.push(await make({ summary: overallSummary }));
    const qriSummary = summary(); qriSummary.sourceVersions[0].versionKey = "qri-v2";
    changed.push(await make({ summary: qriSummary }));
    const qualitySummary = summary(); qualitySummary.dataQuality.status = "partial";
    qualitySummary.dataQuality.warnings = ["nearestLevels.upper"];
    changed.push(await make({ summary: qualitySummary }));
    changed.forEach(item => assert.notEqual(item.semanticSignature, base.semanticSignature));
});

test("validation rejects malformed and mutated observations", async () => {
    const value = await make();
    value.currentPrice.value = Infinity;
    assert.equal(api.validateObservation(value).valid, false);
    const mutated = await make(); mutated.overallV2.direction = -10;
    assert.deepEqual((await api.verifyObservation(mutated)).errors, ["semantic_signature_mismatch"]);
});

test("best-effort persistence contains storage failure", async () => {
    let reported = null;
    const result = await api.persistBestEffort({ summary: summary(), rendererState: renderer(), qri: qri(),
        observedAt: OBSERVED }, { append: async () => { throw new Error("quota"); } }, error => { reported = error; });
    assert.equal(result.saved, false);
    assert.equal(result.outcome, "storage_unavailable");
    assert.equal(reported.message, "quota");
});
